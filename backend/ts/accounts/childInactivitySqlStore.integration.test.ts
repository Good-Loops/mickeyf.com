import assert from 'node:assert/strict';
import { createHash, createHmac, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import cookieParser from 'cookie-parser';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import mysql, { type Connection, type Pool, type ResultSetHeader, type RowDataPacket } from 'mysql2/promise';
import { loadMigrationConfig } from '../config/migrationConfig';
import type { MigrationConnection } from '../migrations/leaderboardSchema';
import type { childSchemaCommandSettings } from '../migrations/runChildSignedFormSchema';
import { loadMigrationManifest } from '../migrations/migrationManifest';
import { applyMigrations } from '../migrations/migrationRunner';
import { createChildInactivitySqlStore } from './childInactivitySqlStore';
import { ACTIVITY_DRAFT_SQL, WARNING_DRAFT_SQL, assertActivityDraft, assertWarningDraft } from './inactivitySchema.testFixture';
import { createInAppInactivityQualityResolver } from './childInactivityInAppTarget';
import { createPinnedPrimaryHealth } from './retentionPrimaryHealth';
import { reconcileDeletedRetentionIntent, reconcileKeptRetentionIntent, reconcileRestoredDeletedIntent } from './retentionReconciliation';
import { executeRetentionReconciliation } from './runRetentionReconciliation';
import { activateRetentionGuard } from './retentionGuardActivation';
import type { RetentionIntent } from './childInactivityWorkflow';
import type { RetentionResolution } from './gcsRetentionJournal';
import { createChildInactivityParentService } from './childInactivityParentService';
import type { ProviderAuthContext } from '../auth/providerAuthContext';
import { acknowledgeInactivityWarning, confirmInactivityWarning, deleteInactiveChild, prepareInactivityWarning } from './childInactivityWorkflow';
import { createAccountSession, revokeAccountSession } from '../auth/accountSessionRepository';
import { runChildInactivityReview } from './runChildInactivityReview';
import { runChildInactivityMaintenance } from './childInactivityMaintenance';
import { prepareChildInactivityDeployment } from './childInactivityDeployment';
import { createGcsRetentionJournal } from './gcsRetentionJournal';
import type { JournalHttpClient } from './gcsDeletionJournal';
import { Readable } from 'node:stream';
import { createAuthRouter } from '../routers/authRouter';
import { parentManagedChildActivity } from './parentManagedChildActivity';
import { issueSessionToken } from '../security/sessionPolicy';
import { verifyChildInactivityWarningReadiness } from './childInactivityRuntime';
import { verifyParentManagedChildActivityReadiness } from '../migrations/parentManagedChildActivityReadiness';
import { renderRuntimeGrantStatements } from '../security/runtimeGrantManifest';
import { applyInactivitySchema, planInactivitySchema, verifyInactivitySchema, InactivitySchemaError } from '../migrations/childInactivitySchemaOperation';
import { CHILD_SIGNED_FORM_SQL_SHA256, childSignedFormFingerprint } from '../migrations/childSignedFormOperation';
import type { ChildSignedFormMetadataSettings } from '../migrations/childSignedFormMetadata';
import { createRetentionKeepReconciler } from './retentionKeepReconciler';
import { createGuardedDeletionReplayReader } from './guardedDeletionReplayReader';

const config = loadMigrationConfig();
const rootPassword = 'migration-test-root-only';
const targetDigest = 'a'.repeat(64);
let admin: Connection;
let database: Pool;

test('parent keep over HTTP reconciles a prior conditional intent or reports uncertainty', async () => {
    const { parentId, childId } = await managedFixture();
    const [[parent]] = await admin.query<RowDataPacket[]>('SELECT user_id, user_name FROM users WHERE account_uuid=?', [parentId]);
    const account = { accountId: parentId, userId: parent.user_id as number, userName: parent.user_name as string };
    const secret = 'synthetic-parent-keep-http-secret', issued = issueSessionToken(account, secret);
    assert.equal(await createAccountSession(database, account, issued.sessionId, issued.expiresAt), true);
    const intent: RetentionIntent = { parentId, childId, warningId: randomUUID(), activityAt:'2020-01-01T00:00:00.000000Z',
        deliveredAt:'2023-01-01T00:00:00.000000Z', channel:'in-app', targetDigest:'a'.repeat(64),
        noticeDigest:'b'.repeat(64), receiptDigest:'c'.repeat(64) };
    let resolution: RetentionResolution | null = null, unavailable = false;
    const journal = { async readIntentsForChild(id: string) { assert.equal(id, childId); if (unavailable) throw new Error('offline'); return [intent]; },
        async verifyRetentionIntent() { return true; }, async readResolution() { return resolution; },
        async recordResolution(_intent: RetentionIntent, value: RetentionResolution) { resolution = value; } };
    const store = createChildInactivitySqlStore(database, createInAppInactivityQualityResolver(Buffer.alloc(32, 3), async () => false));
    const reconcileChildKeep = createRetentionKeepReconciler(store, journal, Buffer.alloc(32, 8));
    const app = express(); app.use(cookieParser(secret)); app.use(express.json());
    app.use('/auth', createAuthRouter(database, secret, false, ['https://parent.example.test'],
        { parentRegistrationStorageReady:true, childActivity:parentManagedChildActivity, reconcileChildKeep }));
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    const signature = createHmac('sha256', secret).update(issued.token).digest('base64').replace(/=+$/, '');
    const cookie = `__session=${encodeURIComponent(`s:${issued.token}.${signature}`)}`;
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/auth/child-activity/keep`;
    const send = () => fetch(url, { method:'POST', headers:{ 'Content-Type':'application/json', Origin:'https://parent.example.test', Cookie:cookie },
        body:JSON.stringify({ childAccountId:childId }) });
    try {
        assert.equal((await send()).status, 204);
        assert.equal((resolution as RetentionResolution | null)?.outcome, 'kept');
        assert.equal((await send()).status, 204, 'confirmed keep reconciliation is idempotent');
        unavailable = true;
        assert.equal((await send()).status, 503, 'an unavailable journal must not report fully confirmed keep');
        await revokeAccountSession(database, account.userId, parentId, issued.sessionId);
        assert.equal((await send()).status, 403);
    } finally { server.close(); await once(server, 'close'); }
});

before(async () => {
    assert.equal(process.env.SYNTHETIC_PARENT_CONSENT_REHEARSAL, '1');
    assert.equal(process.env.NODE_ENV, 'test');
    assert.match(process.env.SYNTHETIC_REHEARSAL_CONTAINER ?? '', /^[a-f0-9]{64}$/u);
    assert.equal(config.host, '127.0.0.1'); assert.equal(config.database, 'mickeyf_migration_test');
    assert.equal(config.user, 'migration_test'); assert.equal(config.password, 'migration-test-only');
    assert.equal(config.port, Number(process.env.MIGRATION_TEST_PORT)); assert.notEqual(config.port, 3306);
    for (const key of ['DATABASE_URL', 'DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASS', 'CLOUD_SQL_CONNECTION_NAME',
        'GOOGLE_APPLICATION_CREDENTIALS']) assert.equal(process.env[key], undefined);
    admin = await mysql.createConnection({ host: config.host, port: config.port, database: config.database,
        user: 'root', password: rootPassword, multipleStatements: false, dateStrings: true, timezone: 'Z' });
    const [[target]] = await admin.query<RowDataPacket[]>('SELECT DATABASE() AS db, @@version AS version, @@version_comment AS vendor');
    assert.equal(target.db, config.database); assert.match(target.version, /^8\.0\.31(?:-|$)/u); assert.doesNotMatch(target.vendor, /Google/iu);
    const [tables] = await admin.query<RowDataPacket[]>('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()');
    assert.equal(tables.length, 0, 'never use a database containing existing tables');
    await admin.query(`CREATE TABLE users (user_id INT NOT NULL AUTO_INCREMENT, user_name VARCHAR(255) NOT NULL,
        email VARCHAR(255) NOT NULL, user_password VARCHAR(255) NOT NULL, PRIMARY KEY (user_id), UNIQUE KEY uq_users_email (email))
        ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    const migrations = loadMigrationManifest();
    for (const allowedEffectKinds of [['create-table'] as const, ['drop-column'] as const,
        [...new Set(migrations.filter(migration => migration.version > '0003').map(migration => migration.effect))]]) {
        await applyMigrations(admin as unknown as MigrationConnection, migrations, config, { allowedEffectKinds });
    }
    assertActivityDraft(readFileSync(path.resolve(__dirname, '../../migrations/pending/draft_create_parent_managed_child_activity.sql'), 'utf8'));
    assertWarningDraft(readFileSync(path.resolve(__dirname, '../../migrations/pending/draft_parent_child_inactivity_warnings.sql'), 'utf8'));
    await admin.query(ACTIVITY_DRAFT_SQL);
    await admin.query(WARNING_DRAFT_SQL);
    database = mysql.createPool({ host: config.host, port: config.port, database: config.database, user: 'root',
        password: rootPassword, connectionLimit: 5, multipleStatements: false, dateStrings: true, timezone: 'Z' });
});
after(async () => { if (database) await database.end(); if (admin) await admin.end(); });

test('primary identity verifier checks a real isolated SQL server and respects an external restore hold', async () => {
    const [[identity]] = await admin.query<RowDataPacket[]>(`SELECT DATABASE() AS name, @@GLOBAL.server_uuid AS id,
        DATE_FORMAT(UTC_TIMESTAMP(6),'%Y-%m-%dT%H:%i:%s.%fZ') AS nowUtc`);
    const accounts = await managedFixture();
    const guard = { state: 'active' as const, database: identity.name as string, serverUuid: identity.id as string,
        epoch: randomUUID(), expiresAt: new Date(Date.parse(identity.nowUtc) + 24 * 60 * 60_000).toISOString(), generation: '1' };
    let held = false;
    const journal = { async readRestoreGuard() { return held ? { ...guard, state: 'hold' as const } : guard; },
        async readIntentsForChild() { return []; }, async readResolution() { return null; } };
    const check = createPinnedPrimaryHealth({ database: identity.name, serverUuid: identity.id, journal });
    const connection = await database.getConnection();
    try {
        assert.equal(await check(connection, accounts.parentId, accounts.childId), true);
        held = true;
        assert.equal(await check(connection, accounts.parentId, accounts.childId), false);
    } finally { connection.release(); }
});

test('only a live parent can reconcile a conditional intent after later real SQL activity', async () => {
    const { parentId, childId } = await managedFixture();
    const store = createChildInactivitySqlStore(database, createInAppInactivityQualityResolver(Buffer.alloc(32, 3), async () => false));
    const [[parent]] = await admin.query<RowDataPacket[]>('SELECT user_id FROM users WHERE account_uuid=?', [parentId]);
    const sessionId = randomBytes(32).toString('base64url');
    const account = { accountId: parentId, userId: parent.user_id as number };
    assert.equal(await createAccountSession(database, account, sessionId, Math.floor(Date.now() / 1000) + 1800), true);
    const intent: RetentionIntent = { parentId, childId, warningId: randomUUID(), activityAt: '2020-01-01T00:00:00.000000Z',
        deliveredAt: '2023-01-01T00:00:00.000000Z', channel: 'in-app', targetDigest: 'a'.repeat(64),
        noticeDigest: 'b'.repeat(64), receiptDigest: 'c'.repeat(64) };
    let resolution: RetentionResolution | null = null;
    const journal = { async verifyRetentionIntent(value: RetentionIntent) { return value.warningId === intent.warningId; },
        async readResolution() { return resolution; },
        async recordResolution(_intent: RetentionIntent, value: RetentionResolution) { resolution = value; } };
    const proof = { accountId: parentId, sessionId };
    assert.equal(await reconcileKeptRetentionIntent(store, journal, intent, proof, Buffer.alloc(32, 8)), false);
    await admin.query('UPDATE parent_managed_child_activity SET retention_activity_at=UTC_TIMESTAMP(6)-INTERVAL 1 SECOND WHERE child_uuid=?', [childId]);
    assert.equal(await reconcileKeptRetentionIntent(store, journal, intent, { ...proof, sessionId: randomBytes(32).toString('base64url') }, Buffer.alloc(32, 8)), false);
    assert.equal(await reconcileKeptRetentionIntent(store, journal, intent, proof, Buffer.alloc(32, 8)), true);
    assert.equal((resolution as RetentionResolution | null)?.outcome, 'kept');
    await revokeAccountSession(database, account.userId, parentId, sessionId);
    assert.equal(await reconcileKeptRetentionIntent(store, journal, intent, proof, Buffer.alloc(32, 8)), false);
});

test('administrator reconciliation verifies actual primary identity and absence under a hold', async () => {
    const [[identity]] = await admin.query<RowDataPacket[]>('SELECT DATABASE() AS db, CURRENT_USER() AS user, @@GLOBAL.server_uuid AS id');
    const guard = { state: 'hold' as const, database: identity.db as string, serverUuid: identity.id as string,
        epoch: randomUUID(), expiresAt: '2099-01-01T00:00:00.000Z', generation: '1' };
    const intent: RetentionIntent = { parentId: randomUUID(), childId: randomUUID(), warningId: randomUUID(),
        activityAt: '2020-01-01T00:00:00.000000Z', deliveredAt: '2023-01-01T00:00:00.000000Z', channel: 'in-app',
        targetDigest: 'a'.repeat(64), noticeDigest: 'b'.repeat(64), receiptDigest: 'c'.repeat(64) };
    let recorded: RetentionResolution | null = null;
    const journal = { async readRestoreGuard() { return guard; }, async verifyRetentionIntent() { return true; },
        async readResolution() { return recorded; },
        async recordResolution(_intent: RetentionIntent, value: RetentionResolution) { recorded = value; } };
    const pins = { database: guard.database, serverUuid: guard.serverUuid, currentUser: identity.user as string,
        confirmation: 'ORIGINAL PRIMARY DRAINED AND ACCOUNT ABSENT' };
    const wrongAdmin = await mysql.createConnection({ host: config.host, port: config.port, database: config.database,
        user: 'root', password: rootPassword, multipleStatements: false, dateStrings: true, timezone: 'Z' });
    await assert.rejects(reconcileDeletedRetentionIntent(wrongAdmin as unknown as mysql.PoolConnection, journal, intent,
        { ...pins, currentUser: 'not-the-pinned-admin@localhost' }, Buffer.alloc(32, 8)), /Keep restoration on hold/);
    assert.equal(recorded, null);
    assert.equal(await reconcileDeletedRetentionIntent(admin as unknown as mysql.PoolConnection, journal, intent, pins, Buffer.alloc(32, 8)), true);
    assert.equal((recorded as RetentionResolution | null)?.outcome, 'deleted');
    const { childId } = await managedFixture();
    recorded = null;
    assert.equal(await reconcileDeletedRetentionIntent(admin as unknown as mysql.PoolConnection, journal,
        { ...intent, childId }, pins, Buffer.alloc(32, 8)), false);
    assert.equal(recorded, null);
});

test('administrator fence rejects a live runtime SQL session and releases its global lock', async () => {
    const [[identity]] = await admin.query<RowDataPacket[]>('SELECT DATABASE() AS db,CURRENT_USER() AS user,@@GLOBAL.server_uuid AS id');
    const guard = { state: 'hold' as const, database: identity.db as string, serverUuid: identity.id as string,
        epoch: randomUUID(), expiresAt: '2099-01-01T00:00:00.000Z', generation: '1' };
    const intent: RetentionIntent = { parentId: randomUUID(), childId: randomUUID(), warningId: randomUUID(),
        activityAt: '2020-01-01T00:00:00.000000Z', deliveredAt: '2023-01-01T00:00:00.000000Z', channel: 'in-app',
        targetDigest: 'a'.repeat(64), noticeDigest: 'b'.repeat(64), receiptDigest: 'c'.repeat(64) };
    let recorded = false;
    const journal = { async readRestoreGuard() { return guard; }, async verifyRetentionIntent() { return true; },
        async readResolution() { return null; }, async recordResolution() { recorded = true; } };
    const pins = { database: guard.database, serverUuid: guard.serverUuid, currentUser: identity.user as string,
        confirmation: 'ORIGINAL PRIMARY DRAINED AND ACCOUNT ABSENT' };
    await admin.query("CREATE USER 'cms_mickeyf'@'%' IDENTIFIED BY 'synthetic-runtime-only'");
    let runtime: Connection | undefined;
    try {
        await admin.query("GRANT SELECT ON mickeyf_migration_test.* TO 'cms_mickeyf'@'%'");
        runtime = await mysql.createConnection({ host: config.host, port: config.port, database: config.database,
            user: 'cms_mickeyf', password: 'synthetic-runtime-only', multipleStatements: false });
        const candidate = await mysql.createConnection({ host: config.host, port: config.port, database: config.database,
            user: 'root', password: rootPassword, multipleStatements: false });
        await assert.rejects(reconcileDeletedRetentionIntent(candidate as unknown as mysql.PoolConnection, journal,
            intent, pins, Buffer.alloc(32, 8)), /Keep restoration on hold/);
        assert.equal(recorded, false);
        const probe = randomUUID();
        await admin.query({ sql: 'INSERT INTO users (user_name,email,user_password,account_uuid) VALUES (?,?,?,?)', timeout: 2000 },
            [`probe-${probe}`, `${probe}@example.test`, 'synthetic', probe]);
        await admin.query('DELETE FROM users WHERE account_uuid=?', [probe]);
    } finally {
        if (runtime) await runtime.end();
        await admin.query("DROP USER 'cms_mickeyf'@'%'");
    }
});

test('operator command pins a real SQL target before confirming a deleted intent', async () => {
    const [[identity]] = await admin.query<RowDataPacket[]>('SELECT DATABASE() AS db,CURRENT_USER() AS user,@@GLOBAL.server_uuid AS id');
    const guard = { state: 'hold' as const, database: identity.db as string, serverUuid: identity.id as string,
        epoch: randomUUID(), expiresAt: '2099-01-01T00:00:00.000Z', generation: '1' };
    const intent: RetentionIntent = { parentId: randomUUID(), childId: randomUUID(), warningId: randomUUID(),
        activityAt: '2020-01-01T00:00:00.000000Z', deliveredAt: '2023-01-01T00:00:00.000000Z', channel: 'in-app',
        targetDigest: 'a'.repeat(64), noticeDigest: 'b'.repeat(64), receiptDigest: 'c'.repeat(64) };
    let records = 0;
    const journal = { async readRestoreGuard() { return guard; }, async verifyRetentionIntent() { return true; },
        async readResolution() { return null; }, async recordResolution() { records++; } } as unknown as ReturnType<typeof createGcsRetentionJournal>;
    const pins = { database: guard.database, serverUuid: guard.serverUuid, originalServerUuid: guard.serverUuid, currentUser: identity.user as string };
    await assert.rejects(executeRetentionReconciliation('confirm-deleted',
        { confirmation: 'ORIGINAL PRIMARY DRAINED AND ACCOUNT ABSENT', intent }, { ...pins, serverUuid: randomUUID() },
        journal, database, Buffer.alloc(32, 8)));
    assert.equal(records, 0);
    assert.deepEqual(await executeRetentionReconciliation('confirm-deleted',
        { confirmation: 'ORIGINAL PRIMARY DRAINED AND ACCOUNT ABSENT', intent }, pins, journal, database, Buffer.alloc(32, 8)),
    { operation: 'confirm-deleted', confirmed: true });
    assert.equal(records, 1);
});

test('guard activation audits an isolated SQL target while runtime writers are drained', async () => {
    const [[identity]] = await admin.query<RowDataPacket[]>('SELECT DATABASE() AS db,CURRENT_USER() AS user,@@GLOBAL.server_uuid AS id');
    const original = randomUUID();
    const guard = { state: 'hold' as const, database: identity.db as string, serverUuid: original,
        epoch: randomUUID(), expiresAt: '2099-01-01T00:00:00.000Z', generation: '1' };
    let writes = 0;
    const journal = { async readRestoreGuard() { return guard; }, async readIntents() { return []; },
        async readResolution() { return null; }, async writeRestoreGuard(value: { state: string; serverUuid: string }, generation: string) {
            assert.equal(value.state, 'active'); assert.equal(value.serverUuid, identity.id); assert.equal(generation, '1'); writes++; return '2';
        } };
    const pins = { database: identity.db as string, serverUuid: identity.id as string, originalServerUuid: original,
        currentUser: identity.user as string, confirmation: 'ALL WRITERS FENCED AND INTENTS RECONCILED' };
    const connection = await database.getConnection();
    const explicit = { async readDeletionIntents() { return { intents: [], digest: 'a'.repeat(64) }; } };
    try { assert.equal(await activateRetentionGuard(connection, journal, pins, explicit), '2'); }
    finally { connection.release(); }
    assert.equal(writes, 1);
});

test('guard activation rejects unreconciled explicit deletion and withdrawal on isolated SQL', async () => {
    const { childId, unrelatedId } = await managedFixture();
    const [[identity]] = await admin.query<RowDataPacket[]>('SELECT DATABASE() AS db,CURRENT_USER() AS user,@@GLOBAL.server_uuid AS id');
    const original = randomUUID();
    const guard = { state: 'hold' as const, database: identity.db as string, serverUuid: original,
        epoch: randomUUID(), expiresAt: '2099-01-01T00:00:00.000Z', generation: '1' };
    let writes = 0;
    const journal = { async readRestoreGuard() { return guard; }, async readIntents() { return []; },
        async readResolution() { return null; }, async writeRestoreGuard() { writes++; return '2'; } };
    const pins = { database: identity.db as string, serverUuid: identity.id as string, originalServerUuid: original,
        currentUser: identity.user as string, confirmation: 'ALL WRITERS FENCED AND INTENTS RECONCILED' };
    const explicit = { async readDeletionIntents() { return { digest: 'a'.repeat(64), intents: [
        { version: 1 as const, accountId: unrelatedId, action: 'delete-account' as const, requestedAt: '2024-01-01T00:00:00.000Z' },
        { version: 1 as const, accountId: childId, action: 'withdraw-public-scores' as const, requestedAt: '2024-01-01T00:00:00.000Z' },
    ] }; } };
    const activate = async () => {
        const connection = await database.getConnection();
        try { return await activateRetentionGuard(connection, journal, pins, explicit); }
        finally { connection.release(); }
    };
    await assert.rejects(activate(), /Keep all writers and traffic stopped/);
    assert.equal(writes, 0);
    await admin.query('DELETE FROM users WHERE account_uuid=?', [unrelatedId]);
    await assert.rejects(activate(), /Keep all writers and traffic stopped/);
    assert.equal(writes, 0);
    await admin.query("INSERT INTO account_score_permissions (account_uuid,visibility,confirmed_at) VALUES (?,'private',UTC_TIMESTAMP(6))", [childId]);
    assert.equal(await activate(), '2');
    assert.equal(writes, 1);
});

test('activation reads the guarded explicit journal while the real SQL lock is held', async () => {
    const [[identity]] = await admin.query<RowDataPacket[]>('SELECT DATABASE() AS db,CURRENT_USER() AS user,@@GLOBAL.server_uuid AS id');
    const original = randomUUID(), lineage = randomUUID(), keys = generateKeyPairSync('ed25519');
    const guard = { state: 'hold' as const, database: identity.db as string, serverUuid: original,
        epoch: randomUUID(), expiresAt: '2099-01-01T00:00:00.000Z', generation: '1',
        recoveryCheckpoint: { lineage, minimumEpoch: '1', keySha256: createHash('sha256')
            .update(keys.publicKey.export({ type: 'spki', format: 'der' })).digest('hex') } };
    let writes = 0, reads = 0;
    const journal = { async readRestoreGuard() { return guard; }, async readIntents() { return []; },
        async readResolution() { return null; }, async writeRestoreGuard() { writes++; return '2'; } };
    const pins = { database: identity.db as string, serverUuid: identity.id as string, originalServerUuid: original,
        currentUser: identity.user as string, confirmation: 'ALL WRITERS FENCED AND INTENTS RECONCILED' };
    await admin.query(`CREATE TABLE account_recovery_checkpoint (singleton_id TINYINT UNSIGNED PRIMARY KEY,
        lineage_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, epoch BIGINT UNSIGNED NOT NULL) ENGINE=InnoDB`);
    try {
        await admin.query('INSERT INTO account_recovery_checkpoint VALUES (1,?,1)', [lineage]);
        const client: JournalHttpClient = { async request() { reads++; return { status: 200, data: { kind: 'storage#objects', items: [] } }; } };
        const explicit = await createGuardedDeletionReplayReader({ database, guard: journal,
            pins: { database: pins.database, currentUser: pins.currentUser, targetServerUuid: pins.serverUuid,
                originalServerUuid: pins.originalServerUuid }, publicKey: keys.publicKey, client, readTimeoutMs: 10_000 });
        const connection = await database.getConnection();
        try { assert.equal(await activateRetentionGuard(connection, journal, pins, explicit), '2'); }
        finally { connection.release(); }
        assert.equal(writes, 1); assert.ok(reads >= 2);
    } finally { await admin.query('DROP TABLE account_recovery_checkpoint'); }
});

test('verified deleted outcome applies only to pinned isolated SQL restore without later activity', async () => {
    const { parentId, childId, unrelatedId } = await managedFixture();
    const [[identity]] = await admin.query<RowDataPacket[]>('SELECT DATABASE() AS db, CURRENT_USER() AS user, @@GLOBAL.server_uuid AS id');
    const originalServerUuid = randomUUID();
    const guard = { state: 'hold' as const, database: 'original', serverUuid: originalServerUuid,
        epoch: randomUUID(), expiresAt: '2099-01-01T00:00:00.000Z', generation: '1' };
    const intent: RetentionIntent = { parentId, childId, warningId: randomUUID(),
        activityAt: '2020-01-01T00:00:00.000000Z', deliveredAt: '2023-01-01T00:00:00.000000Z', channel: 'in-app',
        targetDigest: 'a'.repeat(64), noticeDigest: 'b'.repeat(64), receiptDigest: 'c'.repeat(64) };
    const journal = { async readRestoreGuard() { return guard; }, async verifyRetentionIntent() { return true; },
        async recordResolution() {}, async readResolution() { return { outcome: 'deleted' as const,
            confirmedAt: '2024-01-01T00:00:00.000000Z', observedActivityAt: null, proofDigest: 'd'.repeat(64) }; } };
    const store = createChildInactivitySqlStore(database, createInAppInactivityQualityResolver(Buffer.alloc(32, 3), async () => false));
    const pins = { database: identity.db as string, serverUuid: identity.id as string, originalServerUuid,
        currentUser: identity.user as string, confirmation: 'ISOLATED RESTORE FENCED AND DELETION VERIFIED' };
    assert.equal(await reconcileRestoredDeletedIntent(store, journal, intent, { ...pins, serverUuid: originalServerUuid }), false);
    await admin.query("UPDATE parent_managed_child_activity SET retention_activity_at='2021-01-01 00:00:00.000000' WHERE child_uuid=?", [childId]);
    assert.equal(await reconcileRestoredDeletedIntent(store, journal, intent, pins), false);
    await admin.query("UPDATE parent_managed_child_activity SET retention_activity_at='2020-01-01 00:00:00.000000' WHERE child_uuid=?", [childId]);
    assert.equal(await reconcileRestoredDeletedIntent(store, journal, intent, pins), true);
    const [users] = await admin.query<RowDataPacket[]>('SELECT account_uuid FROM users WHERE account_uuid IN (?,?,?)', [parentId, childId, unrelatedId]);
    assert.deepEqual(users.map(row => row.account_uuid).sort(), [parentId, unrelatedId].sort());
});

test('conditional recovery holds an older checkpoint before reconciling the synthetic restored child', async () => {
    const { parentId, childId, unrelatedId } = await managedFixture();
    const [[identity]] = await admin.query<RowDataPacket[]>('SELECT DATABASE() AS db,CURRENT_USER() AS user,@@GLOBAL.server_uuid AS id');
    const originalServerUuid = randomUUID(), lineage = randomUUID();
    const intent: RetentionIntent = { parentId, childId, warningId: randomUUID(),
        activityAt: '2020-01-01T00:00:00.000000Z', deliveredAt: '2023-01-01T00:00:00.000000Z', channel: 'in-app',
        targetDigest: 'a'.repeat(64), noticeDigest: 'b'.repeat(64), receiptDigest: 'c'.repeat(64) };
    const guard = { state: 'hold' as const, database: identity.db as string, serverUuid: originalServerUuid,
        epoch: randomUUID(), expiresAt: '2099-01-01T00:00:00.000Z', generation: '1',
        recoveryCheckpoint: { lineage, minimumEpoch: '1', keySha256: 'a'.repeat(64) } };
    const journal = { async readRestoreGuard() { return guard; }, async verifyRetentionIntent() { return true; },
        async readResolution() { return { outcome: 'deleted' as const, confirmedAt: '2024-01-01T00:00:00.000000Z',
            observedActivityAt: null, proofDigest: 'd'.repeat(64) }; } };
    const pins = { database: identity.db as string, serverUuid: identity.id as string, originalServerUuid, currentUser: identity.user as string };
    const input = { confirmation: 'ISOLATED RESTORE FENCED AND DELETION VERIFIED', intent };
    await admin.query(`CREATE TABLE account_recovery_checkpoint (singleton_id TINYINT UNSIGNED PRIMARY KEY,
        lineage_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,epoch BIGINT UNSIGNED NOT NULL) ENGINE=InnoDB`);
    try {
        await admin.query('INSERT INTO account_recovery_checkpoint VALUES (1,?,0)', [lineage]);
        await assert.rejects(executeRetentionReconciliation('apply-restored', input, pins, journal as never, database, Buffer.alloc(32, 8)));
        assert.equal((await admin.query<RowDataPacket[]>('SELECT user_id FROM users WHERE account_uuid=?', [childId]))[0].length, 1);
        await admin.query('UPDATE account_recovery_checkpoint SET epoch=1');
        assert.deepEqual(await executeRetentionReconciliation('apply-restored', input, pins, journal as never, database, Buffer.alloc(32, 8)),
            { operation: 'apply-restored', confirmed: true });
        const [remaining] = await admin.query<RowDataPacket[]>('SELECT account_uuid FROM users WHERE account_uuid IN (?,?,?)', [parentId, childId, unrelatedId]);
        assert.deepEqual(remaining.map(row => row.account_uuid).sort(), [parentId, unrelatedId].sort());
    } finally { await admin.query('DROP TABLE account_recovery_checkpoint'); }
});

test('read-only operator report scans real SQL and withholds recent activity without disclosing contact', async () => {
    const due = await managedFixture(), recent = await managedFixture(), missing = await managedFixture();
    await admin.query('UPDATE parent_managed_child_activity SET retention_activity_at=UTC_TIMESTAMP(6) WHERE child_uuid=?', [recent.childId]);
    await admin.query('DELETE FROM parent_managed_child_activity WHERE child_uuid=?', [missing.childId]);
    const [[identity]] = await admin.query<RowDataPacket[]>('SELECT DATABASE() AS db, CURRENT_USER() AS user, @@GLOBAL.server_uuid AS id, @@version AS version, @@version_comment AS vendor');
    let output = '';
    const settings = { config, source: { sourceCommit: 'a'.repeat(40), sqlSha256: 'b'.repeat(64) },
        settings: { target: { project: 'synthetic', instance: 'synthetic', database: identity.db, serverUuid: identity.id },
            expectedCurrentUser: identity.user, expectedServerVersion: identity.version, expectedVersionComment: identity.vendor } } as unknown as ReturnType<typeof childSchemaCommandSettings>;
    await runChildInactivityReview([], {}, {
        settings: () => settings, assertSource() {}, input: Readable.from(['{"afterChildId":null}']), write(value) { output = value; },
        connect() { return { connection: admin as unknown as MigrationConnection, async close() {} }; },
    });
    const report = JSON.parse(output);
    assert.equal(report.draftOnly, true);
    assert.equal(report.candidates.find((item: { childId: string }) => item.childId === due.childId)?.review, 'potentially-approaching-warning');
    assert.equal(report.candidates.find((item: { childId: string }) => item.childId === missing.childId)?.review, 'missing-activity');
    assert.equal(report.candidates.some((item: { childId: string }) => item.childId === recent.childId), false);
    assert.doesNotMatch(output, /@example\.test|verified_contact|user_name|user_password/u);
});

async function managedFixture() {
    const parentId = randomUUID(), childId = randomUUID(), unrelatedId = randomUUID();
    for (const id of [parentId, childId, unrelatedId]) {
        const [insert] = await admin.query<ResultSetHeader>('INSERT INTO users (user_name,email,user_password,account_uuid) VALUES (?,?,?,?)',
            [`synthetic-${id}`, `${id}@example.test`, 'not-a-real-password', id]);
        assert.equal(insert.affectedRows, 1);
    }
    await admin.query(`INSERT INTO parent_child_consents (child_uuid,parent_uuid,country_code,policy_digest,consent_version,consented_at)
        VALUES (?,?,'US',?,'synthetic',UTC_TIMESTAMP(6))`, [childId, parentId, Buffer.alloc(32, 4)]);
    await admin.query("INSERT INTO parent_managed_child_activity (child_uuid,retention_activity_at) VALUES (?,'2020-01-01 00:00:00.000000')", [childId]);
    return { parentId, childId, unrelatedId };
}

test('maintenance scans confirmed due accounts and applies the locked deletion checks', async () => {
    await admin.query('DELETE FROM parent_child_inactivity_warnings');
    const due = await managedFixture(), unconfirmed = await managedFixture(), recent = await managedFixture();
    const store = createChildInactivitySqlStore(database, async () => ({ activityComplete: true, targetVerified: true,
        channel: 'email', currentTargetDigest: targetDigest }));
    for (const item of [due, unconfirmed, recent]) {
        const warning = await prepareInactivityWarning(store, item.parentId, item.childId);
        assert.ok(warning);
        if (item === unconfirmed) continue;
        const [[clock]] = await admin.query<RowDataPacket[]>("SELECT DATE_FORMAT(UTC_TIMESTAMP(6),'%Y-%m-%dT%H:%i:%s.%fZ') AS nowValue");
        assert.equal(await confirmInactivityWarning(store, item.parentId, item.childId, {}, async () => ({
            warningId: warning.warningId, parentId: item.parentId, childId: item.childId, targetDigest,
            deliveredAt: clock.nowValue as string, receiptDigest: 'b'.repeat(64),
        }), Date.now() + 1000), true);
        await admin.query('UPDATE parent_child_inactivity_warnings SET prepared_at=UTC_TIMESTAMP(6)-INTERVAL 32 DAY, delivered_at=UTC_TIMESTAMP(6)-INTERVAL 31 DAY WHERE child_uuid=?', [item.childId]);
    }
    await admin.query('UPDATE parent_managed_child_activity SET retention_activity_at=UTC_TIMESTAMP(6) WHERE child_uuid=?', [recent.childId]);
    const intents: string[] = [];
    const journal = { async recordRetentionIntent(intent: { childId: string }) { intents.push(intent.childId); },
        async recordCommittedDeletion(intent: { childId: string }) {
            const [committed] = await admin.query<RowDataPacket[]>('SELECT account_uuid FROM users WHERE account_uuid=?', [intent.childId]);
            assert.equal(committed.length, 0, 'the SQL deletion must commit before recording the outcome');
        }, async verifyRetentionIntent() { return true; }, async verifyActivityContinuity() { return true; } };
    assert.deepEqual(await runChildInactivityMaintenance(database, store, journal, { afterChildId: null }),
        { examined: 1, held: 0, deleted: 1, nextAfterChildId: null });
    assert.deepEqual(intents, [due.childId]);
    const [remaining] = await admin.query<RowDataPacket[]>('SELECT account_uuid FROM users WHERE account_uuid IN (?,?,?)',
        [due.childId, unconfirmed.childId, recent.childId]);
    assert.deepEqual(remaining.map(row => row.account_uuid).sort(), [unconfirmed.childId, recent.childId].sort());
});

test('real SQL requires a confirmed warning, rechecks the SQL clock before journaling, and deletes only the exact child', async () => {
    const { parentId, childId, unrelatedId } = await managedFixture();
    const store = createChildInactivitySqlStore(database, async () => ({ activityComplete: true, targetVerified: true, channel: 'email', currentTargetDigest: targetDigest }));
    const intents: string[] = [];
    const journal = { async recordRetentionIntent(intent: { childId: string }) { intents.push(intent.childId); },
        async recordCommittedDeletion(intent: { childId: string }) {
            const [committed] = await admin.query<RowDataPacket[]>('SELECT account_uuid FROM users WHERE account_uuid=?', [intent.childId]);
            assert.equal(committed.length, 0, 'the SQL deletion must be committed before the resolution');
        }, async verifyRetentionIntent() { return true; }, async verifyActivityContinuity() { return true; } };
    const warning = await prepareInactivityWarning(store, parentId, childId); assert.ok(warning);
    assert.equal(await deleteInactiveChild(store, journal, parentId, childId, Date.now() + 31 * 86400_000), 'held');
    assert.deepEqual(intents, []);
    const [[clock]] = await admin.query<RowDataPacket[]>("SELECT DATE_FORMAT(UTC_TIMESTAMP(6),'%Y-%m-%dT%H:%i:%s.%fZ') AS nowValue");
    const receipt = { warningId: warning.warningId, parentId, childId, targetDigest,
        deliveredAt: clock.nowValue as string, receiptDigest: 'b'.repeat(64) };
    assert.equal(await confirmInactivityWarning(store, parentId, childId, {}, async () => receipt, Date.now() + 1000), true);
    await assert.rejects(deleteInactiveChild(store, journal, parentId, childId, Date.now() + 31 * 86400_000), /SQL deadline changed/u);
    assert.deepEqual(intents, [], 'a future application clock cannot create a premature independent deletion intent');
    await admin.query("UPDATE parent_child_inactivity_warnings SET prepared_at=UTC_TIMESTAMP(6)-INTERVAL 32 DAY, delivered_at=UTC_TIMESTAMP(6)-INTERVAL 31 DAY WHERE child_uuid=?", [childId]);
    assert.equal(await deleteInactiveChild(store, journal, parentId, childId), 'deleted');
    assert.deepEqual(intents, [childId]);
    const [users] = await admin.query<RowDataPacket[]>('SELECT account_uuid FROM users WHERE account_uuid IN (?,?,?)', [parentId, childId, unrelatedId]);
    assert.deepEqual(users.map(row => row.account_uuid).sort(), [parentId, unrelatedId].sort());
    const [remaining] = await admin.query<RowDataPacket[]>('SELECT child_uuid FROM parent_child_inactivity_warnings WHERE child_uuid=?', [childId]);
    assert.equal(remaining.length, 0, 'child deletion cascades the warning row');
    const [activity] = await admin.query<RowDataPacket[]>('SELECT child_uuid FROM parent_managed_child_activity WHERE child_uuid=?', [childId]);
    assert.equal(activity.length, 0, 'child deletion cascades the activity row');
});

test('a locked activity reread blocks concurrent activity writes and the changed timestamp invalidates the warning', async () => {
    const { parentId, childId } = await managedFixture();
    const store = createChildInactivitySqlStore(database, async () => ({ activityComplete: true, targetVerified: true, channel: 'email', currentTargetDigest: targetDigest }));
    const warning = await prepareInactivityWarning(store, parentId, childId); assert.ok(warning);
    let release!: () => void, locked!: () => void;
    const lockedSignal = new Promise<void>(resolve => { locked = resolve; });
    const releaseSignal = new Promise<void>(resolve => { release = resolve; });
    const hold = store.withLockedChild(parentId, childId, async target => {
        assert.ok(await target.snapshot()); locked(); await releaseSignal;
    });
    await lockedSignal;
    let finished = false;
    const update = database.query("UPDATE parent_managed_child_activity SET retention_activity_at=UTC_TIMESTAMP(6) WHERE child_uuid=?", [childId])
        .then(() => { finished = true; });
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(finished, false);
    release(); await hold; await update;
    assert.equal(await confirmInactivityWarning(store, parentId, childId, {}, async () => ({ warningId: warning.warningId,
        parentId, childId, targetDigest, deliveredAt: new Date().toISOString().replace('Z', '000Z'), receiptDigest: 'b'.repeat(64) })), false);
});

test('real SQL accepts only the live parent session for exact-warning acknowledgment', async () => {
    const { parentId, childId } = await managedFixture();
    const store = createChildInactivitySqlStore(database, createInAppInactivityQualityResolver(Buffer.alloc(32, 3), async () => true));
    const [[parent]] = await admin.query<RowDataPacket[]>('SELECT user_id FROM users WHERE account_uuid=?', [parentId]);
    const sessionId = randomBytes(32).toString('base64url');
    const account = { accountId: parentId, userId: parent.user_id as number };
    assert.equal(await createAccountSession(database, account, sessionId, Math.floor(Date.now() / 1000) + 1800), true);
    const key = Buffer.alloc(32, 8), proof = { accountId: parentId, sessionId };
    const context = { account, session: proof } as unknown as ProviderAuthContext;
    const service = createChildInactivityParentService(store, key);
    const result = await service.read(context, { childAccountId: childId });
    assert.ok('warning' in result && result.warning);
    assert.equal(result.warning.acknowledged, false);
    const warningId = result.warning.warningId;
    assert.equal(await acknowledgeInactivityWarning(store, parentId, childId, warningId,
        'ACKNOWLEDGE WARNING', proof, key), true);
    const [rows] = await admin.query<RowDataPacket[]>('SELECT delivered_at,receipt_digest FROM parent_child_inactivity_warnings WHERE child_uuid=?', [childId]);
    assert.equal(rows.length, 1); assert.ok(rows[0].delivered_at); assert.equal(rows[0].receipt_digest.length, 32);
    assert.equal(await acknowledgeInactivityWarning(store, parentId, childId, warningId,
        'ACKNOWLEDGE WARNING', proof, key), true, 'valid repeated acknowledgment is idempotent');
    await revokeAccountSession(database, account.userId, parentId, sessionId);
    assert.equal(await acknowledgeInactivityWarning(store, parentId, childId, warningId,
        'ACKNOWLEDGE WARNING', proof, key), false, 'revoked parent session cannot acknowledge');
});


test('channel replacement holds current warnings and replaces stale warnings under SQL locks', async () => {
    const { parentId, childId } = await managedFixture();
    const emailStore = createChildInactivitySqlStore(database, async () => ({ activityComplete: true, targetVerified: true,
        channel: 'email', currentTargetDigest: targetDigest }));
    const appStore = createChildInactivitySqlStore(database, createInAppInactivityQualityResolver(Buffer.alloc(32, 3), async () => true));
    const [[parent]] = await admin.query<RowDataPacket[]>('SELECT user_id FROM users WHERE account_uuid=?', [parentId]);
    const sessionId = randomBytes(32).toString('base64url');
    const account = { accountId: parentId, userId: parent.user_id as number }, proof = { accountId: parentId, sessionId };
    assert.equal(await createAccountSession(database, account, sessionId, Math.floor(Date.now() / 1000) + 1800), true);
    const service = createChildInactivityParentService(appStore, Buffer.alloc(32, 8));
    const context = { account, session: proof } as unknown as ProviderAuthContext;
    const original = await prepareInactivityWarning(emailStore, parentId, childId); assert.ok(original);
    const [[clock]] = await admin.query<RowDataPacket[]>("SELECT DATE_FORMAT(UTC_TIMESTAMP(6),'%Y-%m-%dT%H:%i:%s.%fZ') AS nowValue");
    assert.equal(await confirmInactivityWarning(emailStore, parentId, childId, {}, async () => ({ warningId: original.warningId,
        parentId, childId, targetDigest, deliveredAt: clock.nowValue as string, receiptDigest: 'b'.repeat(64) }), Date.now() + 1000), true);
    assert.deepEqual(await service.read(context, { childAccountId: childId }), { warning: null }, 'current confirmed email is preserved');
    await admin.query("UPDATE parent_managed_child_activity SET retention_activity_at='2021-01-01 00:00:00.000000' WHERE child_uuid=?", [childId]);
    const appResult = await service.read(context, { childAccountId: childId }); assert.ok('warning' in appResult && appResult.warning);
    assert.notEqual(appResult.warning.warningId, original.warningId);
    assert.equal(await prepareInactivityWarning(emailStore, parentId, childId), null, 'current in-app warning is preserved');
    await admin.query("UPDATE parent_managed_child_activity SET retention_activity_at='2022-01-01 00:00:00.000000' WHERE child_uuid=?", [childId]);
    const replacement = await prepareInactivityWarning(emailStore, parentId, childId); assert.ok(replacement);
    assert.notEqual(replacement.warningId, appResult.warning.warningId); assert.equal(replacement.channel, 'email');
    assert.deepEqual(await service.acknowledge(context, { childAccountId: childId, warningId: appResult.warning.warningId, acknowledge: true }),
        { error: 'UNAVAILABLE' }, 'the superseded warning cannot be acknowledged');
});

test('warning readiness requires the exact table and actual restricted write grants', async () => {
    await admin.query("CREATE USER 'warning_test'@'%' IDENTIFIED BY 'synthetic-warning-test-only'");
    for (const sql of renderRuntimeGrantStatements('mickeyf_migration_test', { user: 'warning_test', host: '%' },
        'google-apple-parent-signed-inactivity').slice(-2)) await admin.query(sql);
    await admin.query('GRANT SELECT (child_uuid) ON mickeyf_migration_test.parent_child_consents TO \'warning_test\'@\'%\'');
    const limited = mysql.createPool({ host: config.host, port: config.port, database: config.database, user: 'warning_test',
        password: 'synthetic-warning-test-only', connectionLimit: 1 });
    try {
        await verifyChildInactivityWarningReadiness(limited);
        await verifyParentManagedChildActivityReadiness(limited);
        await assert.rejects(limited.query('EXPLAIN DELETE FROM parent_child_inactivity_warnings WHERE child_uuid=?', ['not-an-id']));
        await assert.rejects(limited.query('EXPLAIN DELETE FROM parent_managed_child_activity WHERE child_uuid=?', ['not-an-id']));
        await admin.query('REVOKE UPDATE (receipt_digest) ON mickeyf_migration_test.parent_child_inactivity_warnings FROM \'warning_test\'@\'%\'');
        await assert.rejects(verifyChildInactivityWarningReadiness(limited));
    } finally { await limited.end(); await admin.query("DROP USER 'warning_test'@'%'"); }
});

test('mounted warning route checks origin and parent session and acknowledges the exact child over HTTP', async () => {
    const { parentId, childId } = await managedFixture();
    const [[parent]] = await admin.query<RowDataPacket[]>('SELECT user_id, user_name FROM users WHERE account_uuid=?', [parentId]);
    const account = { accountId: parentId, userId: parent.user_id as number, userName: parent.user_name as string };
    const secret = 'synthetic-parent-warning-http-secret';
    const issued = issueSessionToken(account, secret);
    assert.equal(await createAccountSession(database, account, issued.sessionId, issued.expiresAt), true);
    const store = createChildInactivitySqlStore(database, createInAppInactivityQualityResolver(Buffer.alloc(32, 3), async () => true));
    const service = createChildInactivityParentService(store, Buffer.alloc(32, 8), async id => id === parentId ? [childId] : []);
    const app = express(); app.use(cookieParser(secret)); app.use(express.json());
    app.use('/auth', createAuthRouter(database, secret, false, ['https://parent.example.test'],
        { parentRegistrationStorageReady: true, childActivity: parentManagedChildActivity, childInactivity: service,
            reconcileChildKeep: async () => {} }));
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/auth/child-inactivity`;
    const signature = createHmac('sha256', secret).update(issued.token).digest('base64').replace(/=+$/, '');
    const cookie = `__session=${encodeURIComponent(`s:${issued.token}.${signature}`)}`;
    const send = (route: string, body: unknown, origin = 'https://parent.example.test', session = cookie) => fetch(`${base}/${route}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: session }, body: JSON.stringify(body) });
    try {
        assert.equal((await send('warning', { childAccountId: childId }, 'https://attacker.example.test')).status, 403);
        assert.equal((await send('warning', { childAccountId: childId }, undefined, '')).status, 403);
        const pending = await send('pending', {});
        assert.equal(pending.status, 200); assert.deepEqual(await pending.json(), { pending: true });
        const response = await send('warning', { childAccountId: childId });
        assert.equal(response.status, 200); const body = await response.json() as { warning: { warningId: string; acknowledged: boolean } };
        assert.equal(body.warning.acknowledged, false);
        const acknowledgment = await send('acknowledge', { childAccountId: childId, warningId: body.warning.warningId, acknowledge: true });
        assert.equal(acknowledgment.status, 200); assert.deepEqual(await acknowledgment.json(), { acknowledged: true });
        const cleared = await send('pending', {});
        assert.equal(cleared.status, 200); assert.deepEqual(await cleared.json(), { pending: false });
        const again = await send('warning', { childAccountId: childId });
        assert.equal(((await again.json()) as { warning: { acknowledged: boolean } }).warning.acknowledged, true);
        await revokeAccountSession(database, account.userId, parentId, issued.sessionId);
        assert.equal((await send('acknowledge', { childAccountId: childId, warningId: body.warning.warningId, acknowledge: true })).status, 403);
    } finally { server.close(); await once(server, 'close'); }
});

