import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import type { PoolConnection } from 'mysql2/promise';
import { createGcsRetentionJournal } from './gcsRetentionJournal';
import type { DeletionJournalEntry, JournalHttpClient } from './gcsDeletionJournal';
import type { CloudSqlMetadataClient } from './cloudSqlRecoveryInventory';
import { signPreparedRetirementCheckpoint, verifyRetirementBatch } from './retirementBatchPermit';
import * as cloudModule from './cloudSqlRecoveryInventory';
import * as deletionModule from './gcsDeletionJournal';
import * as schemaModule from './retirementSourceSchema';
import { advanceRetirementGuard } from './retirementGuardAdvance';
import { prepareRecoverySafeRetirement, finishRecoverySafeRetirement } from './recoverySafeRetirement';
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
    let body = '', generation = 0, writes = 0, loseAcknowledgement = false;
    const client: JournalHttpClient = { async request(request) {
        const metadata = () => ({ bucket, name: 'v1/control/restore-guard.json', generation: String(generation),
            size: String(Buffer.byteLength(body)), md5Hash: createHash('md5').update(body).digest('base64') });
        if (request.url.endsWith(`/b/${bucket}`)) return { status: 200, data: { name: bucket,
            versioning: { enabled: true }, softDeletePolicy: { retentionDurationSeconds: '604800' } } };
        if (request.method === 'POST') {
            if (String(request.params.ifGenerationMatch) !== String(generation)) return { status: 412, data: {} };
            body = request.data!; generation++; writes++;
            if (loseAcknowledgement) { loseAcknowledgement = false; throw new Error('synthetic lost acknowledgement'); }
            return { status: 200, data: metadata() };
        }
        if (request.url.endsWith('/o')) return { status: 200, data: { kind: 'storage#objects',
            items: request.params.versions && generation > 0 ? [metadata()] : [] } };
        return { status: 200, data: request.params.alt === 'media' ? body : metadata() };
    } };
    return { client, loseNextAcknowledgement() { loseAcknowledgement = true; }, get writes() { return writes; } };
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

test('the legacy one-stage path is unavailable to the production operator', async () => {
    const f = await fixture();
    const pins = { ...f.options.pins, currentUser: 'ludolume_release_ops@cloudsqlproxy~%' };
    const guard = { read: f.guard.readRestoreGuard, async commit() { assert.fail('production must use the prepared path'); } };
    await assert.rejects(advanceRetirementGuard({ ...f.options, pins }, guard));
    assert.equal(f.db.commits, 0);
    assert.equal(f.io.writes, 1);
});

