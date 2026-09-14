import { isDeepStrictEqual } from 'node:util';
import { tableExists, type MigrationConnection } from './leaderboardSchema';

export const PROVIDER_ATTEMPT_MIGRATION_VERSION = '0010_create_provider_auth_attempts';
const TABLE_NAME = 'provider_auth_attempts';
const ACTION_CHECK = "castactionasbinaryincast'login'asbinary,cast'link'asbinary";
const USER_CHECK = "casewhencastactionasbinary=cast'login'asbinarythenuser_idisnull"
    + 'elsecoalesceuser_id>0,0end=1';

async function rows<T>(connection: MigrationConnection, sql: string, values: unknown[] = [TABLE_NAME]): Promise<T[]> {
    const [result] = await connection.query(sql, values);
    if (!Array.isArray(result)) throw new Error('Provider attempt schema metadata is unavailable');
    return result as T[];
}

function assertExact(label: string, actual: readonly object[], expected: readonly object[]): void {
    if (!isDeepStrictEqual(actual.map(row => ({ ...row })), expected)) {
        throw new Error(`Provider attempt ${label} does not match the reviewed schema`);
    }
}

function normalizedCheck(clause: string): string {
    // Preserve literal bytes while accepting MySQL's binary-cast spelling.
    const normalized = (clause.match(/'(?:''|[^'])*'|[^']+/gu) ?? []).map(part => part.startsWith("'")
        ? part : part.toLowerCase().replace(/\bas\s+char\s+charset\s+binary\b/gu, 'as binary')
            .replace(/_(?:utf8mb4|ascii|binary)$/u, '').replace(/[`()\s]/gu, '')).join('');
    for (const expected of [ACTION_CHECK, USER_CHECK]) {
        if (normalized === expected) return expected;
        // JSON-derived MySQL 8.0.31 metadata can escape literal delimiters.
        // Accept only complete reviewed expressions, never arbitrary unescaping.
        for (const escape of ['\\', '\\\\']) {
            const escaped = expected.replace(/'(login|link)'/gu,
                (_match, value: string) => `_utf8mb4${escape}'${value}${escape}'`);
            if (normalized === escaped) return expected;
        }
    }
    return normalized;
}

/** Exact keys, InnoDB, and UUID cascade protect single-use consumption and deletion. */
export async function verifyProviderAttemptSchema(connection: MigrationConnection): Promise<void> {
    assertExact('table', await rows(connection, `
        SELECT ENGINE AS engine, TABLE_COLLATION AS collation, TABLE_TYPE AS tableType
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
    `), [{ engine: 'InnoDB', collation: 'utf8mb4_unicode_ci', tableType: 'BASE TABLE' }]);

    const columnRows = await rows(connection, `
        SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable,
            CHARACTER_SET_NAME AS characterSet, COLLATION_NAME AS collation,
            COLUMN_DEFAULT AS defaultValue, EXTRA AS extra,
            DATETIME_PRECISION AS datetimePrecision, COLUMN_COMMENT AS comment,
            GENERATION_EXPRESSION AS generationExpression
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION
    `);
    const column = (name: string, type: string, characterSet: string | null = null,
        collation: string | null = null, nullable = 'NO', datetimePrecision: number | null = null, comment = '') => ({
        name, type, nullable, characterSet, collation, defaultValue: null, extra: '',
        datetimePrecision, comment, generationExpression: '',
    });
    assertExact('columns', columnRows as object[], [
        column('state_hash', 'binary(32)'),
        column('binding_hash', 'binary(32)'),
        column('nonce', 'char(43)', 'ascii', 'ascii_bin'),
        column('client_key', 'varchar(64)', 'ascii', 'ascii_bin'),
        column('action', 'varchar(8)', 'ascii', 'ascii_bin'),
        column('user_id', 'int', null, null, 'YES'),
        column('account_uuid', 'char(36)', 'ascii', 'ascii_bin', 'YES'),
        column('expires_at', 'datetime(6)', null, null, 'NO', 6, 'UTC'),
    ]);

    const indexes = await rows<{
        name: string; sequence: number; columnName: string; nonUnique: number;
        indexOrder: string; subPart: number | null; visible: string; indexType: string;
    }>(connection, `
        SELECT INDEX_NAME AS name, SEQ_IN_INDEX AS sequence, COLUMN_NAME AS columnName,
            NON_UNIQUE AS nonUnique, COLLATION AS indexOrder, SUB_PART AS subPart,
            IS_VISIBLE AS visible, INDEX_TYPE AS indexType
        FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX
    `);
    const index = (name: string, columnName: string, nonUnique: number) => ({
        name, sequence: 1, columnName, nonUnique, indexOrder: 'A', subPart: null,
        visible: 'YES', indexType: 'BTREE',
    });
    assertExact('indexes', indexes.map(row => ({
        ...row, sequence: Number(row.sequence), nonUnique: Number(row.nonUnique),
    })), [
        index('idx_provider_auth_attempt_account', 'account_uuid', 1),
        index('idx_provider_auth_attempt_expiry', 'expires_at', 1),
        index('PRIMARY', 'state_hash', 0),
        index('uq_provider_auth_attempt_binding', 'binding_hash', 0),
    ]);

    const foreignKeys = await rows<{
        name: string; sequence: number; columnName: string; referencedTable: string;
        referencedColumn: string; sameSchema: number; deleteRule: string; updateRule: string;
    }>(connection, `
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
    `);
    assertExact('foreign key', foreignKeys.map(row => ({
        ...row, sequence: Number(row.sequence), sameSchema: Number(row.sameSchema),
    })), [{
        name: 'fk_provider_auth_attempt_account', sequence: 1, columnName: 'account_uuid',
        referencedTable: 'users', referencedColumn: 'account_uuid', sameSchema: 1,
        deleteRule: 'CASCADE', updateRule: 'RESTRICT',
    }]);

    const checks = await rows<{ name: string; clause: string; enforced: string }>(connection, `
        SELECT constraints.CONSTRAINT_NAME AS name, checks.CHECK_CLAUSE AS clause,
            constraints.ENFORCED AS enforced
        FROM information_schema.TABLE_CONSTRAINTS AS constraints
        INNER JOIN information_schema.CHECK_CONSTRAINTS AS checks
            ON checks.CONSTRAINT_SCHEMA = constraints.CONSTRAINT_SCHEMA
            AND checks.CONSTRAINT_NAME = constraints.CONSTRAINT_NAME
        WHERE constraints.TABLE_SCHEMA = DATABASE() AND constraints.TABLE_NAME = ?
            AND constraints.CONSTRAINT_TYPE = 'CHECK' ORDER BY constraints.CONSTRAINT_NAME
    `);
    assertExact('checks', checks.map(({ name, clause, enforced }) => ({
        name, clause: normalizedCheck(clause), enforced,
    })), [
        { name: 'chk_provider_auth_attempt_action', clause: ACTION_CHECK, enforced: 'YES' },
        { name: 'chk_provider_auth_attempt_user', clause: USER_CHECK, enforced: 'YES' },
    ]);

    assertExact('triggers', await rows(connection, `
        SELECT TRIGGER_NAME AS name FROM information_schema.TRIGGERS
        WHERE TRIGGER_SCHEMA = DATABASE() AND EVENT_OBJECT_TABLE = ? ORDER BY TRIGGER_NAME
    `), []);
}

/** Backups predating 0010 may omit attempts; recorded migrations may not lose their table. */
export async function verifyOptionalProviderAttemptSchema(connection: MigrationConnection): Promise<void> {
    if (await tableExists(connection, TABLE_NAME)) {
        await verifyProviderAttemptSchema(connection);
        return;
    }
    const recorded = await rows(connection,
        'SELECT version FROM schema_migrations WHERE version = ?', [PROVIDER_ATTEMPT_MIGRATION_VERSION]);
    if (recorded.length !== 0) throw new Error('Recorded provider attempt migration is missing its table');
}
