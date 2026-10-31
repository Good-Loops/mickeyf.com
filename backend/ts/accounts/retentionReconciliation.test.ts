import assert from 'node:assert/strict';
import test from 'node:test';
import { reconcileKeptRetentionIntent } from './retentionReconciliation';
import type { InactivitySnapshot } from './childInactivityPolicy';
import type { InactivityStore, LockedInactivityTarget, RetentionIntent } from './childInactivityWorkflow';
import type { RetentionResolution } from './gcsRetentionJournal';

const parentId = '11111111-1111-4111-8111-111111111111';
const childId = '22222222-2222-4222-8222-222222222222';
const intent: RetentionIntent = { parentId, childId, warningId: '33333333-3333-4333-8333-333333333333',
    activityAt: '2020-01-01T00:00:00.000000Z', deliveredAt: '2023-01-01T00:00:00.000000Z',
    targetDigest: 'a'.repeat(64), channel: 'in-app', noticeDigest: 'b'.repeat(64), receiptDigest: 'c'.repeat(64) };
const proof = { accountId: parentId, sessionId: 'A'.repeat(43) };
const key = Buffer.alloc(32, 4);

function fixture({ active = true, exists = true, newActivity = '2024-01-01T00:00:00.000000Z' } = {}) {
    let resolution: RetentionResolution | undefined;
    const snapshot: InactivitySnapshot = { parentId, childId, activityAt: newActivity, activityComplete: false,
        currentTargetDigest: null, targetVerified: false, channel: 'in-app', warning: null };
    const target = { async parentSessionValid() { return active; }, async snapshot() { return snapshot; },
        async databaseTimestamp() { return '2024-01-02T00:00:00.000000Z'; } } as unknown as LockedInactivityTarget;
    const store: InactivityStore = { async withLockedChild(parent, child, run) {
        assert.equal(parent, parentId); assert.equal(child, childId); return run(target);
    } };
    const journal = { async verifyRetentionIntent() { return exists; },
        async recordResolution(_intent: RetentionIntent, value: RetentionResolution) { resolution = value; } };
    return { store, journal, get resolution() { return resolution; } };
}

test('a live parent can reconcile an exact intent after later recorded use', async () => {
    const f = fixture();
    assert.equal(await reconcileKeptRetentionIntent(f.store, f.journal, intent, proof, key), true);
    assert.equal(f.resolution?.outcome, 'kept');
    assert.equal(f.resolution?.observedActivityAt, '2024-01-01T00:00:00.000000Z');
    assert.match(f.resolution?.proofDigest ?? '', /^[a-f0-9]{64}$/);
});
test('old activity, unverified intent and invalid parent sessions never resolve', async () => {
    for (const options of [{ active: false }, { exists: false }, { newActivity: intent.activityAt },
        { newActivity: '2025-01-01T00:00:00.000000Z' }]) {
        const f = fixture(options);
        assert.equal(await reconcileKeptRetentionIntent(f.store, f.journal, intent, proof, key), false);
        assert.equal(f.resolution, undefined);
    }
    const f = fixture();
    assert.equal(await reconcileKeptRetentionIntent(f.store, f.journal, intent, { ...proof, accountId: childId }, key), false);
    assert.equal(await reconcileKeptRetentionIntent(f.store, f.journal, intent, proof, Buffer.alloc(4)), false);
});
