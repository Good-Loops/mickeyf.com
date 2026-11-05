import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import type { PoolConnection } from 'mysql2/promise';
import { createGcsRetentionJournal } from './gcsRetentionJournal';
import type { DeletionJournalEntry, JournalHttpClient } from './gcsDeletionJournal';
import type { CloudSqlMetadataClient } from './cloudSqlRecoveryInventory';
import { verifyRetirementBatch } from './retirementBatchPermit';
import * as cloudModule from './cloudSqlRecoveryInventory';
import * as deletionModule from './gcsDeletionJournal';
import * as schemaModule from './retirementSourceSchema';
import { advanceRetirementGuard } from './retirementGuardAdvance';
import type { ConditionalRetirementPair, ObservedRestoreGuard } from './gcsRetentionJournal';

const bucket = 'synthetic-retention-guard', key = Buffer.alloc(32, 8);
const accountId = '42a23d28-40cf-4d69-9fdb-74206ef3fa70';
const serverUuid = '42a23d28-40cf-4d69-9fdb-74206ef3fa71';
const lineage = '42a23d28-40cf-4d69-9fdb-74206ef3fa72';
const pins = { database: 'synthetic', currentUser: 'operator@localhost', serverUuid };
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const entry: DeletionJournalEntry = { name: 'v1/intents/42272598-9d28-457d-a63d-e3e3cd0d2a00.json', generation: '123',
    contentSha256: 'a'.repeat(64), intent: { version: 1, action: 'delete-account', accountId, requestedAt: '2026-10-01T00:00:00.000Z' } };

function sql() {
    let epoch = '0', now = '2026-10-15T00:00:00.000000Z', commits = 0, writers = false, present = false;
    const connection = { async beginTransaction() {}, async commit() { commits++; }, async rollback() {}, destroy() {},
        async query(query: { sql: string }) {
            const s = query.sql;
            if (s.includes('USER_PRIVILEGES')) return [[{ count: 1 }], []];
            if (s.includes('PROCESSLIST')) return [[{ count: writers ? 1 : 0 }], []];
            if (s.includes('FROM users') && present) return [[{}], []];
            if (s.includes('information_schema.TABLES')) return [[{ count: 0 }], []];
            if (s.includes('schema_migrations')) return [[], []];
            if (s.startsWith('UPDATE account_recovery_checkpoint')) { epoch = String(BigInt(epoch) + BigInt(1)); return [{ affectedRows: 1 }, []]; }
            if (s.includes('FROM account_recovery_checkpoint')) return [[{ databaseName: pins.database, currentUser: pins.currentUser,
                serverUuid, lineageId: lineage, checkpointEpoch: epoch }], []];
            if (s.startsWith('SELECT DATABASE()')) return [[{ databaseName: pins.database, currentUser: pins.currentUser,
                serverUuid, nowUtc: now }], []];
            return [[], []];
        } } as unknown as PoolConnection;
    return { connection, setNow(value: string) { now = value; }, setWriters(value: boolean) { writers = value; },
        setPresent(value: boolean) { present = value; }, get commits() { return commits; } };
}
function storage() {
    let body = '', generation = 0, writes = 0;
    const client: JournalHttpClient = { async request(request) {
        const metadata = () => ({ bucket, name: 'v1/control/restore-guard.json', generation: String(generation),
            size: String(Buffer.byteLength(body)), md5Hash: createHash('md5').update(body).digest('base64') });
        if (request.url.endsWith(`/b/${bucket}`)) return { status: 200, data: { name: bucket,
            versioning: { enabled: true }, softDeletePolicy: { retentionDurationSeconds: '604800' } } };
        if (request.method === 'POST') {
            if (String(request.params.ifGenerationMatch) !== String(generation)) return { status: 412, data: {} };
            body = request.data!; generation++; writes++; return { status: 200, data: metadata() };
        }
        if (request.url.endsWith('/o')) return { status: 200, data: { kind: 'storage#objects',
            items: request.params.versions && generation > 0 ? [metadata()] : [] } };
        return { status: 200, data: request.params.alt === 'media' ? body : metadata() };
    } };
    return { client, get writes() { return writes; } };
}
function cloud(latest: string): CloudSqlMetadataClient {
    return { async listBackups() { return { kind: 'sql#backupRunsList', items: [{ kind: 'sql#backupRun', id: '1',
        status: 'SUCCESSFUL', enqueuedTime: '2026-10-28T00:00:00Z', startTime: '2026-10-28T00:00:00Z', instance: 'cms-mickeyf' }] }; },
    async getRecoveryWindow() { return { kind: 'sql#getLatestRecoveryTime', earliestRecoveryTime: '2026-10-29T00:00:00Z',
        latestRecoveryTime: latest }; } };
}
async function fixture(latest = '2026-11-05T00:00:00Z') {
    const db = sql(), io = storage();
    db.setNow('2026-11-05T00:00:00.000000Z');
    const guard = createGcsRetentionJournal({ bucket, expectedBucket: bucket, key, client: io.client, verifyActivityContinuity: async () => false });
    await guard.writeRestoreGuard({ state: 'hold', database: pins.database, serverUuid, epoch: accountId,
        expiresAt: '2027-01-01T00:00:00.000Z' }, '0');
    const journal = { async readDeletionEntries() { return { entries: [entry], digest: 'b'.repeat(64) }; },
        async readDeletionIntents() { return { intents: [entry.intent], digest: 'b'.repeat(64) }; },
        async recordAccountDeletion() { throw new Error('not used'); } };
    const options = { connection: db.connection, pins, lineage, publicKey, privateKey, project: 'noted-reef-387021',
        instance: 'cms-mickeyf', cloud: cloud(latest), selected: [{ name: entry.name, generation: entry.generation, contentSha256: entry.contentSha256 }],
        journal, verifySchema: async () => {},
        confirmation: 'ORIGINAL PRIMARY AND ALL WRITERS FENCED', externalCopiesConfirmation: 'ALL PERMITTED RECOVERY COPIES ACCOUNTED FOR',
        coveragePolls: 1 };
    return { db, io, guard, options };
}