test('prepared cleanup leaves old recovery points usable until the provider floor advances', async () => {
    const f = await fixture();
    let state: ObservedRestoreGuard = { state: 'hold', database: pins.database, serverUuid, epoch: accountId,
        expiresAt: '2027-01-01T00:00:00.000Z', generation: '1' };
    const capability = { async read() { return state; }, async commit(next: Omit<ObservedRestoreGuard, 'generation'>, expected: string) {
        assert.equal(expected, state.generation); state = { ...next, generation: '2' }; return '2'; } };
    const prepared = await prepareRecoverySafeRetirement(f.options, capability);
    assert.equal(state.generation, '1');
    assert.equal(state.recoveryCheckpoint, undefined);
    assert.throws(() => verifyRetirementBatch(prepared, publicKey));
    await assert.rejects(finishRecoverySafeRetirement(f.options, capability,
        { ...prepared, claim: { ...prepared.claim, committedBefore: '2026-10-01T00:00:00.000000Z' } }));
    await assert.rejects(finishRecoverySafeRetirement({ ...f.options, selected: [] }, capability, prepared));
    assert.deepEqual(await finishRecoverySafeRetirement(f.options, capability, prepared), { status: 'waiting' });
    assert.equal(state.generation, '1');

    f.db.setNow('2026-11-07T00:00:00.000000Z');
    const laterCloud: CloudSqlMetadataClient = { async listBackups() { return { kind: 'sql#backupRunsList', items: [{
        kind: 'sql#backupRun', id: '2', status: 'SUCCESSFUL', enqueuedTime: '2026-11-06T00:00:00Z',
        startTime: '2026-11-06T00:00:00Z', instance: 'cms-mickeyf' }] }; },
    async getRecoveryWindow() { return { kind: 'sql#getLatestRecoveryTime', earliestRecoveryTime: '2026-11-06T00:00:00Z',
        latestRecoveryTime: '2026-11-07T00:00:00Z' }; } };
    const other = { ...entry, intent: { ...entry.intent, accountId: serverUuid },
        name: 'v1/intents/42272598-9d28-457d-a63d-e3e3cd0d2a01.json', generation: '124' };
    const journal = { async readDeletionEntries() { return { entries: [entry, other], digest: 'c'.repeat(64) }; } };
    const result = await finishRecoverySafeRetirement({ ...f.options, cloud: laterCloud, journal }, capability, prepared);
    assert.equal(result.status, 'advanced');
    if (result.status !== 'advanced') assert.fail('expected an advanced guard');
    assert.equal(result.generation, '2');
    assert.equal((await capability.read()).recoveryCheckpoint?.minimumEpoch, '1');
    assert.deepEqual(verifyRetirementBatch(result.permit, publicKey).entries, f.options.selected);
});

test('an active account’s withdrawal is checked at preparation and again before advancement', async () => {
    const f = await fixture(); let visibility = 'private';
    const target: DeletionJournalEntry = { ...entry, contentSha256: 'd'.repeat(64),
        intent: { ...entry.intent, action: 'withdraw-public-scores' } };
    const connection = { ...f.db.connection, async query(input: { sql: string }, values?: unknown[]) {
        if (input.sql.includes('FROM users')) return [[{ account_uuid: accountId }], []];
        if (input.sql.includes('FROM account_score_permissions')) return [[{ visibility, policy_digest: null,
            registration_policy_version: null, country_code: null, age_band: null, authorizer_uuid: null }], []];
        return f.db.connection.query(input, values);
    } } as unknown as PoolConnection;
    const journal = { async readDeletionEntries() { return { entries: [target], digest: 'c'.repeat(64) }; } };
    let state: ObservedRestoreGuard = { state: 'hold', database: pins.database, serverUuid, epoch: accountId,
        expiresAt: '2027-01-01T00:00:00.000Z', generation: '1' };
    const capability = { async read() { return state; }, async commit(next: Omit<ObservedRestoreGuard, 'generation'>, expected: string) {
        assert.equal(expected, state.generation); state = { ...next, generation: '2' }; return '2'; } };
    const options = { ...f.options, connection, journal,
        selected: [{ name: target.name, generation: target.generation, contentSha256: target.contentSha256 }] };
    const prepared = await prepareRecoverySafeRetirement(options, capability);
    f.db.setNow('2026-11-07T00:00:00.000000Z');
    const laterCloud: CloudSqlMetadataClient = { async listBackups() { return { kind: 'sql#backupRunsList', items: [{
        kind: 'sql#backupRun', id: '2', status: 'SUCCESSFUL', enqueuedTime: '2026-11-06T00:00:00Z',
        startTime: '2026-11-06T00:00:00Z', instance: 'cms-mickeyf' }] }; },
    async getRecoveryWindow() { return { kind: 'sql#getLatestRecoveryTime', earliestRecoveryTime: '2026-11-06T00:00:00Z',
        latestRecoveryTime: '2026-11-07T00:00:00Z' }; } };
    visibility = 'public';
    await assert.rejects(finishRecoverySafeRetirement({ ...options, cloud: laterCloud }, capability, prepared));
    assert.equal(state.generation, '1');
    visibility = 'private';
    const result = await finishRecoverySafeRetirement({ ...options, cloud: laterCloud }, capability, prepared);
    assert.equal(result.status, 'advanced');
});

