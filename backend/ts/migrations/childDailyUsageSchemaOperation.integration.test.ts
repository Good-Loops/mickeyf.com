import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import mysql, { type Connection, type RowDataPacket } from 'mysql2/promise';
import { loadMigrationConfig } from '../config/migrationConfig';
import { applyMigrations } from './migrationRunner';
import { loadMigrationManifest } from './migrationManifest';
import type { MigrationConnection } from './leaderboardSchema';
import type { ChildSignedFormMetadataSettings } from './childSignedFormMetadata';
import { childSignedFormFingerprint, CHILD_SIGNED_FORM_SQL_SHA256, type ChildReleaseSafety } from './childSignedFormOperation';
import { applyDailyUsageSchema, planDailyUsageSchema, verifyDailyUsageSchema, DailyUsageSchemaError,
    type DailyUsageSchemaDependencies, type DailyUsageSchemaPlan } from './childDailyUsageSchemaOperation';

const config = loadMigrationConfig();
const source = { sourceCommit: 'a'.repeat(40), sqlSha256: CHILD_SIGNED_FORM_SQL_SHA256 };
let admin: Connection, settings: ChildSignedFormMetadataSettings, proof: ChildReleaseSafety;
let now = Date.now(), destroyCount = 0;
let lostAcknowledgementTable: string | undefined;
const statements: string[] = [];
const connect = () => mysql.createConnection({ host: config.host, port: config.port, database: config.database,
    user: 'root', password: 'migration-test-root-only', multipleStatements: false, dateStrings: true, timezone: 'Z' });
const metadata = (value: Connection) => value as unknown as MigrationConnection;
const connection: MigrationConnection = {
    destroy() { destroyCount++; admin.destroy(); },
    async query(sql, values) {
        statements.push(sql);
        const result = await metadata(admin).query(sql, values);
        if (lostAcknowledgementTable && sql.includes(`CREATE TABLE ${lostAcknowledgementTable} (`)) {
            lostAcknowledgementTable = undefined;
            throw new Error('Synthetic lost acknowledgement with private driver details');
        }
        return result;
    },
};
const deps = (): DailyUsageSchemaDependencies => ({ connection, settings, source, now: () => now, assertSource() {},
    observeSafety: async () => ({ ...proof, observedAt: new Date(now).toISOString() }) });
const approval = (plan: DailyUsageSchemaPlan) => ({ allow: true, planSha256: plan.sha256, serverUuid: settings.target.serverUuid });
const noDdl = () => assert.equal(statements.filter(sql => /\bCREATE TABLE parent_child_daily_usage|\bCREATE TABLE child_daily_usage_withdrawal_receipts/u.test(sql)).length, 0);

