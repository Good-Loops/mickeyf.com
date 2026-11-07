import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import type { PoolConnection } from 'mysql2/promise';
import { inspectExplicitRetirement, retireExplicitDeletionEntry } from './retireExplicitDeletionEntry';
import { signRetirementBatch } from './retirementBatchPermit';
import { verifyRetiredJournalObjects } from './verifyRetiredJournalObjects';
import { retireAccountWitnesses } from './retireAccountWitnesses';
import { DELETION_JOURNAL_BUCKET, type DeletionJournalEntry, type JournalHttpClient } from './gcsDeletionJournal';
import type { CloudSqlMetadataClient } from './cloudSqlRecoveryInventory';

const accountId = '42a23d28-40cf-4d69-9fdb-74206ef3fa70', serverUuid = '42a23d28-40cf-4d69-9fdb-74206ef3fa71';
const lineage = '42a23d28-40cf-4d69-9fdb-74206ef3fa72';
const pins = { database: 'synthetic', currentUser: 'operator@localhost', serverUuid };
const intent = { version: 1 as const, action: 'delete-account' as const, accountId, requestedAt: '2026-10-01T00:00:00.000Z' };
const body = JSON.stringify(intent);
const entry: DeletionJournalEntry = { name: 'v1/intents/42272598-9d28-457d-a63d-e3e3cd0d2a00.json', generation: '123',
    contentSha256: createHash('sha256').update(body).digest('hex'), intent };
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const fingerprint = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');

