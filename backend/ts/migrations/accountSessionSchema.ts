import { isDeepStrictEqual } from 'node:util';
import { tableExists, type MigrationConnection } from './leaderboardSchema';

export const ACCOUNT_SESSION_MIGRATION_VERSION = '0011_create_account_sessions';
export const ACCOUNT_SESSION_RENEWAL_MIGRATION_VERSION = '0012_add_session_renewal';
const TABLE_NAME = 'account_sessions';

async function rows(connection: MigrationConnection, sql: string, values: unknown[] = [TABLE_NAME]): Promise<Record<string, unknown>[]> {
    const [result] = await connection.query(sql, values);
    if (!Array.isArray(result)) throw new Error('Account session schema metadata is unavailable');
    return result as Record<string, unknown>[];
}

function assertExact(label: string, actual: readonly object[], expected: readonly object[]): void {
    if (!isDeepStrictEqual(actual.map(row => ({ ...row })), expected)) {
        throw new Error(`Account session ${label} does not match the reviewed schema`);
    }
}

/** Exact storage and UUID cascade keep revocation durable and deletion complete. */
export async function verifyAccountSessionSchema(connection: MigrationConnection, renewable = false): Promise<void> {
    assertExact('table', await rows(connection, `
        SELECT ENGINE AS engine, TABLE_COLLATION AS collation, TABLE_TYPE AS tableType
        FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
    `), [{ engine: 'InnoDB', collation: 'utf8mb4_unicode_ci', tableType: 'BASE TABLE' }]);
    const column = (name: string, type: string, characterSet: string | null = null,
        collation: string | null = null, datetimePrecision: number | null = null, comment = '') => ({
        name, type, nullable: 'NO', characterSet, collation, defaultValue: null, extra: '',
        datetimePrecision, comment, generationExpression: '',
    });
    const expectedColumns: Record<string, unknown>[] = [column('session_hash', 'binary(32)'), column('account_uuid', 'char(36)', 'ascii', 'ascii_bin'),
        column('created_at', 'datetime(6)', null, null, 6, 'UTC'),
        column('expires_at', 'datetime(6)', null, null, 6, 'UTC')];
    if (renewable) expectedColumns.push(
        { ...column('remembered', 'tinyint'), defaultValue: '0' },
        { ...column('renewed_at', 'datetime(6)', null, null, 6, 'UTC'), nullable: 'YES' },
        { ...column('previous_session_hash', 'binary(32)'), nullable: 'YES' },
        { ...column('previous_valid_until', 'datetime(6)', null, null, 6, 'UTC'), nullable: 'YES' },
    );
    assertExact('columns', await rows(connection, `
        SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable,
            CHARACTER_SET_NAME AS characterSet, COLLATION_NAME AS collation,
            COLUMN_DEFAULT AS defaultValue, EXTRA AS extra, DATETIME_PRECISION AS datetimePrecision,
            COLUMN_COMMENT AS comment, GENERATION_EXPRESSION AS generationExpression
        FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION
    `), expectedColumns);
    const index = (name: string, columnName: string, nonUnique: number, sequence = 1) => ({
        name, sequence, columnName, nonUnique, indexOrder: 'A', subPart: null, visible: 'YES', indexType: 'BTREE',
    });
    const expectedIndexes = [index('idx_account_sessions_account_created', 'account_uuid', 1),
        index('idx_account_sessions_account_created', 'created_at', 1, 2),
        index('idx_account_sessions_expiry', 'expires_at', 1), index('PRIMARY', 'session_hash', 0)];
    if (renewable) expectedIndexes.push(index('uq_account_sessions_previous_hash', 'previous_session_hash', 0));
    assertExact('indexes', (await rows(connection, `
        SELECT INDEX_NAME AS name, SEQ_IN_INDEX AS sequence, COLUMN_NAME AS columnName,
            NON_UNIQUE AS nonUnique, COLLATION AS indexOrder, SUB_PART AS subPart,
            IS_VISIBLE AS visible, INDEX_TYPE AS indexType
        FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
        ORDER BY INDEX_NAME, SEQ_IN_INDEX
    `)).map(row => ({ ...row, sequence: Number(row.sequence), nonUnique: Number(row.nonUnique) })), expectedIndexes);
    assertExact('foreign key', (await rows(connection, `
        SELECT keyColumns.CONSTRAINT_NAME AS name, keyColumns.ORDINAL_POSITION AS sequence,
            keyColumns.COLUMN_NAME AS columnName, keyColumns.REFERENCED_TABLE_NAME AS referencedTable,
            keyColumns.REFERENCED_COLUMN_NAME AS referencedColumn,
            keyColumns.REFERENCED_TABLE_SCHEMA = DATABASE() AS sameSchema,
            referentialRules.DELETE_RULE AS deleteRule, referentialRules.UPDATE_RULE AS updateRule
        FROM information_schema.KEY_COLUMN_USAGE AS keyColumns
        INNER JOIN information_schema.REFERENTIAL_CONSTRAINTS AS referentialRules
            ON referentialRules.CONSTRAINT_SCHEMA = keyColumns.CONSTRAINT_SCHEMA
            AND referentialRules.TABLE_NAME = keyColumns.TABLE_NAME
            AND referentialRules.CONSTRAINT_NAME = keyColumns.CONSTRAINT_NAME
        WHERE keyColumns.TABLE_SCHEMA = DATABASE() AND keyColumns.TABLE_NAME = ?
            AND keyColumns.REFERENCED_TABLE_NAME IS NOT NULL
        ORDER BY keyColumns.CONSTRAINT_NAME, keyColumns.ORDINAL_POSITION
    `)).map(row => ({ ...row, sequence: Number(row.sequence), sameSchema: Number(row.sameSchema) })), [{
        name: 'fk_account_sessions_account', sequence: 1, columnName: 'account_uuid',
        referencedTable: 'users', referencedColumn: 'account_uuid', sameSchema: 1,
        deleteRule: 'CASCADE', updateRule: 'RESTRICT',
    }]);
    assertExact('checks', await rows(connection, `
        SELECT CONSTRAINT_NAME AS name FROM information_schema.TABLE_CONSTRAINTS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_TYPE = 'CHECK' ORDER BY CONSTRAINT_NAME
    `), []);
    assertExact('triggers', await rows(connection, `
        SELECT TRIGGER_NAME AS name FROM information_schema.TRIGGERS
        WHERE TRIGGER_SCHEMA = DATABASE() AND EVENT_OBJECT_TABLE = ? ORDER BY TRIGGER_NAME
    `), []);
}

