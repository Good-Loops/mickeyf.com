import { isDeepStrictEqual } from 'node:util';
import { tableExists, type MigrationConnection } from './leaderboardSchema';

export const PROVIDER_IDENTITY_MIGRATION_VERSION = '0009_create_account_provider_identities';
const TABLE_NAME = 'account_provider_identities';
const PROVIDER_CHECK = "castproviderasbinaryincast'google'asbinary,cast'apple'asbinary";
const SUBJECT_CHECK = 'octet_lengthsubjectbetween1and255';

async function rows<T>(connection: MigrationConnection, sql: string, values: unknown[] = [TABLE_NAME]): Promise<T[]> {
    const [result] = await connection.query(sql, values);
    if (!Array.isArray(result)) throw new Error('Provider identity schema metadata is unavailable');
    return result as T[];
}

function assertExact(label: string, actual: readonly object[], expected: readonly object[]): void {
    if (!isDeepStrictEqual(actual.map(row => ({ ...row })), expected)) {
        throw new Error(`Provider identity ${label} does not match the reviewed schema`);
    }
}

function normalizedCheck(clause: string): string {
    // MySQL adds identifier quotes and character-set introducers. Preserve
    // string literals exactly: case and whitespace are part of provider IDs.
    const normalized = (clause.match(/'(?:''|[^'])*'|[^']+/gu) ?? []).map(part => part.startsWith("'")
        ? part : part.toLowerCase().replace(/\bas\s+char\s+charset\s+binary\b/gu, 'as binary')
            .replace(/_(?:utf8mb4|ascii|binary)$/u, '').replace(/[`()\s]/gu, '')).join('');
    if (normalized === 'lengthsubjectbetween1and255') return SUBJECT_CHECK;
    // MySQL 8.0.31 metadata escapes the literal delimiters. Accept only this
    // complete known expression; unescaping arbitrary SQL could alter a value.
    for (const escape of ['\\', '\\\\']) {
        const literal = (value: string) => `_utf8mb4${escape}'${value}${escape}'`;
        if (normalized === `castproviderasbinaryincast${literal('google')}asbinary,cast${literal('apple')}asbinary`) {
            return PROVIDER_CHECK;
        }
    }
    return normalized;
}

/** Exact schema is required because account deletion relies on its UUID cascade. */
export async function verifyProviderIdentitySchema(connection: MigrationConnection): Promise<void> {
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
        collation: string | null = null, datetimePrecision: number | null = null, comment = '') => ({
        name, type, nullable: 'NO', characterSet, collation, defaultValue: null, extra: '',
        datetimePrecision, comment, generationExpression: '',
    });
    assertExact('columns', columnRows as object[], [
        column('account_uuid', 'char(36)', 'ascii', 'ascii_bin'),
        column('provider', 'varchar(16)', 'ascii', 'ascii_bin'),
        column('subject', 'varbinary(255)'),
        column('linked_at', 'datetime(6)', null, null, 6, 'UTC'),
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
    const index = (name: string, sequence: number, columnName: string) => ({
        name, sequence, columnName, nonUnique: 0, indexOrder: 'A', subPart: null,
        visible: 'YES', indexType: 'BTREE',
    });
    assertExact('indexes', indexes.map(row => ({
        ...row, sequence: Number(row.sequence), nonUnique: Number(row.nonUnique),
    })), [
        index('PRIMARY', 1, 'provider'), index('PRIMARY', 2, 'subject'),
        index('uq_account_provider_identity', 1, 'account_uuid'),
        index('uq_account_provider_identity', 2, 'provider'),
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
        name: 'fk_account_provider_identity_account', sequence: 1, columnName: 'account_uuid',
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
        { name: 'chk_account_provider_identity_provider',
            clause: PROVIDER_CHECK, enforced: 'YES' },
        { name: 'chk_account_provider_identity_subject', clause: SUBJECT_CHECK, enforced: 'YES' },
    ]);

    assertExact('triggers', await rows(connection, `
        SELECT TRIGGER_NAME AS name FROM information_schema.TRIGGERS
        WHERE TRIGGER_SCHEMA = DATABASE() AND EVENT_OBJECT_TABLE = ? ORDER BY TRIGGER_NAME
    `), []);
}

/** Old backups may precede 0009; a recorded migration must never lose its table. */
export async function verifyOptionalProviderIdentitySchema(connection: MigrationConnection): Promise<void> {
    if (await tableExists(connection, TABLE_NAME)) {
        await verifyProviderIdentitySchema(connection);
        return;
    }
    const recorded = await rows(connection,
        'SELECT version FROM schema_migrations WHERE version = ?', [PROVIDER_IDENTITY_MIGRATION_VERSION]);
    if (recorded.length !== 0) throw new Error('Recorded provider identity migration is missing its table');
}