test('a changed recovery guard invalidates a prepared cleanup', async () => {
    const f = await fixture();
    let state: ObservedRestoreGuard = { state: 'hold', database: pins.database, serverUuid, epoch: accountId,
        expiresAt: '2027-01-01T00:00:00.000Z', generation: '1' };
    const capability = { async read() { return state; }, async commit() { assert.fail('stale preparation must not advance the guard'); } };
    const prepared = await prepareRecoverySafeRetirement(f.options, capability);
    state = { ...state, generation: '2' };
    await assert.rejects(finishRecoverySafeRetirement(f.options, capability, prepared));
    assert.equal(state.generation, '2');
});

test('an unconfirmed guard write resumes the exact prepared batch without another write', async () => {
    const f = await fixture(); let writes = 0;
    let state: ObservedRestoreGuard = { state: 'hold', database: pins.database, serverUuid, epoch: accountId,
        expiresAt: '2027-01-01T00:00:00.000Z', generation: '1' };
    const capability = { async read() { return state; }, async commit(next: Omit<ObservedRestoreGuard, 'generation'>) {
        writes++; state = { ...next, generation: '2' }; throw new Error('synthetic lost acknowledgement'); } };
    const prepared = await prepareRecoverySafeRetirement(f.options, capability);
    f.db.setNow('2026-11-07T00:00:00.000000Z');
    const laterCloud: CloudSqlMetadataClient = { async listBackups() { return { kind: 'sql#backupRunsList', items: [{
        kind: 'sql#backupRun', id: '2', status: 'SUCCESSFUL', enqueuedTime: '2026-11-06T00:00:00Z',
        startTime: '2026-11-06T00:00:00Z', instance: 'cms-mickeyf' }] }; },
    async getRecoveryWindow() { return { kind: 'sql#getLatestRecoveryTime', earliestRecoveryTime: '2026-11-06T00:00:00Z',
        latestRecoveryTime: '2026-11-07T00:00:00Z' }; } };
    const options = { ...f.options, cloud: laterCloud };
    await assert.rejects(finishRecoverySafeRetirement(options, capability, prepared));
    assert.equal((await capability.read()).recoveryCheckpoint?.minimumEpoch, '1');
    const different = signPreparedRetirementCheckpoint({ ...prepared.claim, committedBefore: '2026-10-01T00:00:00.000000Z' }, privateKey);
    await assert.rejects(finishRecoverySafeRetirement(options, capability, different));
    const recovered = await finishRecoverySafeRetirement(options, capability, prepared);
    assert.equal(recovered.status, 'advanced');
    if (recovered.status !== 'advanced') assert.fail('expected a recovered permit');
    assert.equal(verifyRetirementBatch(recovered.permit, publicKey).epoch, '1');
    assert.equal(writes, 1);
});