export async function inspectAccountSessionRenewal(connection: MigrationConnection): Promise<boolean> {
    const columns = await rows(connection, `SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
        AND COLUMN_NAME IN ('remembered', 'renewed_at', 'previous_session_hash', 'previous_valid_until')`);
    if (columns.length === 0) return false;
    if (columns.length !== 4) throw new Error('Account session renewal schema is incomplete');
    return true;
}

export async function verifyRenewableAccountSessionSchema(connection: MigrationConnection): Promise<void> {
    await verifyAccountSessionSchema(connection, true);
}

/** Older backups may omit sessions only if 0011 has not been recorded. */
export async function verifyOptionalAccountSessionSchema(connection: MigrationConnection): Promise<void> {
    if (await tableExists(connection, TABLE_NAME)) {
        const renewable = await inspectAccountSessionRenewal(connection);
        if (!renewable && (await rows(connection, 'SELECT version FROM schema_migrations WHERE version = ?',
            [ACCOUNT_SESSION_RENEWAL_MIGRATION_VERSION])).length !== 0) {
            throw new Error('Recorded session renewal migration is missing its columns');
        }
        await verifyAccountSessionSchema(connection, renewable);
        return;
    }
    const recorded = await rows(connection,
        'SELECT version FROM schema_migrations WHERE version IN (?, ?)',
        [ACCOUNT_SESSION_MIGRATION_VERSION, ACCOUNT_SESSION_RENEWAL_MIGRATION_VERSION]);
    if (recorded.length !== 0) throw new Error('Recorded account session migration is missing its table');
}
