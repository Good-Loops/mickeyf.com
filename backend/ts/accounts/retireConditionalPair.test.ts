import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import type { PoolConnection } from 'mysql2/promise';
import { retireConditionalPair, resumeConditionalResolution } from './retireConditionalPair';
import { signRetirementBatch } from './retirementBatchPermit';
import { verifyRetiredJournalObjects } from './verifyRetiredJournalObjects';
import type { ConditionalRetirementPair } from './gcsRetentionJournal';
import type { JournalHttpClient } from './gcsDeletionJournal';
import type { CloudSqlMetadataClient } from './cloudSqlRecoveryInventory';

const bucket = 'synthetic-conditional-bucket', accountId = '42a23d28-40cf-4d69-9fdb-74206ef3fa70';
const serverUuid = '42a23d28-40cf-4d69-9fdb-74206ef3fa71', lineage = '42a23d28-40cf-4d69-9fdb-74206ef3fa72';
const pins = { database: 'synthetic', currentUser: 'operator@localhost', serverUuid };
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const fingerprint = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
const bodies = ['{"intent":"synthetic"}', '{"resolution":"synthetic"}'];
const tag = 'a'.repeat(64), id = 'b'.repeat(64);
const pair: ConditionalRetirementPair = { intent: { parentId: accountId, childId: serverUuid, warningId: lineage,
    activityAt: '2023-01-01T00:00:00.000000Z', deliveredAt: '2026-10-01T00:00:00.000000Z', channel: 'in-app',
    targetDigest: 'c'.repeat(64), noticeDigest: 'd'.repeat(64), receiptDigest: 'e'.repeat(64) },
    resolution: { outcome: 'deleted', confirmedAt: '2026-10-02T00:00:00.000000Z', observedActivityAt: null, proofDigest: 'f'.repeat(64) },
    intentObject: { name: `v1/conditional/${tag}/${id}.json`, generation: '123', contentSha256: createHash('sha256').update(bodies[0]).digest('hex') },
    resolutionObject: { name: `v1/resolutions/${tag}/${id}.json`, generation: '124', contentSha256: createHash('sha256').update(bodies[1]).digest('hex') } };

function sql() {
    let now = '2026-10-15T00:00:00.000000Z';
    const connection = { async beginTransaction() {}, async rollback() {}, destroy() {}, async query(query: { sql: string }) {
        const s = query.sql;
        if (s.includes('USER_PRIVILEGES')) return [[{ count: 1 }], []];
        if (s.includes('PROCESSLIST')) return [[{ count: 0 }], []];
        if (s.includes('information_schema.TABLES')) return [[{ count: 0 }], []];
        if (s.includes('schema_migrations')) return [[], []];
        if (s.includes('FROM account_recovery_checkpoint')) return [[{ databaseName: pins.database, currentUser: pins.currentUser,
            serverUuid, lineageId: lineage, checkpointEpoch: '1' }], []];
        if (s.startsWith('SELECT DATABASE()')) return [[{ databaseName: pins.database, currentUser: pins.currentUser, serverUuid, nowUtc: now }], []];
        return [[], []];
    } } as unknown as PoolConnection;
    return { connection, setNow(value: string) { now = value; } };
}
function storage() {
    const records = new Map([pair.intentObject, pair.resolutionObject].map((entry, index) => [entry.name,
        { entry, body: bodies[index], meta: '1', custom: {} as Record<string, string>, soft: false }]));
    let loseName = '', deletes: string[] = [], disablePolicyAfterIntent = false;
    const client: JournalHttpClient = { async request(request) {
        if (request.url.endsWith(`/b/${bucket}`)) return { status: 200, data: { name: bucket, versioning: { enabled: true },
            softDeletePolicy: { retentionDurationSeconds: disablePolicyAfterIntent && deletes.includes(pair.intentObject.name) ? '0' : '604800' } } };
        const name = decodeURIComponent(request.url.split('/').at(-1)!); const row = records.get(name);
        if (!row) return { status: 404, data: {} };
        const item = () => ({ bucket, name, generation: row.entry.generation, metageneration: row.meta,
            size: String(Buffer.byteLength(row.body)), md5Hash: createHash('md5').update(row.body).digest('base64'),
            metadata: row.custom, ...(row.soft ? { softDeleteTime: '2026-11-05T00:00:00.000Z' } : {}) });
        if (request.method === 'PATCH') {
            assert.equal(request.params.ifGenerationMatch, row.entry.generation); assert.equal(request.params.ifMetagenerationMatch, row.meta);
            row.custom = JSON.parse(request.data!).metadata; row.meta = String(Number(row.meta) + 1); return { status: 200, data: item() };
        }
        if (request.method === 'DELETE') {
            assert.equal(request.params.ifGenerationMatch, row.entry.generation); assert.equal(request.params.ifMetagenerationMatch, row.meta);
            row.soft = true; deletes.push(name); if (loseName === name) throw new Error('lost acknowledgement');
            return { status: 204, data: undefined };
        }
        if (request.params.softDeleted) return { status: row.soft ? 200 : 404, data: row.soft ? item() : {} };
        if (row.soft) return { status: 404, data: {} };
        return { status: 200, data: request.params.alt === 'media' ? row.body : item() };
    } };
    return { client, lose(name: string) { loseName = name; }, disablePolicyAfterIntent() { disablePolicyAfterIntent = true; },
        restorePolicy() { disablePolicyAfterIntent = false; }, get deletes() { return [...deletes]; },
        metadata(name: string) { return records.get(name)!.custom; } };
}
const cloud: CloudSqlMetadataClient = { async listBackups() { return { kind: 'sql#backupRunsList', items: [{
    kind: 'sql#backupRun', id: '1', status: 'SUCCESSFUL', enqueuedTime: '2026-11-04T12:00:00Z',
    startTime: '2026-11-04T12:00:00Z', instance: 'cms-mickeyf' }] }; },
async getRecoveryWindow() { return { kind: 'sql#getLatestRecoveryTime', earliestRecoveryTime: '2026-11-04T12:00:00Z',
    latestRecoveryTime: '2026-11-05T00:00:00Z' }; } };
