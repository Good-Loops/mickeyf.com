import { createHmac, randomUUID } from 'node:crypto';
import { isAccountId } from './deletionJournal';
import { assessChildInactivity, INACTIVITY_NOTICE_DIGEST, parseInactivityInstant, type InactivityChannel, type InactivitySnapshot, type InactivityWarning } from './childInactivityPolicy';
import { isSessionId, type SessionProof } from '../security/sessionPolicy';
import type { PoolConnection } from 'mysql2/promise';

export type PendingInactivityWarning = Readonly<{
    warningId: string; parentId: string; childId: string; activityAt: string; targetDigest: string; channel: InactivityChannel; noticeDigest: string;
}>;

export type ConfirmedInactivityReceipt = Readonly<{
    warningId: string; parentId: string; childId: string; targetDigest: string;
    deliveredAt: string; receiptDigest: string;
}>;

/**
 * Implementations must hold parent then child locks for the entire callback,
 * use a transaction, re-read the exact relationship/activity/target and commit
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
    /** Run continuity verification on the same locked connection when available. */
    verifyContinuity?(intent: RetentionIntent, journal: RetentionJournal): Promise<boolean>;
    /** Administrative restore operations may pin the isolated target inside this transaction. */
    matchesSqlIdentity?(database: string, serverUuid: string, currentUser: string): Promise<boolean>;
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
        if (!snapshot || !pending || pending.channel !== 'in-app' || snapshot.channel !== 'in-app' || pending.warningId !== warningId || pending.parentId !== parentId
            || pending.childId !== childId || snapshot.parentId !== parentId || snapshot.childId !== childId
            || snapshot.activityAt !== pending.activityAt || snapshot.currentTargetDigest !== pending.targetDigest
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

/** Replace only evidence that is demonstrably stale; incomparable or corrupt rows hold. */
export function canReplaceStaleWarning(pending: PendingInactivityWarning, snapshot: InactivitySnapshot): boolean {
    const hex = /^[a-f0-9]{64}$/u;
    if (!isAccountId(pending.warningId) || !isAccountId(pending.parentId) || !isAccountId(pending.childId)
        || pending.childId !== snapshot.childId || !['in-app', 'email'].includes(pending.channel)
        || !hex.test(pending.targetDigest) || !hex.test(pending.noticeDigest)
        || parseInactivityInstant(pending.activityAt) === null || parseInactivityInstant(snapshot.activityAt) === null
        || !snapshot.activityAt || pending.activityAt > snapshot.activityAt) return false;
    return pending.parentId !== snapshot.parentId || pending.activityAt < snapshot.activityAt
        || pending.noticeDigest !== INACTIVITY_NOTICE_DIGEST
        || (pending.channel === snapshot.channel && pending.targetDigest !== snapshot.currentTargetDigest);
}

/** Email-only operator preparation; in-app preparation requires a live parent session. */
export async function prepareInactivityWarning(store: InactivityStore, parentId: string, childId: string,
    now = Date.now()): Promise<PendingInactivityWarning | null> {
    validIds(parentId, childId);
    return store.withLockedChild(parentId, childId, async target => {
        const snapshot = await target.snapshot();
        if (!snapshot || snapshot.channel !== 'email' || snapshot.parentId !== parentId || snapshot.childId !== childId
            || !['warning-due', 'await-confirmed-warning'].includes(assessChildInactivity(snapshot, now))
            || !snapshot.activityAt || !snapshot.currentTargetDigest) return null;
        const existing = await target.pending();
        if (existing && existing.parentId === parentId && existing.childId === childId
            && existing.activityAt === snapshot.activityAt && existing.channel === snapshot.channel && existing.targetDigest === snapshot.currentTargetDigest
            && existing.noticeDigest === INACTIVITY_NOTICE_DIGEST) return existing;
        if (existing && !canReplaceStaleWarning(existing, snapshot)) return null;
        const pending = Object.freeze({ warningId: randomUUID(), parentId, childId, activityAt: snapshot.activityAt,
            targetDigest: snapshot.currentTargetDigest, channel: snapshot.channel, noticeDigest: INACTIVITY_NOTICE_DIGEST });
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
        if (!snapshot || !pending || pending.channel !== 'email' || snapshot.channel !== 'email' || pending.warningId !== receipt.warningId || pending.parentId !== parentId
            || pending.childId !== childId || snapshot.parentId !== parentId || snapshot.childId !== childId
            || snapshot.activityAt !== pending.activityAt || snapshot.currentTargetDigest !== pending.targetDigest
            || receipt.targetDigest !== pending.targetDigest || pending.noticeDigest !== INACTIVITY_NOTICE_DIGEST) return false;
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
    targetDigest: string; channel: InactivityChannel; noticeDigest: string; deliveredAt: string; receiptDigest: string;
}>;
export interface RetentionJournal {
    /** Must use an independent, immutable store; no generic deletion intent may be written. */
    recordRetentionIntent(intent: RetentionIntent): Promise<void>;
    /** Verify this exact intent exists in the authenticated independent journal. */
    verifyRetentionIntent(intent: RetentionIntent): Promise<boolean>;
    /** Prove independent activity/keep history is complete across any restore. Unknown means false. */
    verifyActivityContinuity(intent: RetentionIntent, connection?: Pick<PoolConnection, 'query'>): Promise<boolean>;
    /** Only after SQL commit, write a separately durable deleted outcome. */
    recordCommittedDeletion(intent: RetentionIntent, confirmedAt: string): Promise<void>;
}

function matchesIntent(snapshot: InactivitySnapshot, intent: RetentionIntent): boolean {
    const warning = snapshot.warning;
    return snapshot.parentId === intent.parentId && snapshot.childId === intent.childId
        && snapshot.activityAt === intent.activityAt && snapshot.channel === intent.channel && snapshot.currentTargetDigest === intent.targetDigest
        && !!warning && warning.warningId === intent.warningId && warning.channel === intent.channel && warning.targetDigest === intent.targetDigest
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
            || !await journal.verifyRetentionIntent(intent)
            || !await (target.verifyContinuity ? target.verifyContinuity(intent, journal) : journal.verifyActivityContinuity(intent))) return 'held';
        await target.assertDeletionStillDue();
        await target.deleteChild(intent.childId);
        return 'deleted';
    });
}

