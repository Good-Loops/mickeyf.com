import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import mysql, { type Connection, type RowDataPacket } from 'mysql2/promise';
import { loadMigrationConfig } from '../config/migrationConfig';
import { renderRuntimeGrantStatements } from '../security/runtimeGrantManifest';
import { loadMigrationManifest } from './migrationManifest';
import { applyMigrations } from './migrationRunner';
import type { MigrationConnection } from './leaderboardSchema';
import { observeChildSignedFormMetadata, createChildSignedFormSchemaReceipt,
    type ChildSignedFormMetadataSettings } from './childSignedFormMetadata';
import { CHILD_SIGNED_FORM_SQL_SHA256, childSignedFormFingerprint, planChildSignedFormOperation, applyChildSignedFormOperation,
    verifyChildSignedFormOperation, type ChildReleaseSafety, type ChildSignedFormOperationDependencies } from './childSignedFormOperation';
import { observeSignedParentFormRetention } from '../accounts/signedParentFormRetention';

const config = loadMigrationConfig();
let admin: Connection;
let runtime: Connection;
let settings: ChildSignedFormMetadataSettings;
const parentId = randomUUID();
const requestId = randomUUID();
const retentionChildId = randomUUID();
const retentionReferences = { approved: randomUUID(), rejected: randomUUID(), expired: randomUUID(), used: randomUUID(), missing: randomUUID() };
const metadataConnection = (connection: Connection) => connection as unknown as MigrationConnection;

