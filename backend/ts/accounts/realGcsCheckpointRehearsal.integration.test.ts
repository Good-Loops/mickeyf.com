import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import mysql, { type PoolConnection, type RowDataPacket } from 'mysql2/promise';
import { GoogleAuth } from 'google-auth-library';
import { createGcsRetentionJournal } from './gcsRetentionJournal';
import { retireConditionalPair, resumeConditionalResolution } from './retireConditionalPair';
import type { JournalHttpClient } from './gcsDeletionJournal';
import type { CloudSqlMetadataClient } from './cloudSqlRecoveryInventory';
import * as cloudModule from './cloudSqlRecoveryInventory';
import * as deletionModule from './gcsDeletionJournal';
import * as schemaModule from './retirementSourceSchema';

test('synthetic SQL and real disposable GCS guard, checkpoint and conditional retirement', { timeout: 120_000 }, async t => {
    assert.equal(process.env.LUDOLUME_SYNTHETIC_GCS_REHEARSAL, '1');
    assert.equal(process.env.NODE_ENV, 'test');
    assert.match(process.env.SYNTHETIC_REHEARSAL_CONTAINER ?? '', /^[a-f0-9]{64}$/u);
    assert.equal(process.env.MIGRATION_DB_HOST, '127.0.0.1');
    assert.equal(process.env.MIGRATION_DB_NAME, 'mickeyf_migration_test');
    assert.equal(process.env.MIGRATION_DB_USER, 'migration_test');
    assert.equal(process.env.MIGRATION_DB_PASS, 'migration-test-only');
    const port = Number(process.env.MIGRATION_TEST_PORT);
    assert.ok(Number.isInteger(port) && port > 0 && port <= 65535 && port !== 3306);
    const suffix = randomBytes(8).toString('hex'), bucket = `ludolume-checkpoint-test-${suffix}`;
    const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
    const authClient = await auth.getClient();
    async function http(method: string, url: string, body?: string, headers: Record<string, string> = {}) {
        const target = new URL(url);
        assert.equal(target.origin, 'https://storage.googleapis.com');
        const access = await authClient.getRequestHeaders(target.toString());
        for (const [name, value] of Object.entries(headers)) access.set(name, value);
        const response = await fetch(target, { method, headers: access, body, redirect: 'error', signal: AbortSignal.timeout(10_000) });
        const text = await response.text();
        if (Buffer.byteLength(text) > 256 * 1024) throw new Error('Synthetic storage response too large.');
        return { status: response.status, text, json: text ? JSON.parse(text) as Record<string, unknown> : {} };
    }
    const client: JournalHttpClient = { async request(input) {
        const url = new URL(input.url);
        const bucketPath = `/storage/v1/b/${bucket}`;
        const uploadPath = `/upload/storage/v1/b/${bucket}/`;
        if (url.pathname !== bucketPath && !url.pathname.startsWith(`${bucketPath}/`) && !url.pathname.startsWith(uploadPath)) {
            throw new Error('Synthetic bucket boundary rejected.');
        }
        for (const [name, value] of Object.entries(input.params)) url.searchParams.set(name, String(value));
        const response = await http(input.method, url.toString(), input.data, input.headers);
        if (response.status !== (input.method === 'DELETE' ? 204 : 200)) {
            console.error(`Synthetic storage request returned ${response.status} for ${input.method}.`);
        }
        return { status: response.status, data: input.responseType === 'text' ? response.text : response.json };
    } };
    let connection: Awaited<ReturnType<typeof mysql.createConnection>> | undefined, maybeCreated = false, stage = 'database';
    try {
        connection = await mysql.createConnection({ host: '127.0.0.1', port, database: 'mickeyf_migration_test',
            user: 'migration_test', password: 'migration-test-only', dateStrings: true, timezone: 'Z', multipleStatements: false });
        const [identities] = await connection.query<RowDataPacket[]>(`SELECT DATABASE() AS db,CURRENT_USER() AS user,
            @@version AS version,@@version_comment AS vendor,@@GLOBAL.server_uuid AS uuid`);
        assert.equal(identities[0].db, 'mickeyf_migration_test'); assert.equal(identities[0].user, 'migration_test@%');
        assert.match(identities[0].version, /^8\.0\.31(?:-|$)/u); assert.doesNotMatch(identities[0].vendor, /Google/iu);
        const serverUuid = String(identities[0].uuid), database = 'mickeyf_migration_test', lineage = randomUUID();
        await connection.query(readFileSync(path.join(__dirname, '../../migrations/pending/draft_account_recovery_checkpoint.sql'), 'utf8'));
        await connection.query('INSERT INTO account_recovery_checkpoint (singleton_id,lineage_id,epoch) VALUES (1,?,0)', [lineage]);
        await connection.query('CREATE TABLE users (account_uuid CHAR(36) PRIMARY KEY) ENGINE=InnoDB');
        await connection.query('CREATE TABLE apple_provider_tokens (account_uuid CHAR(36)) ENGINE=InnoDB');
        await connection.query('CREATE TABLE parent_registration_attempts (parent_uuid CHAR(36),child_uuid CHAR(36)) ENGINE=InnoDB');
        await connection.query('CREATE TABLE schema_migrations (version VARCHAR(255) PRIMARY KEY) ENGINE=InnoDB');
        stage = 'bucket-create'; maybeCreated = true;
        const created = await http('POST', 'https://storage.googleapis.com/storage/v1/b?project=noted-reef-387021', JSON.stringify({
            name: bucket, location: 'US-CENTRAL1', storageClass: 'STANDARD', labels: { purpose: 'synthetic-checkpoint', run: suffix },
            iamConfiguration: { uniformBucketLevelAccess: { enabled: true }, publicAccessPrevention: 'enforced' },
            versioning: { enabled: true }, softDeletePolicy: { retentionDurationSeconds: '604800' },
        }), { 'content-type': 'application/json' });
        assert.equal(created.status, 200); assert.equal(created.json.name, bucket);
        stage = 'guard-create'; const key = randomBytes(32), signing = generateKeyPairSync('ed25519');
        const journal = createGcsRetentionJournal({ bucket, expectedBucket: bucket, key, client, verifyActivityContinuity: async () => false });
        await journal.writeRestoreGuard({ state: 'hold', database, serverUuid, epoch: randomUUID(), expiresAt: '2027-12-31T00:00:00.000Z' }, '0');
        const intent = { parentId: randomUUID(), childId: randomUUID(), warningId: randomUUID(), activityAt: '2023-01-01T00:00:00.000000Z',
            deliveredAt: '2026-01-01T00:00:00.000000Z', channel: 'in-app' as const,
            targetDigest: 'a'.repeat(64), noticeDigest: 'b'.repeat(64), receiptDigest: 'c'.repeat(64) };
        stage = 'journal-intent'; await journal.recordRetentionIntent(intent);
        stage = 'journal-resolution';
        await journal.recordCommittedDeletion(intent, '2026-01-02T00:00:00.000000Z');
        stage = 'journal-pair';
        const pair = (await journal.readConditionalRetirementPairs()).pairs[0]; assert.ok(pair);
        let nowMs = Date.now() + 10 * 86_400_000, floorMs = nowMs - 2 * 86_400_000;
        const clock = () => new Date(nowMs).toISOString().replace('Z', '000Z');
        const raw = connection;
        const wrapped = { async beginTransaction() { await raw.beginTransaction(); }, async commit() { await raw.commit(); },
            async rollback() { await raw.rollback(); }, destroy() { raw.destroy(); }, async query(input: { sql: string }, values?: unknown[]) {
                if (input.sql.includes('USER_PRIVILEGES')) return [[{ count: 1 }], []];
                if (input.sql.includes('PROCESSLIST')) return [[{ count: 0 }], []];
                const [rows, fields] = await raw.query(input, values);
                if (input.sql.includes('DATE_FORMAT(UTC_TIMESTAMP(6)') && Array.isArray(rows))
                    for (const row of rows as RowDataPacket[]) row.nowUtc = clock();
                return [rows, fields];
            } } as unknown as PoolConnection;
        const cloud: CloudSqlMetadataClient = { async listBackups() { const floor = new Date(floorMs).toISOString(); return {
            kind: 'sql#backupRunsList', items: [{ kind: 'sql#backupRun', id: '1', status: 'SUCCESSFUL', instance: 'cms-mickeyf',
                enqueuedTime: floor, startTime: floor }] }; }, async getRecoveryWindow() { return { kind: 'sql#getLatestRecoveryTime',
                earliestRecoveryTime: new Date(floorMs).toISOString(), latestRecoveryTime: new Date(nowMs).toISOString() }; } };
        t.mock.method(cloudModule, 'createCloudSqlMetadataClient', () => cloud);
        t.mock.method(schemaModule, 'verifyRetirementSchemas', async () => {});
        t.mock.method(deletionModule, 'createGcsDeletionJournal', () => ({ async readDeletionEntries() {
            return { entries: [], digest: 'a'.repeat(64) }; }, async readDeletionIntents() { return { intents: [], digest: 'a'.repeat(64) }; },
            async recordAccountDeletion() { throw new Error('Synthetic conditional test only.'); },
            async recordPublicScoreWithdrawal() { throw new Error('Synthetic conditional test only.'); } }));
        const pins = { database, currentUser: 'migration_test@%', serverUuid };
        const confirmation = 'ORIGINAL PRIMARY AND ALL WRITERS FENCED', externalCopiesConfirmation = 'ALL PERMITTED RECOVERY COPIES ACCOUNTED FOR';
        stage = 'guard-advance'; const advanced = await journal.advanceRestoreGuardCheckpoint({ kind: 'conditional', connection: wrapped, pins, lineage,
            publicKey: signing.publicKey, privateKey: signing.privateKey, selected: [pair.intentObject, pair.resolutionObject],
            confirmation, externalCopiesConfirmation, coveragePolls: 1 });
        await journal.assertRestoreGuardHistory();
        floorMs = nowMs + 86_400_000; nowMs = floorMs + 86_400_000;
        const common = { connection: wrapped, pins, bucket, permit: advanced.permit, publicKey: signing.publicKey,
            privateKey: signing.privateKey, project: 'noted-reef-387021', instance: 'cms-mickeyf', cloud,
            guard: journal, client, verifySchema: async () => {}, confirmation, externalCopiesConfirmation };
        stage = 'journal-retire'; assert.deepEqual(await retireConditionalPair({ ...common, pair, journal, retireWitnesses: async () => {}, verifyWitnessesAbsent: async () => {} }),
            { status: 'retired' });
        assert.deepEqual(await resumeConditionalResolution({ ...common, intentObject: pair.intentObject, resolutionObject: pair.resolutionObject }),
            { status: 'already-retired' });
        await journal.assertRestoreGuardHistory();
        console.log('Synthetic GCS guard advancement, exact-generation soft deletion and reconciliation verified.');
    } catch (error) {
        console.error(`Synthetic rehearsal stopped at ${stage}.`);
        throw error;
    } finally {
        if (connection) { try { await connection.end(); } catch { connection.destroy(); } }
        if (maybeCreated) {
            const base = `https://storage.googleapis.com/storage/v1/b/${bucket}`;
            const info = await http('GET', `${base}?fields=name,labels`);
            if (info.status !== 404) {
                if (info.status !== 200 || info.json.name !== bucket || (info.json.labels as Record<string, unknown>)?.run !== suffix
                    || (info.json.labels as Record<string, unknown>)?.purpose !== 'synthetic-checkpoint') {
                    throw new Error(`Synthetic bucket cleanup requires review: ${bucket}`);
                }
                const listed = await http('GET', `${base}/o?versions=true&maxResults=1000&fields=kind,nextPageToken,items(name,generation)`);
                if (listed.status !== 200 || listed.json.nextPageToken !== undefined || (listed.json.items !== undefined && !Array.isArray(listed.json.items))) {
                    throw new Error(`Synthetic bucket inventory requires review: ${bucket}`);
                }
                for (const value of (listed.json.items ?? []) as Array<Record<string, unknown>>) {
                    if (typeof value.name !== 'string' || !/^v1\/(?:control\/restore-guard\.json|conditional\/[a-f0-9]{64}\/[a-f0-9]{64}\.json|resolutions\/[a-f0-9]{64}\/[a-f0-9]{64}\.json)$/u.test(value.name)
                        || typeof value.generation !== 'string' || !/^[1-9][0-9]*$/u.test(value.generation)) throw new Error(`Unexpected synthetic object: ${bucket}`);
                    const url = new URL(`${base}/o/${encodeURIComponent(value.name)}`);
                    url.searchParams.set('generation', value.generation); url.searchParams.set('ifGenerationMatch', value.generation);
                    if ((await http('DELETE', url.toString())).status !== 204) throw new Error(`Synthetic object cleanup unconfirmed: ${bucket}`);
                }
                if ((await http('DELETE', base)).status !== 204) throw new Error(`Synthetic bucket cleanup unconfirmed: ${bucket}`);
                console.log(`Synthetic bucket deleted: ${bucket}`);
            }
        }
    }
});
