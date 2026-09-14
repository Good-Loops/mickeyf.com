import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import mysql, { type Connection, type Pool, type PoolConnection, type QueryOptions, type ResultSetHeader, type RowDataPacket } from 'mysql2/promise';
import { deleteAccount } from '../accounts/accountDeletionRepository';
import { findProviderAccount, linkProviderAccount } from '../accounts/providerAccountRepository';
import { loadMigrationConfig } from '../config/migrationConfig';
import { submitP4VegaScore } from '../leaderboards/p4VegaScoreRepository';
import { submitThreeBossesRun } from '../leaderboards/threeBossesRunRepository';
import type { MigrationConnection } from '../migrations/leaderboardSchema';
import { loadMigrationManifest } from '../migrations/migrationManifest';
import { applyMigrations } from '../migrations/migrationRunner';
import {
    consumeProviderAttempt, createProviderAttempt, ProviderAttemptUnavailableError, type ProviderAttempt,
} from './providerAttemptRepository';
import { createProviderAuthContextReader, PROVIDER_BINDING_COOKIE } from './providerAuthContext';
import { createProviderAuthFlow } from './providerAuthFlow';
import { createProviderTokenVerifier } from './providerTokenVerifier';

const config = loadMigrationConfig();
const testPort = Number(process.env.MIGRATION_TEST_PORT);
const TEST_PASSWORD = 'attempt-isolated-test-only';
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
        await administrator.query(`DROP TABLE IF EXISTS provider_auth_attempts, account_provider_identities,
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
    for (const value of [attempt(), attempt({ ...account, action: 'link', clientKey: 'apple-web' })]) {
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
        clients: { 'apple-web': { provider: 'apple', verifier } },
        attempts: {
            create: value => createProviderAttempt(database, value),
            consume: (state, binding, client, action) => consumeProviderAttempt(database, state, binding, client, action),
        },
        accounts: {
            find: identity => findProviderAccount(database, identity),
            link: (target, password, identity) => linkProviderAccount(database, target, password, identity),
        },
    });
    const sessionSecret = randomBytes(32).toString('base64url');
    const origin = 'https://provider-flow.example.test';
    const readContext = createProviderAuthContextReader({ database, sessionSecret, allowedOrigins: [origin] });
    const session = jwt.sign({ user_id: account.userId, user_name: userName }, sessionSecret, {
        algorithm: 'HS256', expiresIn: '5m',
    });
    // The context reader receives the cookie-parser boundary; the session JWT is genuinely signed and verified.
    const linkingRequest = {
        method: 'POST', headers: { origin, 'content-type': 'application/json' },
        signedCookies: { session, [PROVIDER_BINDING_COOKIE]: randomBytes(32).toString('base64url') },
    };
    const linkContext = await readContext(linkingRequest);
    assert.deepEqual(linkContext?.account, account);
    const linking = await flow.begin(linkContext, { clientKey: 'apple-web', action: 'link' });
    assert.equal(linking.ok, true);
    if (!linking.ok) throw new Error('The isolated linking challenge must be created');
    const linkingInput = {
        clientKey: 'apple-web', action: 'link', state: linking.state,
        idToken: signProviderProof(linking.nonce), password: TEST_PASSWORD,
    };
    assert.deepEqual(await flow.complete(await readContext(linkingRequest), linkingInput), { ok: true, type: 'linked' });
    assert.deepEqual(await flow.complete(await readContext(linkingRequest), linkingInput), { ok: false, reason: 'INVALID_ATTEMPT' });

    const anonymousRequest = {
        method: 'POST', headers: { origin, 'content-type': 'application/json' },
        signedCookies: { [PROVIDER_BINDING_COOKIE]: randomBytes(32).toString('base64url') },
    };
    const loginContext = await readContext(anonymousRequest);
    assert.equal(loginContext?.account, null);
    const login = await flow.begin(loginContext, { clientKey: 'apple-web', action: 'login' });
    assert.equal(login.ok, true);
    if (!login.ok) throw new Error('The isolated login challenge must be created');
    const loginInput = {
        clientKey: 'apple-web', action: 'login', state: login.state, idToken: signProviderProof(login.nonce),
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
});
