import assert from 'node:assert/strict';
import test from 'node:test';
import { acknowledgeInactivityWarning, confirmInactivityWarning, deleteInactiveChild, InactivityDeletionUncertainError,
    prepareInactivityWarning, replayRetentionIntent, type RetentionIntent, type InactivityStore, type LockedInactivityTarget,
    type PendingInactivityWarning, type ConfirmedInactivityReceipt } from './childInactivityWorkflow';
import { INACTIVITY_NOTICE_DIGEST, type InactivitySnapshot, type InactivityWarning } from './childInactivityPolicy';

const parentId = '11111111-1111-4111-8111-111111111111';
const childId = '22222222-2222-4222-8222-222222222222';
const targetDigest = 'a'.repeat(64);
const activityAt = '2028-01-01T00:00:00.000000Z';
const warningTime = Date.parse('2030-12-02T00:00:00.000Z');
const deletionTime = Date.parse('2031-01-01T00:00:00.000Z');

function fixture() {
    let current: InactivitySnapshot | null = { parentId, childId, activityAt, activityComplete: true,
        currentTargetDigest: targetDigest, targetVerified: true, channel: 'email', warning: null };
    let pending: PendingInactivityWarning | null = null;
    let deleted = false;
    const events: string[] = [];
    let failCommit = false;
    const store: InactivityStore = {
        async withLockedChild<T>(parent: string, child: string, callback: (target: LockedInactivityTarget) => Promise<T>): Promise<T> {
            assert.equal(parent, parentId); assert.equal(child, childId);
            // Publish changes only when the synthetic transaction commits.
            let next = current; let nextPending = pending; let nextDeleted = deleted;
            const result = await callback({
                async snapshot() { return next; }, async pending() { return nextPending; },
                async savePending(warning) { nextPending = warning; },
                async saveConfirmed(warning: InactivityWarning) { if (next) next = { ...next, warning }; },
                async parentSessionValid(proof) { return proof.sessionId === 'A'.repeat(43); },
                async databaseTimestamp() { return '2030-12-02T00:00:00.000000Z'; },
                async assertDeletionStillDue() {},
                async deleteChild(id) { assert.equal(id, childId); events.push('delete'); nextDeleted = true; next = null; },
            });
            if (failCommit) throw new Error('simulated commit ambiguity');
            current = next; pending = nextPending; deleted = nextDeleted; return result;
        },
    };
    let intent: RetentionIntent | undefined;
    const journal = { async recordRetentionIntent(value: RetentionIntent) { assert.equal(value.childId, childId); intent = value; events.push('journal'); }, async verifyRetentionIntent() { return true; }, async verifyActivityContinuity() { return true; } };
    return { store, journal, events, get snapshot() { return current; }, get deleted() { return deleted; }, get intent() { return intent; },
        setSnapshot(next: InactivitySnapshot | null) { current = next; }, setPending(value: PendingInactivityWarning | null) { pending = value; },
        setCommitFailure(value = true) { failCommit = value; } };
}

function receipt(pending: PendingInactivityWarning): ConfirmedInactivityReceipt {
    return { warningId: pending.warningId, parentId, childId, targetDigest,
        deliveredAt: '2030-12-02T00:00:00.000000Z', receiptDigest: 'b'.repeat(64) };
}

test('warning is prepared once, confirmed with evidence, and deletion follows the full grace period', async () => {
    const f = fixture();
    assert.equal(await prepareInactivityWarning(f.store, parentId, childId, warningTime - 1), null);
    const pending = await prepareInactivityWarning(f.store, parentId, childId, warningTime); assert.ok(pending);
    assert.deepEqual(await prepareInactivityWarning(f.store, parentId, childId, warningTime), pending);
    assert.equal(await confirmInactivityWarning(f.store, parentId, childId, {}, async () => null, warningTime), false);
    assert.equal(await deleteInactiveChild(f.store, f.journal, parentId, childId, deletionTime), 'held');
    assert.equal(await confirmInactivityWarning(f.store, parentId, childId, {}, async () => receipt(pending), warningTime), true);
    assert.equal(await deleteInactiveChild(f.store, f.journal, parentId, childId, deletionTime - 1), 'held');
    assert.deepEqual(f.events, []);
    assert.equal(await deleteInactiveChild(f.store, f.journal, parentId, childId, deletionTime), 'deleted');
    assert.deepEqual(f.events, ['journal', 'delete']); assert.equal(f.deleted, true);
});

test('a warning cannot follow a changed activity, identity, address, or unverified receipt', async () => {
    for (const change of ['activity', 'contact', 'unverified', 'receipt'] as const) {
        const f = fixture(); const pending = await prepareInactivityWarning(f.store, parentId, childId, warningTime); assert.ok(pending);
        if (change === 'activity') f.setSnapshot({ ...f.snapshot!, activityAt: '2028-01-02T00:00:00.000000Z' });
        if (change === 'contact') f.setSnapshot({ ...f.snapshot!, currentTargetDigest: 'c'.repeat(64) });
        if (change === 'unverified') f.setSnapshot({ ...f.snapshot!, targetVerified: false });
        assert.equal(await confirmInactivityWarning(f.store, parentId, childId, {}, async () =>
            change === 'receipt' ? { ...receipt(pending), receiptDigest: '' } : receipt(pending), warningTime), false, change);
        assert.equal(await deleteInactiveChild(f.store, f.journal, parentId, childId, deletionTime + 100 * 86400_000), 'held');
        assert.deepEqual(f.events, []);
    }
});

