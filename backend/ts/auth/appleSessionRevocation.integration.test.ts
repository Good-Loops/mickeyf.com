import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import mysql, { type Connection, type Pool, type PoolConnection, type QueryOptions, type ResultSetHeader, type RowDataPacket } from 'mysql2/promise';
import { loadMigrationConfig } from '../config/migrationConfig';
import { withUserSubmissionLock } from '../leaderboards/userSubmissionLock';
import type { MigrationConnection } from '../migrations/leaderboardSchema';
import { loadMigrationManifest } from '../migrations/migrationManifest';
import { applyMigrations, planMigrations } from '../migrations/migrationRunner';
import { verifyAppleRevocationReadiness } from '../migrations/appleRevocationSchema';
import { createAccountSession, readLiveSession, renewAccountSession } from './accountSessionRepository';
import type { VerifiedAppleNotification } from './appleNotificationVerifier';
import { applyAppleNotification, appleSubjectHash, cleanupExpiredAppleRevocations, type AppleSessionProof } from './appleSessionRevocation';

const config = loadMigrationConfig();
const testPort = Number(process.env.MIGRATION_TEST_PORT);
const CLIENT_ID = 'com.example.disposable-apple-test';
let administrator: Connection;
let database: Pool;
const newId = () => randomBytes(32).toString('base64url');
const expiry = () => Math.floor(Date.now() / 1000) + 3600;
const sessionHash = (id: string) => createHash('sha256').update(id).digest();
const replacement = (id: string) => createHmac('sha256', 'disposable-apple-renewal-key').update(id).digest('base64url');
type Account = { userId: number; accountId: string; subject: string };

