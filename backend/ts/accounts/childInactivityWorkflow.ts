import { createHmac, randomUUID } from 'node:crypto';
import { isAccountId } from './deletionJournal';
import { assessChildInactivity, INACTIVITY_NOTICE_DIGEST, type InactivitySnapshot, type InactivityWarning } from './childInactivityPolicy';
import { isSessionId, type SessionProof } from '../security/sessionPolicy';

export type PendingInactivityWarning = Readonly<{
    warningId: string; parentId: string; childId: string; activityAt: string; contactDigest: string; noticeDigest: string;
}>;

export type ConfirmedInactivityReceipt = Readonly<{
    warningId: string; parentId: string; childId: string; contactDigest: string;
    deliveredAt: string; receiptDigest: string;
}>;

/**
 * Implementations must hold parent then child locks for the entire callback,
 * use a transaction, re-read the exact relationship/activity/contact and commit
 * only after the callback succeeds. Missing rows must return null, not guesses.
 */
export type LockedInactivityTarget = Readonly<{
    snapshot(): Promise<InactivitySnapshot | null>;
    pending(): Promise<PendingInactivityWarning | null>;
    savePending(warning: PendingInactivityWarning): Promise<void>;
    saveConfirmed(warning: InactivityWarning): Promise<void>;
    /** Verify the exact live parent session while the relationship is locked. */
    parentSessionValid(proof: SessionProof): Promise<boolean>;
    databaseTimestamp(): Promise<string>;
    /** Recheck deadlines against the locked datastore clock before journaling. */
    assertDeletionStillDue(): Promise<void>;
    deleteChild(childId: string): Promise<void>;
}>;
export type InactivityStore = Readonly<{
    withLockedChild<T>(parentId: string, childId: string, operation: (target: LockedInactivityTarget) => Promise<T>): Promise<T>;
}>;

export class InactivityDeletionUncertainError extends Error {
    constructor(readonly cause: unknown) {
        super('The independent deletion intent may have been recorded; inspect and reconcile before retrying.');
    }
}

/** An explicit acknowledgment from the currently authenticated parent is delivery evidence. */
export async function acknowledgeInactivityWarning(store: InactivityStore, parentId: string, childId: string,
    warningId: string, confirmation: string, proof: SessionProof, receiptKey: Buffer): Promise<boolean> {
    validIds(parentId, childId);
    if (!isAccountId(warningId) || confirmation !== 'ACKNOWLEDGE WARNING' || !proof
        || proof.accountId !== parentId || !isSessionId(proof.sessionId)
        || !Buffer.isBuffer(receiptKey) || receiptKey.length < 32) return false;
    return store.withLockedChild(parentId, childId, async target => {
        if (!await target.parentSessionValid(proof)) return false;
        const snapshot = await target.snapshot();
        const pending = await target.pending();
        if (!snapshot || !pending || pending.warningId !== warningId || pending.parentId !== parentId
            || pending.childId !== childId || snapshot.parentId !== parentId || snapshot.childId !== childId
            || snapshot.activityAt !== pending.activityAt || snapshot.currentContactDigest !== pending.contactDigest
            || pending.noticeDigest !== INACTIVITY_NOTICE_DIGEST) return false;
        const deliveredAt = await target.databaseTimestamp();
        const now = Date.parse(deliveredAt) + 1;
        if (snapshot.warning?.warningId === warningId) {
            return ['grace', 'eligible'].includes(assessChildInactivity(snapshot, now)) && await target.parentSessionValid(proof);
        }
        const receiptDigest = createHmac('sha256', receiptKey).update('parent-inactivity-ack\0')
            .update(parentId).update('\0').update(childId).update('\0').update(warningId).update('\0')
            .update(pending.noticeDigest).update('\0').update(proof.sessionId).digest('hex');
        const warning: InactivityWarning = { ...pending, deliveredAt, receiptDigest };
        const decision = assessChildInactivity({ ...snapshot, warning }, now);
        if (decision !== 'grace' && decision !== 'eligible') return false;
        if (!await target.parentSessionValid(proof)) return false;
        await target.saveConfirmed(warning);
        return true;
    });
}

function validIds(parentId: string, childId: string): void {
    if (!isAccountId(parentId) || !isAccountId(childId) || parentId === childId) throw new TypeError('Invalid parent or child account.');
}

/** No mail is sent here: the returned opaque warning ID is for a private operator workflow. */
export async function prepareInactivityWarning(store: InactivityStore, parentId: string, childId: string,
    now = Date.now()): Promise<PendingInactivityWarning | null> {
    validIds(parentId, childId);
    return store.withLockedChild(parentId, childId, async target => {
        const snapshot = await target.snapshot();
        if (!snapshot || snapshot.parentId !== parentId || snapshot.childId !== childId
            || !['warning-due', 'await-confirmed-warning'].includes(assessChildInactivity(snapshot, now))
            || !snapshot.activityAt || !snapshot.currentContactDigest) return null;
        const existing = await target.pending();
        if (existing && existing.parentId === parentId && existing.childId === childId
            && existing.activityAt === snapshot.activityAt && existing.contactDigest === snapshot.currentContactDigest
            && existing.noticeDigest === INACTIVITY_NOTICE_DIGEST) return existing;
        const pending = Object.freeze({ warningId: randomUUID(), parentId, childId, activityAt: snapshot.activityAt,
            contactDigest: snapshot.currentContactDigest, noticeDigest: INACTIVITY_NOTICE_DIGEST });
        await target.savePending(pending);
        return pending;
    });
}

