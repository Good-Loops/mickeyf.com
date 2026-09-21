import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { issueSessionToken } from '../security/sessionPolicy';
import { WEB_SESSION_COOKIE } from '../security/sessionCookie';
import { createAccountSession, revokeAccountSession } from './accountSessionRepository';
import mysql, { type Connection, type Pool, type PoolConnection, type QueryOptions, type ResultSetHeader, type RowDataPacket } from 'mysql2/promise';
import { deleteAccount } from '../accounts/accountDeletionRepository';
import { findProviderAccount, linkProviderAccount, persistProviderCredential } from '../accounts/providerAccountRepository';
import { createAppleTokenRepository, type StoredAppleToken } from '../accounts/appleTokenRepository';
import { loadMigrationConfig } from '../config/migrationConfig';
import { submitP4VegaScore } from '../leaderboards/p4VegaScoreRepository';
import { submitThreeBossesRun } from '../leaderboards/threeBossesRunRepository';
import type { MigrationConnection } from '../migrations/leaderboardSchema';
import { loadMigrationManifest } from '../migrations/migrationManifest';
import { applyMigrations } from '../migrations/migrationRunner';
import {
    consumeProviderAttempt, createProviderAttempt, ProviderAttemptUnavailableError, type ProviderAttempt,
} from './providerAttemptRepository';
import { createProviderAuthContextReader } from './providerAuthContext';
import { createProviderAuthFlow } from './providerAuthFlow';
import { createProviderTokenVerifier } from './providerTokenVerifier';
import type { VerifiedProviderIdentity } from './providerIdentity';
import { createProviderAuthRouter } from '../routers/providerAuthRouter';

const config = loadMigrationConfig();
const testPort = Number(process.env.MIGRATION_TEST_PORT);
const TEST_PASSWORD = 'attempt-isolated-test-only';
const tokenVault = createAppleTokenRepository({ clientId: 'com.example.disposable', activeKeyId: 'test',
    encryptionKeys: { test: randomBytes(32) } });
const localAppleTokens = {
    async exchangeCode(authorizationCode: string) {
        return { idToken: authorizationCode, refreshToken: 'isolated-composed-refresh-token' };
    },
    async revoke() { throw new Error('This fixture must not make a revocation call'); },
};
let administrator: Connection;
let database: Pool;
let passwordHash: string;

function assertIsolatedFixture(): void {
    assert.equal(process.env.NODE_ENV, 'test');
    assert.equal(process.env.MIGRATION_TEST_ENABLED, '1');
    for (const key of ['DATABASE_URL', 'DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASS', 'CLOUD_SQL_CONNECTION_NAME']) {
        assert.equal(process.env[key], undefined, `${key} must be absent in the disposable harness`);
    }
    assert.ok(Number.isSafeInteger(testPort) && testPort >= 1 && testPort <= 65535 && testPort !== 3306);
    assert.deepEqual({ host: config.host, port: config.port, database: config.database, user: config.user }, {
        host: '127.0.0.1', port: testPort, database: 'mickeyf_migration_test', user: 'migration_test',
    }, 'Attempt integration runs only inside the pinned disposable MySQL harness');
    assert.equal(config.password, 'migration-test-only');
    assert.equal(process.env.MIGRATION_TEST_HOST, config.host);
    assert.equal(process.env.MIGRATION_TEST_DATABASE, config.database);
    assert.equal(process.env.MIGRATION_TEST_USER, config.user);
    assert.equal(process.env.MIGRATION_TEST_PASSWORD, config.password);
}