async function fixture() {
    const db = sql(), io = storage();
    db.setNow('2026-11-05T00:00:00.000000Z');
    const guard = { async readRestoreGuard() { return { state: 'hold' as const, database: pins.database, serverUuid, epoch: accountId,
        expiresAt: '2027-01-01T00:00:00.000Z', generation: '77', recoveryCheckpoint: { lineage, minimumEpoch: '1', keySha256: fingerprint } }; } };
    const permit = signRetirementBatch({ version: 1, bucket, database: pins.database, serverUuid, guardGeneration: '77',
        lineage, epoch: '1', committedBefore: '2026-11-04T00:00:00.000000Z', entries: [pair.intentObject, pair.resolutionObject] }, privateKey);
    const options = { connection: db.connection, pins, bucket, pair, permit, publicKey, privateKey,
        project: 'noted-reef-387021', instance: 'cms-mickeyf', guard,
        journal: { async readConditionalRetirementPairs() { return { pairs: [pair], digest: 'b'.repeat(64) }; } },
        cloud, client: io.client, verifySchema: async () => {},
        retireWitnesses: async () => {}, verifyWitnessesAbsent: async () => {},
        confirmation: 'ORIGINAL PRIMARY AND ALL WRITERS FENCED', externalCopiesConfirmation: 'ALL PERMITTED RECOVERY COPIES ACCOUNTED FOR' };
    return { db, io, guard, options };
}

test('retires conditional intent before its outcome and keeps the intent verifiable during soft delete', async () => {
    const f = await fixture();
    assert.deepEqual(await retireConditionalPair(f.options), { status: 'retired' });
    assert.deepEqual(f.io.deletes, [pair.intentObject.name, pair.resolutionObject.name]);
    await verifyRetiredJournalObjects(f.db.connection, f.guard, { database: pins.database, currentUser: pins.currentUser,
        targetServerUuid: serverUuid, originalServerUuid: serverUuid }, [{ bucket, name: pair.intentObject.name,
        generation: pair.intentObject.generation, stamp: JSON.parse(f.io.metadata(pair.intentObject.name).ludolumeRetirement) }], publicKey);
});

test('keeps both conditional objects if account-linked witnesses remain', async () => {
    const f = await fixture();
    await assert.rejects(retireConditionalPair({ ...f.options, verifyWitnessesAbsent: async id => {
        assert.equal(id, pair.intent.childId); throw new Error('witness remains');
    } }));
    assert.deepEqual(f.io.deletes, []);
});

test('a lost intent delete acknowledgment leaves its outcome intact and permits safe resumption', async () => {
    const f = await fixture(); f.io.lose(pair.intentObject.name);
    await assert.rejects(retireConditionalPair(f.options));
    assert.deepEqual(f.io.deletes, [pair.intentObject.name]);
    assert.deepEqual(await resumeConditionalResolution({ ...f.options, intentObject: pair.intentObject, resolutionObject: pair.resolutionObject }), { status: 'retired' });
    assert.deepEqual(f.io.deletes, [pair.intentObject.name, pair.resolutionObject.name]);
});

test('holds the outcome if soft-delete protection changes after the intent', async () => {
    const f = await fixture(); f.io.disablePolicyAfterIntent();
    await assert.rejects(retireConditionalPair(f.options));
    assert.deepEqual(f.io.deletes, [pair.intentObject.name]);
    f.io.restorePolicy();
    assert.deepEqual(await resumeConditionalResolution({ ...f.options, intentObject: pair.intentObject,
        resolutionObject: pair.resolutionObject }), { status: 'retired' });
});

test('a lost outcome delete acknowledgment can be reconciled without a second delete', async () => {
    const f = await fixture(); f.io.lose(pair.resolutionObject.name);
    await assert.rejects(retireConditionalPair(f.options));
    assert.deepEqual(await resumeConditionalResolution({ ...f.options, intentObject: pair.intentObject, resolutionObject: pair.resolutionObject }), { status: 'already-retired' });
    assert.deepEqual(f.io.deletes, [pair.intentObject.name, pair.resolutionObject.name]);
});