/** No production journal/continuity verifier exists: deletion must remain unavailable until both are qualified. */
export async function deleteInactiveChild(store: InactivityStore, journal: RetentionJournal,
    parentId: string, childId: string, now = Date.now()): Promise<'held' | 'deleted'> {
    validIds(parentId, childId);
    if (!journal || typeof journal.recordRetentionIntent !== 'function' || typeof journal.verifyRetentionIntent !== 'function'
        || typeof journal.verifyActivityContinuity !== 'function' || typeof journal.recordCommittedDeletion !== 'function')
        throw new TypeError('An independent retention journal and continuity verifier are required.');
    let journalAttempted = false;
    let committedIntent: RetentionIntent | undefined;
    let confirmedAt: string | undefined;
    try {
        const result = await store.withLockedChild(parentId, childId, async target => {
            const snapshot = await target.snapshot();
            if (!snapshot || snapshot.parentId !== parentId || snapshot.childId !== childId
                || assessChildInactivity(snapshot, now) !== 'eligible' || !snapshot.warning || !snapshot.activityAt
                || !snapshot.currentTargetDigest) return 'held';
            const warning = snapshot.warning;
            const intent: RetentionIntent = { parentId, childId, activityAt: snapshot.activityAt, warningId: warning.warningId,
                targetDigest: snapshot.currentTargetDigest, channel: snapshot.channel, noticeDigest: warning.noticeDigest,
                deliveredAt: warning.deliveredAt, receiptDigest: warning.receiptDigest };
            if (!await (target.verifyContinuity ? target.verifyContinuity(intent, journal) : journal.verifyActivityContinuity(intent))) return 'held';
            await target.assertDeletionStillDue();
            const databaseTime = await target.databaseTimestamp();
            if (parseInactivityInstant(databaseTime) === null || databaseTime < intent.deliveredAt) {
                throw new Error('Database clock is unavailable.');
            }
            journalAttempted = true;
            await journal.recordRetentionIntent(intent);
            await target.deleteChild(childId);
            committedIntent = intent;
            confirmedAt = databaseTime;
            return 'deleted';
        });
        // The result above is returned only after the SQL adapter confirms COMMIT.
        // A lost journal acknowledgement leaves an explicit intent requiring review.
        if (result === 'deleted') {
            if (!committedIntent || !confirmedAt) throw new Error('Committed deletion evidence is unavailable.');
            await journal.recordCommittedDeletion(committedIntent, confirmedAt);
        }
        return result;
    } catch (error) {
        if (journalAttempted) throw new InactivityDeletionUncertainError(error);
        throw error;
    }
}