before(async () => {
    assertIsolatedFixture();
    administrator = await mysql.createConnection({
        host: config.host, port: config.port, database: config.database, user: config.user, password: config.password,
        connectTimeout: 10000, multipleStatements: false, dateStrings: true, timezone: 'Z',
    });
    const [identity] = await administrator.query<RowDataPacket[]>(`SELECT DATABASE() AS databaseName,
        CURRENT_USER() AS currentUser, @@version AS version, @@version_comment AS versionComment`);
    assert.equal(identity.length, 1);
    assert.equal(identity[0].databaseName, 'mickeyf_migration_test');
    assert.equal(identity[0].currentUser, 'migration_test@%');
    assert.match(identity[0].version, /^8\.0\.31(?:-|$)/u);
    assert.doesNotMatch(identity[0].versionComment, /Google/iu);
    await administrator.query('SET FOREIGN_KEY_CHECKS = 0');
    try {
        await administrator.query(`DROP TABLE IF EXISTS apple_auth_revocations, apple_provider_tokens, account_sessions, provider_auth_attempts, account_provider_identities,
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
    await applyMigrations(connection, migrations, config, { allowedEffectKinds: ['add-account-sessions'] });
    await applyMigrations(connection, migrations, config, { allowedEffectKinds: ['add-session-renewal'] });
    await applyMigrations(connection, migrations, config, { allowedEffectKinds: ['add-unique-user-names'] });
    await applyMigrations(connection, migrations, config, { allowedEffectKinds: ['allow-passwordless-accounts'] });
    await applyMigrations(connection, migrations, config, { allowedEffectKinds: ['extend-provider-attempt-actions'] });
    await applyMigrations(connection, migrations, config, { allowedEffectKinds: ['add-apple-tokens'] });
    database = mysql.createPool({
        host: config.host, port: config.port, database: config.database, user: config.user, password: config.password,
        connectTimeout: 10000, multipleStatements: false, connectionLimit: 2, dateStrings: true, timezone: 'Z',
    });
    passwordHash = await bcrypt.hash(TEST_PASSWORD, 4);
});

beforeEach(async () => { await administrator.query('DELETE FROM provider_auth_attempts'); });
after(async () => {
    if (database) await database.end();
    if (administrator) await administrator.end();
});

function attempt(overrides: Partial<ProviderAttempt> = {}): ProviderAttempt {
    return {
        stateHash: randomBytes(32), bindingHash: randomBytes(32), nonce: randomBytes(32).toString('base64url'),
        clientKey: 'google-web', action: 'login', userId: null, accountId: null, ...overrides,
    };
}

function consume(value: ProviderAttempt, db: Pick<Pool, 'getConnection'> = database) {
    return consumeProviderAttempt(db, value.stateHash, value.bindingHash, value.clientKey, value.action);
}

async function attemptRows(): Promise<RowDataPacket[]> {
    const [rows] = await administrator.query<RowDataPacket[]>('SELECT * FROM provider_auth_attempts ORDER BY state_hash');
    return rows;
}

async function snapshotAccountData(): Promise<Record<string, RowDataPacket[]>> {
    const snapshots: Record<string, RowDataPacket[]> = {};
    for (const [table, order] of [
        ['users', 'user_id'], ['account_provider_identities', 'account_uuid, provider'],
        ['game_personal_bests', 'game_id, rules_version, user_id'], ['game_submission_receipts', 'game_run_id'],
    ]) {
        [snapshots[table]] = await administrator.query<RowDataPacket[]>(`SELECT * FROM ${table} ORDER BY ${order}`);
    }
    return snapshots;
}

async function createAccount(name: string): Promise<{ userId: number; accountId: string }> {
    const [inserted] = await administrator.query<ResultSetHeader>(
        'INSERT INTO users (user_name,email,user_password) VALUES (?,?,?)', [name, `${name}@example.test`, passwordHash]);
    const [rows] = await administrator.query<RowDataPacket[]>('SELECT account_uuid FROM users WHERE user_id = ?', [inserted.insertId]);
    await submitP4VegaScore(database, inserted.insertId, 500);
    await submitThreeBossesRun(database, inserted.insertId, randomUUID(), 60000);
    await administrator.query(`INSERT INTO account_provider_identities (provider, subject, account_uuid, linked_at)
        VALUES ('google', ?, ?, UTC_TIMESTAMP(6))`, [Buffer.from(name), rows[0].account_uuid]);
    return { userId: inserted.insertId, accountId: rows[0].account_uuid };
}

async function concurrent<T>(operations: Array<(db: Pick<Pool, 'getConnection'>) => Promise<T>>): Promise<T[]> {
    const connections = await Promise.all(operations.map(() => database.getConnection()));
    assert.notEqual(connections[0].threadId, connections[1].threadId);
    // Repository operations own and release these already leased, distinct server sessions.
    const results = await Promise.allSettled(operations.map((operation, index) =>
        operation({ getConnection: async () => connections[index] })));
    return results.map(result => {
        if (result.status === 'rejected') throw result.reason;
        return result.value;
    });
}

test('stores hashed bindings with database-clock expiry and preserves every account and score field', async () => {
    const account = await createAccount('attempt-preserved-fixture');
    const original = await snapshotAccountData();
    for (const value of [attempt(), attempt({ ...account, action: 'link', clientKey: 'apple-web' }),
        attempt({ action: 'signup' }), attempt({ ...account, action: 'delete' })]) {
        assert.equal(await createProviderAttempt(database, value), 'created');
        const [rows] = await administrator.query<RowDataPacket[]>(`SELECT *,
            TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(6), expires_at) AS remainingSeconds
            FROM provider_auth_attempts WHERE state_hash = ?`, [value.stateHash]);
        assert.equal(rows.length, 1);
        assert.deepEqual(rows[0].state_hash, value.stateHash);
        assert.deepEqual(rows[0].binding_hash, value.bindingHash);
        assert.equal(rows[0].nonce, value.nonce);
        assert(rows[0].remainingSeconds >= 295 && rows[0].remainingSeconds <= 300);
        assert.deepEqual(await consume(value), { nonce: value.nonce, userId: value.userId, accountId: value.accountId });
        assert.equal(await consume(value), null);
    }
    assert.deepEqual(await snapshotAccountData(), original);
});

test('real HTTP and SQL create a passwordless Google account, establish its session, then require fresh Google proof for deletion', async () => {
    const original = await snapshotAccountData();
    const sessionSecret = randomBytes(32).toString('base64url');
    const origin = 'https://synthetic-provider-http.example.test';
    const audience = 'synthetic-google-http-client';
    const subject = 'SyntheticGoogleSignupAndDeletionSubject';
    const userName = 'provider-http-passwordless-fixture';
    const key = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const nowSeconds = 1_800_000_000;
    const journaled: string[] = [];
    const verifier = createProviderTokenVerifier({ googleAudience: audience }, {
        now: () => nowSeconds * 1000,
        fetch: async input => {
            assert.equal(String(input), 'https://www.googleapis.com/oauth2/v3/certs');
            return Response.json({ keys: [{ ...key.publicKey.export({ format: 'jwk' }),
                kid: 'synthetic-http-key', alg: 'RS256', use: 'sig' }] });
        },
    });
    const signProof = (nonce: string, selectedSubject = subject) => jwt.sign({
        sub: selectedSubject, nonce, iat: nowSeconds - 10, exp: nowSeconds + 300,
        email: 'synthetic-provider-http@gmail.com', email_verified: true,
    }, key.privateKey, { algorithm: 'RS256', keyid: 'synthetic-http-key', audience, issuer: 'https://accounts.google.com' });
    const app = express();
    app.use(cookieParser(sessionSecret));
    app.use('/auth/providers', createProviderAuthRouter({ database, sessionSecret, isProduction: false,
        allowedOrigins: [origin], clients: { 'google-web': { provider: 'google', verifier } },
        enabled: true, signupEnabled: true, accountDeletionEnabled: true,
        deletionJournal: { async recordAccountDeletion(accountId) { journaled.push(accountId); } },
    }));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/auth/providers`;
    const post = (path: string, body: unknown, cookie = '') => fetch(`${base}/${path}`, {
        method: 'POST', headers: { origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
        body: JSON.stringify(body),
    });
    try {
        const begin = await post('begin', { action: 'signup', clientKey: 'google-web' });
        assert.equal(begin.status, 200);
        const challenge = await begin.json() as { state: string; nonce: string };
        const bindingCookie = begin.headers.getSetCookie()[0].split(';')[0];
        const signup = await post('complete', { action: 'signup', clientKey: 'google-web', userName,
            state: challenge.state, idToken: signProof(challenge.nonce), rememberMe: true }, bindingCookie);
        assert.equal(signup.status, 200);
        assert.deepEqual(await signup.json(), { success: true, user_name: userName });
        // The session writer clears old cookies first; the last same-name cookie
        // wins in a browser and contains the newly committed session.
        const sessionCookie = signup.headers.getSetCookie().filter(value => value.startsWith('__session=')).at(-1)!.split(';')[0];
        const methods = await fetch(`${base}/account`, { headers: { cookie: sessionCookie } });
        assert.equal(methods.status, 200);
        assert.deepEqual(await methods.json(), { hasPassword: false, googleLinked: true, googleDeletionEnabled: true,
            appleLinked: false, appleDeletionEnabled: false });
        const [users] = await administrator.query<RowDataPacket[]>('SELECT account_uuid, user_password FROM users WHERE user_name = ?', [userName]);
        assert.equal(users.length, 1);
        assert.equal(users[0].user_password, null);
        assert.deepEqual(journaled, []);
        for (const wrongSubject of [true, false]) {
            const beginning = await post('begin', { action: 'delete', clientKey: 'google-web' }, sessionCookie);
            assert.equal(beginning.status, 200);
            const deletion = await beginning.json() as { state: string; nonce: string };
            const response = await post('complete', { action: 'delete', clientKey: 'google-web', state: deletion.state,
                idToken: signProof(deletion.nonce, wrongSubject ? 'AnotherGoogleSubject' : subject), confirmation: 'DELETE' }, sessionCookie);
            assert.equal(response.status, wrongSubject ? 401 : 200);
            assert.deepEqual(await response.json(), wrongSubject ? { error: 'INVALID_PROVIDER_TOKEN' } : { success: true, deleted: true });
            if (wrongSubject) {
                assert.equal(response.headers.get('set-cookie'), null);
                assert.deepEqual(journaled, []);
            } else {
                assert.equal(response.headers.getSetCookie().length, 2);
                assert.deepEqual(journaled, [users[0].account_uuid]);
            }
        }
        assert.equal((await fetch(`${base}/account`, { headers: { cookie: sessionCookie } })).status, 401);
        assert.deepEqual(await snapshotAccountData(), original);
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test('wrong browser binding, state, provider client, client case and action cannot consume a valid row', async () => {
    const value = attempt();
    assert.equal(await createProviderAttempt(database, value), 'created');
    const original = await attemptRows();
    for (const change of [
        { bindingHash: randomBytes(32) }, { stateHash: randomBytes(32) }, { clientKey: 'apple-web' },
        { clientKey: 'Google-web' }, { action: 'link' as const },
    ]) {
        assert.equal(await consume({ ...value, ...change }), null);
        assert.deepEqual(await attemptRows(), original);
    }
    assert.deepEqual(await consume(value), { nonce: value.nonce, userId: null, accountId: null });
});

test('two separate database sessions consuming the same attempt yield exactly one durable winner', async () => {
    const value = attempt();
    assert.equal(await createProviderAttempt(database, value), 'created');
    const results = await concurrent([db => consume(value, db), db => consume(value, db)]);
    assert.equal(results.filter(result => result !== null).length, 1);
    assert.equal(results.filter(result => result === null).length, 1);
    assert.deepEqual(results.find(result => result !== null), { nonce: value.nonce, accountId: null, userId: null });
    assert.deepEqual(await attemptRows(), []);
    assert.equal(await consume(value), null);
});

test('expired attempts are removed and a delayed row lock cannot extend their lifetime', async () => {
    const expired = attempt();
    assert.equal(await createProviderAttempt(database, expired), 'created');
    await administrator.query('UPDATE provider_auth_attempts SET expires_at = UTC_TIMESTAMP(6) WHERE state_hash = ?', [expired.stateHash]);
    assert.equal(await consume(expired), null);
    assert.deepEqual(await attemptRows(), []);

    const waiting = attempt();
    assert.equal(await createProviderAttempt(database, waiting), 'created');
    const owner = await database.getConnection();
    const contender = await database.getConnection();
    let signalSelect!: () => void;
    const selectStarted = new Promise<void>(resolve => { signalSelect = resolve; });
    const wrapped = {
        async query(query: QueryOptions, values?: unknown[]) {
            const pending = contender.query(query, values);
            if (query.sql.startsWith('SELECT nonce')) signalSelect();
            return pending;
        },
        release() { contender.release(); }, destroy() { contender.destroy(); },
    } as unknown as PoolConnection;
    let result: Promise<unknown> | undefined;
    try {
        await owner.beginTransaction();
        await owner.query('SELECT state_hash FROM provider_auth_attempts WHERE state_hash = ? FOR UPDATE', [waiting.stateHash]);
        result = consume(waiting, { getConnection: async () => wrapped });
        await selectStarted;
        await owner.query('UPDATE provider_auth_attempts SET expires_at = UTC_TIMESTAMP(6) WHERE state_hash = ?', [waiting.stateHash]);
        await owner.commit();
        assert.equal(await result, null);
    } finally {
        await owner.rollback();
        owner.release();
        if (!result) contender.release();
    }
    assert.deepEqual(await attemptRows(), []);
});

test('starting again replaces only the prior attempt for that browser, including concurrent starts', async () => {
    const original = attempt();
    const unrelated = attempt();
    assert.equal(await createProviderAttempt(database, original), 'created');
    assert.equal(await createProviderAttempt(database, unrelated), 'created');
    const replacements = [attempt({ bindingHash: original.bindingHash }), attempt({ bindingHash: original.bindingHash })];
    assert.deepEqual(await concurrent(replacements.map(value => db => createProviderAttempt(db, value))), ['created', 'created']);
    assert.equal((await attemptRows()).length, 2);
    assert.equal(await consume(original), null);
    const results = await Promise.all(replacements.map(value => consume(value)));
    assert.equal(results.filter(result => result !== null).length, 1);
    assert.deepEqual(await consume(unrelated), { nonce: unrelated.nonce, accountId: null, userId: null });
});

function seedAttempt(index: number): ProviderAttempt {
    return attempt({
        stateHash: createHash('sha256').update(`seed-state-${index}`).digest(),
        bindingHash: createHash('sha256').update(`seed-binding-${index}`).digest(),
    });
}

async function seedRows(count: number, expiresAt: string): Promise<void> {
    for (let offset = 0; offset < count; offset += 500) {
        const values = Array.from({ length: Math.min(500, count - offset) }, (_, position) => {
            const value = seedAttempt(offset + position);
            return [value.stateHash, value.bindingHash, value.nonce, value.clientKey, value.action, null, null, expiresAt];
        });
        await administrator.query(`INSERT INTO provider_auth_attempts
            (state_hash, binding_hash, nonce, client_key, action, user_id, account_uuid, expires_at) VALUES ?`, [values]);
    }
}

test('start-time cleanup deletes at most 100 expired rows per request and retains live attempts', async () => {
    await seedRows(101, '2000-01-01 00:00:00.000000');
    const value = attempt();
    assert.equal(await createProviderAttempt(database, value), 'created');
    const [counts] = await administrator.query<RowDataPacket[]>(`SELECT COUNT(*) AS total,
        SUM(expires_at <= UTC_TIMESTAMP(6)) AS expired FROM provider_auth_attempts`);
    assert.equal(counts[0].total, 2);
    assert.equal(Number(counts[0].expired), 1);
    assert.equal(await createProviderAttempt(database, attempt()), 'created');
    assert.equal((await attemptRows()).length, 2);
    assert.deepEqual(await consume(value), { nonce: value.nonce, accountId: null, userId: null });
});

test('serialized creators respect the 10000-row cap and still allow replacement at capacity', async () => {
    await seedRows(9_999, '2099-01-01 00:00:00.000000');
    const contenders = [attempt(), attempt()];
    const results = await concurrent(contenders.map(value => db => createProviderAttempt(db, value)));
    assert.deepEqual([...results].sort(), ['busy', 'created']);
    const [count] = await administrator.query<RowDataPacket[]>('SELECT COUNT(*) AS total FROM provider_auth_attempts');
    assert.equal(count[0].total, 10_000);
    assert.equal(await createProviderAttempt(database, attempt()), 'busy');
    const replacement = attempt({ bindingHash: seedAttempt(0).bindingHash });
    assert.equal(await createProviderAttempt(database, replacement), 'created');
    assert.equal(await consume(seedAttempt(0)), null);
    assert.deepEqual(await consume(replacement), { nonce: replacement.nonce, accountId: null, userId: null });
});

test('a committed consume with a lost acknowledgement cannot succeed again', async () => {
    const value = attempt();
    assert.equal(await createProviderAttempt(database, value), 'created');
    const connection = await database.getConnection();
    let destroyed = false;
    const uncertain = {
        async query(query: QueryOptions, values?: unknown[]) {
            const result = await connection.query(query, values);
            if (query.sql === 'COMMIT') throw new Error('simulated lost commit acknowledgement');
            return result;
        },
        release() { connection.release(); },
        destroy() { destroyed = true; connection.destroy(); },
    } as unknown as PoolConnection;
    await assert.rejects(consume(value, { getConnection: async () => uncertain }), error => {
        assert(error instanceof ProviderAttemptUnavailableError);
        assert.equal('cause' in error, false);
        return true;
    });
    assert.equal(destroyed, true);
    assert.equal(await consume(value), null);
    assert.deepEqual(await attemptRows(), []);
});

test('ordinary account deletion cascades its link attempt and preserves unrelated login attempts', async () => {
    const account = await createAccount('attempt-deletion-fixture');
    const value = attempt({ ...account, action: 'link' });
    const unrelated = attempt();
    const original = await snapshotAccountData();
    assert.equal(await createProviderAttempt(database, value), 'created');
    assert.equal(await createProviderAttempt(database, unrelated), 'created');
    assert.deepEqual(await snapshotAccountData(), original);
    const journaled: string[] = [];
    assert.equal(await deleteAccount(database, account.userId, TEST_PASSWORD, {
        async recordAccountDeletion(deleted) { journaled.push(deleted); },
    }), 'deleted');
    assert.deepEqual(journaled, [account.accountId]);
    assert.equal(await consume(value), null);
    assert.deepEqual(await consume(unrelated), { nonce: unrelated.nonce, accountId: null, userId: null });
    const remaining = await snapshotAccountData();
    for (const [table, rows] of Object.entries(original)) {
        assert.deepEqual(remaining[table], rows.filter(row => table === 'account_provider_identities'
            ? row.account_uuid !== account.accountId : row.user_id !== account.userId));
    }
});

test('complete flow links a locally verified provider proof, verifies anonymous login and rejects both replays', async () => {
    const userName = 'attempt-complete-flow-fixture';
    const account = await createAccount(userName);
    const original = await snapshotAccountData();
    const key = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const nowSeconds = 1_800_000_000;
    const audience = 'isolated-attempt-complete-flow-client';
    const subject = 'SyntheticAppleCompleteFlowSubject';
    const verifier = createProviderTokenVerifier({ appleAudience: audience }, {
        now: () => nowSeconds * 1000,
        fetch: async input => {
            assert.equal(String(input), 'https://appleid.apple.com/auth/keys');
            return new Response(JSON.stringify({ keys: [{
                ...key.publicKey.export({ format: 'jwk' }), kid: 'isolated-flow-key', alg: 'RS256', use: 'sig',
            }] }), { headers: { 'cache-control': 'max-age=3600' } });
        },
    });
    const signProviderProof = (nonce: string) => jwt.sign({
        sub: subject, nonce, iat: nowSeconds - 10, exp: nowSeconds + 300,
    }, key.privateKey, {
        algorithm: 'RS256', keyid: 'isolated-flow-key', audience, issuer: 'https://appleid.apple.com',
    });
    const flow = createProviderAuthFlow({
        enabled: true,
        clients: { 'apple-web': { provider: 'apple', verifier, appleTokens: localAppleTokens } },
        attempts: {
            create: value => createProviderAttempt(database, value),
            consume: (state, binding, client, action) => consumeProviderAttempt(database, state, binding, client, action),
        },
        accounts: {
            find: identity => findProviderAccount(database, identity),
            link: (target, password, identity, session, refreshToken) => linkProviderAccount(database, target, password, identity, session,
                (connection, locked) => tokenVault.save(connection, tokenVault.prepare(refreshToken!, locked.accountId))),
            saveAppleToken: (target, identity, refreshToken) => persistProviderCredential(database, target, identity,
                (connection, locked) => tokenVault.save(connection, tokenVault.prepare(refreshToken, locked.accountId))),
        },
    });
    const sessionSecret = randomBytes(32).toString('base64url');
    const origin = 'https://provider-flow.example.test';
    const readContext = createProviderAuthContextReader({ database, sessionSecret, allowedOrigins: [origin] });
    const issued = issueSessionToken({ ...account, userName }, sessionSecret);
    assert.equal(await createAccountSession(database, account, issued.sessionId, issued.expiresAt), true);
    const session = issued.token;
    // The context reader receives the cookie-parser boundary; the session JWT is genuinely signed and verified.
    const linkingRequest = {
        method: 'POST', headers: { origin, 'content-type': 'application/json' },
        signedCookies: { [WEB_SESSION_COOKIE]: session },
    };
    const linkContext = await readContext(linkingRequest);
    assert.deepEqual(linkContext?.account, account);
    assert.deepEqual(linkContext?.session, { accountId: account.accountId, sessionId: issued.sessionId });
    const linking = await flow.begin(linkContext, { clientKey: 'apple-web', action: 'link' });
    assert.equal(linking.ok, true);
    if (!linking.ok) throw new Error('The isolated linking challenge must be created');
    const linkingInput = {
        clientKey: 'apple-web', action: 'link', state: linking.state,
        idToken: signProviderProof(linking.nonce), authorizationCode: signProviderProof(linking.nonce), password: TEST_PASSWORD,
    };
    assert.deepEqual(await flow.complete(await readContext(linkingRequest), linkingInput), { ok: true, type: 'linked' });
    assert.deepEqual(await flow.complete(await readContext(linkingRequest), linkingInput), { ok: false, reason: 'INVALID_ATTEMPT' });

    const anonymousRequest = {
        method: 'POST', headers: { origin, 'content-type': 'application/json' },
        signedCookies: {} as Record<string, unknown>,
    };
    assert.equal(await readContext(anonymousRequest), null, 'completion cannot bootstrap an anonymous browser');
    const loginContext = await readContext(anonymousRequest, 'begin');
    assert.ok(loginContext?.anonymousCookie);
    anonymousRequest.signedCookies[loginContext.anonymousCookie.name] = loginContext.anonymousCookie.value;
    assert.equal(loginContext?.account, null);
    assert.deepEqual((await readContext(anonymousRequest))?.bindingHash, loginContext.bindingHash);
    const login = await flow.begin(loginContext, { clientKey: 'apple-web', action: 'login' });
    assert.equal(login.ok, true);
    if (!login.ok) throw new Error('The isolated login challenge must be created');
    const loginInput = {
        clientKey: 'apple-web', action: 'login', state: login.state, idToken: signProviderProof(login.nonce),
        authorizationCode: signProviderProof(login.nonce),
    };
    assert.deepEqual(await flow.complete(await readContext(anonymousRequest), loginInput), {
        ok: true, type: 'account-verified', account: { ...account, userName },
    });
    assert.deepEqual(await flow.complete(await readContext(anonymousRequest), loginInput), { ok: false, reason: 'INVALID_ATTEMPT' });
    assert.deepEqual(await attemptRows(), []);
    const completed = await snapshotAccountData();
    for (const table of ['users', 'game_personal_bests', 'game_submission_receipts']) {
        assert.deepEqual(completed[table], original[table]);
    }
    const newLinks = completed.account_provider_identities.filter(row =>
        row.account_uuid === account.accountId && row.provider === 'apple');
    assert.equal(newLinks.length, 1);
    assert.deepEqual(newLinks[0].subject, Buffer.from(subject));
    assert.deepEqual(completed.account_provider_identities.filter(row => row !== newLinks[0]), original.account_provider_identities);
    const [storedTokens] = await administrator.query<(RowDataPacket & StoredAppleToken)[]>(
        'SELECT * FROM apple_provider_tokens WHERE account_uuid = ?', [account.accountId]);
    assert.equal(storedTokens.length, 2, 'link and returning login each retain their own encrypted credential');
    for (const row of storedTokens) assert.equal(tokenVault.decrypt(row), 'isolated-composed-refresh-token');
});

test('logout or expiry during provider verification prevents the composed flow from creating a link', async () => {
    for (const invalidation of ['logout', 'expiry'] as const) {
        const userName = `attempt-verification-${invalidation}-fixture`;
        const account = await createAccount(userName);
        const sessionSecret = randomBytes(32).toString('base64url');
        const issued = issueSessionToken({ ...account, userName }, sessionSecret);
        assert.equal(await createAccountSession(database, account, issued.sessionId, issued.expiresAt), true);
        const origin = 'https://provider-flow.example.test';
        const readContext = createProviderAuthContextReader({ database, sessionSecret, allowedOrigins: [origin] });
        const request = { method: 'POST', headers: { origin, 'content-type': 'application/json' },
            signedCookies: { [WEB_SESSION_COOKIE]: issued.token } };
        const context = await readContext(request);
        assert.ok(context?.session);
        let signalVerification!: () => void;
        let releaseVerification!: () => void;
        const verificationStarted = new Promise<void>(resolve => { signalVerification = resolve; });
        const verificationGate = new Promise<void>(resolve => { releaseVerification = resolve; });
        // Signed-token cryptography is covered above; this fixture isolates session changes during that asynchronous work.
        const identity = { provider: 'apple', subject: `VerificationSession-${invalidation}` } as VerifiedProviderIdentity;
        const flow = createProviderAuthFlow({
            enabled: true,
            clients: { 'apple-web': { provider: 'apple', appleTokens: localAppleTokens, verifier: { async verify() {
                signalVerification();
                await verificationGate;
                return { verified: true, identity };
            } } } },
            attempts: {
                create: value => createProviderAttempt(database, value),
                consume: (state, binding, client, action) => consumeProviderAttempt(database, state, binding, client, action),
            },
            accounts: {
                find: verified => findProviderAccount(database, verified),
                link: (target, password, verified, session, refreshToken) => linkProviderAccount(database, target, password, verified, session,
                    (connection, locked) => tokenVault.save(connection, tokenVault.prepare(refreshToken!, locked.accountId))),
                saveAppleToken: (target, verified, refreshToken) => persistProviderCredential(database, target, verified,
                    (connection, locked) => tokenVault.save(connection, tokenVault.prepare(refreshToken, locked.accountId))),
            },
        });
        const challenge = await flow.begin(context, { clientKey: 'apple-web', action: 'link' });
        assert.ok(challenge.ok);
        const input = { clientKey: 'apple-web', action: 'link', state: challenge.state,
            idToken: 'synthetic-verifier-input', authorizationCode: 'synthetic-code', password: TEST_PASSWORD };
        const original = await snapshotAccountData();
        const completing = flow.complete(context, input);
        await Promise.race([verificationStarted, completing.then(() => {
            throw new Error('Provider verification was not reached');
        })]);
        try {
            assert.deepEqual(await attemptRows(), [], 'the one-use attempt is committed before provider verification');
            if (invalidation === 'logout') {
                await revokeAccountSession(database, account.userId, account.accountId, issued.sessionId);
            } else {
                await administrator.query('UPDATE account_sessions SET expires_at = UTC_TIMESTAMP(6) WHERE session_hash = ?',
                    [createHash('sha256').update(issued.sessionId, 'ascii').digest()]);
            }
        } finally { releaseVerification(); }
        assert.deepEqual(await completing, { ok: false, reason: 'ACCOUNT_GONE' });
        assert.deepEqual(await flow.complete(context, input), { ok: false, reason: 'INVALID_ATTEMPT' });
        assert.equal(await readContext(request), null);
        assert.equal(await findProviderAccount(database, identity), null);
        assert.deepEqual(await snapshotAccountData(), original);
        assert.deepEqual((await administrator.query<RowDataPacket[]>(
            'SELECT token_id FROM apple_provider_tokens WHERE account_uuid = ?', [account.accountId]))[0], []);
    }
});
