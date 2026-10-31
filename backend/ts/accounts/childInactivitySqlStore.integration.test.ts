import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
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
import { createInAppInactivityQualityResolver } from './childInactivityInAppTarget';
import { createPinnedPrimaryHealth } from './retentionPrimaryHealth';
import { createChildInactivityParentService } from './childInactivityParentService';
import type { ProviderAuthContext } from '../auth/providerAuthContext';
import { acknowledgeInactivityWarning, confirmInactivityWarning, deleteInactiveChild, prepareInactivityWarning } from './childInactivityWorkflow';
import { createAccountSession, revokeAccountSession } from '../auth/accountSessionRepository';
import { runChildInactivityReview } from './runChildInactivityReview';
import { runChildInactivityMaintenance } from './childInactivityMaintenance';
import { Readable } from 'node:stream';

const config = loadMigrationConfig();
const rootPassword = 'migration-test-root-only';
const targetDigest = 'a'.repeat(64);
let admin: Connection;
let database: Pool;

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
    await admin.query(`CREATE TABLE parent_managed_child_activity (
        child_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
        retention_activity_at DATETIME(6) NOT NULL,
        FOREIGN KEY (child_uuid) REFERENCES parent_child_consents(child_uuid) ON DELETE CASCADE ON UPDATE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    const sql = readFileSync(path.resolve(__dirname, '../../migrations/pending/draft_parent_child_inactivity_warnings.sql'), 'utf8');
    assert.match(sql, /CREATE TABLE parent_child_inactivity_warnings/u);
    await admin.query(sql);
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
        async readIntents() { return []; } };
    const check = createPinnedPrimaryHealth({ database: identity.name, serverUuid: identity.id, journal });
    const connection = await database.getConnection();
    try {
        assert.equal(await check(connection, accounts.parentId, accounts.childId), true);
        held = true;
        assert.equal(await check(connection, accounts.parentId, accounts.childId), false);
    } finally { connection.release(); }
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
        async verifyRetentionIntent() { return true; }, async verifyActivityContinuity() { return true; } };
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
    const journal = { async recordRetentionIntent(intent: { childId: string }) { intents.push(intent.childId); }, async verifyRetentionIntent() { return true; }, async verifyActivityContinuity() { return true; } };
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
