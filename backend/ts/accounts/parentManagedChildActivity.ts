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

/** Call after successful password proof and session insertion, in the same transaction. */
async function recordInteractiveSignIn(connection: WriterConnection, accountId: string): Promise<void> {
    // No upsert: old accounts without a prospective record stay untracked.
    await connection.query({ sql: `UPDATE parent_managed_child_activity
        SET retention_activity_at=GREATEST(retention_activity_at, UTC_TIMESTAMP(6)) WHERE child_uuid=?`, timeout }, [accountId]);
}

/** No runtime wiring enables this writer until schema, permissions and rollout are reviewed. */
export const parentManagedChildActivity = Object.freeze({ initialize, recordInteractiveSignIn });
export type ParentManagedChildActivity = typeof parentManagedChildActivity;
