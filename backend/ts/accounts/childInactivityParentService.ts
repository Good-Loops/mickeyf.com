import type { ProviderAuthContext } from '../auth/providerAuthContext';
import { randomUUID } from 'node:crypto';
import { isAccountId } from './deletionJournal';
import { assessChildInactivity, INACTIVITY_NOTICE, INACTIVITY_NOTICE_DIGEST } from './childInactivityPolicy';
import { acknowledgeInactivityWarning, type InactivityStore } from './childInactivityWorkflow';

const childInput = (input: unknown): input is { childAccountId: string } => !!input && typeof input === 'object'
    && !Array.isArray(input) && Object.keys(input).join(',') === 'childAccountId'
    && isAccountId((input as { childAccountId?: unknown }).childAccountId);

/** Parent-only surface. The caller must use the cookie/origin-protected context reader. */
export function createChildInactivityParentService(store: InactivityStore, receiptKey: Buffer) {
    if (!Buffer.isBuffer(receiptKey) || receiptKey.length < 32) throw new TypeError('A separate receipt HMAC key is required.');
    const key = Buffer.from(receiptKey);
    return {
        async read(context: ProviderAuthContext | null, input: unknown) {
            if (!context?.account || !context.session || context.account.accountId !== context.session.accountId) return { error: 'INVALID_CONTEXT' as const };
            if (!childInput(input)) return { error: 'INVALID_REQUEST' as const };
            try {
                return await store.withLockedChild(context.account.accountId, input.childAccountId, async target => {
                    if (!await target.parentSessionValid(context.session!)) return { error: 'INVALID_CONTEXT' as const };
                    const snapshot = await target.snapshot(); let pending = await target.pending();
                    const timestamp = await target.databaseTimestamp(); const now = Date.parse(timestamp) + 1;
                    if (!snapshot || snapshot.channel !== 'in-app' || snapshot.parentId !== context.account!.accountId || snapshot.childId !== input.childAccountId
                        || assessChildInactivity({ ...snapshot, warning: null }, now) !== 'warning-due') return { warning: null };
                    if (pending && pending.channel !== 'in-app') return { warning: null };
                    if (!pending || pending.parentId !== snapshot.parentId || pending.childId !== snapshot.childId
                        || pending.activityAt !== snapshot.activityAt || pending.targetDigest !== snapshot.currentTargetDigest
                        || pending.noticeDigest !== INACTIVITY_NOTICE_DIGEST) {
                        if (!snapshot.activityAt || !snapshot.currentTargetDigest || !await target.parentSessionValid(context.session!)) return { error: 'INVALID_CONTEXT' as const };
                        pending = { parentId: snapshot.parentId, childId: snapshot.childId, activityAt: snapshot.activityAt,
                            targetDigest: snapshot.currentTargetDigest, channel: 'in-app', noticeDigest: INACTIVITY_NOTICE_DIGEST,
                            warningId: randomUUID() };
                        await target.savePending(pending);
                    }
                    const acknowledged = snapshot.warning?.warningId === pending.warningId
                        && ['grace', 'eligible'].includes(assessChildInactivity(snapshot, now));
                    if (!await target.parentSessionValid(context.session!)) return { error: 'INVALID_CONTEXT' as const };
                    return { warning: { warningId: pending.warningId, notice: INACTIVITY_NOTICE, acknowledged: !!acknowledged } };
                });
            } catch { return { error: 'UNAVAILABLE' as const }; }
        },
        async acknowledge(context: ProviderAuthContext | null, input: unknown) {
            if (!context?.account || !context.session || context.account.accountId !== context.session.accountId) return { error: 'INVALID_CONTEXT' as const };
            if (!input || typeof input !== 'object' || Array.isArray(input)
                || Object.keys(input).sort().join(',') !== 'acknowledge,childAccountId,warningId') return { error: 'INVALID_REQUEST' as const };
            const body = input as Record<string, unknown>;
            if (body.acknowledge !== true || !isAccountId(body.childAccountId) || !isAccountId(body.warningId)) return { error: 'INVALID_REQUEST' as const };
            try {
                const accepted = await acknowledgeInactivityWarning(store, context.account.accountId, body.childAccountId,
                    body.warningId, 'ACKNOWLEDGE WARNING', context.session, key);
                return accepted ? { acknowledged: true as const } : { error: 'UNAVAILABLE' as const };
            } catch { return { error: 'UNAVAILABLE' as const }; }
        },
    };
}
export type ChildInactivityParentService = ReturnType<typeof createChildInactivityParentService>;