before(async () => {
    assert.equal(process.env.NODE_ENV, 'test');
    assert.equal(process.env.MIGRATION_TEST_ENABLED, '1');
    for (const key of ['DATABASE_URL', 'DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASS', 'CLOUD_SQL_CONNECTION_NAME']) {
        assert.equal(process.env[key], undefined, `${key} must be absent in the disposable harness`);
    }
    assert.ok(Number.isSafeInteger(testPort) && testPort > 0 && testPort <= 65535 && testPort !== 3306);
    assert.deepEqual({ host: config.host, port: config.port, database: config.database, user: config.user }, {
        host: '127.0.0.1', port: testPort, database: 'mickeyf_migration_test', user: 'migration_test',
    });
    assert.equal(config.password, 'migration-test-only');
    assert.equal(process.env.MIGRATION_TEST_HOST, config.host);
    assert.equal(process.env.MIGRATION_TEST_DATABASE, config.database);
    assert.equal(process.env.MIGRATION_TEST_USER, config.user);
    assert.equal(process.env.MIGRATION_TEST_PASSWORD, config.password);
    const options = { host: config.host, port: config.port, database: config.database, user: config.user,
        password: config.password, connectTimeout: 10000, multipleStatements: false, dateStrings: true, timezone: 'Z' };
    administrator = await mysql.createConnection(options);
    const [identity] = await administrator.query<RowDataPacket[]>(`SELECT DATABASE() AS databaseName,
        CURRENT_USER() AS currentUser, @@version AS version, @@version_comment AS versionComment`);
    assert.equal(identity.length, 1);
    assert.equal(identity[0].databaseName, 'mickeyf_migration_test');
    assert.equal(identity[0].currentUser, 'migration_test@%');
    assert.match(identity[0].version, /^8\.0\.31(?:-|$)/u);
    assert.doesNotMatch(identity[0].versionComment, /Google/iu);
    // Only the harness-pinned disposable database reaches these fixture resets.
    await administrator.query('SET FOREIGN_KEY_CHECKS = 0');
    try {
        await administrator.query(`DROP TABLE IF EXISTS apple_auth_revocations, apple_provider_tokens,
            account_sessions, provider_auth_attempts, account_provider_identities,
            game_personal_bests, game_runs, game_submission_receipts, schema_migrations, users`);
    } finally { await administrator.query('SET FOREIGN_KEY_CHECKS = 1'); }
    await administrator.query(`CREATE TABLE users (
        user_id INT NOT NULL AUTO_INCREMENT, user_name VARCHAR(255) NOT NULL,
        email VARCHAR(255) NOT NULL, user_password VARCHAR(255) NOT NULL,
        PRIMARY KEY (user_id), UNIQUE KEY uq_users_email (email)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    const connection = administrator as unknown as MigrationConnection;
    const migrations = loadMigrationManifest();
    await applyMigrations(connection, migrations, config);
    await applyMigrations(connection, migrations, config, { allowedEffectKinds: ['drop-column'] });
    await applyMigrations(connection, migrations, config, { allowedEffectKinds: ['detach-best-source', 'retain-receipts'] });
    for (const effect of ['add-account-identity', 'add-provider-identities', 'add-provider-attempts',
        'add-account-sessions', 'add-session-renewal', 'add-unique-user-names', 'allow-passwordless-accounts',
        'extend-provider-attempt-actions', 'add-apple-tokens', 'add-apple-revocations', 'add-apple-session-provenance'] as const) {
        await applyMigrations(connection, migrations, config, { allowedEffectKinds: [effect] });
    }
    assert.deepEqual((await planMigrations(connection, migrations, config)).pending, []);
    await verifyAppleRevocationReadiness(connection);
    database = mysql.createPool({ ...options, connectionLimit: 4 });
});

beforeEach(async () => {
    await administrator.query('DELETE FROM game_personal_bests');
    await administrator.query('DELETE FROM users');
    await administrator.query('DELETE FROM apple_auth_revocations');
});

after(async () => {
    if (database) await database.end();
    if (administrator) await administrator.end();
});

async function databaseNow(): Promise<number> {
    const [rows] = await administrator.query<RowDataPacket[]>("SELECT TIMESTAMPDIFF(SECOND, '1970-01-01', UTC_TIMESTAMP()) AS now");
    return Number(rows[0].now);
}

async function account(subject = randomUUID()): Promise<Account> {
    const name = randomUUID();
    const [inserted] = await administrator.query<ResultSetHeader>(
        'INSERT INTO users (user_name, email, user_password) VALUES (?, ?, ?)', [name, `${name}@example.test`, 'unused-test-only']);
    const [rows] = await administrator.query<RowDataPacket[]>('SELECT account_uuid FROM users WHERE user_id = ?', [inserted.insertId]);
    const target = { userId: inserted.insertId, accountId: String(rows[0].account_uuid), subject };
    await administrator.query(`INSERT INTO account_provider_identities (provider, subject, account_uuid, linked_at)
        VALUES ('apple', ?, ?, UTC_TIMESTAMP(6))`, [Buffer.from(subject), target.accountId]);
    return target;
}

const appleProof = (target: Pick<Account, 'subject'>, issuedAt: number): AppleSessionProof => ({
    clientId: CLIENT_ID, subject: target.subject, issuedAt,
});
const notification = (target: Pick<Account, 'subject'>, eventTime: number): VerifiedAppleNotification => ({
    audience: CLIENT_ID, subject: target.subject, issuedAt: eventTime,
    eventType: 'consent-revoked', eventTime,
}) as VerifiedAppleNotification;

function gate() {
    let open!: () => void;
    const promise = new Promise<void>(resolve => { open = resolve; });
    return { promise, open };
}

async function bounded(promise: Promise<unknown>): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
        await Promise.race([promise, new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('Disposable SQL coordination did not reach its boundary.')), 4500);
        })]);
    } finally { if (timer) clearTimeout(timer); }
}

test('Apple revocation preserves password/Google and newer Apple sessions, including original proof after renewal', async () => {
    const target = await account(); const now = await databaseNow();
    const ids = { password: newId(), google: newId(), older: newId(), renewed: newId(), newer: newId() };
    for (const id of [ids.password, ids.google]) assert.equal(await createAccountSession(database, target, id, expiry()), true);
    assert.equal(await createAccountSession(database, target, ids.older, expiry(), undefined, false, appleProof(target, now - 20)), true);
    assert.equal(await createAccountSession(database, target, ids.renewed, expiry(), undefined, true, appleProof(target, now - 20)), true);
    assert.equal(await createAccountSession(database, target, ids.newer, expiry(), undefined, false, appleProof(target, now - 1)), true);
    await administrator.query(`UPDATE account_sessions SET renewed_at = UTC_TIMESTAMP(6) - INTERVAL 16 MINUTE
        WHERE session_hash = ?`, [sessionHash(ids.renewed)]);
    assert.equal((await renewAccountSession(database, target.userId, target.accountId, ids.renewed, replacement))?.renewal?.sessionId,
        replacement(ids.renewed));
    const [renewed] = await administrator.query<RowDataPacket[]>(
        'SELECT apple_authenticated_at FROM account_sessions WHERE session_hash = ?', [sessionHash(replacement(ids.renewed))]);
    assert.equal(Number(renewed[0].apple_authenticated_at), now - 20);
    await administrator.query(`INSERT INTO game_personal_bests
        (game_id, rules_version, user_id, score, completion_time_ms, recorded_at)
        VALUES ('p4-vega', 1, ?, 50, NULL, UTC_TIMESTAMP(6))`, [target.userId]);
    await applyAppleNotification(database, notification(target, now - 10));
    for (const id of [ids.older, ids.renewed, replacement(ids.renewed)]) {
        assert.equal(await readLiveSession(database, target.userId, target.accountId, id), null);
    }
    for (const id of [ids.password, ids.google, ids.newer]) {
        assert.notEqual(await readLiveSession(database, target.userId, target.accountId, id), null);
    }
    const [preserved] = await administrator.query<RowDataPacket[]>('SELECT score FROM game_personal_bests WHERE user_id = ?', [target.userId]);
    assert.deepEqual(preserved.map(row => row.score), [50]);
    const [linked] = await administrator.query<RowDataPacket[]>('SELECT subject FROM account_provider_identities WHERE account_uuid = ?', [target.accountId]);
    assert.deepEqual(linked[0].subject, Buffer.from(target.subject));
    await applyAppleNotification(database, notification(target, now - 10));
    await applyAppleNotification(database, notification(target, now - 15));
    assert.notEqual(await readLiveSession(database, target.userId, target.accountId, ids.newer), null);
    const [watermark] = await administrator.query<RowDataPacket[]>(`SELECT revoked_at,
        TIMESTAMPDIFF(SECOND, '1970-01-01', expires_at) AS expiresAt FROM apple_auth_revocations`);
    assert.equal(Number(watermark[0].revoked_at), now - 10);
    assert.equal(Number(watermark[0].expiresAt), now - 10 + 330);
});

test('unknown-subject notification blocks pending signup proof and account recreation, but allows fresh authorization', async () => {
    const subject = randomUUID(); const now = await databaseNow();
    await applyAppleNotification(database, notification({ subject }, now - 5));
    const target = await account(subject);
    assert.equal(await createAccountSession(database, target, newId(), expiry(), undefined, false, appleProof(target, now - 10)), false);
    const freshId = newId();
    assert.equal(await createAccountSession(database, target, freshId, expiry(), undefined, false, appleProof(target, now - 1)), true);
    await administrator.query('DELETE FROM users WHERE user_id = ?', [target.userId]);
    const recreated = await account(subject);
    assert.notEqual(recreated.accountId, target.accountId);
    assert.equal(await createAccountSession(database, recreated, newId(), expiry(), undefined, false, appleProof(recreated, now - 10)), false);
    assert.equal(await createAccountSession(database, recreated, newId(), expiry(), undefined, false, appleProof(recreated, now - 1)), true);
});

test('watermark arriving between final proof check and INSERT waits for the user lock, then removes that session', async () => {
    const target = await account(); const now = await databaseNow(); const id = newId();
    const proofChecked = gate(); const releaseInsert = gate(); const eventWaiting = gate();
    const interceptedIssuer = {
        async getConnection() {
            const connection = await database.getConnection();
            return {
                async query(query: QueryOptions, values?: unknown[]) {
                    const result = await connection.query(query, values);
                    if (query.sql.startsWith('SELECT TIMESTAMPDIFF')) {
                        proofChecked.open(); await releaseInsert.promise;
                    }
                    return result;
                }, release() { connection.release(); }, destroy() { connection.destroy(); },
            } as unknown as PoolConnection;
        },
    };
    const interceptedEvent = {
        query: database.query.bind(database),
        async getConnection() {
            const connection = await database.getConnection();
            return {
                async query(query: QueryOptions, values?: unknown[]) {
                    if (query.sql.includes('GET_LOCK') && query.sql.includes('leaderboard-user')) eventWaiting.open();
                    return connection.query(query, values);
                }, release() { connection.release(); }, destroy() { connection.destroy(); },
            } as unknown as PoolConnection;
        },
    } as Pick<Pool, 'query' | 'getConnection'>;
    const issuing = createAccountSession(interceptedIssuer, target, id, expiry(), undefined, false, appleProof(target, now - 1));
    let notifying: Promise<void> | undefined;
    try {
        await bounded(proofChecked.promise);
        notifying = applyAppleNotification(interceptedEvent, notification(target, now));
        await bounded(eventWaiting.promise);
        const [watermark] = await administrator.query<RowDataPacket[]>('SELECT revoked_at FROM apple_auth_revocations');
        assert.equal(Number(watermark[0].revoked_at), now, 'watermark commits before waiting for the user lock');
        releaseInsert.open();
        assert.equal(await issuing, true);
        await notifying;
        assert.equal(await readLiveSession(database, target.userId, target.accountId, id), null);
    } finally {
        releaseInsert.open();
        await Promise.allSettled([issuing, ...(notifying ? [notifying] : [])]);
    }
});

test('proof expiry is checked after the user-lock queue using database time, not initial request time', async () => {
    const target = await account(); const now = await databaseNow();
    const held = gate(); const releaseLock = gate(); const queued = gate();
    const holding = withUserSubmissionLock(database, target.userId, async () => { held.open(); await releaseLock.promise; });
    await bounded(held.promise);
    const connection = await database.getConnection();
    const shiftedConnection = {
        async query(query: QueryOptions, values?: unknown[]) {
            if (query.sql.includes('GET_LOCK')) queued.open();
            const result = await connection.query(query, values);
            if (query.sql.includes('GET_LOCK')) await connection.query('SET timestamp = ?', [now + 301]);
            return result;
        }, release() {}, destroy() { connection.destroy(); },
    } as unknown as PoolConnection;
    const issuing = createAccountSession({ getConnection: async () => shiftedConnection }, target, newId(), expiry(),
        undefined, false, appleProof(target, now));
    try {
        await bounded(queued.promise);
        releaseLock.open(); await holding;
        assert.equal(await issuing, false);
        const [rows] = await administrator.query<RowDataPacket[]>('SELECT session_hash FROM account_sessions');
        assert.equal(rows.length, 0);
    } finally {
        releaseLock.open(); await Promise.allSettled([holding, issuing]);
        await connection.query('SET timestamp = 0'); connection.release();
    }
});

test('stale Apple proof rolls back cap eviction and rejects half-populated provenance', async () => {
    const target = await account(); const now = await databaseNow();
    const ids = Array.from({ length: 10 }, newId);
    for (const id of ids) assert.equal(await createAccountSession(database, target, id, expiry()), true);
    await applyAppleNotification(database, notification(target, now - 5));
    assert.equal(await createAccountSession(database, target, newId(), expiry(), undefined, false, appleProof(target, now - 10)), false);
    const [rows] = await administrator.query<RowDataPacket[]>('SELECT session_hash FROM account_sessions');
    assert.deepEqual(rows.map(row => row.session_hash.toString('hex')).sort(), ids.map(id => sessionHash(id).toString('hex')).sort());
    await assert.rejects(administrator.query('UPDATE account_sessions SET apple_authenticated_at = ? WHERE session_hash = ?',
        [now, sessionHash(ids[0])]), (error: unknown) => (error as { errno?: number }).errno === 3819);
});

test('expired watermark rows are physically purged in bounded batches and old events still revoke old sessions', async () => {
    const target = await account(); const now = await databaseNow(); const id = newId();
    assert.equal(await createAccountSession(database, target, id, expiry(), undefined, false, appleProof(target, now - 1)), true);
    await administrator.query('UPDATE account_sessions SET apple_authenticated_at = ? WHERE session_hash = ?', [now - 1000, sessionHash(id)]);
    const values = Array.from({ length: 101 }, (_, index) => [createHash('sha256').update(`expired-fixture-${index}`).digest(), now - 400]);
    await administrator.query(`INSERT INTO apple_auth_revocations (subject_hash, revoked_at, expires_at) VALUES
        ${values.map(() => '(?, ?, UTC_TIMESTAMP(6) - INTERVAL 1 SECOND)').join(', ')}`, values.flat());
    assert.equal(await cleanupExpiredAppleRevocations(database), 100);
    const [remaining] = await administrator.query<RowDataPacket[]>('SELECT subject_hash FROM apple_auth_revocations');
    assert.equal(remaining.length, 1);
    await applyAppleNotification(database, notification(target, now - 500));
    assert.equal(await readLiveSession(database, target.userId, target.accountId, id), null);
    const [watermarks] = await administrator.query<RowDataPacket[]>('SELECT subject_hash FROM apple_auth_revocations');
    assert.equal(watermarks.length, 0, 'an old delivery cannot restart expired watermark retention');
});
