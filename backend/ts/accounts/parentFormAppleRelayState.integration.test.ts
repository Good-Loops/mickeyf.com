import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import type { VerifiedAppleNotification } from '../auth/appleNotificationVerifier';
import { loadMigrationConfig } from '../config/migrationConfig';
import { cleanupParentFormAppleRelayState, recordParentFormAppleRelayEvent, verifyParentFormAppleRelayWriteAccess } from './parentFormAppleRelayState';
import { verifyParentFormAppleRelayReadiness } from './parentFormAppleRelayReadiness';

let database: Pool;
const reference = randomUUID();
const otherReference = randomUUID();
const futureReference = randomUUID();
const otherSubjectReference = randomUUID();
const otherContactReference = randomUUID();
const subject = 'synthetic-apple-subject';
const email = 'synthetic@privaterelay.appleid.com';

before(async () => {
    const config = loadMigrationConfig();
    assert.equal(process.env.SYNTHETIC_PARENT_CONSENT_REHEARSAL, '1');
    assert.equal(process.env.NODE_ENV, 'test');
    assert.match(process.env.SYNTHETIC_REHEARSAL_CONTAINER ?? '', /^[a-f0-9]{64}$/u);
    assert.equal(config.host, '127.0.0.1'); assert.equal(config.database, 'mickeyf_migration_test');
    assert.equal(config.user, 'migration_test'); assert.equal(config.password, 'migration-test-only');
    assert.equal(config.port, Number(process.env.MIGRATION_TEST_PORT)); assert.notEqual(config.port, 3306);
    for (const key of ['DATABASE_URL', 'DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASS',
        'CLOUD_SQL_CONNECTION_NAME', 'GOOGLE_APPLICATION_CREDENTIALS']) assert.equal(process.env[key], undefined);
    database = mysql.createPool({ host: config.host, port: config.port, user: 'root',
        password: 'migration-test-root-only', database: config.database, dateStrings: true, timezone: 'Z', connectionLimit: 1 });
    const [[target]] = await database.query<RowDataPacket[]>('SELECT DATABASE() AS db, @@version AS version, @@version_comment AS vendor');
    assert.equal(target.db, config.database); assert.match(target.version, /^8\.0\.31(?:-|$)/u);
    assert.doesNotMatch(target.vendor, /Google/iu);
    const [tables] = await database.query<RowDataPacket[]>('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()');
    assert.equal(tables.length, 0, 'rehearsal requires a fresh disposable database');
    await database.query(`CREATE TABLE parent_signed_forms (
        reference CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
        provider ENUM('google','apple') NOT NULL, subject VARBINARY(255) NOT NULL,
        verified_contact VARCHAR(254) NOT NULL, status ENUM('pending','approved','rejected','used') NOT NULL,
        submitted_at DATETIME(6) NOT NULL, expires_at DATETIME(6) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    const schema = readFileSync(path.resolve(__dirname, '../../migrations/pending/draft_parent_form_apple_relay_state.sql'), 'utf8');
    await database.query(schema);
    for (const [id, provider, time] of [[reference, 'apple', 'UTC_TIMESTAMP(6)-INTERVAL 20 SECOND'],
        [otherReference, 'google', 'UTC_TIMESTAMP(6)-INTERVAL 20 SECOND'],
        [futureReference, 'apple', 'UTC_TIMESTAMP(6)+INTERVAL 20 SECOND']]) {
        await database.query(`INSERT INTO parent_signed_forms VALUES (?,?,?,?, 'pending',${time},UTC_TIMESTAMP(6)+INTERVAL 1 DAY)`,
            [id, provider, Buffer.from(subject), email]);
    }
    await database.query(`INSERT INTO parent_signed_forms VALUES
        (?, 'apple', ?, ?, 'pending', UTC_TIMESTAMP(6)-INTERVAL 20 SECOND, UTC_TIMESTAMP(6)+INTERVAL 1 DAY),
        (?, 'apple', ?, ?, 'pending', UTC_TIMESTAMP(6)-INTERVAL 20 SECOND, UTC_TIMESTAMP(6)+INTERVAL 1 DAY)`,
    [otherSubjectReference, Buffer.from('another-subject'), email, otherContactReference, Buffer.from(subject), 'other@privaterelay.appleid.com']);
});

after(async () => { if (database) await database.end(); });

test('real MySQL preserves latest forwarding state and holds equal-time conflicts', async () => {
    await verifyParentFormAppleRelayReadiness(database);
    await verifyParentFormAppleRelayWriteAccess(database);
    // DATETIME fields contain UTC even when the database session is not UTC.
    await database.query("SET time_zone='+05:30'");
    const [[clock]] = await database.query<RowDataPacket[]>('SELECT UNIX_TIMESTAMP() AS now');
    const now = Number(clock.now);
    const event = { audience: 'com.example.app', subject, eventType: 'email-disabled', issuedAt: now,
        eventTime: now - 2, relayEmail: email } as VerifiedAppleNotification;
    const rows = async () => (await database.query<RowDataPacket[]>(
        'SELECT reference,last_event_at,forwarding_disabled FROM parent_form_apple_relay_state ORDER BY reference'))[0];
    await recordParentFormAppleRelayEvent(database, event);
    assert.deepEqual(await rows(), [{ reference, last_event_at: now - 2, forwarding_disabled: 1 }]);
    await recordParentFormAppleRelayEvent(database, { ...event, eventType: 'email-enabled', eventTime: now - 3 });
    await recordParentFormAppleRelayEvent(database, { ...event, eventType: 'email-enabled' });
    assert.deepEqual(await rows(), [{ reference, last_event_at: now - 2, forwarding_disabled: 1 }]);
    await recordParentFormAppleRelayEvent(database, { ...event, eventType: 'email-enabled', eventTime: now - 1 });
    assert.deepEqual(await rows(), [{ reference, last_event_at: now - 1, forwarding_disabled: 0 }]);
    await recordParentFormAppleRelayEvent(database, { ...event, eventTime: now - 1 });
    assert.deepEqual(await rows(), [{ reference, last_event_at: now - 1, forwarding_disabled: 1 }]);
    await database.query("UPDATE parent_signed_forms SET status='used' WHERE reference=?", [reference]);
    assert.deepEqual(await cleanupParentFormAppleRelayState(database), { backlog: false });
    assert.deepEqual(await rows(), [], 'completed requests do not retain relay state');
    await database.query("UPDATE parent_signed_forms SET status='pending' WHERE reference=?", [reference]);
    await recordParentFormAppleRelayEvent(database, event);
    await database.query('DELETE FROM parent_signed_forms WHERE reference=?', [reference]);
    assert.deepEqual(await rows(), [], 'request cleanup cascades its relay state');
    await database.query('ALTER TABLE parent_form_apple_relay_state ADD COLUMN synthetic_drift INT NULL');
    await assert.rejects(verifyParentFormAppleRelayReadiness(database));
});