function sql() {
    let now = '2026-10-15T00:00:00.000000Z', writers = false, epoch = '1';
    const connection = { async beginTransaction() {}, async rollback() {}, destroy() {}, async query(query: { sql: string }) {
        const s = query.sql;
        if (s.includes('USER_PRIVILEGES')) return [[{ count: 1 }], []];
        if (s.includes('PROCESSLIST')) return [[{ count: writers ? 1 : 0 }], []];
        if (s.includes('information_schema.TABLES')) return [[{ count: 0 }], []];
        if (s.includes('schema_migrations')) return [[], []];
        if (s.includes('FROM account_recovery_checkpoint')) return [[{ databaseName: pins.database, currentUser: pins.currentUser,
                serverUuid, lineageId: lineage, checkpointEpoch: epoch }], []];
        if (s.startsWith('SELECT DATABASE()')) return [[{ databaseName: pins.database, currentUser: pins.currentUser, serverUuid, nowUtc: now }], []];
        return [[], []];
    } } as unknown as PoolConnection;
    return { connection, setNow(value: string) { now = value; }, setWriters(value: boolean) { writers = value; }, setEpoch(value: string) { epoch = value; } };
}
function storage() {
    let soft = false, generation = '1', custom: Record<string, string> = {}, patches = 0, deletes = 0, failPatch = false, failDelete = false;
    const item = () => ({ bucket: DELETION_JOURNAL_BUCKET, name: entry.name, generation: entry.generation,
        metageneration: generation, size: String(Buffer.byteLength(body)), md5Hash: createHash('md5').update(body).digest('base64'),
        metadata: custom, ...(soft ? { softDeleteTime: '2026-11-05T00:00:00.000Z' } : {}) });
    const client: JournalHttpClient = { async request(request) {
        if (request.url.endsWith(`/b/${DELETION_JOURNAL_BUCKET}`)) return { status: 200, data: { name: DELETION_JOURNAL_BUCKET,
            versioning: { enabled: true }, softDeletePolicy: { retentionDurationSeconds: '604800' } } };
        if (request.method === 'PATCH') {
            patches++;
            assert.equal(request.params.ifGenerationMatch, entry.generation); assert.equal(request.params.ifMetagenerationMatch, generation);
            custom = JSON.parse(request.data!).metadata; generation = String(Number(generation) + 1);
            if (failPatch) throw new Error('lost acknowledgement');
            return { status: 200, data: item() };
        }
        if (request.method === 'DELETE') {
            deletes++;
            assert.equal(request.params.ifGenerationMatch, entry.generation); assert.equal(request.params.ifMetagenerationMatch, generation);
            soft = true;
            if (failDelete) throw new Error('lost acknowledgement');
            return { status: 204, data: undefined };
        }
        if (request.params.softDeleted) return { status: soft ? 200 : 404, data: soft ? item() : {} };
        if (soft) return { status: 404, data: {} };
        return { status: 200, data: request.params.alt === 'media' ? body : item() };
    } };
    return { client, get soft() { return soft; }, get patches() { return patches; }, get deletes() { return deletes; },
        get metadata() { return custom; }, losePatch() { failPatch = true; }, restorePatchAck() { failPatch = false; }, loseDelete() { failDelete = true; } };
}
const cloud: CloudSqlMetadataClient = {
    async listBackups() { return { kind: 'sql#backupRunsList', items: [{ kind: 'sql#backupRun', id: '1', status: 'SUCCESSFUL',
        enqueuedTime: '2026-11-04T12:00:00Z', startTime: '2026-11-04T12:00:00Z', instance: 'cms-mickeyf' }] }; },
    async getRecoveryWindow() { return { kind: 'sql#getLatestRecoveryTime', earliestRecoveryTime: '2026-11-04T12:00:00Z',
        latestRecoveryTime: '2026-11-05T00:00:00Z' }; },
};
async function fixture() {
    const db = sql(), io = storage();
    db.setNow('2026-11-05T00:00:00.000000Z');
    const guardValue = { state: 'hold' as const, database: pins.database, serverUuid, epoch: accountId,
        expiresAt: '2027-01-01T00:00:00.000Z', generation: '77',
        recoveryCheckpoint: { lineage, minimumEpoch: '1', keySha256: fingerprint } };
    const guard = { async readRestoreGuard() { return guardValue; } };
    const permit = signRetirementBatch({ version: 1, bucket: DELETION_JOURNAL_BUCKET, database: pins.database, serverUuid,
        guardGeneration: '77', lineage, epoch: '1', committedBefore: '2026-11-04T00:00:00.000000Z',
        entries: [{ name: entry.name, generation: entry.generation, contentSha256: entry.contentSha256 }] }, privateKey);
    const options = { connection: db.connection, pins, entry, permit, publicKey, privateKey,
        project: 'noted-reef-387021', instance: 'cms-mickeyf', guard,
        journal: { async readDeletionEntries() { return { entries: [entry], digest: 'b'.repeat(64) }; } },
        cloud, client: io.client, verifySchema: async () => {},
        retireWitnesses: async () => {}, verifyWitnessesAbsent: async () => {},
        confirmation: 'ORIGINAL PRIMARY AND ALL WRITERS FENCED', externalCopiesConfirmation: 'ALL PERMITTED RECOVERY COPIES ACCOUNTED FOR' };
    return { db, io, guard, options };
}

test('keeps the journal if account-linked witnesses remain', async () => {
    const f = await fixture();
    await assert.rejects(retireExplicitDeletionEntry({ ...f.options, verifyWitnessesAbsent: async id => {
        assert.equal(id, accountId); throw new Error('witness remains');
    } }));
    assert.equal(f.io.patches, 0); assert.equal(f.io.deletes, 0);
});

test('cleans both witness streams under the held fence before retiring the journal', async () => {
    const f = await fixture(), keys = [Buffer.alloc(32, 5), Buffer.alloc(32, 6)];
    const groups = new Map([[5, [{ name: 'activity', generation: '1', metageneration: '1', contentSha256: 'a'.repeat(64) }]],
        [6, [{ name: 'warning', generation: '2', metageneration: '1', contentSha256: 'b'.repeat(64) }]]]);
    const store = { async list(id: string, key: Buffer) { assert.equal(id, accountId); return [...(groups.get(key[0]) ?? [])]; },
        async remove(item: { name: string }) { assert.equal(f.io.patches, 0); assert.equal(f.io.deletes, 0);
            for (const [key, entries] of groups) groups.set(key, entries.filter(entry => entry.name !== item.name)); },
        async assertEmpty(_id: string, key: Buffer) { assert.equal(groups.get(key[0])?.length, 0); } };
    await retireExplicitDeletionEntry({ ...f.options,
        async retireWitnesses(id, verifyFence) { await retireAccountWitnesses({ accountId: id, activityKey: keys[0], warningKey: keys[1], store,
            verifyBeforeDelete: verifyFence }); },
        async verifyWitnessesAbsent(id) { for (const key of keys) await store.assertEmpty(id, key); } });
    assert.equal(f.io.deletes, 1);
});

