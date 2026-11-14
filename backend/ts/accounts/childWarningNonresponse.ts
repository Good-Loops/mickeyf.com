import { createHash, randomUUID } from 'node:crypto';
import { assessNonresponseCandidate, NONRESPONSE_NOTICE_DIGEST, type AcceptedOutreach, type NonresponseDecision } from '../experimental/childInactivityNonresponsePolicy';
import { observeBrevoInactivityWarning, sendBrevoInactivityWarning, type WarningAttempt, type WarningBinding,
    type SendResult, type MailObservation } from '../experimental/brevoInactivityMail';
import { parseInactivityInstant } from './childInactivityPolicy';
import type { DurableWarningStore, LockedWarning, WarningEvent } from './durableChildWarningStore';
import { InactivityDeletionUncertainError, type RetentionIntent, type RetentionJournal } from './childInactivityWorkflow';

type Mail = Readonly<{
    send(attempt: WarningAttempt): Promise<SendResult>;
    observe(binding: WarningBinding, now: number): Promise<MailObservation>;
}>;
type Attempt = Readonly<{ prepared: WarningEvent; events: readonly WarningEvent[] }>;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const micros = (value: string) => value.replace(/\.(\d{3})Z$/u, '.$1000Z');
const messageId = /^<[^\s<>\x00-\x1f\x7f]{1,250}>$/u;

function latest(target: LockedWarning): Attempt | null {
    const prepared = [...target.history.events].reverse().find(event => event.kind === 'prepared');
    return prepared ? { prepared, events: target.history.events.filter(event => event.attemptId === prepared.attemptId) } : null;
}
function matches(target: LockedWarning, attempt: Attempt): boolean {
    const { snapshot, recipient } = target.context, prepared = attempt.prepared;
    return snapshot.activityComplete === true && snapshot.targetVerified === true && snapshot.warning === null
        && typeof recipient === 'string' && recipient.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(recipient)
        && prepared.activityAt === snapshot.activityAt && prepared.targetDigest === snapshot.currentTargetDigest
        && prepared.noticeDigest === NONRESPONSE_NOTICE_DIGEST;
}
function halted(attempt: Attempt) { return attempt.events.some(event => event.kind === 'hold'); }

function outreachFor(target: LockedWarning): AcceptedOutreach | null {
    const attempt = latest(target);
    if (!attempt || !matches(target, attempt) || halted(attempt)) return null;
    const accepted = attempt.events.find(event => event.kind === 'accepted');
    const dispatch = attempt.events.find(event => event.kind === 'dispatch');
    const delivery = attempt.events.find(event => event.kind === 'delivered');
    if (!accepted || !dispatch || !delivery?.deliveredAt) return null;
    return { parentId: target.history.parentId, childId: target.history.childId, activityAt: attempt.prepared.activityAt!,
        targetDigest: attempt.prepared.targetDigest!, warningId: attempt.prepared.attemptId,
        noticeDigest: NONRESPONSE_NOTICE_DIGEST, channel: 'email', acceptedAt: dispatch.at,
        acceptanceDigest: digest(accepted), deliveredAt: delivery.deliveredAt, deliveryDigest: digest(delivery) };
}
function assessLocked(target: LockedWarning): NonresponseDecision {
    const outreach = outreachFor(target);
    return outreach ? assessNonresponseCandidate(target.context.snapshot, outreach, 'not-acknowledged',
        Date.parse(target.now), value => digest(value) === digest(outreach)) : 'hold';
}

/**
 * Durable candidate workflow, deliberately not mounted or scheduled. A verified
 * provider observation starts the wait. Child activity and the parent keep
 * action reset it through the existing activity writer; free-form replies and
 * engagement events are not timer controls. Production activation is separate.
 */