test('a delayed first guard write cannot overwrite a successful conditional retry', async () => {
    const f = await fixture(); let attempts = 0, applied = 0, finishDelayed!: () => void;
    let state: ObservedRestoreGuard = { state: 'hold', database: pins.database, serverUuid, epoch: accountId,
        expiresAt: '2027-01-01T00:00:00.000Z', generation: '1' };
    const capability = { async read() { return state; }, async commit(next: Omit<ObservedRestoreGuard, 'generation'>, expected: string) {
        attempts++;
        if (attempts === 1) {
            finishDelayed = () => { if (state.generation === expected) { state = { ...next, generation: '3' }; applied++; } };
            throw new Error('synthetic timeout with request still in flight');
        }
        assert.equal(state.generation, expected);
        state = { ...next, generation: '2' }; applied++; return '2';
    } };
    const prepared = await prepareRecoverySafeRetirement(f.options, capability);
    f.db.setNow('2026-11-07T00:00:00.000000Z');
    const laterCloud: CloudSqlMetadataClient = { async listBackups() { return { kind: 'sql#backupRunsList', items: [{
        kind: 'sql#backupRun', id: '2', status: 'SUCCESSFUL', enqueuedTime: '2026-11-06T00:00:00Z',
        startTime: '2026-11-06T00:00:00Z', instance: 'cms-mickeyf' }] }; },
    async getRecoveryWindow() { return { kind: 'sql#getLatestRecoveryTime', earliestRecoveryTime: '2026-11-06T00:00:00Z',
        latestRecoveryTime: '2026-11-07T00:00:00Z' }; } };
    const options = { ...f.options, cloud: laterCloud };
    await assert.rejects(finishRecoverySafeRetirement(options, capability, prepared));
    const result = await finishRecoverySafeRetirement(options, capability, prepared);
    assert.equal(result.status, 'advanced');
    finishDelayed();
    assert.equal(attempts, 2); assert.equal(applied, 1); assert.equal(state.generation, '2');
});

test('the storage guard adapter prepares and advances in separate calls', async t => {
    const f = await fixture();
    let old = true;
    const provider: CloudSqlMetadataClient = { async listBackups() {
        const time = old ? '2026-10-28T00:00:00Z' : '2026-11-06T00:00:00Z';
        return { kind: 'sql#backupRunsList', items: [{ kind: 'sql#backupRun', id: '1', status: 'SUCCESSFUL',
            enqueuedTime: time, startTime: time, instance: 'cms-mickeyf' }] };
    }, async getRecoveryWindow() { return { kind: 'sql#getLatestRecoveryTime',
        earliestRecoveryTime: old ? '2026-10-29T00:00:00Z' : '2026-11-06T00:00:00Z',
        latestRecoveryTime: old ? '2026-11-05T00:00:00Z' : '2026-11-07T00:00:00Z' }; } };
    t.mock.method(cloudModule, 'createCloudSqlMetadataClient', () => provider);
    t.mock.method(deletionModule, 'createGcsDeletionJournal', () => f.options.journal as ReturnType<typeof deletionModule.createGcsDeletionJournal>);
    t.mock.method(schemaModule, 'verifyRetirementSchemas', async () => {});
    const prepared = await f.guard.prepareRetirementCheckpoint(f.options);
    assert.equal(f.io.writes, 1);
    assert.deepEqual(await f.guard.finishRetirementCheckpoint(f.options, prepared), { status: 'waiting' });
    old = false; f.db.setNow('2026-11-07T00:00:00.000000Z');
    f.io.loseNextAcknowledgement();
    await assert.rejects(f.guard.finishRetirementCheckpoint(f.options, prepared));
    assert.equal(f.io.writes, 2);
    const finished = await f.guard.finishRetirementCheckpoint(f.options, prepared);
    assert.equal(finished.status, 'advanced');
    if (finished.status !== 'advanced') assert.fail('expected an advanced guard');
    assert.equal(f.io.writes, 2);
    assert.equal((await f.guard.readRestoreGuard()).recoveryCheckpoint?.minimumEpoch, '1');
    assert.equal(verifyRetirementBatch(finished.permit, publicKey).epoch, '1');
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
    const safeDb = sql(); safeDb.setNow('2026-11-05T00:00:00.000000Z');
    const safeGuard = { async read(): Promise<ObservedRestoreGuard> { return { state: 'hold', database: pins.database,
        serverUuid, epoch: accountId, expiresAt: '2027-01-01T00:00:00.000Z', generation: '10' }; },
    async commit() { assert.fail('preparing must not change the guard'); } };
    const safeOptions = { ...options, connection: safeDb.connection };
    await assert.rejects(prepareRecoverySafeRetirement({ ...safeOptions, selected: [pair.intentObject] }, safeGuard));
    const prepared = await prepareRecoverySafeRetirement(safeOptions, safeGuard);
    assert.equal(prepared.claim.bucket, bucket);
    assert.equal(prepared.claim.entries.length, 2);
});