test('advances the held guard only after the exact deletion and post-commit recovery coverage', async t => {
    const f = await fixture();
    t.mock.method(cloudModule, 'createCloudSqlMetadataClient', () => f.options.cloud);
    t.mock.method(deletionModule, 'createGcsDeletionJournal', () => f.options.journal as ReturnType<typeof deletionModule.createGcsDeletionJournal>);
    t.mock.method(schemaModule, 'verifyRetirementSchemas', async () => {});
    const result = await f.guard.advanceRestoreGuardCheckpoint(f.options);
    assert.equal(f.db.commits, 1); assert.equal(f.io.writes, 2); assert.equal(result.epoch, '1');
    assert.equal((await f.guard.readRestoreGuard()).recoveryCheckpoint?.minimumEpoch, '1');
    assert.deepEqual(verifyRetirementBatch(result.permit, publicKey).entries, f.options.selected);
});

test('a lagging PITR window, active writers or an unaccounted copy never advance the guard', async t => {
    const lag = await fixture('2026-11-04T00:00:00Z');
    const cloud = t.mock.method(cloudModule, 'createCloudSqlMetadataClient', () => lag.options.cloud);
    const journal = t.mock.method(deletionModule, 'createGcsDeletionJournal', () => lag.options.journal as ReturnType<typeof deletionModule.createGcsDeletionJournal>);
    t.mock.method(schemaModule, 'verifyRetirementSchemas', async () => {});
    await assert.rejects(lag.guard.advanceRestoreGuardCheckpoint(lag.options));
    assert.equal(lag.db.commits, 1); assert.equal(lag.io.writes, 1);
    const busy = await fixture(); busy.db.setWriters(true);
    cloud.mock.mockImplementation(() => busy.options.cloud);
    journal.mock.mockImplementation(() => busy.options.journal as ReturnType<typeof deletionModule.createGcsDeletionJournal>);
    await assert.rejects(busy.guard.advanceRestoreGuardCheckpoint(busy.options));
    assert.equal(busy.db.commits, 0); assert.equal(busy.io.writes, 1);
    const copies = await fixture();
    await assert.rejects(copies.guard.advanceRestoreGuardCheckpoint({ ...copies.options, externalCopiesConfirmation: '' }));
    assert.equal(copies.db.commits, 0); assert.equal(copies.io.writes, 1);
    const existing = await fixture(); existing.db.setPresent(true);
    cloud.mock.mockImplementation(() => existing.options.cloud);
    journal.mock.mockImplementation(() => existing.options.journal as ReturnType<typeof deletionModule.createGcsDeletionJournal>);
    await assert.rejects(existing.guard.advanceRestoreGuardCheckpoint(existing.options));
    assert.equal(existing.db.commits, 0); assert.equal(existing.io.writes, 1);
});

