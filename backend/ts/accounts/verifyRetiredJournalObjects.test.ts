import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import type { PoolConnection } from 'mysql2/promise';
import { signJournalRetirementClaim } from './journalRetirementStamp';
import { verifyRetiredJournalObjects } from './verifyRetiredJournalObjects';
import { createGcsRetentionJournal, type ObservedRestoreGuard } from './gcsRetentionJournal';
import { createGcsDeletionJournal, DELETION_JOURNAL_BUCKET, type JournalHttpClient } from './gcsDeletionJournal';
import { createGuardedDeletionReplayReader } from './guardedDeletionReplayReader';
import { createGuardedDeletionAuditReader } from './guardedDeletionAuditReader';

const source = '42a23d28-40cf-4d69-9fdb-74206ef3fa70';
const target = '42a23d28-40cf-4d69-9fdb-74206ef3fa71';
const lineage = '42a23d28-40cf-4d69-9fdb-74206ef3fa72';
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const guard: ObservedRestoreGuard = { state: 'hold', database: 'synthetic', serverUuid: source,
    epoch: lineage, expiresAt: '2027-01-01T00:00:00.000Z', generation: '12',
    recoveryCheckpoint: { lineage, minimumEpoch: '3', keySha256: createHash('sha256')
        .update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex') } };
const pins = { database: 'synthetic', currentUser: 'operator@localhost', targetServerUuid: target, originalServerUuid: source };
const claim = { version: 1, bucket: 'synthetic-bucket', name: 'v1/intents/one.json', generation: '123',
    contentSha256: 'a'.repeat(64), effectConfirmedAt: '2026-01-01T00:00:00.000000Z',
    recoveryFloor: '2026-01-02T00:00:00.000000Z', checkpointLineage: lineage, checkpointEpoch: '3',
    signedAt: '2026-01-03T00:00:00.000000Z' } as const;
const object = { bucket: claim.bucket, name: claim.name, generation: claim.generation,
    stamp: signJournalRetirementClaim(claim, privateKey) };

function fixture(options: { checkpoint?: string | null; before?: ObservedRestoreGuard; after?: ObservedRestoreGuard } = {}) {
    let reads = 0;
    const journal = { async readRestoreGuard() { return ++reads === 1 ? (options.before ?? guard) : (options.after ?? options.before ?? guard); } };
    const connection = { async query(query: { sql: string }) {
        const identity = { databaseName: 'synthetic', currentUser: 'operator@localhost', serverUuid: target };
        return [query.sql.includes('account_recovery_checkpoint')
            ? (options.checkpoint === null ? [] : [{ ...identity, lineageId: lineage, checkpointEpoch: options.checkpoint ?? '3' }])
            : [{ ...identity, nowUtc: '2026-01-04T00:00:00.000000Z' }], []];
    } } as unknown as PoolConnection;
    return { connection, journal };
}

test('accepts only a signed generation already covered by the guard and restored SQL', async () => {
    const { connection, journal } = fixture();
    await verifyRetiredJournalObjects(connection, journal, pins, [object], publicKey);
});

test('rejects old SQL, missing SQL, changed guard, duplicate, unsigned or tampered generations', async () => {
    for (const options of [{ checkpoint: '2' }, { checkpoint: null }, { after: { ...guard, generation: '13' } },
        { before: { ...guard, recoveryCheckpoint: undefined } },
        { before: { ...guard, recoveryCheckpoint: { ...guard.recoveryCheckpoint!, keySha256: 'a'.repeat(64) } } }]) {
        const { connection, journal } = fixture(options);
        await assert.rejects(verifyRetiredJournalObjects(connection, journal, pins, [object], publicKey));
    }
    for (const objects of [[object, object], [{ ...object, generation: '124' }], [{ ...object, stamp: null }],
        [{ ...object, stamp: signJournalRetirementClaim({ ...claim, checkpointEpoch: '4' }, privateKey) }]]) {
        const { connection, journal } = fixture({ checkpoint: '4' });
        await assert.rejects(verifyRetiredJournalObjects(connection, journal, pins, objects, publicKey));
    }
});

test('explicit journal recovery accepts an authorized soft deletion and holds older restored SQL even after expiry', async () => {
    const name = 'v1/intents/42272598-9d28-457d-a63d-e3e3cd0d2a00.json';
    const stamp = signJournalRetirementClaim({ ...claim, bucket: DELETION_JOURNAL_BUCKET, name }, privateKey);
    const retired = { bucket: DELETION_JOURNAL_BUCKET, name, generation: claim.generation,
        softDeleteTime: '2026-01-03T01:00:00.000Z', metadata: { ludolumeRetirement: JSON.stringify(stamp) } };
    function client(items: unknown[]): JournalHttpClient {
        return { async request(request) { return { status: 200,
            data: { kind: 'storage#objects', items: request.params.softDeleted ? items : [] } }; } };
    }
    const good = fixture();
    const reader = createGcsDeletionJournal({ client: client([retired]),
        verifyRetiredObjects: objects => verifyRetiredJournalObjects(good.connection, good.journal, pins, objects, publicKey) });
    assert.deepEqual((await reader.readDeletionIntents()).intents, []);
    const old = fixture({ checkpoint: '2' });
    const expired = createGcsDeletionJournal({ client: client([]),
        verifyRetiredObjects: objects => verifyRetiredJournalObjects(old.connection, old.journal, pins, objects, publicKey) });
    await assert.rejects(expired.readDeletionIntents());
    const unexpected = createGcsDeletionJournal({ client: client([{ ...retired, metadata: {} }]),
        verifyRetiredObjects: objects => verifyRetiredJournalObjects(good.connection, good.journal, pins, objects, publicKey) });
    await assert.rejects(unexpected.readDeletionIntents());
});

test('conditional journal administrative recovery verifies signed retirements while ordinary reads stay strict', async () => {
    const bucket = 'synthetic-conditional-bucket';
    const name = `v1/conditional/${'a'.repeat(64)}/${'b'.repeat(64)}.json`;
    const stamp = signJournalRetirementClaim({ ...claim, bucket, name }, privateKey);
    const retired = { bucket, name, generation: claim.generation,
        softDeleteTime: '2026-01-03T01:00:00.000Z', metadata: { ludolumeRetirement: JSON.stringify(stamp) } };
    const client: JournalHttpClient = { async request(request) { return { status: 200,
        data: { kind: 'storage#objects', items: request.params.softDeleted ? [retired] : [] } }; } };
    const good = fixture();
    const reader = createGcsRetentionJournal({ bucket, expectedBucket: bucket, key: Buffer.alloc(32, 1), client,
        verifyActivityContinuity: async () => false,
        verifyRetiredObjects: objects => verifyRetiredJournalObjects(good.connection, good.journal, pins, objects, publicKey) });
    assert.deepEqual(await reader.readIntents(), []);
    await assert.rejects(reader.readIntentsForChild(target));
    const old = fixture({ checkpoint: '2' });
    const stale = createGcsRetentionJournal({ bucket, expectedBucket: bucket, key: Buffer.alloc(32, 1), client,
        verifyActivityContinuity: async () => false,
        verifyRetiredObjects: objects => verifyRetiredJournalObjects(old.connection, old.journal, pins, objects, publicKey) });
    await assert.rejects(stale.readIntents());
});

test('the guarded replay reader checks SQL even when all retirement markers have expired', async () => {
    const client: JournalHttpClient = { async request() { return { status: 200, data: { kind: 'storage#objects', items: [] } }; } };
    for (const checkpoint of ['3', '2'] as const) {
        const current = fixture({ checkpoint });
        const connection = Object.assign(current.connection, { release() {} });
        const reader = await createGuardedDeletionReplayReader({ database: { async getConnection() { return connection; } },
            guard: current.journal, pins, publicKey, client, readTimeoutMs: 60_000 });
        if (checkpoint === '3') assert.deepEqual((await reader.readDeletionIntents()).intents, []);
        else await assert.rejects(reader.readDeletionIntents());
    }
    const current = fixture();
    const connection = Object.assign(current.connection, { release() {} });
    await assert.rejects(createGuardedDeletionReplayReader({ database: { async getConnection() { return connection; } },
        guard: current.journal, pins, client, readTimeoutMs: 60_000 }));
});

test('a replay plan binds its held guard and rejects a guard changed during reading', async () => {
    const client: JournalHttpClient = { async request() { return { status: 200, data: { kind: 'storage#objects', items: [] } }; } };
    async function open(before: ObservedRestoreGuard, after?: ObservedRestoreGuard) {
        const current = fixture({ before, after });
        const connection = Object.assign(current.connection, { release() {} });
        return createGuardedDeletionReplayReader({ database: { async getConnection() { return connection; } },
            guard: current.journal, pins, publicKey, client, readTimeoutMs: 60_000 });
    }
    const first = await open(guard);
    const next = await open({ ...guard, generation: '13' });
    assert.notEqual((await first.readDeletionIntents()).digest, (await next.readDeletionIntents()).digest);
    const changed = await open(guard, { ...guard, generation: '13' });
    await assert.rejects(changed.readDeletionIntents());
});

test('an audit may use an active guard only on its pinned primary and cannot accept an older checkpoint', async () => {
    const active = { ...guard, state: 'active' as const, serverUuid: target };
    const auditPins = { ...pins, originalServerUuid: target };
    const good = fixture({ before: active });
    await verifyRetiredJournalObjects(good.connection, good.journal, auditPins, [object], publicKey, 'audit');
    await assert.rejects(verifyRetiredJournalObjects(good.connection, good.journal, auditPins, [object], publicKey));
    const old = fixture({ before: active, checkpoint: '2' });
    await assert.rejects(verifyRetiredJournalObjects(old.connection, old.journal, auditPins, [], publicKey, 'audit'));
    await assert.rejects(verifyRetiredJournalObjects(good.connection, good.journal, pins, [], publicKey, 'audit'));
});

test('the audit reader checks its guard and SQL even after retirement markers expire', async () => {
    const client: JournalHttpClient = { async request() { return { status: 200, data: { kind: 'storage#objects', items: [] } }; } };
    const active = { ...guard, state: 'active' as const, serverUuid: target };
    const auditPins = { database: pins.database, currentUser: pins.currentUser, serverUuid: target };
    for (const checkpoint of ['3', '2'] as const) {
        const current = fixture({ before: active, checkpoint });
        const reader = createGuardedDeletionAuditReader({ guard: current.journal, pins: auditPins,
            publicKey, client, readTimeoutMs: 60_000 });
        if (checkpoint === '3') assert.deepEqual((await reader.readDeletionIntents(current.connection)).intents, []);
        else await assert.rejects(reader.readDeletionIntents(current.connection));
    }
});
