import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { isAccountId } from './deletionJournal';

/**
 * Conservative first cleanup scope: only accounts that are fully absent.
 * The caller must authenticate the exact journal objects, fence writers and
 * verify the reviewed foreign-key schema and call this inside the checkpoint
 * transaction. The result is an observation, not proof of when deletion
 * happened or authorization to delete a journal.
 */
export async function verifyDeletedAccountEffects(connection: Pick<PoolConnection, 'query'>,
    accountIds: readonly string[]): Promise<boolean> {
    if (!Array.isArray(accountIds) || accountIds.length < 1 || accountIds.length > 100
        || accountIds.some(id => !isAccountId(id)) || new Set(accountIds).size !== accountIds.length) return false;
    try {
        const statements = [
            'SELECT account_uuid FROM users WHERE account_uuid IN (?) LIMIT 1 FOR UPDATE',
            'SELECT account_uuid FROM apple_provider_tokens WHERE account_uuid IN (?) LIMIT 1 FOR UPDATE',
            'SELECT child_uuid FROM parent_registration_attempts WHERE child_uuid IN (?) OR parent_uuid IN (?) LIMIT 1 FOR UPDATE',
        ];
        for (const [index, sql] of statements.entries()) {
            const [rows] = await connection.query<RowDataPacket[]>({ sql, timeout: 10_000 },
                index === 2 ? [accountIds, accountIds] : [accountIds]);
            if (!Array.isArray(rows) || rows.length !== 0) return false;
        }
        const [tables] = await connection.query<RowDataPacket[]>({ sql: `SELECT COUNT(*) AS count FROM information_schema.TABLES
            WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='apple_android_handoffs'`, timeout: 10_000 });
        const [migrations] = await connection.query<RowDataPacket[]>({ sql: `SELECT version FROM schema_migrations
            WHERE version='0027_create_apple_android_handoffs' LIMIT 2`, timeout: 10_000 });
        if (!Array.isArray(tables) || tables.length !== 1 || !Array.isArray(migrations) || migrations.length > 1) return false;
        const count = Number(tables[0].count);
        if ((count !== 0 && count !== 1) || (count === 0 && migrations.length !== 0)
            || (count === 1 && migrations.length !== 1)) return false;
        if (count === 1) {
            const [rows] = await connection.query<RowDataPacket[]>({ sql: `SELECT account_uuid FROM apple_android_handoffs
                WHERE account_uuid IN (?) LIMIT 1 FOR UPDATE`, timeout: 10_000 }, [accountIds]);
            if (!Array.isArray(rows) || rows.length !== 0) return false;
        }
        return true;
    } catch { throw new Error('Deletion effects could not be checked.'); }
}
