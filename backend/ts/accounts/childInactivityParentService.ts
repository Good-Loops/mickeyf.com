import type { ProviderAuthContext } from '../auth/providerAuthContext';
import { randomUUID } from 'node:crypto';
import { isAccountId } from './deletionJournal';
import { assessChildInactivity, INACTIVITY_NOTICE, INACTIVITY_NOTICE_DIGEST } from './childInactivityPolicy';
import { acknowledgeInactivityWarning, canReplaceStaleWarning, type InactivityStore } from './childInactivityWorkflow';

const childInput = (input: unknown): input is { childAccountId: string } => !!input && typeof input === 'object'
    && !Array.isArray(input) && Object.keys(input).join(',') === 'childAccountId'
    && isAccountId((input as { childAccountId?: unknown }).childAccountId);

/** Parent-only surface. The caller must use the cookie/origin-protected context reader. */
export function createChildInactivityParentService(store: InactivityStore, receiptKey: Buffer,
    findChildren?: (parentId: string) => Promise<readonly string[]>) {
    if (!Buffer.isBuffer(receiptKey) || receiptKey.length < 32) throw new TypeError('A separate receipt HMAC key is required.');
    const key = Buffer.from(receiptKey);
    const service = {
        async read(context: ProviderAuthContext | null, input: unknown) {
            if (!context?.account || !context.session || context.account.accountId !== context.session.accountId) return { error: 'INVALID_CONTEXT' as const };
            if (!childInput(input)) return { error: 'INVALID_REQUEST' as const };
            try {
                return await store.withLockedChild(context.account.accountId, input.childAccountId, async target => {
                    if (!await target.parentSessionValid(context.session!)) return { error: 'INVALID_CONTEXT' as const };
                    const snapshot = await target.snapshot(); let pending = await target.pending();
                    const timestamp = await target.databaseTimestamp(); const now = Date.parse(timestamp) + 1;
                    if (!snapshot || !snapshot.activityComplete || !snapshot.targetVerified) return { error: 'UNAVAILABLE' as const };
                    if (snapshot.channel !== 'in-app' || snapshot.parentId !== context.account!.accountId || snapshot.childId !== input.childAccountId
                        || assessChildInactivity({ ...snapshot, warning: null }, now) !== 'warning-due') return { warning: null };
                    if (!pending || pending.parentId !== snapshot.parentId || pending.childId !== snapshot.childId
                        || pending.activityAt !== snapshot.activityAt || pending.targetDigest !== snapshot.currentTargetDigest
                        || pending.channel !== snapshot.channel || pending.noticeDigest !== INACTIVITY_NOTICE_DIGEST) {
                        if (pending && !canReplaceStaleWarning(pending, snapshot)) return { warning: null };
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
        /** Generic in-app reminder; no child identities or contact details are exposed. */
        async pending(context: ProviderAuthContext | null, input: unknown) {
            if (!context?.account || !context.session || context.account.accountId !== context.session.accountId) return { error: 'INVALID_CONTEXT' as const };
            if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 0) return { error: 'INVALID_REQUEST' as const };
            if (!findChildren) return { error: 'UNAVAILABLE' as const };
            try {
                const children = await findChildren(context.account.accountId);
                if (!Array.isArray(children) || children.length > 50 || new Set(children).size !== children.length
                    || children.some(id => !isAccountId(id) || id === context.account!.accountId)) return { error: 'UNAVAILABLE' as const };
                for (const childAccountId of children) {
                    // Each read rechecks the exact parent session and ownership while holding the relationship locks.
                    const result = await service.read(context, { childAccountId });
                    if ('error' in result && result.error) return { error: result.error };
                    if (result.warning && !result.warning.acknowledged) return { pending: true as const };
                }
                return { pending: false as const };
            } catch { return { error: 'UNAVAILABLE' as const }; }
        },
    };
    return service;
}
type ParentWarningError = Readonly<{ error: 'INVALID_CONTEXT' | 'INVALID_REQUEST' | 'UNAVAILABLE' }>;
export type ChildInactivityParentService = Readonly<{
    read(context: ProviderAuthContext | null, input: unknown): Promise<ParentWarningError | { warning: null | {
        warningId: string; acknowledged: boolean; notice: { version: string; en: string; ptBR: string } } }>;
    acknowledge(context: ProviderAuthContext | null, input: unknown): Promise<ParentWarningError | { acknowledged: boolean }>;
    pending(context: ProviderAuthContext | null, input: unknown): Promise<ParentWarningError | { pending: boolean }>;
}>;
