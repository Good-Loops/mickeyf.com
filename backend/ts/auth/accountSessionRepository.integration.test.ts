import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import bcrypt from 'bcryptjs';
import mysql, { type Connection, type Pool, type PoolConnection, type QueryOptions, type ResultSetHeader, type RowDataPacket } from 'mysql2/promise';
import { deleteAccount } from '../accounts/accountDeletionRepository';
import { loadMigrationConfig } from '../config/migrationConfig';
import type { MigrationConnection } from '../migrations/leaderboardSchema';
import { loadMigrationManifest } from '../migrations/migrationManifest';
import { applyMigrations, planMigrations } from '../migrations/migrationRunner';
import { verifyAccountSessionSchema } from '../migrations/accountSessionSchema';
import { AccountSessionUnavailableError, createAccountSession, readLiveSession, revokeAccountSession } from './accountSessionRepository';

const config = loadMigrationConfig();
const testPort = Number(process.env.MIGRATION_TEST_PORT);
const PASSWORD = 'session-isolated-test-only';
let administrator: Connection;
let database: Pool;
let passwordHash: string;
const newId = () => randomBytes(32).toString('base64url');
const expiry = () => Math.floor(Date.now() / 1000) + 3600;
const hash = (id: string) => createHash('sha256').update(id).digest();

