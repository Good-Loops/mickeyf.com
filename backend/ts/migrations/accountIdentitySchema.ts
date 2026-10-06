import type { MigrationConnection } from './leaderboardSchema';

export const ACCOUNT_IDENTITY_MIGRATION_VERSION = '0008_finalize_account_identity';

export async function assertAccountIdentityEpoch(
    connection: MigrationConnection, expectedEpoch: string
): Promise<void> {
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/u.test(expectedEpoch)) {
        throw new Error('Account identity epoch must be the original migration UTC timestamp with six fractional digits');
    }
    const epochs = await rows<{ epoch: string }>(connection, `
        SELECT DATE_FORMAT(applied_at, '%Y-%m-%d %H:%i:%s.%f') AS epoch
        FROM schema_migrations WHERE version = '${ACCOUNT_IDENTITY_MIGRATION_VERSION}'
    `);
    if (epochs.length !== 1 || epochs[0].epoch !== expectedEpoch) {
        throw new Error('Account identity epoch differs from the independently approved original migration');
    }
}

async function rows<T>(connection: MigrationConnection, sql: string): Promise<T[]> {
    const [result] = await connection.query(sql);
    if (!Array.isArray(result)) throw new Error('Account identity metadata is unavailable');
    return result as T[];
}

type IdentityColumn = {
    type: string; nullable: string; characterSet: string; collation: string;
    defaultValue: string; extra: string; generationExpression: string;
};

async function identityColumns(connection: MigrationConnection): Promise<IdentityColumn[]> {
    return rows(connection, `
        SELECT COLUMN_TYPE AS type, IS_NULLABLE AS nullable,
            CHARACTER_SET_NAME AS characterSet, COLLATION_NAME AS collation,
            COLUMN_DEFAULT AS defaultValue, EXTRA AS extra,
            GENERATION_EXPRESSION AS generationExpression
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'
          AND COLUMN_NAME = 'account_uuid'
    `);
}

export async function accountIdentityColumnExists(connection: MigrationConnection): Promise<boolean> {
    return (await identityColumns(connection)).length !== 0;
}

async function verifyIdentityUsersTable(connection: MigrationConnection): Promise<void> {
    const tables = await rows<{ engine: string }>(connection, `
        SELECT ENGINE AS engine FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'
    `);
    if (tables.length !== 1 || tables[0].engine !== 'InnoDB') {
        throw new Error('Account identity migration requires an InnoDB users table');
    }
}

export async function verifyAccountIdentityPrecondition(connection: MigrationConnection): Promise<void> {
    await verifyIdentityUsersTable(connection);
    await inspectAccountIdentityStage(connection);
    const logging = await rows<{ binaryLogging: number; format: string }>(connection,
        'SELECT @@log_bin AS binaryLogging, @@binlog_format AS format');
    if (logging.length !== 1 || ![0, 1].includes(Number(logging[0].binaryLogging))
        || !['ROW', 'MIXED'].includes(logging[0].format)) {
        // UUID defaults are nondeterministic; statement replay must not regenerate identities.
        throw new Error('Account identity migration requires ROW or MIXED binary logging format');
    }
}

export async function verifyAccountIdentitySchema(connection: MigrationConnection): Promise<void> {
    if (await inspectAccountIdentityStage(connection) !== 'complete') {
        throw new Error('Account identity column does not match the reviewed schema');
    }
}

export async function accountIdentityBackfillComplete(connection: MigrationConnection): Promise<boolean> {
    if (await inspectAccountIdentityStage(connection) === 'absent') return false;
    const counts = await rows<{ missingCount: number }>(connection,
        'SELECT COUNT(*) AS missingCount FROM users WHERE account_uuid IS NULL');
    if (counts.length !== 1 || !Number.isSafeInteger(Number(counts[0].missingCount))) {
        throw new Error('Account identity backfill count is unavailable');
    }
    return Number(counts[0].missingCount) === 0;
}

export async function inspectAccountIdentityStage(
    connection: MigrationConnection
): Promise<'absent' | 'staged' | 'complete'> {
    const columns = await identityColumns(connection);
    if (columns.length === 0) return 'absent';
    await verifyIdentityUsersTable(connection);
    const column = columns[0];
    const complete = column.nullable === 'NO'
        && column.defaultValue?.toLowerCase().replace(/[()\s]/gu, '') === 'uuid'
        && column.extra === 'DEFAULT_GENERATED';
    const staged = column.nullable === 'YES' && column.defaultValue === null && column.extra === '';
    if (columns.length !== 1 || column.type !== 'char(36)' || (!complete && !staged)
        || column.characterSet !== 'ascii' || column.collation !== 'ascii_bin'
        || column.generationExpression !== '') {
        throw new Error('Account identity column does not match the reviewed schema');
    }
    const indexes = await rows<{ columnName: string; nonUnique: number; sequence: number;
        subPart: number | null; visible: string; indexType: string }>(connection, `
        SELECT COLUMN_NAME AS columnName, NON_UNIQUE AS nonUnique,
            SEQ_IN_INDEX AS sequence, SUB_PART AS subPart,
            IS_VISIBLE AS visible, INDEX_TYPE AS indexType
        FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'
          AND INDEX_NAME = 'uq_users_account_uuid' ORDER BY SEQ_IN_INDEX
    `);
    const index = indexes[0];
    if (indexes.length !== 1 || index.columnName !== 'account_uuid'
        || Number(index.nonUnique) !== 0 || Number(index.sequence) !== 1
        || index.subPart !== null || index.visible !== 'YES' || index.indexType !== 'BTREE') {
        throw new Error('Account identity unique index does not match the reviewed schema');
    }
    const invalid = await rows<{ invalidCount: number }>(connection, `
        SELECT COUNT(*) AS invalidCount FROM users
        WHERE NOT REGEXP_LIKE(account_uuid,
            '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$', 'c')
    `);
    if (invalid.length !== 1 || Number(invalid[0].invalidCount) !== 0) {
        throw new Error('Account identity migration found malformed account identifiers');
    }
    return complete ? 'complete' : 'staged';
}