export function createChildWarningNonresponse(store: DurableWarningStore, mail: Mail, sender: string) {
    if (!store || typeof store.withChild !== 'function' || !mail || typeof mail.send !== 'function'
        || typeof mail.observe !== 'function' || sender !== 'accounts@notify.mickeyf.com') {
        throw new TypeError('Invalid warning workflow configuration.');
    }
    return Object.freeze({
        async recordFailure(parentId: string, childId: string, failed: Readonly<{ messageId: string; recipient: string }>): Promise<void> {
            await store.withChild(parentId, childId, async target => {
                const attempt = latest(target);
                if (!attempt || halted(attempt) || !matches(target, attempt)
                    || target.context.recipient !== failed.recipient
                    || !attempt.events.some(event => event.kind === 'accepted' && event.messageId === failed.messageId)) return;
                await target.append({ kind: 'hold', attemptId: attempt.prepared.attemptId, at: target.now });
            });
        },
        async nextAction(parentId: string, childId: string): Promise<'prepare' | 'dispatch' | 'observe' | 'waiting' | 'candidate' | 'held'> {
            return store.withChild(parentId, childId, async target => {
                const attempt = latest(target);
                if (!attempt || !matches(target, attempt)) {
                    return assessNonresponseCandidate(target.context.snapshot, null, 'not-acknowledged', Date.parse(target.now), () => false)
                        === 'warning-due' ? 'prepare' : 'held';
                }
                if (halted(attempt)) return 'held';
                if (attempt.events.length === 1) return 'dispatch';
                if (!attempt.events.some(event => event.kind === 'accepted')) return 'held';
                if (!attempt.events.some(event => event.kind === 'delivered')) return 'observe';
                const decision = assessLocked(target);
                return decision === 'waiting' || decision === 'candidate' ? decision : 'held';
            });
        },
        async prepare(parentId: string, childId: string, language: 'en' | 'pt-BR'): Promise<string | null> {
            if (!['en', 'pt-BR'].includes(language)) throw new TypeError('Invalid warning language.');
            return store.withChild(parentId, childId, async target => {
                const current = latest(target), { snapshot, recipient } = target.context;
                if (current && matches(target, current)) return halted(current) ? null : current.prepared.attemptId;
                if (!recipient || assessNonresponseCandidate(snapshot, null, 'not-acknowledged', Date.parse(target.now), () => false) !== 'warning-due') return null;
                // Never replace an incomparable activity instant, even if a contact changed.
                if (current && (!snapshot.activityAt || !current.prepared.activityAt
                    || snapshot.activityAt < current.prepared.activityAt)) return null;
                const attemptId = randomUUID();
                await target.append({ kind: 'prepared', attemptId, at: target.now, activityAt: snapshot.activityAt!,
                    targetDigest: snapshot.currentTargetDigest!, noticeDigest: NONRESPONSE_NOTICE_DIGEST, language });
                return attemptId;
            });
        },
        async dispatch(parentId: string, childId: string): Promise<'accepted' | 'held' | 'uncertain'> {
            // Persist and commit before ANY provider request. A lost commit, process
            // crash, send response or later SQL write never permits an automatic retry.
            const claimed = await store.withChild(parentId, childId, async target => {
                const attempt = latest(target);
                if (!attempt || !matches(target, attempt) || attempt.events.length !== 1) return null;
                await target.append({ kind: 'dispatch', attemptId: attempt.prepared.attemptId, at: target.now });
                return attempt.prepared.attemptId;
            });
            if (!claimed) return 'held';
            return store.withChild(parentId, childId, async target => {
                const attempt = latest(target);
                if (!attempt || attempt.prepared.attemptId !== claimed || !matches(target, attempt)
                    || attempt.events.length !== 2 || attempt.events[1].kind !== 'dispatch') return 'held';
                // Reacquired locks exclude keep/contact writers while sending. No
                // other dispatcher can claim this already committed attempt.
                let result: SendResult;
                try { result = await mail.send({ attemptId: claimed, recipient: target.context.recipient!, sender,
                    language: attempt.prepared.language!, noticeDigest: NONRESPONSE_NOTICE_DIGEST }); }
                catch { result = { kind: 'uncertain' }; }
                if (result?.kind === 'accepted' && messageId.test(result.messageId)) {
                    await target.append({ kind: 'accepted', attemptId: claimed, at: target.now, messageId: result.messageId });
                    return 'accepted';
                }
                await target.append({ kind: 'hold', attemptId: claimed, at: target.now });
                return 'uncertain';
            });
        },
        async observe(parentId: string, childId: string): Promise<'delivered' | 'pending' | 'held'> {
            return store.withChild(parentId, childId, async target => {
                const attempt = latest(target);
                if (!attempt || !matches(target, attempt) || halted(attempt)) return 'held';
                const accepted = attempt.events.find(event => event.kind === 'accepted');
                const dispatched = attempt.events.find(event => event.kind === 'dispatch');
                if (!accepted?.messageId || !dispatched) return 'held';
                let result: MailObservation;
                try { result = await mail.observe({ sender, recipient: target.context.recipient!, messageId: accepted.messageId,
                    notBeforeMs: Date.parse(dispatched.at) }, Date.parse(target.now)); }
                catch { result = { kind: 'hold' }; }
                const previous = attempt.events.find(event => event.kind === 'delivered');
                if (result?.kind === 'pending' && !previous) return 'pending';
                const deliveredAt = result?.kind === 'delivered' ? micros(result.observedAt) : null;
                const delivered = parseInactivityInstant(deliveredAt), now = Date.parse(target.now);
                if (delivered === null || delivered > now || deliveredAt! < dispatched.at) {
                    await target.append({ kind: 'hold', attemptId: attempt.prepared.attemptId, at: target.now });
                    return 'held';
                }
                // The first receipt fixes the waiting clock. Inconsistent later
                // reports hold; they cannot replace it or erase earlier failures.
                if (previous?.deliveredAt === deliveredAt) return 'delivered';
                await target.append(previous ? { kind: 'hold', attemptId: attempt.prepared.attemptId, at: target.now }
                    : { kind: 'delivered', attemptId: attempt.prepared.attemptId, at: target.now, deliveredAt: deliveredAt! });
                return previous ? 'held' : 'delivered';
            });
        },
        async assess(parentId: string, childId: string): Promise<NonresponseDecision> {
            return store.withChild(parentId, childId, async target => assessLocked(target));
        },
    });
}