test('a kept account requires preserved activity at both checkpoint and advancement', async () => {
    const db = sql(); db.setNow('2026-11-05T00:00:00.000000Z');
    let activityAt = '2026-10-01T12:00:00.000000Z';
    const connection = { ...db.connection, async query(input: { sql: string }, values?: unknown[]) {
        if (input.sql.includes('LEFT JOIN parent_child_consents')) return [[{ childId: serverUuid, parentId: accountId, activityAt }], []];
        return db.connection.query(input, values);
    } } as unknown as PoolConnection;
    const tag = 'a'.repeat(64), id = 'b'.repeat(64);
    const pair: ConditionalRetirementPair = { intent: { parentId: accountId, childId: serverUuid, warningId: lineage,
        activityAt: '2023-01-01T00:00:00.000000Z', deliveredAt: '2026-10-01T00:00:00.000000Z', channel: 'in-app',
        targetDigest: 'c'.repeat(64), noticeDigest: 'd'.repeat(64), receiptDigest: 'e'.repeat(64) },
        resolution: { outcome: 'kept', confirmedAt: '2026-10-02T00:00:00.000000Z',
            observedActivityAt: '2026-10-01T12:00:00.000000Z', proofDigest: 'f'.repeat(64) },
        intentObject: { name: `v1/conditional/${tag}/${id}.json`, generation: '123', contentSha256: '1'.repeat(64) },
        resolutionObject: { name: `v1/resolutions/${tag}/${id}.json`, generation: '124', contentSha256: '2'.repeat(64) } };
    let state: ObservedRestoreGuard = { state: 'hold', database: pins.database, serverUuid, epoch: accountId,
        expiresAt: '2027-01-01T00:00:00.000Z', generation: '1' };
    const guard = { async read() { return state; }, async commit(next: Omit<ObservedRestoreGuard, 'generation'>, expected: string) {
        assert.equal(expected, state.generation); state = { ...next, generation: '2' }; return '2'; } };
    const laterCloud: CloudSqlMetadataClient = { async listBackups() { return { kind: 'sql#backupRunsList', items: [{
        kind: 'sql#backupRun', id: '2', status: 'SUCCESSFUL', enqueuedTime: '2026-11-06T00:00:00Z',
        startTime: '2026-11-06T00:00:00Z', instance: 'cms-mickeyf' }] }; },
    async getRecoveryWindow() { return { kind: 'sql#getLatestRecoveryTime', earliestRecoveryTime: '2026-11-06T00:00:00Z',
        latestRecoveryTime: '2026-11-07T00:00:00Z' }; } };
    const options = { connection, pins, lineage, publicKey, privateKey, project: 'noted-reef-387021', instance: 'cms-mickeyf',
        cloud: laterCloud, selected: [pair.intentObject, pair.resolutionObject],
        journal: { async readDeletionEntries() { return { entries: [], digest: 'b'.repeat(64) }; } },
        conditional: { bucket, async readPairs() { return { pairs: [pair], digest: 'c'.repeat(64) }; } }, verifySchema: async () => {},
        confirmation: 'ORIGINAL PRIMARY AND ALL WRITERS FENCED', externalCopiesConfirmation: 'ALL PERMITTED RECOVERY COPIES ACCOUNTED FOR' };
    const prepared = await prepareRecoverySafeRetirement(options, guard);
    db.setNow('2026-11-07T00:00:00.000000Z'); activityAt = '2026-09-30T00:00:00.000000Z';
    await assert.rejects(finishRecoverySafeRetirement(options, guard, prepared));
    assert.equal(state.generation, '1');
    activityAt = '2026-10-01T12:00:00.000000Z';
    assert.equal((await finishRecoverySafeRetirement(options, guard, prepared)).status, 'advanced');
});
