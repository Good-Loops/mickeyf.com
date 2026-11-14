import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProviderAuthContext } from '../auth/providerAuthContext';
import type { InactivitySnapshot } from './childInactivityPolicy';
import type { InactivityStore, RetentionIntent } from './childInactivityWorkflow';
import type { RetentionResolution } from './gcsRetentionJournal';
import { createRetentionKeepReconciler } from './retentionKeepReconciler';

const parentId = '11111111-1111-4111-8111-111111111111', childId = '22222222-2222-4222-8222-222222222222';
const sessionId = 'A'.repeat(43), key = Buffer.alloc(32, 7);
const intent: RetentionIntent = { parentId, childId, warningId: '33333333-3333-4333-8333-333333333333',
    activityAt: '2020-01-01T00:00:00.000000Z', deliveredAt: '2023-01-01T00:00:00.000000Z', channel: 'in-app',
    targetDigest: 'a'.repeat(64), noticeDigest: 'b'.repeat(64), receiptDigest: 'c'.repeat(64) };
const context = { account: { accountId: parentId, userId: 1 }, session: { accountId: parentId, sessionId } } as unknown as ProviderAuthContext;
function fixture() {
    let resolution: RetentionResolution | null = null, alive = true;
    const snapshot: InactivitySnapshot = { parentId, childId, activityAt:'2024-01-01T00:00:00.000000Z',
        activityComplete:false, targetVerified:true, channel:'in-app', currentTargetDigest:'a'.repeat(64), warning:null };
    const store = { async withLockedChild(parent: string, child: string, operation: (target: unknown) => Promise<unknown>) {
        assert.equal(parent, parentId); assert.equal(child, childId);
        return operation({ async parentSessionValid() { return alive; }, async snapshot() { return snapshot; },
            async databaseTimestamp() { return '2024-01-02T00:00:00.000000Z'; } });
    } } as unknown as InactivityStore;
    const journal = { async readIntentsForChild(id: string) { assert.equal(id, childId); return [intent]; },
        async verifyRetentionIntent() { return true; }, async readResolution() { return resolution; },
        async recordResolution(_intent: RetentionIntent, value: RetentionResolution) { resolution = value; } };
    return { store, journal, resolution: () => resolution, revoke() { alive = false; } };
}
test('confirmed parent keep resolves an exact conditional intent and retries idempotently', async () => {
    const f = fixture(), reconcile = createRetentionKeepReconciler(f.store, f.journal, key);
    await reconcile(context, childId); assert.equal(f.resolution()?.outcome, 'kept');
    await reconcile(context, childId); assert.equal(f.resolution()?.outcome, 'kept');
    f.revoke(); await assert.rejects(reconcile(context, childId));
});
test('foreign intents, unavailable journal and invalid targets cannot be marked kept', async () => {
    const f = fixture();
    await assert.rejects(createRetentionKeepReconciler(f.store, { ...f.journal, async readIntentsForChild() {
        return [{ ...intent, parentId: '44444444-4444-4444-8444-444444444444' }]; } }, key)(context, childId));
    await assert.rejects(createRetentionKeepReconciler(f.store, { ...f.journal, async readIntentsForChild() { throw new Error('offline'); } }, key)(context, childId));
    await assert.rejects(createRetentionKeepReconciler(f.store, f.journal, key)(context, parentId));
    assert.equal(f.resolution(), null);
});
