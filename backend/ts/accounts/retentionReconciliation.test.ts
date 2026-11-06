import assert from 'node:assert/strict';
import test from 'node:test';
import { assertNoRetentionRuntimeWriters, isProductionRecoveryOperator, reconcileDeletedRetentionIntent, reconcileKeptRetentionIntent, reconcileRestoredDeletedIntent } from './retentionReconciliation';
import type { InactivitySnapshot } from './childInactivityPolicy';
import type { InactivityStore, LockedInactivityTarget, RetentionIntent } from './childInactivityWorkflow';
import type { RetentionResolution } from './gcsRetentionJournal';
import type { PoolConnection } from 'mysql2/promise';

const parentId = '11111111-1111-4111-8111-111111111111';
const childId = '22222222-2222-4222-8222-222222222222';
const intent: RetentionIntent = { parentId, childId, warningId: '33333333-3333-4333-8333-333333333333',
    activityAt: '2020-01-01T00:00:00.000000Z', deliveredAt: '2023-01-01T00:00:00.000000Z',
    targetDigest: 'a'.repeat(64), channel: 'in-app', noticeDigest: 'b'.repeat(64), receiptDigest: 'c'.repeat(64) };
const proof = { accountId: parentId, sessionId: 'A'.repeat(43) };
const key = Buffer.alloc(32, 4);

test('writer inspection accepts only effective global PROCESS privileges', async () => {
    const connection = (grant: string) => ({ async query(query: { sql: string }) {
        if (query.sql.includes('USER_PRIVILEGES')) return [[{ count: 0 }], []];
        if (query.sql === 'SHOW GRANTS') return [[{ grant }], []];
        if (query.sql.includes('PROCESSLIST')) return [[{ count: 0 }], []];
        throw new Error('Unexpected query');
    } }) as unknown as PoolConnection;
    for (const grant of ['GRANT SELECT, PROCESS ON *.* TO `operator`@`%`',
        'GRANT ALL PRIVILEGES ON *.* TO `operator`@`%`']) {
        await assertNoRetentionRuntimeWriters(connection(grant));
    }
    for (const grant of ['GRANT `PROCESS`@`%` TO `operator`@`%`',
        'GRANT PROCESS ON `cms`.* TO `operator`@`%`', 'GRANT SELECT ON *.* TO `operator`@`%`']) {
        await assert.rejects(assertNoRetentionRuntimeWriters(connection(grant)), /cannot verify/u);
    }
});

test('production recovery checks root sessions while generic isolated rehearsals do not', async () => {
    const seen: number[] = [];
    const connection = { async query(query: { sql: string }, values?: number[]) {
        if (query.sql.includes('USER_PRIVILEGES')) return [[{ count: 1 }], []];
        if (query.sql.includes('PROCESSLIST')) { seen.push(values?.[0] ?? -1); return [[{ count: 0 }], []]; }
        throw new Error('Unexpected query');
    } } as unknown as PoolConnection;
    const production = { currentUser: 'ludolume_release_ops@cloudsqlproxy~%' };
    assert.equal(isProductionRecoveryOperator(production), true);
    assert.equal(isProductionRecoveryOperator({ currentUser: 'root@%' }), false);
    await assertNoRetentionRuntimeWriters(connection, isProductionRecoveryOperator(production));
    await assertNoRetentionRuntimeWriters(connection);
    assert.deepEqual(seen, [1, 0]);
});

function fixture({ active = true, exists = true, newActivity = '2024-01-01T00:00:00.000000Z' } = {}) {
    let resolution: RetentionResolution | undefined;
    const snapshot: InactivitySnapshot = { parentId, childId, activityAt: newActivity, activityComplete: false,
        currentTargetDigest: null, targetVerified: false, channel: 'in-app', warning: null };
    const target = { async parentSessionValid() { return active; }, async snapshot() { return snapshot; },
        async databaseTimestamp() { return '2024-01-02T00:00:00.000000Z'; } } as unknown as LockedInactivityTarget;
    const store: InactivityStore = { async withLockedChild(parent, child, run) {
        assert.equal(parent, parentId); assert.equal(child, childId); return run(target);
    } };
    const journal = { async verifyRetentionIntent() { return exists; }, async readResolution() { return resolution ?? null; },
        async recordResolution(_intent: RetentionIntent, value: RetentionResolution) { resolution = value; } };
    return { store, journal, get resolution() { return resolution; } };
}

