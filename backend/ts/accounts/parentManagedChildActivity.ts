import type { PoolConnection, ResultSetHeader } from 'mysql2/promise';

type WriterConnection = Pick<PoolConnection, 'query'>;
const timeout = 10_000;

/** Must run in the transaction that inserts the parent-child relationship. */
async function initialize(connection: WriterConnection, childAccountId: string): Promise<void> {
    const [result] = await connection.query<ResultSetHeader>({ sql: `INSERT INTO parent_managed_child_activity
        (child_uuid, retention_activity_at)
        SELECT child_uuid, UTC_TIMESTAMP(6) FROM parent_child_consents WHERE child_uuid=?`, timeout }, [childAccountId]);
    if (result.affectedRows !== 1) throw new Error('Managed child activity could not be initialized.');
}

/** Call only after authenticated interactive use, in the enclosing account transaction. */
async function recordInteraction(connection: WriterConnection, accountId: string): Promise<boolean> {
    // No upsert: old accounts without a prospective record stay untracked.
    const [result] = await connection.query<ResultSetHeader>({ sql: `UPDATE parent_managed_child_activity
        SET retention_activity_at=GREATEST(retention_activity_at + INTERVAL 1 MICROSECOND, UTC_TIMESTAMP(6)) WHERE child_uuid=?`, timeout }, [accountId]);
    if (result.affectedRows !== 0 && result.affectedRows !== 1) throw new Error('Managed child activity update is unavailable.');
    return result.affectedRows === 1;
}

/** Runtime wiring is default-off and requires successful storage readiness. */
export const parentManagedChildActivity = Object.freeze({ initialize, recordInteraction });
export type ParentManagedChildActivity = typeof parentManagedChildActivity;