export function createBrevoChildWarningNonresponse(store: DurableWarningStore, apiKey: string) {
    return createChildWarningNonresponse(store, {
        send: attempt => sendBrevoInactivityWarning(apiKey, attempt),
        observe: (binding, now) => observeBrevoInactivityWarning(apiKey, binding, now),
    }, 'accounts@notify.mickeyf.com');
}

/** The separate conditional journal is reused; nonresponse notices cannot enter legacy 30-day replay. */
export async function deleteChildAfterNonresponse(store: DurableWarningStore, journal: RetentionJournal,
    parentId: string, childId: string, replay?: RetentionIntent): Promise<'held' | 'deleted'> {
    let attempted = false, committed: RetentionIntent | undefined, confirmedAt: string | undefined;
    try {
        const result = await store.withChild(parentId, childId, async target => {
            const outreach = outreachFor(target);
            if (!outreach || assessLocked(target) !== 'candidate') return 'held';
            const intent: RetentionIntent = { parentId, childId, activityAt: outreach.activityAt, warningId: outreach.warningId,
                targetDigest: outreach.targetDigest, channel: 'email', noticeDigest: NONRESPONSE_NOTICE_DIGEST,
                deliveredAt: outreach.deliveredAt, receiptDigest: digest({ history: target.history, outreach }) };
            if (replay && (digest(replay) !== digest(intent) || !await journal.verifyRetentionIntent(replay))) return 'held';
            if (!await target.verifyJournal(intent, journal)) return 'held';
            attempted = true;
            if (!replay) await journal.recordRetentionIntent(intent);
            await target.deleteChild();
            committed = intent; confirmedAt = target.now;
            return 'deleted';
        });
        if (result === 'deleted') await journal.recordCommittedDeletion(committed!, confirmedAt!);
        return result;
    } catch (error) {
        if (attempted) throw new InactivityDeletionUncertainError(error);
        throw error;
    }
}