test('a parent keep action or later use invalidates a previously confirmed warning', async () => {
    const f = fixture(); const pending = await prepareInactivityWarning(f.store, parentId, childId, warningTime); assert.ok(pending);
    assert.equal(await confirmInactivityWarning(f.store, parentId, childId, {}, async () => receipt(pending), warningTime), true);
    f.setSnapshot({ ...f.snapshot!, activityAt: '2030-12-10T00:00:00.000000Z' });
    assert.equal(await deleteInactiveChild(f.store, f.journal, parentId, childId, deletionTime), 'held');
    assert.deepEqual(f.events, []);
});

test('journal failure or uncertain commit never reports deletion as safely failed', async () => {
    for (const cause of ['journal', 'commit'] as const) {
        const f = fixture(); const pending = await prepareInactivityWarning(f.store, parentId, childId, warningTime); assert.ok(pending);
        await confirmInactivityWarning(f.store, parentId, childId, {}, async () => receipt(pending), warningTime);
        if (cause === 'commit') f.setCommitFailure();
        const journal = cause === 'journal' ? { async recordRetentionIntent() { throw new Error('ack lost'); }, async verifyRetentionIntent() { return true; }, async verifyActivityContinuity() { return true; } } : f.journal;
        await assert.rejects(deleteInactiveChild(f.store, journal, parentId, childId, deletionTime), InactivityDeletionUncertainError);
        assert.equal(f.deleted, false);
    }
});

test('unknown relationship or unhealthy tracking never reaches the journal', async () => {
    const f = fixture(); f.setSnapshot(null);
    assert.equal(await prepareInactivityWarning(f.store, parentId, childId, deletionTime), null);
    assert.equal(await deleteInactiveChild(f.store, f.journal, parentId, childId, deletionTime), 'held');
    assert.deepEqual(f.events, []);
    await assert.rejects(deleteInactiveChild(f.store, f.journal, parentId, parentId, deletionTime), TypeError);
});

test('only the exact live parent can explicitly acknowledge a current warning', async () => {
    const f = fixture(); f.setSnapshot({ ...f.snapshot!, channel: 'in-app' });
    assert.equal(await prepareInactivityWarning(f.store, parentId, childId, warningTime), null, 'operator preparation cannot impersonate an in-app session');
    const pending: PendingInactivityWarning = { parentId, childId, warningId: '33333333-3333-4333-8333-333333333333',
        channel: 'in-app', activityAt, targetDigest, noticeDigest: INACTIVITY_NOTICE_DIGEST };
    f.setPending(pending);
    const key = Buffer.alloc(32, 9);
    const session = { accountId: parentId, sessionId: 'A'.repeat(43) };
    assert.equal(await acknowledgeInactivityWarning(f.store, parentId, childId, pending.warningId, 'ACKNOWLEDGE WARNING',
        { ...session, accountId: childId }, key), false);
    assert.equal(await acknowledgeInactivityWarning(f.store, parentId, childId, pending.warningId, 'ACKNOWLEDGE WARNING',
        { ...session, sessionId: 'B'.repeat(42) + 'A' }, key), false);
    assert.equal(await acknowledgeInactivityWarning(f.store, parentId, childId, pending.warningId, 'yes', session, key), false);
    assert.equal(await acknowledgeInactivityWarning(f.store, parentId, childId, pending.warningId, 'ACKNOWLEDGE WARNING', session, key), true);
    assert.equal(f.snapshot?.warning?.warningId, pending.warningId);
    assert.equal(f.snapshot?.warning?.receiptDigest.length, 64);
    assert.equal(await deleteInactiveChild(f.store, f.journal, parentId, childId, deletionTime - 1), 'held');
});


test('failed commit followed by parent keep prevents guarded retention replay', async () => {
    const f = fixture(); const pending = await prepareInactivityWarning(f.store, parentId, childId, warningTime); assert.ok(pending);
    await confirmInactivityWarning(f.store, parentId, childId, {}, async () => receipt(pending), warningTime);
    f.setCommitFailure();
    await assert.rejects(deleteInactiveChild(f.store, f.journal, parentId, childId, deletionTime), InactivityDeletionUncertainError);
    assert.ok(f.intent); f.setCommitFailure(false);
    f.setSnapshot({ ...f.snapshot!, activityAt: '2031-01-02T00:00:00.000000Z' });
    assert.equal(await replayRetentionIntent(f.store, f.journal, f.intent, deletionTime + 500 * 86400_000), 'held');
    assert.equal(f.deleted, false);
});

test('replay holds when independent activity history is incomplete even if restored SQL rows match', async () => {
    const f = fixture(); const pending = await prepareInactivityWarning(f.store, parentId, childId, warningTime); assert.ok(pending);
    await confirmInactivityWarning(f.store, parentId, childId, {}, async () => receipt(pending), warningTime);
    f.setCommitFailure();
    await assert.rejects(deleteInactiveChild(f.store, f.journal, parentId, childId, deletionTime), InactivityDeletionUncertainError);
    assert.ok(f.intent); f.setCommitFailure(false);
    const incompleteJournal = { ...f.journal, async verifyActivityContinuity() { return false; } };
    assert.equal(await replayRetentionIntent(f.store, incompleteJournal, f.intent, deletionTime + 500 * 86400_000), 'held');
    assert.equal(f.deleted, false);
});