before(async () => {
    assert.equal(process.env.NODE_ENV, 'test');
    assert.equal(process.env.MIGRATION_TEST_ENABLED, '1');
    for (const key of ['DATABASE_URL', 'DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASS', 'CLOUD_SQL_CONNECTION_NAME']) {
        assert.equal(process.env[key], undefined, `${key} must be absent in the disposable harness`);
    }
    assert.ok(Number.isSafeInteger(testPort) && testPort >= 1 && testPort <= 65535 && testPort !== 3306);
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
    await administrator.query('SET FOREIGN_KEY_CHECKS = 0');
    try {
        await administrator.query(`DROP TABLE IF EXISTS account_sessions, provider_auth_attempts, account_provider_identities,
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
    await applyMigrations(connection, migrations, config, { allowedEffectKinds: ['add-account-identity'] });
    await applyMigrations(connection, migrations, config, { allowedEffectKinds: ['add-provider-identities'] });
    await applyMigrations(connection, migrations, config, { allowedEffectKinds: ['add-provider-attempts'] });
    assert.deepEqual((await planMigrations(connection, migrations, config)).pending, ['0011_create_account_sessions']);
    await applyMigrations(connection, migrations, config, { allowedEffectKinds: ['add-account-sessions'] });
    await verifyAccountSessionSchema(connection);
    assert.deepEqual((await planMigrations(connection, migrations, config)).pending, []);
    database = mysql.createPool({ ...options, connectionLimit: 2 });
    passwordHash = await bcrypt.hash(PASSWORD, 4);
});

beforeEach(async () => { await administrator.query('DELETE FROM users'); });
after(async () => {
    if (database) await database.end();
    if (administrator) await administrator.end();
});

async function account(name: string = randomUUID()) {
    const [inserted] = await administrator.query<ResultSetHeader>(
        'INSERT INTO users (user_name, email, user_password) VALUES (?, ?, ?)', [name, `${name}@example.test`, passwordHash]);
    const [rows] = await administrator.query<RowDataPacket[]>('SELECT account_uuid FROM users WHERE user_id = ?', [inserted.insertId]);
    return { userId: inserted.insertId, accountId: String(rows[0].account_uuid) };
}
async function rows() {
    const [result] = await administrator.query<RowDataPacket[]>('SELECT * FROM account_sessions ORDER BY account_uuid, created_at, session_hash');
    return result;
}

test('sessions store hashes and UTC expiry across pool time zones; logout revokes only one device and rejects replay', async () => {
    const target = await account('session-fixture');
    const first = newId(); const second = newId();
    const expiresAt = expiry();
    const connection = await database.getConnection();
    await connection.query("SET SESSION time_zone = '+05:30'");
    assert.equal(await createAccountSession({ getConnection: async () => connection }, target, first, expiresAt, passwordHash), true);
    assert.equal(await createAccountSession(database, target, second, expiresAt), true);
    const stored = await rows();
    assert.deepEqual(Object.keys(stored[0]), ['session_hash', 'account_uuid', 'created_at', 'expires_at']);
    assert.deepEqual(stored.map(row => row.session_hash.toString('hex')).sort(), [hash(first).toString('hex'), hash(second).toString('hex')].sort());
    const [time] = await administrator.query<RowDataPacket[]>(`SELECT TIMESTAMPDIFF(SECOND,
        '1970-01-01 00:00:00', expires_at) AS expires FROM account_sessions`);
    assert.deepEqual(time.map(row => row.expires), [expiresAt, expiresAt]);
    assert.deepEqual(await readLiveSession(database, target.userId, target.accountId, first), { userName: 'session-fixture' });
    await revokeAccountSession(database, target.userId, randomUUID(), first);
    assert.equal((await rows()).length, 2);
    await revokeAccountSession(database, target.userId, target.accountId, first);
    await revokeAccountSession(database, target.userId, target.accountId, first);
    assert.equal(await readLiveSession(database, target.userId, target.accountId, first), null);
    assert.deepEqual(await readLiveSession(database, target.userId, target.accountId, second), { userName: 'session-fixture' });
});

test('expiration, password replacement, account deletion and numeric-ID reuse cannot revive authentication', async () => {
    const target = await account(); const id = newId();
    assert.equal(await createAccountSession(database, target, id, expiry(), passwordHash), true);
    await administrator.query('UPDATE account_sessions SET expires_at = UTC_TIMESTAMP(6) WHERE session_hash = ?', [hash(id)]);
    assert.equal(await readLiveSession(database, target.userId, target.accountId, id), null);
    await administrator.query('UPDATE users SET user_password = ? WHERE user_id = ?', ['changed-hash', target.userId]);
    assert.equal(await createAccountSession(database, target, newId(), expiry(), passwordHash), false);
    await administrator.query('DELETE FROM users WHERE user_id = ?', [target.userId]);
    assert.deepEqual(await rows(), []);
    await administrator.query('INSERT INTO users (user_id, user_name, email, user_password) VALUES (?, ?, ?, ?)',
        [target.userId, 'replacement', 'replacement@example.test', passwordHash]);
    assert.equal(await createAccountSession(database, target, newId(), expiry(), passwordHash), false);
    assert.equal(await readLiveSession(database, target.userId, target.accountId, id), null);
});

test('parallel device creation obeys the ten-session cap and evicts oldest only when required', async () => {
    const target = await account(); const unrelated = await account(); const keep = newId();
    assert.equal(await createAccountSession(database, unrelated, keep, expiry()), true);
    const oldest = newId();
    assert.equal(await createAccountSession(database, target, oldest, expiry()), true);
    await administrator.query("UPDATE account_sessions SET created_at = '2000-01-01' WHERE session_hash = ?", [hash(oldest)]);
    const candidates = Array.from({ length: 11 }, newId);
    assert((await Promise.all(candidates.map(id => createAccountSession(database, target, id, expiry())))).every(Boolean));
    const stored = await rows();
    assert.equal(stored.filter(row => row.account_uuid === target.accountId).length, 10);
    assert.equal(stored.length, 11);
    assert.equal(await readLiveSession(database, target.userId, target.accountId, oldest), null);
    assert.notEqual(await readLiveSession(database, unrelated.userId, unrelated.accountId, keep), null);
    await administrator.query('UPDATE account_sessions SET expires_at = UTC_TIMESTAMP(6) WHERE account_uuid = ?', [target.accountId]);
    assert.equal(await createAccountSession(database, target, newId(), expiry()), true);
    assert.equal((await rows()).filter(row => row.account_uuid === target.accountId).length, 1);
});

test('ordinary account deletion cascades all its sessions and preserves unrelated devices', async () => {
    const target = await account(); const unrelated = await account(); const keep = newId();
    await createAccountSession(database, target, newId(), expiry());
    await createAccountSession(database, target, newId(), expiry());
    await createAccountSession(database, unrelated, keep, expiry());
    const journal: string[] = [];
    assert.equal(await deleteAccount(database, target.userId, PASSWORD, {
        async recordAccountDeletion(id) { journal.push(id); },
    }), 'deleted');
    assert.deepEqual(journal, [target.accountId]);
    assert.equal((await rows()).length, 1);
    assert.notEqual(await readLiveSession(database, unrelated.userId, unrelated.accountId, keep), null);
});

test('lost logout commit acknowledgement is sanitized and the revoked token stays revoked', async () => {
    const target = await account(); const id = newId();
    await createAccountSession(database, target, id, expiry());
    const connection = await database.getConnection();
    let destroyed = false;
    const uncertain = {
        async query(query: QueryOptions, values?: unknown[]) {
            const result = await connection.query(query, values);
            if (query.sql === 'COMMIT') throw new Error('simulated lost acknowledgement');
            return result;
        }, release() { connection.release(); }, destroy() { destroyed = true; connection.destroy(); },
    } as unknown as PoolConnection;
    await assert.rejects(revokeAccountSession({ getConnection: async () => uncertain }, target.userId, target.accountId, id),
        AccountSessionUnavailableError);
    assert.equal(destroyed, true);
    assert.equal(await readLiveSession(database, target.userId, target.accountId, id), null);
});
