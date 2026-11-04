import type { Pool, RowDataPacket } from 'mysql2/promise';
import { isAccountId } from './deletionJournal';
import type { DurableWarningStore } from './durableChildWarningStore';
import type { ChildInactivityParentService } from './childInactivityParentService';
import { NONRESPONSE_NOTICE, NONRESPONSE_NOTICE_DIGEST } from '../experimental/childInactivityNonresponsePolicy';

/** Read-only parent surface. Only the separate authenticated Keep account action resets activity. */
export function createChildWarningParentService(database: Pick<Pool, 'query'>, store: DurableWarningStore): ChildInactivityParentService {
    const service: ChildInactivityParentService = {
        async read(context, input) {
            if (!context?.account || !context.session || context.account.accountId !== context.session.accountId) return { error: 'INVALID_CONTEXT' };
            if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).join(',') !== 'childAccountId'
                || !isAccountId((input as { childAccountId?: unknown }).childAccountId)) return { error: 'INVALID_REQUEST' };
            const childId = (input as { childAccountId: string }).childAccountId;
            try {
                return await store.withChild(context.account.accountId, childId, async target => {
                    if (!await target.parentSessionValid(context.session!)) return { error: 'INVALID_CONTEXT' as const };
                    const prepared = [...target.history.events].reverse().find(event => event.kind === 'prepared');
                    const events = target.history.events.filter(event => event.attemptId === prepared?.attemptId);
                    const current = !!prepared && prepared.activityAt === target.context.snapshot.activityAt
                        && prepared.targetDigest === target.context.snapshot.currentTargetDigest
                        && prepared.noticeDigest === NONRESPONSE_NOTICE_DIGEST && target.context.snapshot.targetVerified
                        && events.some(event => event.kind === 'delivered') && !events.some(event => event.kind === 'hold');
                    if (!await target.parentSessionValid(context.session!)) return { error: 'INVALID_CONTEXT' as const };
                    return { warning: current ? { warningId: prepared!.attemptId, notice: NONRESPONSE_NOTICE, acknowledged: false } : null };
                });
            } catch { return { error: 'UNAVAILABLE' }; }
        },
        async acknowledge() { return { error: 'INVALID_REQUEST' }; },
        async pending(context, input) {
            if (!context?.account || !context.session || context.account.accountId !== context.session.accountId) return { error: 'INVALID_CONTEXT' };
            if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 0) return { error: 'INVALID_REQUEST' };
            try {
                const [children] = await database.query<RowDataPacket[]>({ sql: `SELECT child_uuid AS childId FROM parent_child_consents
                    WHERE parent_uuid=? ORDER BY child_uuid LIMIT 51`, timeout: 10_000 }, [context.account.accountId]);
                if (children.length > 50) return { error: 'UNAVAILABLE' };
                for (const child of children) {
                    const result = await service.read(context, { childAccountId: child.childId });
                    if ('error' in result) return result;
                    if (result.warning) return { pending: true };
                }
                return { pending: false };
            } catch { return { error: 'UNAVAILABLE' }; }
        },
    };
    return Object.freeze(service);
}