test('guard may advance with older backups when newer checkpoint recovery remains available', async t => {
    const f = await fixture(); let scans = 0;
    const changingCloud: CloudSqlMetadataClient = { ...f.options.cloud, async listBackups() {
        const time = ++scans <= 2 ? '2026-10-28T00:00:00Z' : '2026-10-01T00:00:00Z';
        return { kind: 'sql#backupRunsList', items: [{ kind: 'sql#backupRun', id: '1', status: 'SUCCESSFUL',
            enqueuedTime: time, startTime: time, instance: 'cms-mickeyf' }] };
    } };
    t.mock.method(cloudModule, 'createCloudSqlMetadataClient', () => changingCloud);
    t.mock.method(deletionModule, 'createGcsDeletionJournal', () => f.options.journal as ReturnType<typeof deletionModule.createGcsDeletionJournal>);
    t.mock.method(schemaModule, 'verifyRetirementSchemas', async () => {});
    const result = await f.guard.advanceRestoreGuardCheckpoint(f.options);
    assert.equal(result.epoch, '1'); assert.equal(f.db.commits, 1); assert.equal(f.io.writes, 2);
});

test('conditional guard advancement requires both authenticated objects and a verified absence', async () => {
    const db = sql();
    const tag = 'a'.repeat(64), id = 'b'.repeat(64);
    const pair: ConditionalRetirementPair = { intent: { parentId: accountId, childId: serverUuid, warningId: lineage,
        activityAt: '2023-01-01T00:00:00.000000Z', deliveredAt: '2026-10-01T00:00:00.000000Z', channel: 'in-app',
        targetDigest: 'c'.repeat(64), noticeDigest: 'd'.repeat(64), receiptDigest: 'e'.repeat(64) },
        resolution: { outcome: 'deleted', confirmedAt: '2026-10-02T00:00:00.000000Z', observedActivityAt: null, proofDigest: 'f'.repeat(64) },
        intentObject: { name: `v1/conditional/${tag}/${id}.json`, generation: '123', contentSha256: '1'.repeat(64) },
        resolutionObject: { name: `v1/resolutions/${tag}/${id}.json`, generation: '124', contentSha256: '2'.repeat(64) } };
    db.setNow('2026-11-05T00:00:00.000000Z');
    let state: ObservedRestoreGuard = { state: 'hold', database: pins.database, serverUuid, epoch: accountId,
        expiresAt: '2027-01-01T00:00:00.000Z', generation: '1' };
    const guard = { async read() { return state; }, async commit(next: Omit<ObservedRestoreGuard, 'generation'>, expected: string) {
        assert.equal(expected, state.generation); state = { ...next, generation: '2' }; return '2'; } };
    const options = { connection: db.connection, pins, lineage, publicKey, privateKey,
        project: 'noted-reef-387021', instance: 'cms-mickeyf', cloud: cloud('2026-11-05T00:00:00Z'),
        selected: [pair.intentObject, pair.resolutionObject], journal: { async readDeletionEntries() { return { entries: [], digest: 'b'.repeat(64) }; } },
        conditional: { bucket, async readPairs() { return { pairs: [pair], digest: 'c'.repeat(64) }; } }, verifySchema: async () => {},
        confirmation: 'ORIGINAL PRIMARY AND ALL WRITERS FENCED', externalCopiesConfirmation: 'ALL PERMITTED RECOVERY COPIES ACCOUNTED FOR', coveragePolls: 1 };
    const result = await advanceRetirementGuard(options, guard);
    assert.equal(result.epoch, '1'); assert.equal(verifyRetirementBatch(result.permit, publicKey).bucket, bucket);
    const retryDb = sql(); retryDb.setNow('2026-11-05T00:00:00.000000Z');
    await assert.rejects(advanceRetirementGuard({ ...options, connection: retryDb.connection, selected: [pair.intentObject] }, guard));
    assert.equal(retryDb.commits, 0);
});