/**
 * A trusted verifier must independently establish receipt by the current parent.
 * Mail accepted for delivery, a message in Sent, or an unverified claim are not
 * receipt. The opaque evidence remains with the verifier; only its digest is kept.
 */
export async function confirmInactivityWarning(store: InactivityStore, parentId: string, childId: string,
    evidence: unknown, verifyReceipt: (evidence: unknown) => Promise<ConfirmedInactivityReceipt | null>,
    now = Date.now()): Promise<boolean> {
    validIds(parentId, childId);
    const receipt = await verifyReceipt(evidence);
    if (!receipt || receipt.parentId !== parentId || receipt.childId !== childId) return false;
    return store.withLockedChild(parentId, childId, async target => {
        const snapshot = await target.snapshot();
        const pending = await target.pending();
        if (!snapshot || !pending || pending.warningId !== receipt.warningId || pending.parentId !== parentId
            || pending.childId !== childId || snapshot.parentId !== parentId || snapshot.childId !== childId
            || snapshot.activityAt !== pending.activityAt || snapshot.currentContactDigest !== pending.contactDigest
            || receipt.contactDigest !== pending.contactDigest || pending.noticeDigest !== INACTIVITY_NOTICE_DIGEST) return false;
        const warning: InactivityWarning = { ...pending, deliveredAt: receipt.deliveredAt, receiptDigest: receipt.receiptDigest };
        const decision = assessChildInactivity({ ...snapshot, warning }, now);
        if (decision !== 'grace' && decision !== 'eligible') return false;
        await target.saveConfirmed(warning);
        return true;
    });
}

/** Retention intents must live outside the explicit-account-deletion journal and its replay. */
export type RetentionIntent = Readonly<{
    parentId: string; childId: string; activityAt: string; warningId: string;
    contactDigest: string; noticeDigest: string; deliveredAt: string; receiptDigest: string;
}>;
export interface RetentionJournal {
    /** Must use an independent, immutable store; no generic deletion intent may be written. */
    recordRetentionIntent(intent: RetentionIntent): Promise<void>;
    /** Verify this exact intent exists in the authenticated independent journal. */
    verifyRetentionIntent(intent: RetentionIntent): Promise<boolean>;
    /** Prove independent activity/keep history is complete across any restore. Unknown means false. */
    verifyActivityContinuity(intent: RetentionIntent): Promise<boolean>;
}

function matchesIntent(snapshot: InactivitySnapshot, intent: RetentionIntent): boolean {
    const warning = snapshot.warning;
    return snapshot.parentId === intent.parentId && snapshot.childId === intent.childId
        && snapshot.activityAt === intent.activityAt && snapshot.currentContactDigest === intent.contactDigest
        && !!warning && warning.warningId === intent.warningId && warning.contactDigest === intent.contactDigest
        && warning.noticeDigest === intent.noticeDigest && warning.deliveredAt === intent.deliveredAt
        && warning.receiptDigest === intent.receiptDigest;
}

/** Replay is held unless independent activity history establishes continuity across restores. */
export async function replayRetentionIntent(store: InactivityStore, journal: RetentionJournal,
    intent: RetentionIntent, now = Date.now()): Promise<'held' | 'deleted'> {
    validIds(intent.parentId, intent.childId);
    return store.withLockedChild(intent.parentId, intent.childId, async target => {
        const snapshot = await target.snapshot();
        if (!snapshot || !matchesIntent(snapshot, intent) || assessChildInactivity(snapshot, now) !== 'eligible'
            || !await journal.verifyRetentionIntent(intent) || !await journal.verifyActivityContinuity(intent)) return 'held';
        await target.assertDeletionStillDue();
        await target.deleteChild(intent.childId);
        return 'deleted';
    });
}

/** No production journal/continuity verifier exists: deletion must remain unavailable until both are qualified. */
export async function deleteInactiveChild(store: InactivityStore, journal: RetentionJournal,
    parentId: string, childId: string, now = Date.now()): Promise<'held' | 'deleted'> {
    validIds(parentId, childId);
    if (!journal || typeof journal.recordRetentionIntent !== 'function' || typeof journal.verifyRetentionIntent !== 'function' || typeof journal.verifyActivityContinuity !== 'function')
        throw new TypeError('An independent retention journal and continuity verifier are required.');
    let journalAttempted = false;
    try {
        return await store.withLockedChild(parentId, childId, async target => {
            const snapshot = await target.snapshot();
            if (!snapshot || snapshot.parentId !== parentId || snapshot.childId !== childId
                || assessChildInactivity(snapshot, now) !== 'eligible' || !snapshot.warning || !snapshot.activityAt
                || !snapshot.currentContactDigest) return 'held';
            const warning = snapshot.warning;
            const intent: RetentionIntent = { parentId, childId, activityAt: snapshot.activityAt, warningId: warning.warningId,
                contactDigest: snapshot.currentContactDigest, noticeDigest: warning.noticeDigest,
                deliveredAt: warning.deliveredAt, receiptDigest: warning.receiptDigest };
            if (!await journal.verifyActivityContinuity(intent)) return 'held';
            await target.assertDeletionStillDue();
            journalAttempted = true;
            await journal.recordRetentionIntent(intent);
            await target.deleteChild(childId);
            return 'deleted';
        });
    } catch (error) {
        if (journalAttempted) throw new InactivityDeletionUncertainError(error);
        throw error;
    }
}