test('production inactivity composition is disabled without independent activity continuity', async () => {
    const [[identity]] = await admin.query<RowDataPacket[]>('SELECT DATABASE() AS db, @@GLOBAL.server_uuid AS serverUuid');
    await assert.rejects(prepareChildInactivityDeployment(database, {
        bucket: 'synthetic-retention-journal', database: identity.db as string, serverUuid: identity.serverUuid as string,
        journalKey: Buffer.alloc(32, 7), targetKey: Buffer.alloc(32, 8), receiptKey: Buffer.alloc(32, 9),
    }), /independent activity continuity/u);
});

test('schema plan creates the four reviewed tables and holds partial DDL or changed metadata', async () => {
    async function run(partial: 'none' | 'warning' | 'continuity' | 'history') {
        const db = `inactivity_test_${randomBytes(5).toString('hex')}`;
        await admin.query(`CREATE DATABASE \`${db}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
        const connection = await mysql.createConnection({ host: config.host, port: config.port, database: db, user: 'root', password: rootPassword });
        try {
            await connection.query(`CREATE TABLE parent_child_consents (child_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY) ENGINE=InnoDB`);
            await connection.query(`CREATE TABLE schema_migrations LIKE mickeyf_migration_test.schema_migrations`);
            await connection.query(`INSERT INTO schema_migrations SELECT * FROM mickeyf_migration_test.schema_migrations`);
            const [[identity]] = await connection.query<RowDataPacket[]>('SELECT CURRENT_USER() AS user,@@GLOBAL.server_uuid AS uuid,@@version AS version,@@version_comment AS comment');
            const target = { project: 'synthetic', instance: 'synthetic', database: db, serverUuid: identity.uuid as string };
            const settings = { target, expectedCurrentUser: identity.user, expectedServerVersion: identity.version,
                expectedVersionComment: identity.comment } as ChildSignedFormMetadataSettings;
            const source = { sourceCommit: 'a'.repeat(40), sqlSha256: CHILD_SIGNED_FORM_SQL_SHA256 };
            const at = Date.now(), observedAt = new Date(at).toISOString(), hash = 'b'.repeat(64);
            const proofBase = { schemaVersion: 1 as const, operation: 'child-schema-prerequisites' as const, sourceCommit: source.sourceCommit,
                sqlSha256: source.sqlSha256, target, pinsSha256: hash, serviceSha256: hash, candidateSha256: hash,
                fallbackSha256: hash, readerSince: new Date(at-301_000).toISOString(), readerVerifiedAt: new Date(at-1_000).toISOString(),
                readerDurationMs: 300_000, automationSha256: hash, backup: { id: '1', endTime: new Date(at-30_000).toISOString(), sha256: hash },
                cloudSqlSha256: hash };
            const safety = { ...proofBase, observedAt, pitr: { earliestRecoveryTime: new Date(at-3600_000).toISOString(),
                latestRecoveryTime: new Date(at-1000).toISOString() }, stableSha256: childSignedFormFingerprint(proofBase) };
            const attempted: string[] = [];
            const wrapped: MigrationConnection = { query: async (sql, values) => {
                const create = /CREATE TABLE (parent_[a-z_]+)/u.exec(sql);
                if (create) attempted.push(create[1]);
                if ((partial === 'warning' && create?.[1] === 'parent_child_inactivity_warnings')
                    || (partial === 'continuity' && create?.[1] === 'parent_child_activity_continuity')
                    || (partial === 'history' && create?.[1] === 'parent_child_warning_history')) throw new Error('synthetic interrupted DDL');
                return await connection.query(sql, values as never) as [unknown, unknown];
            }, destroy() {} };
            const deps = { connection: wrapped, settings, source, assertSource() {}, observeSafety: async () => safety, now: () => at };
            const plan = await planInactivitySchema(deps);
            assert.equal(plan.sqlHashes.length, 4);
            await assert.rejects(verifyInactivitySchema(deps), /blocked/u);
            await assert.rejects(applyInactivitySchema(deps, plan, { allow: true, planSha256: '0'.repeat(64), serverUuid: target.serverUuid }),
                error => error instanceof InactivitySchemaError && error.state === 'blocked');
            assert.deepEqual(attempted, []);
            const approval = { allow: true, planSha256: plan.sha256, serverUuid: target.serverUuid };
            if (partial !== 'none') await assert.rejects(applyInactivitySchema(deps, plan, approval), error => error instanceof InactivitySchemaError && error.state === 'indeterminate');
            else await applyInactivitySchema(deps, plan, approval);
            const [tables] = await connection.query<RowDataPacket[]>(`SELECT TABLE_NAME AS name FROM information_schema.TABLES
                WHERE TABLE_SCHEMA=? AND TABLE_NAME LIKE 'parent_%' ORDER BY TABLE_NAME`, [db]);
            assert.deepEqual(tables.map(row => row.name), partial === 'warning' ? ['parent_child_consents','parent_managed_child_activity']
                : partial === 'continuity' ? ['parent_child_consents','parent_child_inactivity_warnings','parent_managed_child_activity']
                : partial === 'history' ? ['parent_child_activity_continuity','parent_child_consents','parent_child_inactivity_warnings','parent_managed_child_activity']
                : ['parent_child_activity_continuity','parent_child_consents','parent_child_inactivity_warnings','parent_child_warning_history','parent_managed_child_activity']);
            assert.deepEqual(attempted, partial === 'warning' ? ['parent_managed_child_activity', 'parent_child_inactivity_warnings']
                : partial === 'continuity' ? ['parent_managed_child_activity', 'parent_child_inactivity_warnings', 'parent_child_activity_continuity']
                : ['parent_managed_child_activity', 'parent_child_inactivity_warnings', 'parent_child_activity_continuity', 'parent_child_warning_history']);
            await assert.rejects(planInactivitySchema(deps), /blocked/u, 'existing or partial tables cannot be silently reused');
            if (partial === 'none') {
                await verifyInactivitySchema(deps);
                await connection.query('ALTER TABLE parent_child_activity_continuity ALTER CHECK chk_child_continuity_head NOT ENFORCED');
                await assert.rejects(verifyInactivitySchema(deps), /blocked/u);
                await connection.query('ALTER TABLE parent_child_activity_continuity ALTER CHECK chk_child_continuity_head ENFORCED');
                await connection.query(`CREATE TRIGGER synthetic_continuity_trigger BEFORE UPDATE ON parent_child_activity_continuity
                    FOR EACH ROW SET NEW.ledger_json=NEW.ledger_json`);
                await assert.rejects(verifyInactivitySchema(deps), /blocked/u, 'administrative verification must detect triggers hidden from runtime');
                await connection.query('DROP TRIGGER synthetic_continuity_trigger');
                await verifyInactivitySchema(deps);
                assert.equal(attempted.length, 4, 'verification never creates or rewrites tables');
            } else await assert.rejects(verifyInactivitySchema(deps), /blocked/u);
        } finally { await connection.end(); await admin.query(`DROP DATABASE \`${db}\``); }
    }
    await run('none');
    await run('warning');
    await run('continuity');
    await run('history');
});