before(async () => {
    assert.equal(process.env.CHILD_SCHEMA_TEST_ENABLED, '1');
    assert.equal(process.env.NODE_ENV, 'test'); assert.equal(process.env.MIGRATION_TEST_ENABLED, '1');
    assert.match(process.env.CHILD_SCHEMA_TEST_CONTAINER ?? '', /^[a-f0-9]{64}$/u);
    assert.equal(config.host, '127.0.0.1'); assert.equal(config.database, 'mickeyf_migration_test');
    assert.equal(config.user, 'migration_test'); assert.equal(config.password, 'migration-test-only');
    assert.equal(config.port, Number(process.env.MIGRATION_TEST_PORT)); assert.notEqual(config.port, 3306);
    for (const key of ['DATABASE_URL', 'DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASS', 'CLOUD_SQL_CONNECTION_NAME',
        'GOOGLE_APPLICATION_CREDENTIALS', 'SIGNED_FORM_CONFIRM_SERVER_UUID']) assert.equal(process.env[key], undefined);
    assert.equal(process.env.MIGRATION_TEST_ROOT_PASSWORD, 'migration-test-root-only');
    admin = await mysql.createConnection({ host: config.host, port: config.port, database: config.database, user: 'root',
        password: 'migration-test-root-only', multipleStatements: false, dateStrings: true, timezone: 'Z' });
    const [[target]] = await admin.query<RowDataPacket[]>('SELECT DATABASE() AS db, CURRENT_USER() AS account, @@version AS version, @@version_comment AS vendor, @@server_uuid AS serverUuid');
    assert.equal(target.db, config.database); assert.match(target.version, /^8\.0\.31(?:-|$)/u); assert.doesNotMatch(target.vendor, /Google/iu);
    const [tables] = await admin.query<RowDataPacket[]>('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()');
    assert.equal(tables.length, 0, 'start in a fresh disposable database; never drop existing tables');
    settings = { target: { project: 'synthetic-local', instance: 'synthetic-only', database: config.database, serverUuid: target.serverUuid },
        expectedCurrentUser: target.account, expectedServerVersion: target.version, expectedVersionComment: target.vendor };
    await admin.query(`CREATE TABLE users (user_id INT NOT NULL AUTO_INCREMENT, user_name VARCHAR(255) NOT NULL,
        email VARCHAR(255) NOT NULL, user_password VARCHAR(255) NOT NULL, PRIMARY KEY (user_id), UNIQUE KEY uq_users_email (email))
        ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    const migrations = loadMigrationManifest();
    for (const allowedEffectKinds of [['create-table'] as const, ['drop-column'] as const,
        [...new Set(migrations.filter(migration => migration.version > '0003').map(migration => migration.effect))]]) {
        await applyMigrations(metadataConnection(admin), migrations, config, { allowedEffectKinds });
    }
    await admin.query("CREATE USER 'cms_mickeyf'@'%' IDENTIFIED BY 'synthetic-runtime-only'");
    for (const sql of renderRuntimeGrantStatements(config.database, { user: 'cms_mickeyf', host: '%' }, 'google-apple-parent-signed')) await admin.query(sql);
    runtime = await mysql.createConnection({ host: config.host, port: config.port, database: config.database, user: 'cms_mickeyf',
        password: 'synthetic-runtime-only', multipleStatements: false, dateStrings: true, timezone: 'Z' });
    await admin.query('INSERT INTO users (user_name,email,user_password,account_uuid) VALUES (?,?,?,?)',
        ['SYNTHETIC SCHEMA PARENT', 'synthetic@example.test', 'SYNTHETIC-NOT-A-REAL-PASSWORD-HASH', parentId]);
    await admin.query(`INSERT INTO parent_signed_forms (reference,parent_uuid,country_code,user_name,policy_digest,consent_version,
        policy_version,provider,subject,verified_contact,status,submitted_at,expires_at)
        VALUES (?,?,'US','SYNTHETIC LEGACY REQUEST',?,'synthetic-consent','synthetic-policy','google',?,'synthetic@example.test','pending',UTC_TIMESTAMP(6),UTC_TIMESTAMP(6)+INTERVAL 1 DAY)`,
    [requestId, parentId, Buffer.alloc(32, 1), Buffer.from('SYNTHETIC-SUBJECT')]);
});

after(async () => { if (runtime) await runtime.end(); if (admin) await admin.end(); });

test('actual metadata observer reads only metadata and recognizes exact legacy schema/history/grants', async () => {
    const statements: string[] = [];
    const connection: MigrationConnection = { async query(sql, parameters) {
        statements.push(sql.trim()); return metadataConnection(admin).query(sql, parameters);
    } };
    const snapshot = await observeChildSignedFormMetadata(connection, settings);
    assert.equal(snapshot.capability, 'legacy-us'); assert.equal(snapshot.history.length, 26);
    assert.equal(snapshot.target.serverUuid, settings.target.serverUuid);
    assert.match(snapshot.schemaSha256, /^[a-f0-9]{64}$/u); assert.match(snapshot.grantsSha256, /^[a-f0-9]{64}$/u);
    for (const sql of statements) assert.match(sql, /^(?:SELECT|SHOW)\b/u, 'read-only observation must not SET, lock or mutate');
    assert.throws(() => createChildSignedFormSchemaReceipt(snapshot, { sourceCommit: 'a'.repeat(40), sqlSha256: 'b'.repeat(64) }));
    const [[row]] = await admin.query<RowDataPacket[]>('SELECT user_name,status FROM parent_signed_forms WHERE reference=?', [requestId]);
    assert.equal(row.user_name, 'SYNTHETIC LEGACY REQUEST'); assert.equal(row.status, 'pending');
});

test('wrong database/server/operator/version pins fail before any migration or data change', async () => {
    for (const changed of [
        { ...settings, target: { ...settings.target, database: 'wrong_database' } },
        { ...settings, target: { ...settings.target, serverUuid: '00000000-0000-4000-8000-000000000001' } },
        { ...settings, expectedCurrentUser: 'wrong@%' }, { ...settings, expectedServerVersion: '8.0.31-wrong' },
        { ...settings, expectedVersionComment: 'wrong vendor' },
    ]) await assert.rejects(observeChildSignedFormMetadata(metadataConnection(admin), changed));
});

test('retention observation works on the exact legacy schema before pending 0028 is applied', async () => {
    const missingReference = randomUUID();
    const report = await observeSignedParentFormRetention({ connection: metadataConnection(admin), settings,
        source: { sourceCommit: 'a'.repeat(40), sqlSha256: CHILD_SIGNED_FORM_SQL_SHA256 } }, [requestId, missingReference]);
    assert.deepEqual(report.requests.map(request => request.state), ['pending', 'not-found']);
    assert.equal((await observeChildSignedFormMetadata(metadataConnection(admin), settings)).capability, 'legacy-us');
});

test('unexpected history or a checksum change is rejected without applying an unrelated migration', async () => {
    const first = loadMigrationManifest()[0];
    await admin.query('UPDATE schema_migrations SET checksum=? WHERE version=?', [Buffer.alloc(32, 3), first.version]);
    await assert.rejects(observeChildSignedFormMetadata(metadataConnection(admin), settings));
    await admin.query('UPDATE schema_migrations SET checksum=? WHERE version=?', [first.checksum, first.version]);
    await admin.query("INSERT INTO schema_migrations (version,checksum,applied_at) VALUES ('0027_UNREVIEWED_SYNTHETIC',?,UTC_TIMESTAMP(6))", [Buffer.alloc(32, 4)]);
    await assert.rejects(observeChildSignedFormMetadata(metadataConnection(admin), settings));
    await admin.query("DELETE FROM schema_migrations WHERE version='0027_UNREVIEWED_SYNTHETIC'");
    assert.equal((await observeChildSignedFormMetadata(metadataConnection(admin), settings)).capability, 'legacy-us');
});

test('owner-only review privilege drift and role grants fail the read-only readiness check', async () => {
    await admin.query("GRANT UPDATE (reviewed_at) ON mickeyf_migration_test.parent_signed_forms TO 'cms_mickeyf'@'%'");
    await assert.rejects(observeChildSignedFormMetadata(metadataConnection(admin), settings));
    await admin.query("REVOKE UPDATE (reviewed_at) ON mickeyf_migration_test.parent_signed_forms FROM 'cms_mickeyf'@'%'");
    await admin.query("CREATE ROLE 'synthetic_unexpected_role'@'%'");
    await admin.query("GRANT 'synthetic_unexpected_role'@'%' TO 'cms_mickeyf'@'%'");
    await assert.rejects(observeChildSignedFormMetadata(metadataConnection(admin), settings));
    await admin.query("REVOKE 'synthetic_unexpected_role'@'%' FROM 'cms_mickeyf'@'%'");
    assert.equal((await observeChildSignedFormMetadata(metadataConnection(admin), settings)).capability, 'legacy-us');
});

test('partial nullable-only extension and disabled constraint cannot masquerade as compatible readiness', async () => {
    await admin.query('ALTER TABLE parent_signed_forms MODIFY COLUMN user_name VARCHAR(64) NULL');
    await assert.rejects(observeChildSignedFormMetadata(metadataConnection(admin), settings));
    await admin.query('ALTER TABLE parent_signed_forms MODIFY COLUMN user_name VARCHAR(64) NOT NULL');
    await admin.query('ALTER TABLE parent_signed_forms ALTER CHECK chk_signed_form_status NOT ENFORCED');
    await assert.rejects(observeChildSignedFormMetadata(metadataConnection(admin), settings));
    await admin.query('ALTER TABLE parent_signed_forms ALTER CHECK chk_signed_form_status ENFORCED');
    assert.equal((await observeChildSignedFormMetadata(metadataConnection(admin), settings)).capability, 'legacy-us');
});

test('reviewed operation executes one exact ALTER, preserves legacy requests/history/grants and yields real extended receipt', async () => {
    const before = await observeChildSignedFormMetadata(metadataConnection(admin), settings);
    const at = Date.now();
    const proofBody = {
        schemaVersion: 1, operation: 'child-schema-prerequisites', observedAt: new Date(at).toISOString(),
        sourceCommit: 'a'.repeat(40), sqlSha256: CHILD_SIGNED_FORM_SQL_SHA256, target: settings.target,
        pinsSha256: 'b'.repeat(64), serviceSha256: 'c'.repeat(64), candidateSha256: 'd'.repeat(64), fallbackSha256: 'e'.repeat(64),
        readerSince: new Date(at - 301_000).toISOString(), readerVerifiedAt: new Date(at - 1000).toISOString(), readerDurationMs: 300_000,
        automationSha256: 'f'.repeat(64), backup: { id: '1', endTime: new Date(at - 60_000).toISOString(), sha256: '1'.repeat(64) },
        pitr: { earliestRecoveryTime: new Date(at - 86_400_000).toISOString(), latestRecoveryTime: new Date(at).toISOString() },
        cloudSqlSha256: '2'.repeat(64),
    };
    const { observedAt: _observedAt, pitr: _pitr, ...stableProof } = proofBody;
    const proof = { ...proofBody, stableSha256: childSignedFormFingerprint(stableProof) } as ChildReleaseSafety;
    // Only cloud observations are synthetic here. All SQL, locks, schema and grant observations are real and disposable.
    let alters = 0;
    const connection: MigrationConnection = { async query(sql, values) {
        if (/^ALTER TABLE/u.test(sql)) alters++;
        return metadataConnection(admin).query(sql, values);
    }, destroy() { admin.destroy(); } };
    const deps: ChildSignedFormOperationDependencies = { connection, settings,
        source: { sourceCommit: proof.sourceCommit, sqlSha256: CHILD_SIGNED_FORM_SQL_SHA256 },
        observeReleaseSafety: async () => ({ ...proof, observedAt: new Date().toISOString(),
            pitr: { ...proof.pitr, latestRecoveryTime: new Date().toISOString() } }) };
    const plan = await planChildSignedFormOperation(deps);
    assert.equal(plan.baseline.capability, 'legacy-us'); assert.equal(alters, 0);
    const approval = { approvedPlanSha256: plan.sha256, confirmedServerUuid: settings.target.serverUuid, allowApply: true };
    await assert.rejects(applyChildSignedFormOperation(deps, plan, { ...approval, approvedPlanSha256: '0'.repeat(64) }));
    assert.equal(alters, 0);
    await admin.query("GRANT UPDATE (reviewed_at) ON mickeyf_migration_test.parent_signed_forms TO 'cms_mickeyf'@'%'");
    await assert.rejects(applyChildSignedFormOperation(deps, plan, approval));
    assert.equal(alters, 0, 'privilege drift must prevent ALTER');
    await admin.query("REVOKE UPDATE (reviewed_at) ON mickeyf_migration_test.parent_signed_forms FROM 'cms_mickeyf'@'%'");
    const receipt = await applyChildSignedFormOperation(deps, plan, approval);
    assert.equal(alters, 1); assert.equal(receipt.capability, 'nullable-parent-request-us-br');
    assert.equal(receipt.target.serverUuid, settings.target.serverUuid); assert.equal(receipt.grantsSha256, before.grantsSha256);
    const after = await observeChildSignedFormMetadata(metadataConnection(admin), settings);
    assert.deepEqual(after.history, before.history); assert.notEqual(after.schemaSha256, before.schemaSha256);
    const verified = await verifyChildSignedFormOperation(deps);
    assert.deepEqual({ ...verified, verifiedAt: receipt.verifiedAt }, receipt);
    const [[row]] = await admin.query<RowDataPacket[]>('SELECT user_name,status FROM parent_signed_forms WHERE reference=?', [requestId]);
    assert.equal(row.user_name, 'SYNTHETIC LEGACY REQUEST'); assert.equal(row.status, 'pending');
    await assert.rejects(runtime.query('UPDATE parent_signed_forms SET reviewed_at=UTC_TIMESTAMP(6) WHERE reference=?', [requestId]), /command denied/iu);
    const newReference = randomUUID();
    await runtime.query(`INSERT INTO parent_signed_forms (reference,parent_uuid,country_code,user_name,policy_digest,consent_version,
        policy_version,provider,subject,verified_contact,status,submitted_at,expires_at)
        VALUES (?,?,'BR',NULL,?,'synthetic-consent','synthetic-policy','google',?,'synthetic@example.test','pending',UTC_TIMESTAMP(6),UTC_TIMESTAMP(6)+INTERVAL 1 DAY)`,
    [newReference, parentId, Buffer.alloc(32, 1), Buffer.from('SYNTHETIC-BR-SUBJECT')]);
    const [[created]] = await admin.query<RowDataPacket[]>('SELECT user_name,country_code,status FROM parent_signed_forms WHERE reference=?', [newReference]);
    assert.equal(created.user_name, null); assert.equal(created.country_code, 'BR'); assert.equal(created.status, 'pending');
    await assert.rejects(applyChildSignedFormOperation(deps, plan, approval));
    assert.equal(alters, 1, 'old plan cannot replay an already extended schema');
    assert.throws(() => createChildSignedFormSchemaReceipt(JSON.parse(JSON.stringify(after)), deps.source),
        'a serialized snapshot cannot be promoted into live SQL evidence');
});

test('real retention observation includes all requested statuses without contacts, credentials, writes or child identifiers', async () => {
    await admin.query('INSERT INTO users (user_name,email,user_password,account_uuid) VALUES (?,NULL,?,?)',
        ['SYNTHETIC RETENTION CHILD', 'SYNTHETIC-NOT-A-REAL-PASSWORD-HASH', retentionChildId]);
    for (const [kind, reference] of Object.entries(retentionReferences)) {
        if (kind === 'missing') continue;
        const status = kind === 'expired' ? 'approved' : kind;
        await admin.query(`INSERT INTO parent_signed_forms (reference,parent_uuid,country_code,user_name,policy_digest,consent_version,
            policy_version,provider,subject,verified_contact,status,submitted_at,expires_at,reviewed_at,reviewer,form_sha256,child_uuid)
            VALUES (?,?,'US',NULL,?,'synthetic-consent','synthetic-policy','google',?,'synthetic@example.test',?,UTC_TIMESTAMP(6),
                UTC_TIMESTAMP(6)+INTERVAL ? DAY,UTC_TIMESTAMP(6),'SYNTHETIC-OWNER',?,?)`,
        [reference, parentId, Buffer.alloc(32, 1), Buffer.from('SYNTHETIC-RETENTION-SUBJECT'), status,
            kind === 'expired' || kind === 'used' ? -1 : 1, Buffer.alloc(32, 5), kind === 'used' ? retentionChildId : null]);
    }
    const statements: string[] = [];
    const connection: MigrationConnection = { async query(sql, parameters) {
        statements.push(sql.trim()); return metadataConnection(admin).query(sql, parameters);
    } };
    const references = [requestId, ...Object.values(retentionReferences)];
    const report = await observeSignedParentFormRetention({ connection, settings,
        source: { sourceCommit: 'a'.repeat(40), sqlSha256: CHILD_SIGNED_FORM_SQL_SHA256 } }, references);
    const states = new Map(report.requests.map(request => [request.reference, request.state]));
    assert.equal(states.get(requestId), 'pending');
    assert.equal(states.get(retentionReferences.approved), 'approved');
    assert.equal(states.get(retentionReferences.rejected), 'rejected');
    assert.equal(states.get(retentionReferences.expired), 'expired-unused');
    assert.equal(states.get(retentionReferences.used), 'used', 'used consent must survive the original request expiry');
    assert.equal(states.get(retentionReferences.missing), 'not-found');
    assert.equal(report.requests.length, references.length);
    for (const sql of statements) assert.match(sql, /^(?:SELECT|SHOW)\b/u);
    const encoded = JSON.stringify(report);
    for (const privateValue of ['synthetic@example.test', 'SYNTHETIC-OWNER', 'SYNTHETIC RETENTION CHILD', retentionChildId, parentId]) {
        assert.equal(encoded.includes(privateValue), false, 'retention report must not copy identity/contact/evidence data');
    }
});

test('real retention report detects cascaded form absence and rejects a failed lookup instead of claiming deletion', async () => {
    await admin.query('DELETE FROM users WHERE account_uuid=?', [retentionChildId]);
    const deps = { connection: metadataConnection(admin), settings,
        source: { sourceCommit: 'a'.repeat(40), sqlSha256: CHILD_SIGNED_FORM_SQL_SHA256 } };
    const report = await observeSignedParentFormRetention(deps, [retentionReferences.used]);
    assert.equal(report.requests[0].state, 'not-found');
    assert.equal(report.requests[0].expiresAt, null);
    const unavailable: MigrationConnection = { async query(sql, parameters) {
        if (/FROM parent_signed_forms\b/u.test(sql)) throw new Error('SYNTHETIC PRIVATE LOOKUP FAILURE');
        return metadataConnection(admin).query(sql, parameters);
    } };
    await assert.rejects(observeSignedParentFormRetention({ ...deps, connection: unavailable }, [retentionReferences.used]));
    const [[unchanged]] = await admin.query<RowDataPacket[]>('SELECT status FROM parent_signed_forms WHERE reference=?', [requestId]);
    assert.equal(unchanged.status, 'pending', 'observation must leave unrelated requests untouched');
});