before(async () => {
    assert.equal(process.env.NODE_ENV, 'test'); assert.equal(process.env.MIGRATION_TEST_ENABLED, '1');
    assert.equal(process.env.MIGRATION_DB_HOST, '127.0.0.1');
    assert.equal(process.env.MIGRATION_DB_NAME, 'mickeyf_migration_test');
    assert.equal(config.host, '127.0.0.1'); assert.equal(config.database, 'mickeyf_migration_test');
    assert.equal(config.user, 'migration_test'); assert.equal(config.password, 'migration-test-only');
    assert.equal(config.port, Number(process.env.MIGRATION_TEST_PORT)); assert.notEqual(config.port, 3306);
    assert.equal(process.env.MIGRATION_TEST_ROOT_PASSWORD, 'migration-test-root-only');
    for (const key of ['DATABASE_URL', 'DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASS', 'CLOUD_SQL_CONNECTION_NAME',
        'GOOGLE_APPLICATION_CREDENTIALS']) assert.equal(process.env[key], undefined);
    admin = await connect();
    const [[identity]] = await admin.query<RowDataPacket[]>('SELECT DATABASE() AS db,CURRENT_USER() AS account,@@version AS version,@@version_comment AS vendor,@@server_uuid AS uuid');
    assert.equal(identity.db, config.database); assert.match(identity.version, /^8\.0\.31(?:-|$)/u);
    assert.doesNotMatch(identity.vendor, /Google/iu);
    const [tables] = await admin.query<RowDataPacket[]>('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()');
    assert.equal(tables.length, 0, 'The existing harness must supply an empty disposable database.');
    settings = { target: { project: 'synthetic-local', instance: 'synthetic-only', database: config.database, serverUuid: identity.uuid },
        expectedCurrentUser: identity.account, expectedServerVersion: identity.version, expectedVersionComment: identity.vendor,
        runtimeGrantProfile: 'google-apple-parent-signed-recovery' };
    await admin.query(`CREATE TABLE users (user_id INT NOT NULL AUTO_INCREMENT,user_name VARCHAR(255) NOT NULL,
        email VARCHAR(255) NOT NULL,user_password VARCHAR(255) NOT NULL,PRIMARY KEY(user_id),UNIQUE KEY uq_users_email(email))
        ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    const migrations = loadMigrationManifest();
    for (const allowedEffectKinds of [['create-table'] as const, ['drop-column'] as const,
        [...new Set(migrations.filter(migration => migration.version > '0003').map(migration => migration.effect))]]) {
        await applyMigrations(metadata(admin), migrations, config, { allowedEffectKinds });
    }
    now = Date.now();
    const body = { schemaVersion: 1 as const, operation: 'child-schema-prerequisites' as const,
        sourceCommit: source.sourceCommit, sqlSha256: source.sqlSha256, target: settings.target,
        pinsSha256: '1'.repeat(64), serviceSha256: '2'.repeat(64), candidateSha256: '3'.repeat(64), fallbackSha256: '4'.repeat(64),
        readerSince: new Date(now - 300_001).toISOString(), readerVerifiedAt: new Date(now - 1).toISOString(), readerDurationMs: 300_000,
        automationSha256: '5'.repeat(64), backup: { id: '123', endTime: new Date(now - 60_000).toISOString(), sha256: '6'.repeat(64) }, cloudSqlSha256: '7'.repeat(64) };
    proof = { ...body, observedAt: new Date(now).toISOString(),
        pitr: { earliestRecoveryTime: new Date(now - 3_600_000).toISOString(), latestRecoveryTime: new Date(now - 10_000).toISOString() },
        stableSha256: childSignedFormFingerprint(body) };
});
after(async () => { if (admin) await admin.end(); });

let originalPlan: DailyUsageSchemaPlan;
test('plan observes absent tables without DDL; exact approval and fresh target are required', async () => {
    statements.length = 0;
    originalPlan = await planDailyUsageSchema(deps());
    assert.deepEqual(originalPlan.snapshot.tables.map(table => table.present), [false, false]);
    assert.ok(statements.every(sql => /^\s*(?:SELECT|SHOW)\b/u.test(sql))); noDdl();
    for (const change of [{ ...approval(originalPlan), allow: false }, { ...approval(originalPlan), planSha256: '0'.repeat(64) },
        { ...approval(originalPlan), serverUuid: 'd1e6865c-ecad-11ee-a6b0-42010a400002' }]) {
        await assert.rejects(applyDailyUsageSchema(deps(), originalPlan, change), error => error instanceof DailyUsageSchemaError && error.state === 'blocked');
    }
    const expired = { ...deps(), now: () => now + 300_001 };
    await assert.rejects(applyDailyUsageSchema(expired, originalPlan, approval(originalPlan)), /blocked/u);
    await assert.rejects(planDailyUsageSchema({ ...deps(), assertSource() { throw new Error('dirty'); } }), /blocked/u);
    await assert.rejects(planDailyUsageSchema({ ...deps(), settings: { ...settings, expectedCurrentUser: 'wrong@%' } }), /blocked/u);
    noDdl();
});

test('lost first CREATE acknowledgement discards connection; fresh readback rejects blind replay and plans only the missing table', async () => {
    statements.length = 0; lostAcknowledgementTable = 'parent_child_daily_usage';
    await assert.rejects(applyDailyUsageSchema(deps(), originalPlan, approval(originalPlan)), error =>
        error instanceof DailyUsageSchemaError && error.state === 'indeterminate' && !error.message.includes('private driver'));
    assert.equal(destroyCount, 1);
    assert.equal(statements.filter(sql => /CREATE TABLE /u.test(sql)).length, 1);
    assert.ok(!statements.some(sql => sql.includes('RELEASE_LOCK')), 'No cleanup queries are queued on the discarded connection.');
    admin = await connect(); statements.length = 0;
    await assert.rejects(verifyDailyUsageSchema({ ...deps(), observeSafety: async () => { throw new Error('Readback must not call cloud'); } }), /blocked/u);
    await assert.rejects(applyDailyUsageSchema(deps(), originalPlan, approval(originalPlan)), /blocked/u);
    noDdl();
    const fresh = await planDailyUsageSchema(deps());
    assert.deepEqual(fresh.snapshot.tables.map(table => table.present), [true, false]);
    assert.notEqual(fresh.sha256, originalPlan.sha256);
});

test('an existing incompatible table blocks both new planning and verification without modifying it', async () => {
    await admin.query('ALTER TABLE parent_child_daily_usage MODIFY time_zone VARCHAR(99) CHARACTER SET ascii COLLATE ascii_bin NOT NULL');
    statements.length = 0;
    await assert.rejects(planDailyUsageSchema(deps()), /blocked/u);
    await assert.rejects(verifyDailyUsageSchema(deps()), /blocked/u); noDdl();
    await admin.query('ALTER TABLE parent_child_daily_usage MODIFY time_zone VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL');
});

test('fresh approval completes only the missing CREATE; a lost final acknowledgement is resolved by strict read-only verification', async () => {
    const fresh = await planDailyUsageSchema(deps());
    statements.length = 0; lostAcknowledgementTable = 'child_daily_usage_withdrawal_receipts';
    await assert.rejects(applyDailyUsageSchema(deps(), fresh, approval(fresh)), error => error instanceof DailyUsageSchemaError && error.state === 'indeterminate');
    assert.equal(destroyCount, 2);
    const creates = statements.filter(sql => /CREATE TABLE /u.test(sql));
    assert.equal(creates.length, 1); assert.match(creates[0], /CREATE TABLE child_daily_usage_withdrawal_receipts/u);
    admin = await connect(); statements.length = 0;
    const verified = await verifyDailyUsageSchema({ ...deps(), observeSafety: async () => { throw new Error('Readback must not call cloud'); } });
    assert.deepEqual(verified.snapshot.tables.map(table => table.present), [true, true]);
    assert.ok(statements.every(sql => /^\s*(?:SELECT|SHOW)\b/u.test(sql))); noDdl();
    assert.equal(verified.snapshot.history, originalPlan.snapshot.history, 'The historical migration checksums are unchanged.');
    const noOp = await planDailyUsageSchema(deps()); statements.length = 0;
    assert.deepEqual((await applyDailyUsageSchema(deps(), noOp, approval(noOp))).snapshot, verified.snapshot); noDdl();
    assert.equal(statements.filter(sql => sql.includes('GET_LOCK')).length, 2);
    assert.equal(statements.filter(sql => sql.includes('RELEASE_LOCK')).length, 2);
});
