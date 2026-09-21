import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import bcrypt from 'bcryptjs';
import mysql, { type Connection, type Pool, type PoolConnection, type QueryOptions, type ResultSetHeader, type RowDataPacket } from 'mysql2/promise';
import { deleteAccount } from '../accounts/accountDeletionRepository';
import { loadMigrationConfig } from '../config/migrationConfig';
import type { MigrationConnection } from '../migrations/leaderboardSchema';
import { loadMigrationManifest } from '../migrations/migrationManifest';
import { applyMigrations, planMigrations } from '../migrations/migrationRunner';
import { verifyAccountSessionSchema, verifyRenewableAccountSessionSchema } from '../migrations/accountSessionSchema';
import { AccountSessionUnavailableError, createAccountSession, readLiveSession, renewAccountSession, revokeAccountSession } from './accountSessionRepository';

const config = loadMigrationConfig();
const testPort = Number(process.env.MIGRATION_TEST_PORT);
const PASSWORD = 'session-isolated-test-only';
let administrator: Connection;
let database: Pool;
let passwordHash: string;
const newId = () => randomBytes(32).toString('base64url');
const expiry = () => Math.floor(Date.now() / 1000) + 3600;
const hash = (id: string) => createHash('sha256').update(id).digest();
const replacement = (id: string) => createHmac('sha256', 'isolated-renewal-fixture-key').update(id).digest('base64url');

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
        await administrator.query(`DROP TABLE IF EXISTS apple_provider_tokens, account_sessions, provider_auth_attempts, account_provider_identities,
            game_personal_bests, game_runs, game_submission_receipts, schema_migrations, users`);
    } finally { await administrator.query('SET FOREIGN_KEY_CHECKS = 1'); }
    await administrator.query(`CREATE TABLE users (
        user_id INT NOT NULL AUTO_INCREMENT, user_name VARCHAR(255) NOT NULL,
        email VARCHAR(255) NOT NULL, user_password VARCHAR(255) NOT NULL,
        PRIMARY KEY (user_id), UNIQUE KEY uq_users_email (email)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    const connection = administrator as unknown as MigrationConnection;
    // This fixture verifies the historical 0011/0012 transition and its missing-history recovery.
    const migrations = loadMigrationManifest().filter(({ version }) => version <= '0012_add_session_renewal');
    await applyMigrations(connection, migrations, config);
    await applyMigrations(connection, migrations, config, { allowedEffectKinds: ['drop-column'] });
    await applyMigrations(connection, migrations, config, { allowedEffectKinds: ['detach-best-source', 'retain-receipts'] });
    await applyMigrations(connection, migrations, config, { allowedEffectKinds: ['add-account-identity'] });
    await applyMigrations(connection, migrations, config, { allowedEffectKinds: ['add-provider-identities'] });
    await applyMigrations(connection, migrations, config, { allowedEffectKinds: ['add-provider-attempts'] });
    assert.deepEqual((await planMigrations(connection, migrations, config)).pending,
        ['0011_create_account_sessions', '0012_add_session_renewal']);
    await applyMigrations(connection, migrations, config, { allowedEffectKinds: ['add-account-sessions'] });
    await verifyAccountSessionSchema(connection);
    // A pre-renewal device remains non-renewable after this additive migration.
    const [legacyUser] = await administrator.query<ResultSetHeader>(`INSERT INTO users (user_name, email, user_password)
        VALUES ('legacy-session', 'legacy-session@example.test', 'unused-fixture-password')`);
    const legacyId = newId();
    await administrator.query(`INSERT INTO account_sessions (session_hash, account_uuid, created_at, expires_at)
        SELECT ?, account_uuid, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6) + INTERVAL 1 HOUR FROM users WHERE user_id = ?`,
    [hash(legacyId), legacyUser.insertId]);
    assert.deepEqual((await applyMigrations(connection, migrations, config)).pending, ['0012_add_session_renewal']);
    await applyMigrations(connection, migrations, config, { allowedEffectKinds: ['add-session-renewal'] });
    await verifyRenewableAccountSessionSchema(connection);
    const [legacy] = await administrator.query<RowDataPacket[]>('SELECT * FROM account_sessions WHERE session_hash = ?', [hash(legacyId)]);
    assert.equal(legacy[0].remembered, 0); assert.equal(legacy[0].renewed_at, null);
    assert.equal(legacy[0].previous_session_hash, null); assert.equal(legacy[0].previous_valid_until, null);
    assert.deepEqual((await planMigrations(connection, migrations, config)).pending, []);
    database = mysql.createPool({ ...options, connectionLimit: 2 });
    assert.deepEqual(await renewAccountSession(database, legacyUser.insertId, legacy[0].account_uuid, legacyId, replacement),
        { userName: 'legacy-session' });
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
    assert.deepEqual(Object.keys(stored[0]), ['session_hash', 'account_uuid', 'created_at', 'expires_at',
        'remembered', 'renewed_at', 'previous_session_hash', 'previous_valid_until']);
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

test('different accounts can create their first sessions concurrently', async (t) => {
    // Physically empty the disposable index: DELETE can leave unpurged gap-lock boundaries.
    await administrator.query('TRUNCATE TABLE account_sessions');
    const targets = [await account('parallel-first'), await account('parallel-second')];
    const ids = targets.map(newId);
    let arrivals = 0;
    let timedOut = false;
    let release!: () => void;
    const bothScanned = new Promise<void>(resolve => { release = resolve; });
    const timer = setTimeout(() => { timedOut = true; release(); }, 5000);
    const sqlErrors: string[] = [];
    const poolDefaults: string[] = [];
    const synchronized = {
        async getConnection() {
            const connection = await database.getConnection();
            return {
                async query(query: QueryOptions, values?: unknown[]) {
                    try {
                        const result = await connection.query(query, values);
                        if (query.sql === 'COMMIT') {
                            const [settings] = await connection.query<RowDataPacket[]>(
                                'SELECT @@session.transaction_isolation AS isolationLevel');
                            poolDefaults.push(String(settings[0].isolationLevel));
                        }
                        if (query.sql.startsWith('SELECT session_hash FROM account_sessions')) {
                            if (++arrivals === targets.length) release();
                            await bothScanned;
                        }
                        return result;
                    } catch (error) {
                        const failure = error as { code?: string; errno?: number; sqlState?: string };
                        sqlErrors.push(`${failure.code}/${failure.errno}/${failure.sqlState}`);
                        release();
                        throw error;
                    }
                },
                release() { connection.release(); },
                destroy() { connection.destroy(); },
            } as unknown as PoolConnection;
        },
    };
    try {
        const results = await Promise.allSettled(targets.map((target, index) =>
            createAccountSession(synchronized, target, ids[index], expiry(), passwordHash)));
        if (sqlErrors.length) t.diagnostic(`SQL error codes only: ${sqlErrors.join(', ')}`);
        assert.equal(timedOut, false, 'both accounts must reach the insert boundary together');
        assert.equal(arrivals, 2);
        assert.deepEqual(results, targets.map(() => ({ status: 'fulfilled', value: true })));
        assert.deepEqual(poolDefaults, ['REPEATABLE-READ', 'REPEATABLE-READ']);
        assert.equal((await rows()).length, 2);
        for (const [index, target] of targets.entries()) {
            assert.notEqual(await readLiveSession(database, target.userId, target.accountId, ids[index]), null);
        }
        await revokeAccountSession(database, targets[0].userId, targets[0].accountId, ids[0]);
        assert.equal(await readLiveSession(database, targets[0].userId, targets[0].accountId, ids[0]), null);
        assert.notEqual(await readLiveSession(database, targets[1].userId, targets[1].accountId, ids[1]), null);
    } finally {
        clearTimeout(timer);
        release();
    }
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

test('parallel renewal produces one replacement and a thirty-day idle deadline even for a years-old active session', async () => {
    const target = await account('renewal-fixture'); const id = newId();
    await createAccountSession(database, target, id, expiry(), passwordHash, true);
    await administrator.query(`UPDATE account_sessions SET created_at = '2000-01-01',
        renewed_at = UTC_TIMESTAMP(6) - INTERVAL 16 MINUTE WHERE session_hash = ?`, [hash(id)]);
    const results = await Promise.all([0, 1].map(() => renewAccountSession(database,
        target.userId, target.accountId, id, replacement)));
    assert.deepEqual(results[0], results[1]);
    assert.equal(results[0]?.renewal?.sessionId, replacement(id));
    assert.equal(results[0]!.renewal!.expiresAt - results[0]!.renewal!.issuedAt, 30 * 86400);
    const stored = await rows();
    assert.equal(stored.length, 1); assert.equal(stored[0].created_at, '2000-01-01 00:00:00.000000');
    assert.deepEqual(stored[0].session_hash, hash(replacement(id)));
    assert.deepEqual(stored[0].previous_session_hash, hash(id));
    assert.equal(stored[0].remembered, 1);
    assert.deepEqual(await readLiveSession(database, target.userId, target.accountId, id), { userName: 'renewal-fixture' });
    assert.deepEqual(await renewAccountSession(database, target.userId, target.accountId, replacement(id), replacement),
        { userName: 'renewal-fixture' });
    await administrator.query(`UPDATE account_sessions SET previous_valid_until = UTC_TIMESTAMP(6) - INTERVAL 1 SECOND
        WHERE session_hash = ?`, [hash(replacement(id))]);
    assert.equal(await readLiveSession(database, target.userId, target.accountId, id), null);
    assert.equal(await renewAccountSession(database, target.userId, target.accountId, id, replacement), null);
    assert.notEqual(await readLiveSession(database, target.userId, target.accountId, replacement(id)), null);
    // An in-flight logout must still revoke the rotated device when its grace has ended.
    await revokeAccountSession(database, target.userId, target.accountId, id);
    assert.equal(await readLiveSession(database, target.userId, target.accountId, replacement(id)), null);
});

test('only one predecessor is retained; a second rotation does not revive an older generation', async () => {
    const target = await account(); const first = newId();
    await createAccountSession(database, target, first, expiry(), undefined, true);
    const rotateDue = async (id: string) => {
        await administrator.query('UPDATE account_sessions SET renewed_at = UTC_TIMESTAMP(6) - INTERVAL 16 MINUTE WHERE session_hash = ?', [hash(id)]);
        return renewAccountSession(database, target.userId, target.accountId, id, replacement);
    };
    const second = (await rotateDue(first))!.renewal!.sessionId;
    const third = (await rotateDue(second))!.renewal!.sessionId;
    assert.notEqual(second, first); assert.notEqual(third, second);
    assert.equal(await renewAccountSession(database, target.userId, target.accountId, first, replacement), null);
    assert.equal(await readLiveSession(database, target.userId, target.accountId, first), null);
    assert.deepEqual((await rows())[0].previous_session_hash, hash(second));
    assert.equal((await rows()).length, 1);
});

test('expired and revoked remembered sessions cannot renew; ordinary sessions never change their deadline', async () => {
    const target = await account('idle-fixture'); const ordinary = newId(); const remembered = newId();
    await createAccountSession(database, target, ordinary, expiry());
    await createAccountSession(database, target, remembered, expiry(), undefined, true);
    await administrator.query('UPDATE account_sessions SET renewed_at = UTC_TIMESTAMP(6) - INTERVAL 1 DAY WHERE account_uuid = ?', [target.accountId]);
    const before = (await rows()).find(row => row.session_hash.equals(hash(ordinary)))!;
    assert.deepEqual(await renewAccountSession(database, target.userId, target.accountId, ordinary, replacement),
        { userName: 'idle-fixture' });
    assert.deepEqual((await rows()).find(row => row.session_hash.equals(hash(ordinary))), before);
    await administrator.query('UPDATE account_sessions SET expires_at = UTC_TIMESTAMP(6) WHERE session_hash = ?', [hash(remembered)]);
    assert.equal(await renewAccountSession(database, target.userId, target.accountId, remembered, replacement), null);
    await revokeAccountSession(database, target.userId, target.accountId, ordinary);
    assert.equal(await renewAccountSession(database, target.userId, target.accountId, ordinary, replacement), null);
});

test('a lost renewal acknowledgement is recoverable using the original credential without a second rotation', async () => {
    const target = await account(); const id = newId();
    await createAccountSession(database, target, id, expiry(), undefined, true);
    await administrator.query('UPDATE account_sessions SET renewed_at = UTC_TIMESTAMP(6) - INTERVAL 16 MINUTE WHERE session_hash = ?', [hash(id)]);
    const connection = await database.getConnection(); let destroyed = false;
    const uncertain = {
        async query(query: QueryOptions, values?: unknown[]) {
            const result = await connection.query(query, values);
            if (query.sql === 'COMMIT') throw new Error('simulated lost renewal acknowledgement');
            return result;
        }, release() { connection.release(); }, destroy() { destroyed = true; connection.destroy(); },
    } as unknown as PoolConnection;
    await assert.rejects(renewAccountSession({ getConnection: async () => uncertain }, target.userId, target.accountId, id, replacement),
        AccountSessionUnavailableError);
    assert.equal(destroyed, true);
    const stored = (await rows())[0];
    const recovered = await renewAccountSession(database, target.userId, target.accountId, id, replacement);
    assert.equal(recovered?.renewal?.sessionId, replacement(id));
    assert.deepEqual((await rows())[0], stored);
});

test('concurrent renewal and logout never resurrect the revoked device or affect another device', async () => {
    const target = await account(); const revoked = newId(); const other = newId();
    await createAccountSession(database, target, revoked, expiry(), undefined, true);
    await createAccountSession(database, target, other, expiry(), undefined, true);
    await administrator.query('UPDATE account_sessions SET renewed_at = UTC_TIMESTAMP(6) - INTERVAL 16 MINUTE WHERE session_hash = ?', [hash(revoked)]);
    await Promise.all([
        renewAccountSession(database, target.userId, target.accountId, revoked, replacement),
        revokeAccountSession(database, target.userId, target.accountId, revoked),
    ]);
    assert.equal(await readLiveSession(database, target.userId, target.accountId, revoked), null);
    assert.equal(await readLiveSession(database, target.userId, target.accountId, replacement(revoked)), null);
    assert.equal(await renewAccountSession(database, target.userId, target.accountId, revoked, replacement), null);
    assert.notEqual(await readLiveSession(database, target.userId, target.accountId, other), null);
    assert.equal((await rows()).length, 1);
});

test('renewal after schema DDL can recover its missing history record without rerunning ALTER', async () => {
    const version = '0012_add_session_renewal';
    const migrations = loadMigrationManifest().filter(migration => migration.version <= version);
    await administrator.query('DELETE FROM schema_migrations WHERE version = ?', [version]);
    const connection = administrator as unknown as MigrationConnection;
    assert.deepEqual((await planMigrations(connection, migrations, config)).recoverable, [version]);
    assert.deepEqual((await applyMigrations(connection, migrations, config, { allowedEffectKinds: ['add-session-renewal'] })).pending, []);
    await verifyRenewableAccountSessionSchema(connection);
});