test('retires only the permitted exact generation and leaves a verifiable soft-delete stamp', async () => {
    const f = await fixture();
    assert.deepEqual(await retireExplicitDeletionEntry(f.options), { status: 'retired', generation: '123' });
    assert.equal(f.io.patches, 1); assert.equal(f.io.deletes, 1); assert.equal(f.io.soft, true);
    await verifyRetiredJournalObjects(f.db.connection, f.guard, { database: pins.database, currentUser: pins.currentUser,
        targetServerUuid: serverUuid, originalServerUuid: serverUuid }, [{ bucket: DELETION_JOURNAL_BUCKET,
        name: entry.name, generation: entry.generation, stamp: JSON.parse(f.io.metadata.ludolumeRetirement) }], publicKey);
});

test('lost patch acknowledgement is reconciled by reading the signed stamp before a later attempt', async () => {
    const f = await fixture(); f.io.losePatch();
    assert.equal(await inspectExplicitRetirement(f.options), 'live-unstamped');
    await assert.rejects(retireExplicitDeletionEntry(f.options));
    assert.equal(f.io.patches, 1); assert.equal(f.io.deletes, 0);
    assert.equal(await inspectExplicitRetirement(f.options), 'live-stamped');
    f.io.restorePatchAck();
    assert.equal((await retireExplicitDeletionEntry(f.options)).status, 'retired');
    assert.equal(f.io.patches, 1); assert.equal(f.io.deletes, 1);
});

test('lost delete acknowledgement is unconfirmed and never retried automatically', async () => {
    const f = await fixture(); f.io.loseDelete();
    await assert.rejects(retireExplicitDeletionEntry(f.options));
    assert.equal(f.io.soft, true); assert.equal(f.io.deletes, 1);
    assert.equal(await inspectExplicitRetirement(f.options), 'retired');
    assert.equal(f.io.deletes, 1);
});

test('active writers or missing copy attestation block changes', async () => {
    const f = await fixture(); f.db.setWriters(true);
    await assert.rejects(retireExplicitDeletionEntry(f.options));
    assert.equal(f.io.patches, 0); assert.equal(f.io.deletes, 0);
    const missing = await fixture();
    await assert.rejects(retireExplicitDeletionEntry({ ...missing.options, externalCopiesConfirmation: '' }));
    assert.equal(missing.io.patches, 0); assert.equal(missing.io.deletes, 0);
});

test('backups older than the checkpoint block retirement, while later guard generations remain usable', async () => {
    const f = await fixture();
    const oldCloud: CloudSqlMetadataClient = { ...cloud, async listBackups() { return { kind: 'sql#backupRunsList', items: [{
        kind: 'sql#backupRun', id: '1', status: 'SUCCESSFUL', enqueuedTime: '2026-11-01T00:00:00Z',
        startTime: '2026-11-01T00:00:00Z', instance: 'cms-mickeyf' }] }; } };
    await assert.rejects(retireExplicitDeletionEntry({ ...f.options, cloud: oldCloud }));
    assert.equal(f.io.patches, 0); assert.equal(f.io.deletes, 0);
    const later = await fixture(), guard = await later.guard.readRestoreGuard();
    guard.generation = '78'; guard.recoveryCheckpoint.minimumEpoch = '2';
    await assert.rejects(retireExplicitDeletionEntry(later.options)); // SQL has not reached the newer floor.
    later.db.setEpoch('2');
    assert.equal((await retireExplicitDeletionEntry(later.options)).status, 'retired');
});
