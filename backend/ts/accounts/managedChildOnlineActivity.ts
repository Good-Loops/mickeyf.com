import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { ProviderAuthContext } from '../auth/providerAuthContext';
import { readLiveSession } from '../auth/accountSessionRepository';
import { withUserSubmissionLock, type UserSubmissionLockContext } from '../leaderboards/userSubmissionLock';
import { isAccountId } from './deletionJournal';
import type { ParentManagedChildActivity } from './parentManagedChildActivity';

const timeout = 10_000;
type Database = Pick<Pool, 'getConnection'>;

async function transaction<T>(lock: UserSubmissionLockContext, run: (connection: PoolConnection) => Promise<T>): Promise<T> {
    let phase: 'begin' | 'active' | 'commit' = 'begin';
    try {
        await lock.connection.query({ sql: 'START TRANSACTION', timeout }); phase = 'active';
        const result = await run(lock.connection);
        phase = 'commit'; await lock.connection.query({ sql: 'COMMIT', timeout }); return result;
    } catch (error) {
        if (phase !== 'active') lock.invalidateConnection();
        else { try { await lock.connection.query({ sql: 'ROLLBACK', timeout }); } catch { lock.invalidateConnection(); } }
        throw error;
    }
}

function current(context: ProviderAuthContext | null) {
    if (!context?.account || !context.session || context.account.accountId !== context.session.accountId) throw new Error('Invalid session.');
    return { account: context.account, session: context.session };
}

/** Track only the signed-in account; no account ID or event details are accepted from the client. */
export async function recordOnlineInteraction(database: Database, context: ProviderAuthContext | null,
    activity: ParentManagedChildActivity): Promise<boolean> {
    const { account, session } = current(context);
    return withUserSubmissionLock(database, account.userId, lock => transaction(lock, async connection => {
        if (!await readLiveSession(connection, account.userId, account.accountId, session.sessionId)) throw new Error('Session unavailable.');
        // An absent row is deliberately not backfilled; lifecycle assessment must hold it.
        return activity.recordInteraction(connection, account.accountId, 'online');
    }));
}

/** A signed-in parent can extend only a child they still manage. */
export async function keepManagedChild(database: Database, context: ProviderAuthContext | null,
    childAccountId: string, activity: ParentManagedChildActivity): Promise<void> {
    const { account, session } = current(context);
    if (!isAccountId(childAccountId) || childAccountId === account.accountId) throw new Error('Child unavailable.');
    await withUserSubmissionLock(database, account.userId, async parentLock => {
        const [target] = await parentLock.connection.query<RowDataPacket[]>({ sql: `SELECT u.user_id FROM users u
            JOIN parent_child_consents c ON c.child_uuid=u.account_uuid
            WHERE u.account_uuid=? AND c.parent_uuid=? LIMIT 1`, timeout }, [childAccountId, account.accountId]);
        if (target.length !== 1 || !Number.isSafeInteger(target[0].user_id) || target[0].user_id === account.userId) throw new Error('Child unavailable.');
        await parentLock.withAdditionalLock(target[0].user_id, childLock => transaction(childLock, async connection => {
            if (!await readLiveSession(connection, account.userId, account.accountId, session.sessionId)) throw new Error('Session unavailable.');
            const [owned] = await connection.query<RowDataPacket[]>({ sql: `SELECT c.child_uuid FROM parent_child_consents c
                WHERE c.parent_uuid=? AND c.child_uuid=? LIMIT 1 FOR SHARE`, timeout }, [account.accountId, childAccountId]);
            if (owned.length !== 1 || !await activity.recordInteraction(connection, childAccountId, 'parent-keep')) throw new Error('Child tracking unavailable.');
        }));
    });
}
