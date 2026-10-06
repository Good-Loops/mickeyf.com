import { isDeepStrictEqual } from 'node:util';
import { tableExists, type MigrationConnection } from './leaderboardSchema';
import { APPLE_SESSION_PROVENANCE_MIGRATION_VERSION, verifyAccountSessionSchema } from './accountSessionSchema';

export const APPLE_REVOCATION_MIGRATION_VERSION = '0017_create_apple_auth_revocations';
const TABLE_NAME = 'apple_auth_revocations';

async function rows(connection: MigrationConnection, sql: string, values: unknown[] = [TABLE_NAME]): Promise<Record<string, unknown>[]> {
    const [result] = await connection.query(sql, values);
    if (!Array.isArray(result)) throw new Error('Apple revocation schema metadata is unavailable');
    return result as Record<string, unknown>[];
}

function assertExact(label: string, actual: readonly object[], expected: readonly object[]): void {
    if (!isDeepStrictEqual(actual.map(row => ({ ...row })), expected)) {
        throw new Error(`Apple revocation ${label} does not match the reviewed schema`);
    }
}

/** One expiring watermark per hashed subject; never a notification or account history. */
export async function verifyAppleRevocationSchema(connection: MigrationConnection): Promise<void> {
    assertExact('table', await rows(connection, `SELECT ENGINE AS engine, TABLE_COLLATION AS collation, TABLE_TYPE AS tableType
        FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`),
    [{ engine: 'InnoDB', collation: 'utf8mb4_unicode_ci', tableType: 'BASE TABLE' }]);
    const column = (name: string, type: string, datetimePrecision: number | null = null, comment = '') => ({
        name, type, nullable: 'NO', characterSet: null, collation: null, defaultValue: null, extra: '',
        datetimePrecision, comment, generationExpression: '',
    });
    assertExact('columns', await rows(connection, `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable,
        CHARACTER_SET_NAME AS characterSet, COLLATION_NAME AS collation, COLUMN_DEFAULT AS defaultValue, EXTRA AS extra,
        DATETIME_PRECISION AS datetimePrecision, COLUMN_COMMENT AS comment, GENERATION_EXPRESSION AS generationExpression
        FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`), [
        column('subject_hash', 'binary(32)'), column('revoked_at', 'bigint unsigned'),
        column('expires_at', 'datetime(6)', 6, 'UTC'),
    ]);
    const index = (name: string, columnName: string, nonUnique = 1, sequence = 1) => ({
        name, sequence, columnName, nonUnique, indexOrder: 'A', subPart: null, visible: 'YES', indexType: 'BTREE',
    });
    assertExact('indexes', (await rows(connection, `SELECT INDEX_NAME AS name, SEQ_IN_INDEX AS sequence,
        COLUMN_NAME AS columnName, NON_UNIQUE AS nonUnique, COLLATION AS indexOrder, SUB_PART AS subPart,
        IS_VISIBLE AS visible, INDEX_TYPE AS indexType FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX`))
        .map(row => ({ ...row, sequence: Number(row.sequence), nonUnique: Number(row.nonUnique) })), [
        index('idx_apple_revocations_expiry', 'expires_at'), index('idx_apple_revocations_expiry', 'subject_hash', 1, 2),
        index('PRIMARY', 'subject_hash', 0),
    ]);
    for (const kind of ['FOREIGN KEY', 'CHECK']) {
        assertExact(kind, await rows(connection, `SELECT CONSTRAINT_NAME AS name FROM information_schema.TABLE_CONSTRAINTS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_TYPE = '${kind}' ORDER BY CONSTRAINT_NAME`), []);
    }
    assertExact('triggers', await rows(connection, `SELECT TRIGGER_NAME AS name FROM information_schema.TRIGGERS
        WHERE TRIGGER_SCHEMA = DATABASE() AND EVENT_OBJECT_TABLE = ? ORDER BY TRIGGER_NAME`), []);
}

export async function verifyOptionalAppleRevocationSchema(connection: MigrationConnection): Promise<void> {
    if (await tableExists(connection, TABLE_NAME)) return verifyAppleRevocationSchema(connection);
    if ((await rows(connection, 'SELECT version FROM schema_migrations WHERE version = ?', [APPLE_REVOCATION_MIGRATION_VERSION])).length !== 0) {
        throw new Error('Recorded Apple revocation migration is missing its table');
    }
}

export async function verifyAppleRevocationReadiness(connection: MigrationConnection): Promise<void> {
    for (const version of [APPLE_REVOCATION_MIGRATION_VERSION, APPLE_SESSION_PROVENANCE_MIGRATION_VERSION]) {
        const recorded = await rows(connection, 'SELECT version FROM schema_migrations WHERE version = ?', [version]);
        if (recorded.length !== 1 || recorded[0].version !== version) {
            throw new Error('Apple revocation requires both recorded migrations');
        }
    }
    await verifyAppleRevocationSchema(connection);
    await verifyAccountSessionSchema(connection, true, true);
}
