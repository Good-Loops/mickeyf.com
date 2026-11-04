import { createHash, randomUUID } from 'node:crypto';
import { assessNonresponseCandidate, NONRESPONSE_NOTICE_DIGEST, type AcceptedOutreach, type NonresponseDecision } from '../experimental/childInactivityNonresponsePolicy';
import { observeBrevoInactivityWarning, sendBrevoInactivityWarning, type WarningAttempt, type WarningBinding,
    type SendResult, type MailObservation } from '../experimental/brevoInactivityMail';
import { parseInactivityInstant } from './childInactivityPolicy';
import type { DurableWarningStore, LockedWarning, WarningEvent } from './durableChildWarningStore';
import type { SessionProof } from '../security/sessionPolicy';

type Mail = Readonly<{
    send(attempt: WarningAttempt): Promise<SendResult>;
    observe(binding: WarningBinding, now: number): Promise<MailObservation>;
}>;
type Attempt = Readonly<{ prepared: WarningEvent; events: readonly WarningEvent[] }>;
type CoverageVerifier = (input: Readonly<{ historyDigest: string; outreach: AcceptedOutreach; checkedAt: string }>) => Promise<boolean>;
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
function halted(attempt: Attempt) { return attempt.events.some(event => ['hold', 'response'].includes(event.kind)); }

/**
 * Durable candidate workflow, deliberately not mounted or scheduled. A verified
 * provider observation is not a completeness proof: qualification of all reply,
 * forwarding and later-failure channels is required separately at final review.
 * No method here deletes an account or creates a deletion-journal intent.
 */
export function createChildWarningNonresponse(store: DurableWarningStore, mail: Mail, sender: string,
    verifyCoverage: CoverageVerifier = async () => false) {
    if (!store || typeof store.withChild !== 'function' || !mail || typeof mail.send !== 'function'
        || typeof mail.observe !== 'function' || sender !== 'accounts@notify.mickeyf.com' || typeof verifyCoverage !== 'function') {
        throw new TypeError('Invalid warning workflow configuration.');
    }
    return Object.freeze({
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
        async observe(parentId: string, childId: string): Promise<'delivered' | 'held'> {
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
                if (result?.kind === 'pending' && !previous) return 'held';
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
        async recordParentResponse(parentId: string, childId: string, attemptId: string, proof: SessionProof): Promise<boolean> {
            return store.withChild(parentId, childId, async target => {
                const attempt = latest(target);
                if (!attempt || attempt.prepared.attemptId !== attemptId || !matches(target, attempt)
                    || !await target.parentSessionValid(proof)) return false;
                if (!attempt.events.some(event => event.kind === 'response')) {
                    await target.append({ kind: 'response', attemptId, at: target.now });
                }
                return true;
            });
        },
        async assess(parentId: string, childId: string): Promise<NonresponseDecision> {
            return store.withChild(parentId, childId, async target => {
                const attempt = latest(target);
                if (!attempt || !matches(target, attempt) || halted(attempt)) return 'hold';
                const accepted = attempt.events.find(event => event.kind === 'accepted');
                const dispatch = attempt.events.find(event => event.kind === 'dispatch');
                const delivery = attempt.events.find(event => event.kind === 'delivered');
                if (!accepted || !dispatch || !delivery?.deliveredAt) return 'hold';
                const outreach: AcceptedOutreach = { parentId, childId, activityAt: attempt.prepared.activityAt!,
                    targetDigest: attempt.prepared.targetDigest!, warningId: attempt.prepared.attemptId,
                    noticeDigest: NONRESPONSE_NOTICE_DIGEST, channel: 'email',
                    // The committed dispatch is a proven lower bound on acceptance.
                    // Only authenticated delivery determines the additional wait.
                    acceptedAt: dispatch.at, acceptanceDigest: digest(accepted),
                    deliveredAt: delivery.deliveredAt, deliveryDigest: digest(delivery) };
                const result = assessNonresponseCandidate(target.context.snapshot, outreach, 'not-acknowledged',
                    Date.parse(target.now), value => digest(value) === digest(outreach));
                if (result !== 'candidate') return result;
                try {
                    return await verifyCoverage({ historyDigest: digest(target.history), outreach, checkedAt: target.now }) === true ? 'candidate' : 'hold';
                } catch { return 'hold'; }
            });
        },
    });
}

export function createBrevoChildWarningNonresponse(store: DurableWarningStore, apiKey: string, verifyCoverage?: CoverageVerifier) {
    return createChildWarningNonresponse(store, {
        send: attempt => sendBrevoInactivityWarning(apiKey, attempt),
        observe: (binding, now) => observeBrevoInactivityWarning(apiKey, binding, now),
    }, 'accounts@notify.mickeyf.com', verifyCoverage);
}
