import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { ProviderAuthContext } from '../auth/providerAuthContext';
import { readLiveSession } from '../auth/accountSessionRepository';
import { withUserSubmissionLock, type UserSubmissionLockContext } from '../leaderboards/userSubmissionLock';
import { isAccountId } from './deletionJournal';
import { clearChildDailyUsage, configureChildDailyUsage, readChildDailyUsage } from './childDailyUsageStore';
import type { ChildDailyUsagePolicy, ChildDailyUsageResult } from './childDailyUsage';
import { CHILD_DAILY_USAGE_NOTICE_VERSION } from './childDailyUsageNotice';

type Database = Pick<Pool, 'getConnection'>;
const timeout = 10_000;

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

function display(result: ChildDailyUsageResult, policy: ChildDailyUsagePolicy) {
    return { day: result.state.day, timeZone: policy.timeZone, dailyLimitMs: policy.dailyLimitMs,
        usedMs: result.state.usedMs, remainingMs: result.remainingMs };
}

/** Parent and child locks protect the relationship against concurrent withdrawal or deletion. */
async function withParentChild<T>(database: Database, context: ProviderAuthContext | null, childId: string,
    run: (connection: PoolConnection) => Promise<T>): Promise<T> {
    const { account, session } = current(context);
    if (!isAccountId(childId) || childId === account.accountId) throw new Error('Child unavailable.');
    return withUserSubmissionLock(database, account.userId, async parentLock => {
        const [target] = await parentLock.connection.query<RowDataPacket[]>({ sql: `SELECT u.user_id AS userId
            FROM users u JOIN parent_child_consents c ON c.child_uuid=u.account_uuid
            WHERE u.account_uuid=? AND c.parent_uuid=? LIMIT 2`, timeout }, [childId, account.accountId]);
        if (!Array.isArray(target) || target.length !== 1 || !Number.isSafeInteger(target[0].userId)
            || target[0].userId === account.userId) throw new Error('Child unavailable.');
        return parentLock.withAdditionalLock(target[0].userId, childLock => transaction(childLock, async connection => {
            if (!await readLiveSession(connection, account.userId, account.accountId, session.sessionId)) throw new Error('Session unavailable.');
            const [owned] = await connection.query<RowDataPacket[]>({ sql: `SELECT child_uuid FROM parent_child_consents
                WHERE parent_uuid=? AND child_uuid=? LIMIT 2 FOR SHARE`, timeout }, [account.accountId, childId]);
            if (!Array.isArray(owned) || owned.length !== 1) throw new Error('Child unavailable.');
            return run(connection);
        }));
    });
}

export async function setChildDailyUsageLimit(database: Database, context: ProviderAuthContext | null,
    childId: string, policy: ChildDailyUsagePolicy, consent: { accepted: boolean; noticeVersion: string }) {
    if (consent?.accepted !== true || consent.noticeVersion !== CHILD_DAILY_USAGE_NOTICE_VERSION) throw new Error('Usage consent unavailable.');
    const { account } = current(context);
    return withParentChild(database, context, childId, async connection => {
        // Reuse the matched, signed parent proof already bound to this child.
        const [forms] = await connection.query<RowDataPacket[]>({ sql: `SELECT reference FROM parent_signed_forms
            WHERE parent_uuid=? AND child_uuid=? AND status='used' LIMIT 2 FOR SHARE`, timeout }, [account.accountId, childId]);
        if (!Array.isArray(forms) || forms.length !== 1) throw new Error('Parent proof unavailable.');
        return display(await configureChildDailyUsage(connection, childId, policy), policy);
    });
}

export async function getChildDailyUsageLimit(database: Database, context: ProviderAuthContext | null, childId: string) {
    return withParentChild(database, context, childId, async connection => {
        const result = await readChildDailyUsage(connection, childId, false);
        return result ? display(result, result.policy) : null;
    });
}

export async function clearChildDailyUsageLimit(database: Database, context: ProviderAuthContext | null, childId: string) {
    return withParentChild(database, context, childId, connection => clearChildDailyUsage(connection, childId));
}

/** A child can report only their own foreground lease, never another account ID or a client timestamp. */
export async function heartbeatChildDailyUsage(database: Database, context: ProviderAuthContext | null) {
    const { account, session } = current(context);
    return withUserSubmissionLock(database, account.userId, lock => transaction(lock, async connection => {
        if (!await readLiveSession(connection, account.userId, account.accountId, session.sessionId)) throw new Error('Session unavailable.');
        const [relationships] = await connection.query<RowDataPacket[]>({ sql: `SELECT child_uuid FROM parent_child_consents
            WHERE child_uuid=? LIMIT 2 FOR SHARE`, timeout }, [account.accountId]);
        if (!Array.isArray(relationships) || relationships.length > 1) throw new Error('Relationship unavailable.');
        if (!relationships.length) return { status: 'not-managed' as const };
        const result = await readChildDailyUsage(connection, account.accountId, true);
        if (!result) return { status: 'not-configured' as const };
        return { status: 'configured' as const, ...display(result, result.policy),
            allowedForMs: result.allowedUntilMs === null ? 0 : result.allowedUntilMs - result.state.accountedAtMs };
    }));
}