test('a live parent can reconcile an exact intent after later recorded use', async () => {
    const f = fixture();
    assert.equal(await reconcileKeptRetentionIntent(f.store, f.journal, intent, proof, key), true);
    assert.equal(f.resolution?.outcome, 'kept');
    assert.equal(f.resolution?.observedActivityAt, '2024-01-01T00:00:00.000000Z');
    assert.match(f.resolution?.proofDigest ?? '', /^[a-f0-9]{64}$/);
    assert.equal(await reconcileKeptRetentionIntent(f.store, f.journal, intent, proof, key), true, 'confirmed retry is idempotent');
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

test('a pinned administrator can attest original primary absence only under a stable restore hold', async () => {
    const guard = { state: 'hold' as const, database: 'synthetic', serverUuid: parentId,
        epoch: '44444444-4444-4444-8444-444444444444', generation: '7', expiresAt: '2026-01-01T00:00:00.000Z' };
    const pins = { database: guard.database, serverUuid: guard.serverUuid, currentUser: 'admin@localhost',
        confirmation: 'ORIGINAL PRIMARY DRAINED AND ACCOUNT ABSENT' };
    let exists = false; let guardChanged = false; let writerCount = 0; let reads = 0; let recorded: RetentionResolution | undefined;
    const connection = { destroy() {}, async query(query: { sql: string }) {
        if (query.sql.includes('USER_PRIVILEGES')) return [[{ count: 1 }], []];
        if (query.sql.includes('PROCESSLIST')) return [[{ count: writerCount }], []];
        if (query.sql.includes('CURRENT_USER')) return [[{ db: pins.database, user: pins.currentUser,
            serverUuid: pins.serverUuid, nowUtc: '2024-01-02T00:00:00.000000Z' }], []];
        if (query.sql.includes('SELECT account_uuid')) return [exists ? [{ account_uuid: childId }] : [], []];
        return [[], []];
    } } as unknown as PoolConnection;
    const journal = { async readRestoreGuard() { reads++; return guardChanged && reads > 1 ? { ...guard, generation: '8' } : guard; },
        async verifyRetentionIntent() { return true; }, async readResolution() { return null; },
        async recordResolution(_intent: RetentionIntent, value: RetentionResolution) { recorded = value; } };
    assert.equal(await reconcileDeletedRetentionIntent(connection, journal, intent, { ...pins, confirmation: 'yes' }, key), false);
    exists = true;
    assert.equal(await reconcileDeletedRetentionIntent(connection, journal, intent, pins, key), false);
    assert.equal(recorded, undefined);
    exists = false; writerCount = 1;
    await assert.rejects(reconcileDeletedRetentionIntent(connection, journal, intent, pins, key), /Keep restoration on hold/);
    assert.equal(recorded, undefined); writerCount = 0;
    reads = 0; guardChanged = true;
    await assert.rejects(reconcileDeletedRetentionIntent(connection, journal, intent, pins, key), /Keep restoration on hold/);
    assert.equal(recorded, undefined);
    reads = 0; guardChanged = false;
    assert.equal(await reconcileDeletedRetentionIntent(connection, journal, intent, pins, key), true);
    const result = recorded as RetentionResolution | undefined;
    assert.equal(result?.outcome, 'deleted'); assert.equal(result?.observedActivityAt, null);
});

test('confirmed deletion can be replayed only to a pinned isolated restore without newer activity', async () => {
    const original = '44444444-4444-4444-8444-444444444444';
    const restored = '55555555-5555-4555-8555-555555555555';
    const guard = { state: 'hold' as const, database: 'primary', serverUuid: original,
        epoch: '66666666-6666-4666-8666-666666666666', generation: '2', expiresAt: '2026-01-01T00:00:00.000Z' };
    const pins = { database: 'restored', originalServerUuid: original, serverUuid: restored,
        currentUser: 'admin@localhost', confirmation: 'ISOLATED RESTORE FENCED AND DELETION VERIFIED' };
    let activityAt = intent.activityAt; let deleted = false; let identityMatches = true;
    const snapshot = (): InactivitySnapshot => ({ parentId, childId, activityAt, activityComplete: false,
        currentTargetDigest: null, targetVerified: false, channel: 'in-app', warning: null });
    const target = { async matchesSqlIdentity() { return identityMatches; }, async snapshot() { return snapshot(); },
        async deleteChild(id: string) { assert.equal(id, childId); deleted = true; } } as unknown as LockedInactivityTarget;
    const store: InactivityStore = { async withLockedChild(_parent, _child, run) { return run(target); } };
    const resolution: RetentionResolution = { outcome: 'deleted', confirmedAt: '2024-01-02T00:00:00.000000Z',
        observedActivityAt: null, proofDigest: 'a'.repeat(64) };
    const journal = { async readRestoreGuard() { return guard; }, async verifyRetentionIntent() { return true; },
        async readResolution() { return resolution; }, async recordResolution() {} };
    assert.equal(await reconcileRestoredDeletedIntent(store, journal, intent, { ...pins, serverUuid: original }), false);
    identityMatches = false;
    assert.equal(await reconcileRestoredDeletedIntent(store, journal, intent, pins), false);
    identityMatches = true; activityAt = '2021-01-01T00:00:00.000000Z';
    assert.equal(await reconcileRestoredDeletedIntent(store, journal, intent, pins), false);
    assert.equal(deleted, false);
    activityAt = intent.activityAt;
    assert.equal(await reconcileRestoredDeletedIntent(store, journal, intent, pins), true);
    assert.equal(deleted, true);
});
