import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProviderAuthContext } from '../auth/providerAuthContext';
import { INACTIVITY_NOTICE, INACTIVITY_NOTICE_DIGEST, type InactivitySnapshot } from './childInactivityPolicy';
import { createChildInactivityParentService } from './childInactivityParentService';
import type { InactivityStore, PendingInactivityWarning } from './childInactivityWorkflow';

const parentId = '11111111-1111-4111-8111-111111111111';
const childId = '22222222-2222-4222-8222-222222222222';
const warningId = '33333333-3333-4333-8333-333333333333';
const contactDigest = 'a'.repeat(64);
const sessionId = 'A'.repeat(43);

function fixture() {
    let snapshot: InactivitySnapshot | null = { parentId, childId, activityAt: '2020-01-01T00:00:00.000000Z', activityComplete: true,
        currentContactDigest: contactDigest, contactVerified: true, warning: null };
    const pending: PendingInactivityWarning = { parentId, childId, warningId, activityAt: snapshot.activityAt!, contactDigest,
        noticeDigest: INACTIVITY_NOTICE_DIGEST };
    let sessionLive = true;
    const store: InactivityStore = { async withLockedChild(parent, child, operation) {
        if (parent !== parentId || child !== childId) throw new Error('Not an owned child.');
        return operation({ async snapshot() { return snapshot; }, async pending() { return pending; },
            async savePending() { assert.fail('parent cannot prepare a warning'); },
            async saveConfirmed(warning) { if (snapshot) snapshot = { ...snapshot, warning }; },
            async parentSessionValid(proof) { return sessionLive && proof.accountId === parentId && proof.sessionId === sessionId; },
            async databaseTimestamp() { return '2026-10-31T12:00:00.000000Z'; },
            async assertDeletionStillDue() { assert.fail('parent service cannot delete'); },
            async deleteChild() { assert.fail('parent service cannot delete'); } });
    } };
    const context = { account: { accountId: parentId, userId: 1 }, session: { accountId: parentId, sessionId } } as unknown as ProviderAuthContext;
    return { service: createChildInactivityParentService(store, Buffer.alloc(32, 7)), context,
        stopSession() { sessionLive = false; }, setSnapshot(next: InactivitySnapshot | null) { snapshot = next; } };
}

test('a current parent can read and explicitly acknowledge the exact rendered warning', async () => {
    const f = fixture();
    assert.deepEqual(await f.service.read(f.context, { childAccountId: childId }),
        { warning: { warningId, notice: INACTIVITY_NOTICE, acknowledged: false } });
    assert.deepEqual(await f.service.acknowledge(f.context, { childAccountId: childId, warningId, acknowledge: true }), { acknowledged: true });
    assert.deepEqual(await f.service.read(f.context, { childAccountId: childId }),
        { warning: { warningId, notice: INACTIVITY_NOTICE, acknowledged: true } });
    f.stopSession();
    assert.deepEqual(await f.service.acknowledge(f.context, { childAccountId: childId, warningId, acknowledge: true }), { error: 'UNAVAILABLE' });
});

test('anonymous, altered or wrong-child requests never disclose or acknowledge a warning', async () => {
    const f = fixture();
    assert.deepEqual(await f.service.read(null, { childAccountId: childId }), { error: 'INVALID_CONTEXT' });
    assert.deepEqual(await f.service.read(f.context, { childAccountId: childId, extra: true }), { error: 'INVALID_REQUEST' });
    assert.deepEqual(await f.service.acknowledge(f.context, { childAccountId: childId, warningId, acknowledge: false }), { error: 'INVALID_REQUEST' });
    assert.deepEqual(await f.service.acknowledge(f.context, { childAccountId: parentId, warningId, acknowledge: true }), { error: 'UNAVAILABLE' });
    f.setSnapshot(null);
    assert.deepEqual(await f.service.read(f.context, { childAccountId: childId }), { warning: null });
});
