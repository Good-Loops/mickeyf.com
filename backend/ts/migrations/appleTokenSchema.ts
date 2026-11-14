import { isDeepStrictEqual } from 'node:util';
import { tableExists, type MigrationConnection } from './leaderboardSchema';

export const APPLE_TOKEN_MIGRATION_VERSION = '0016_create_apple_provider_tokens';
const TABLE_NAME = 'apple_provider_tokens';

async function rows(connection: MigrationConnection, sql: string, values: unknown[] = [TABLE_NAME]): Promise<Record<string, unknown>[]> {
    const [result] = await connection.query(sql, values);
    if (!Array.isArray(result)) throw new Error('Apple token schema metadata is unavailable');
    return result as Record<string, unknown>[];
}

function assertExact(label: string, actual: readonly object[], expected: readonly object[]): void {
    if (!isDeepStrictEqual(actual.map(row => ({ ...row })), expected)) {
        throw new Error(`Apple token ${label} does not match the reviewed schema`);
    }
}

/** Deliberately no foreign key: encrypted revocation work survives its account. */
export async function verifyAppleTokenSchema(connection: MigrationConnection): Promise<void> {
    assertExact('table', await rows(connection, `SELECT ENGINE AS engine, TABLE_COLLATION AS collation, TABLE_TYPE AS tableType
        FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`),
    [{ engine: 'InnoDB', collation: 'utf8mb4_unicode_ci', tableType: 'BASE TABLE' }]);
    const column = (name: string, type: string, characterSet: string | null = null, collation: string | null = null,
        nullable = 'NO', defaultValue: string | null = null, datetimePrecision: number | null = null, comment = '') => ({
        name, type, nullable, characterSet, collation, defaultValue, extra: '', datetimePrecision, comment, generationExpression: '',
    });
    const date = (name: string, nullable = 'YES') => column(name, 'datetime(6)', null, null, nullable, null, 6, 'UTC');
    assertExact('columns', await rows(connection, `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable,
        CHARACTER_SET_NAME AS characterSet, COLLATION_NAME AS collation, COLUMN_DEFAULT AS defaultValue, EXTRA AS extra,
        DATETIME_PRECISION AS datetimePrecision, COLUMN_COMMENT AS comment, GENERATION_EXPRESSION AS generationExpression
        FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`), [
        column('token_id', 'char(36)', 'ascii', 'ascii_bin'), column('account_uuid', 'char(36)', 'ascii', 'ascii_bin'),
        column('client_id', 'varchar(255)', 'ascii', 'ascii_bin'), column('encrypted_token', 'varbinary(8192)'),
        date('created_at', 'NO'), date('revocation_requested_at'), date('next_attempt_at'), date('retention_deadline'),
        column('attempt_count', 'int unsigned', null, null, 'NO', '0'),
    ]);
    const index = (name: string, columnName: string, nonUnique = 1, sequence = 1) => ({
        name, sequence, columnName, nonUnique, indexOrder: 'A', subPart: null, visible: 'YES', indexType: 'BTREE',
    });
    assertExact('indexes', (await rows(connection, `SELECT INDEX_NAME AS name, SEQ_IN_INDEX AS sequence,
        COLUMN_NAME AS columnName, NON_UNIQUE AS nonUnique, COLLATION AS indexOrder, SUB_PART AS subPart,
        IS_VISIBLE AS visible, INDEX_TYPE AS indexType FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX`))
        .map(row => ({ ...row, sequence: Number(row.sequence), nonUnique: Number(row.nonUnique) })), [
        index('idx_apple_tokens_account', 'account_uuid'), index('idx_apple_tokens_retention', 'retention_deadline'),
        index('idx_apple_tokens_retry', 'next_attempt_at'), index('idx_apple_tokens_retry', 'token_id', 1, 2),
        index('PRIMARY', 'token_id', 0),
    ]);
    assertExact('foreign keys', await rows(connection, `SELECT CONSTRAINT_NAME AS name FROM information_schema.TABLE_CONSTRAINTS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_TYPE = 'FOREIGN KEY' ORDER BY CONSTRAINT_NAME`), []);
    assertExact('checks', await rows(connection, `SELECT CONSTRAINT_NAME AS name FROM information_schema.TABLE_CONSTRAINTS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_TYPE = 'CHECK' ORDER BY CONSTRAINT_NAME`), []);
    assertExact('triggers', await rows(connection, `SELECT TRIGGER_NAME AS name FROM information_schema.TRIGGERS
        WHERE TRIGGER_SCHEMA = DATABASE() AND EVENT_OBJECT_TABLE = ? ORDER BY TRIGGER_NAME`), []);
}

export async function verifyOptionalAppleTokenSchema(connection: MigrationConnection): Promise<void> {
    if (await tableExists(connection, TABLE_NAME)) return verifyAppleTokenSchema(connection);
    if ((await rows(connection, 'SELECT version FROM schema_migrations WHERE version = ?', [APPLE_TOKEN_MIGRATION_VERSION])).length !== 0) {
        throw new Error('Recorded Apple token migration is missing its table');
    }
}

export async function verifyAppleTokenReadiness(connection: MigrationConnection): Promise<void> {
    const recorded = await rows(connection, 'SELECT version FROM schema_migrations WHERE version = ?', [APPLE_TOKEN_MIGRATION_VERSION]);
    if (recorded.length !== 1 || recorded[0].version !== APPLE_TOKEN_MIGRATION_VERSION) {
        throw new Error('Apple token storage requires its recorded migration');
    }
    await verifyAppleTokenSchema(connection);
}
