import { isDeepStrictEqual } from 'node:util';
import type { MigrationConnection } from './leaderboardSchema';

export const UNIQUE_USER_NAME_MIGRATION_VERSION = '0013_add_unique_user_names';
export const PASSWORDLESS_ACCOUNT_MIGRATION_VERSION = '0014_allow_passwordless_accounts';

async function rows(connection: MigrationConnection, sql: string, values: unknown[] = []): Promise<Record<string, unknown>[]> {
    const [result] = await connection.query(sql, values);
    if (!Array.isArray(result)) throw new Error('Passwordless account schema metadata is unavailable');
    return result as Record<string, unknown>[];
}

function assertExact(label: string, actual: readonly object[], expected: readonly object[]): void {
    if (!isDeepStrictEqual(actual.map(row => ({ ...row })), expected)) {
        throw new Error(`Passwordless account ${label} does not match the reviewed schema`);
    }
}

async function verifyUsersTable(connection: MigrationConnection): Promise<void> {
    assertExact('table', await rows(connection, `
        SELECT ENGINE AS engine, TABLE_TYPE AS tableType FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'
    `), [{ engine: 'InnoDB', tableType: 'BASE TABLE' }]);
}

async function inspectCredentialColumn(
    connection: MigrationConnection, columnName: 'user_name' | 'user_password'
): Promise<boolean> {
    await verifyUsersTable(connection);
    const columns = await rows(connection, `
        SELECT COLUMN_TYPE AS type, IS_NULLABLE AS nullable, CHARACTER_SET_NAME AS characterSet,
            COLLATION_NAME AS collation, COLUMN_DEFAULT AS defaultValue, EXTRA AS extra,
            COLUMN_COMMENT AS comment, GENERATION_EXPRESSION AS generationExpression
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = ?
    `, [columnName]);
    const nullable = columns[0]?.nullable;
    if (nullable !== 'NO' && (columnName !== 'user_password' || nullable !== 'YES')) {
        throw new Error(`Passwordless account ${columnName} does not match the reviewed schema`);
    }
    assertExact(columnName, columns, [{ type: 'varchar(255)', nullable,
        characterSet: 'utf8mb4', collation: 'utf8mb4_unicode_ci', defaultValue: null,
        extra: '', comment: '', generationExpression: '' }]);
    return nullable === 'YES';
}

/** Preserve the existing username collation and reject partial, composite or invisible uniqueness. */
export async function inspectUniqueUserNames(connection: MigrationConnection): Promise<boolean> {
    await inspectCredentialColumn(connection, 'user_name');
    const indexes = await rows(connection, `
        SELECT COLUMN_NAME AS columnName, NON_UNIQUE AS nonUnique, SEQ_IN_INDEX AS sequence,
            COLLATION AS indexOrder, SUB_PART AS subPart, IS_VISIBLE AS visible, INDEX_TYPE AS indexType
        FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND INDEX_NAME = 'uq_users_user_name'
        ORDER BY SEQ_IN_INDEX
    `);
    if (indexes.length === 0) return false;
    assertExact('username unique index', indexes.map(row => ({ ...row,
        nonUnique: Number(row.nonUnique), sequence: Number(row.sequence) })), [{
        columnName: 'user_name', nonUnique: 0, sequence: 1, indexOrder: 'A', subPart: null,
        visible: 'YES', indexType: 'BTREE',
    }]);
    return true;
}

/** Never choose a surviving account or rewrite names automatically. The unique DDL also closes races. */
export async function verifyUniqueUserNamesPrecondition(connection: MigrationConnection): Promise<void> {
    if (await inspectUniqueUserNames(connection)) throw new Error('Username uniqueness is already present');
    const duplicates = await rows(connection, `
        SELECT 1 AS duplicateFound FROM users GROUP BY user_name HAVING COUNT(*) > 1 LIMIT 1
    `);
    if (duplicates.length !== 0) {
        throw new Error('Username uniqueness migration blocked: duplicate user names require explicit resolution before retrying');
    }
}

export async function verifyUniqueUserNamesSchema(connection: MigrationConnection): Promise<void> {
    if (!(await inspectUniqueUserNames(connection))) throw new Error('Reviewed username unique index is missing');
}

export async function inspectPasswordlessAccounts(connection: MigrationConnection): Promise<boolean> {
    return inspectCredentialColumn(connection, 'user_password');
}

export async function verifyPasswordlessAccountsPrecondition(connection: MigrationConnection): Promise<void> {
    await verifyUniqueUserNamesSchema(connection);
    if (await inspectPasswordlessAccounts(connection)) throw new Error('Passwordless account column is already present');
}

export async function verifyPasswordlessAccountSchema(connection: MigrationConnection): Promise<void> {
    await verifyUniqueUserNamesSchema(connection);
    if (!(await inspectPasswordlessAccounts(connection))) throw new Error('Reviewed nullable password column is missing');
}
