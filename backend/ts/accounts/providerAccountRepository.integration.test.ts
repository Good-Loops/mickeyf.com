import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import mysql, { type Connection, type Pool, type ResultSetHeader, type RowDataPacket } from 'mysql2/promise';
import type { IdentityProvider, VerifiedProviderIdentity } from '../auth/providerIdentity';
import { createAccountSession, readLiveSession, revokeAccountSession } from '../auth/accountSessionRepository';
import { createProviderTokenVerifier } from '../auth/providerTokenVerifier';
import { loadMigrationConfig } from '../config/migrationConfig';
import { submitP4VegaScore } from '../leaderboards/p4VegaScoreRepository';
import { submitThreeBossesRun } from '../leaderboards/threeBossesRunRepository';
import type { MigrationConnection } from '../migrations/leaderboardSchema';
import { loadMigrationManifest } from '../migrations/migrationManifest';
import { applyMigrations } from '../migrations/migrationRunner';
import type { SessionProof } from '../security/sessionPolicy';
import { deleteAccount, deleteProviderAccount } from './accountDeletionRepository';
import {
    createProviderAccount, findProviderAccount, linkProviderAccount, readProviderAccountMethods,
    ProviderAccountUnavailableError, type ProviderAccount,
} from './providerAccountRepository';

const config = loadMigrationConfig();
const testPort = Number(process.env.MIGRATION_TEST_PORT);
const TEST_PASSWORD = 'provider-isolated-test-only';
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
    }, 'Provider linking integration runs only inside the pinned disposable MySQL harness');
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
    // This suite runs last and replaces only the already verified disposable fixtures.
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

after(async () => {
    if (database) await database.end();
    if (administrator) await administrator.end();
});

async function createAccount(name: string, options: { userId?: number; scores?: boolean } = {}): Promise<ProviderAccount> {
    const [inserted] = await administrator.query<ResultSetHeader>(
        'INSERT INTO users (user_id,user_name,email,user_password) VALUES (?,?,?,?)',
        [options.userId ?? null, name, `${name}@example.test`, passwordHash]);
    const [rows] = await administrator.query<(RowDataPacket & ProviderAccount)[]>(
        'SELECT user_id AS userId, user_name AS userName, account_uuid AS accountId FROM users WHERE user_id = ?',
        [options.userId ?? inserted.insertId]);
    assert.equal(rows.length, 1);
    if (options.scores !== false) {
        await submitP4VegaScore(database, rows[0].userId, 500);
        await submitThreeBossesRun(database, rows[0].userId, randomUUID(), 60000);
    }
    return { userId: rows[0].userId, userName: rows[0].userName, accountId: rows[0].accountId };
}

function verifiedFixture(provider: IdentityProvider, subject: string): VerifiedProviderIdentity {
    // Failure/race fixtures represent the verifier output; signed-token composition is tested below.
    return { provider, subject } as VerifiedProviderIdentity;
}

async function createSession(account: ProviderAccount): Promise<SessionProof> {
    const sessionId = randomBytes(32).toString('base64url');
    assert.equal(await createAccountSession(database, account, sessionId,
        Math.floor(Date.now() / 1000) + 3600, passwordHash), true);
    return { accountId: account.accountId, sessionId };
}

async function providerRows(): Promise<RowDataPacket[]> {
    const [rows] = await administrator.query<RowDataPacket[]>(
        'SELECT * FROM account_provider_identities ORDER BY provider, subject');
    return rows;
}

async function snapshotUsersAndScores(): Promise<Record<string, RowDataPacket[]>> {
    const snapshots: Record<string, RowDataPacket[]> = {};
    for (const [table, order] of [
        ['users', 'user_id'], ['game_personal_bests', 'game_id, rules_version, user_id'],
        ['game_submission_receipts', 'game_run_id'],
    ]) {
        [snapshots[table]] = await administrator.query<RowDataPacket[]>(`SELECT * FROM ${table} ORDER BY ${order}`);
    }
    return snapshots;
}

async function preservesUsersAndScores(operation: () => Promise<void>): Promise<void> {
    const original = await snapshotUsersAndScores();
    await operation();
    assert.deepEqual(await snapshotUsersAndScores(), original, 'Linking must preserve profiles, passwords, UUIDs and scores exactly');
}

test('locally signed Google and Apple tokens link to one existing account and retry idempotently', async () => {
    const account = await createAccount('signed-provider-fixture');
    const session = await createSession(account);
    const key = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const nowSeconds = 1_800_000_000;
    const nonce = 'server-issued-isolated-provider-attempt';
    const audience = 'isolated-provider-integration-client';
    const verifier = createProviderTokenVerifier({ googleAudience: audience, appleAudience: audience }, {
        now: () => nowSeconds * 1000,
        // Injected JWKS keeps every token, key and request local to this fixture.
        fetch: async () => new Response(JSON.stringify({ keys: [{
            ...key.publicKey.export({ format: 'jwk' }), kid: 'isolated-key', alg: 'RS256', use: 'sig',
        }] }), { headers: { 'cache-control': 'max-age=3600' } }),
    });
    await preservesUsersAndScores(async () => {
        for (const provider of ['google', 'apple'] as const) {
            const token = jwt.sign({
                sub: 'SameOpaqueSubjectForBothProviders', nonce, iat: nowSeconds - 10, exp: nowSeconds + 3600,
                email: 'signed-provider-fixture@example.test',
            }, key.privateKey, {
                algorithm: 'RS256', keyid: 'isolated-key', audience,
                issuer: provider === 'google' ? 'https://accounts.google.com' : 'https://appleid.apple.com',
            });
            const verified = await verifier.verify(provider, token, nonce);
            assert.equal(verified.verified, true);
            if (!verified.verified) throw new Error('The locally signed fixture must verify');
            assert.equal(await findProviderAccount(database, verified.identity), null, 'Matching email does not create a link');
            assert.equal(await linkProviderAccount(database, account, TEST_PASSWORD, verified.identity, session), 'linked');
            assert.deepEqual(await findProviderAccount(database, verified.identity), account);
            const linked = await providerRows();
            assert.equal(await linkProviderAccount(database, account, TEST_PASSWORD, verified.identity, session), 'already-linked');
            assert.deepEqual(await providerRows(), linked, 'A retry preserves the link and its original timestamp');
        }
    });
});

test('wrong passwords and absent accounts create no provider links', async () => {
    const account = await createAccount('invalid-provider-fixture');
    const session = await createSession(account);
    await preservesUsersAndScores(async () => {
        const original = await providerRows();
        for (const provider of ['google', 'apple'] as const) {
            const identity = verifiedFixture(provider, 'UnlinkedInvalidCredentials');
            assert.equal(await linkProviderAccount(database, account, 'wrong-password', identity, session), 'invalid-password');
            const absent = {
                userId: account.userId + 1_000_000, accountId: randomUUID(),
            };
            assert.equal(await linkProviderAccount(database, absent, TEST_PASSWORD, identity,
                { ...session, accountId: absent.accountId }), 'not-found');
            assert.equal(await findProviderAccount(database, identity), null);
        }
        assert.deepEqual(await providerRows(), original);
    });
});

test('unique conflicts cannot move a subject or replace an account provider link', async () => {
    const first = await createAccount('first-conflict-fixture');
    const second = await createAccount('second-conflict-fixture');
    const firstSession = await createSession(first);
    const secondSession = await createSession(second);
    await preservesUsersAndScores(async () => {
        for (const provider of ['google', 'apple'] as const) {
            const firstIdentity = verifiedFixture(provider, 'FirstConflictSubject');
            const secondIdentity = verifiedFixture(provider, 'SecondConflictSubject');
            assert.equal(await linkProviderAccount(database, first, TEST_PASSWORD, firstIdentity, firstSession), 'linked');
            assert.equal(await linkProviderAccount(database, second, TEST_PASSWORD, secondIdentity, secondSession), 'linked');
            const original = await providerRows();
            assert.equal(await linkProviderAccount(database, second, TEST_PASSWORD, firstIdentity, secondSession), 'link-conflict');
            assert.equal(await linkProviderAccount(database, first, TEST_PASSWORD,
                verifiedFixture(provider, 'ReplacementConflictSubject'), firstSession), 'link-conflict');
            assert.deepEqual(await findProviderAccount(database, firstIdentity), first);
            assert.deepEqual(await findProviderAccount(database, secondIdentity), second);
            assert.deepEqual(await providerRows(), original);
        }
    });
});

test('provider subjects remain case-sensitive in storage and lookup', async () => {
    const upper = await createAccount('upper-subject-fixture');
    const lower = await createAccount('lower-subject-fixture');
    const upperSession = await createSession(upper);
    const lowerSession = await createSession(lower);
    await preservesUsersAndScores(async () => {
        for (const provider of ['google', 'apple'] as const) {
            const upperIdentity = verifiedFixture(provider, 'CaseSensitiveSubject');
            const lowerIdentity = verifiedFixture(provider, 'casesensitivesubject');
            assert.equal(await linkProviderAccount(database, upper, TEST_PASSWORD, upperIdentity, upperSession), 'linked');
            assert.equal(await findProviderAccount(database, lowerIdentity), null);
            assert.equal(await linkProviderAccount(database, lower, TEST_PASSWORD, lowerIdentity, lowerSession), 'linked');
            assert.deepEqual(await findProviderAccount(database, upperIdentity), upper);
            assert.deepEqual(await findProviderAccount(database, lowerIdentity), lower);
            assert.equal(await findProviderAccount(database, verifiedFixture(provider, 'CASESENSITIVESUBJECT')), null);
        }
    });
});

test('two concurrent accounts racing for one subject leave exactly one durable owner', async () => {
    const accounts = [await createAccount('first-race-fixture'), await createAccount('second-race-fixture')];
    // Session creation is setup, not this test's race; keep the two concurrent link operations below isolated.
    const sessions = [await createSession(accounts[0]), await createSession(accounts[1])];
    await preservesUsersAndScores(async () => {
        for (const provider of ['google', 'apple'] as const) {
            const identity = verifiedFixture(provider, 'ContendedProviderSubject');
            const original = await providerRows();
            // Lease both real sessions first so the contenders cannot share a pooled connection.
            const connections = await Promise.all(accounts.map(() => database.getConnection()));
            assert.notEqual(connections[0].threadId, connections[1].threadId);
            const outcomes = await Promise.allSettled(accounts.map((account, index) =>
                linkProviderAccount({ getConnection: async () => connections[index] }, account, TEST_PASSWORD, identity, sessions[index])));
            const winners = outcomes.flatMap((outcome, index) =>
                outcome.status === 'fulfilled' && outcome.value === 'linked' ? [index] : []);
            assert.equal(winners.length, 1);
            const loser = outcomes[1 - winners[0]];
            if (loser.status === 'fulfilled') assert.equal(loser.value, 'link-conflict');
            else {
                assert(loser.reason instanceof ProviderAccountUnavailableError);
                assert.equal(loser.reason.message, 'The provider account operation could not be confirmed.');
                assert.equal('cause' in loser.reason, false);
            }
            const linked = await providerRows();
            assert.equal(linked.length, original.length + 1);
            assert.deepEqual(linked.filter(row => row.provider !== provider
                || !row.subject.equals(Buffer.from(identity.subject))), original);
            assert.deepEqual(await findProviderAccount(database, identity), accounts[winners[0]]);
            assert.equal(await linkProviderAccount(database, accounts[1 - winners[0]], TEST_PASSWORD,
                identity, sessions[1 - winners[0]]), 'link-conflict');
        }
    });
});

test('a stale UUID cannot link a replacement account that reuses its numeric ID', async () => {
    const stale = await createAccount('stale-id-fixture', { scores: false });
    const staleSession = await createSession(stale);
    // Deleting the old incarnation cascades its device session.
    await administrator.query('DELETE FROM users WHERE user_id = ? AND account_uuid = ?', [stale.userId, stale.accountId]);
    const replacement = await createAccount('replacement-id-fixture', { userId: stale.userId });
    const replacementSession = await createSession(replacement);
    assert.equal(replacement.userId, stale.userId);
    assert.notEqual(replacement.accountId, stale.accountId);
    await preservesUsersAndScores(async () => {
        const original = await providerRows();
        for (const provider of ['google', 'apple'] as const) {
            const identity = verifiedFixture(provider, 'StaleAccountSubject');
            assert.equal(await linkProviderAccount(database, stale, TEST_PASSWORD, identity, staleSession), 'not-found');
            assert.equal(await findProviderAccount(database, identity), null);
        }
        assert.deepEqual(await providerRows(), original);
        const identity = verifiedFixture('google', 'FreshReplacementSubject');
        assert.equal(await linkProviderAccount(database, replacement, TEST_PASSWORD, identity, replacementSession), 'linked');
        assert.deepEqual(await findProviderAccount(database, identity), replacement);
    });
});

test('logout or expiry after a live context check prevents linking while another device stays valid', async () => {
    for (const invalidation of ['logout', 'expiry'] as const) {
        const account = await createAccount(`session-${invalidation}-fixture`);
        const session = await createSession(account);
        const otherDevice = await createSession(account);
        const identity = verifiedFixture('google', `SessionInvalidation-${invalidation}`);
        const original = await providerRows();
        assert.deepEqual(await readLiveSession(database, account.userId, account.accountId, session.sessionId),
            { userName: account.userName });
        if (invalidation === 'logout') {
            await revokeAccountSession(database, account.userId, account.accountId, session.sessionId);
        } else {
            await administrator.query('UPDATE account_sessions SET expires_at = UTC_TIMESTAMP(6) WHERE session_hash = ?',
                [createHash('sha256').update(session.sessionId, 'ascii').digest()]);
        }
        await preservesUsersAndScores(async () => {
            assert.equal(await linkProviderAccount(database, account, TEST_PASSWORD, identity, session), 'not-found');
            assert.deepEqual(await providerRows(), original);
            assert.equal(await findProviderAccount(database, identity), null);
            assert.deepEqual(await readLiveSession(database, account.userId, account.accountId, otherDevice.sessionId),
                { userName: account.userName });
            assert.equal(await linkProviderAccount(database, account, TEST_PASSWORD, identity, otherDevice), 'linked');
            assert.equal(await linkProviderAccount(database, account, TEST_PASSWORD, identity, session), 'not-found');
        });
    }
});

test('a valid session for another account cannot authorize the target account link', async () => {
    const account = await createAccount('session-target-fixture');
    const otherAccount = await createAccount('session-other-account-fixture');
    const otherSession = await createSession(otherAccount);
    const identity = verifiedFixture('google', 'OtherAccountSessionSubject');
    const original = await providerRows();
    await preservesUsersAndScores(async () => {
        assert.equal(await linkProviderAccount(database, account, TEST_PASSWORD, identity, otherSession), 'not-found');
        assert.equal(await linkProviderAccount(database, account, TEST_PASSWORD, identity,
            { ...otherSession, accountId: account.accountId }), 'not-found');
        assert.deepEqual(await providerRows(), original);
        assert.equal(await findProviderAccount(database, identity), null);
    });
});

function signupIdentity(subject: string, email = `${subject}@example.test`): VerifiedProviderIdentity {
    return { provider: 'google', subject, email } as VerifiedProviderIdentity;
}

async function createPasswordlessFixture(name: string): Promise<{ account: ProviderAccount; identity: VerifiedProviderIdentity }> {
    const identity = signupIdentity(name);
    const result = await createProviderAccount(database, identity, name);
    assert.equal(result.created, true);
    if (!result.created) throw new Error('Passwordless fixture was not created');
    return { account: result.account, identity };
}

async function createPasswordlessSession(account: ProviderAccount): Promise<SessionProof> {
    const sessionId = randomBytes(32).toString('base64url');
    assert.equal(await createAccountSession(database, account, sessionId, Math.floor(Date.now() / 1000) + 3600), true);
    return { accountId: account.accountId, sessionId };
}

test('passwordless signup stores NULL, links only the verified subject and creates no session before the caller issues one', async () => {
    const { account, identity } = await createPasswordlessFixture('passwordless-created');
    const [users] = await administrator.query<RowDataPacket[]>(
        'SELECT user_password, email FROM users WHERE account_uuid = ?', [account.accountId]);
    assert.deepEqual(users.map(row => ({ ...row })), [{ user_password: null, email: 'passwordless-created@example.test' }]);
    assert.deepEqual(await findProviderAccount(database, identity), account);
    assert.deepEqual(await readProviderAccountMethods(database, account.accountId), { hasPassword: false, googleLinked: true, appleLinked: false });
    const [sessions] = await administrator.query<RowDataPacket[]>(
        'SELECT session_hash FROM account_sessions WHERE account_uuid = ?', [account.accountId]);
    assert.equal(sessions.length, 0);
    const session = await createPasswordlessSession(account);
    const intents: string[] = [];
    const journal = { async recordAccountDeletion(accountId: string) { intents.push(accountId); } };
    assert.equal(await deleteAccount(database, account.userId, TEST_PASSWORD, journal, session), 'invalid-password');
    assert.deepEqual(intents, []);
    assert.equal(await linkProviderAccount(database, account, TEST_PASSWORD, signupIdentity('another-google'), session), 'invalid-password');
});

test('username/email collisions and repeated signup never attach to or modify an existing account', async () => {
    const existing = await createAccount('signup-collision-existing', { scores: false });
    await preservesUsersAndScores(async () => {
        const before = await providerRows();
        assert.deepEqual(await createProviderAccount(database, signupIdentity('unique-google-for-name'), existing.userName.toUpperCase()),
            { created: false, reason: 'DUPLICATE_USER' });
        assert.deepEqual(await createProviderAccount(database,
            signupIdentity('unique-google-for-email', 'SIGNUP-COLLISION-EXISTING@example.test'), 'signup-unique-name'),
        { created: false, reason: 'DUPLICATE_USER' });
        assert.deepEqual(await providerRows(), before);
        assert.deepEqual(await readProviderAccountMethods(database, existing.accountId), { hasPassword: true, googleLinked: false, appleLinked: false });
    });
    const created = await createPasswordlessFixture('signup-repeated-subject');
    await preservesUsersAndScores(async () => {
        const before = await providerRows();
        assert.deepEqual(await createProviderAccount(database, created.identity, 'signup-repeated-new-name'),
            { created: false, reason: 'ALREADY_LINKED' });
        assert.deepEqual(await providerRows(), before);
    });
});

test('concurrent signup collisions leave exactly one account and identity, never an orphan or reassignment', async () => {
    for (const collision of ['username', 'subject'] as const) {
        const names = [0, 1].map(index => `signup-race-${collision}-${collision === 'username' ? 0 : index}`);
        const identities = [0, 1].map(index => signupIdentity(`Race-${collision}-${collision === 'subject' ? 0 : index}`,
            `signup-race-${collision}-${index}@example.test`));
        const connections = await Promise.all([database.getConnection(), database.getConnection()]);
        const outcomes = await Promise.allSettled(connections.map((connection, index) =>
            createProviderAccount({ getConnection: async () => connection }, identities[index], names[index])));
        const created = outcomes.flatMap(outcome => outcome.status === 'fulfilled' && outcome.value.created ? [outcome.value.account] : []);
        assert.equal(created.length, 1);
        const [users] = await administrator.query<RowDataPacket[]>(
            'SELECT account_uuid FROM users WHERE user_name IN (?, ?)', names);
        assert.equal(users.length, 1, 'The losing transaction must roll back its user insert');
        const links = (await providerRows()).filter(row => identities.some(identity => row.provider === 'google'
            && row.subject.equals(Buffer.from(identity.subject))));
        assert.equal(links.length, 1);
        assert.equal(links[0].account_uuid, created[0].accountId);
        for (const outcome of outcomes) {
            if (outcome.status === 'rejected') assert.ok(outcome.reason instanceof ProviderAccountUnavailableError);
            else if (!outcome.value.created) assert.equal(outcome.value.reason, collision === 'username' ? 'DUPLICATE_USER' : 'ALREADY_LINKED');
        }
    }
});

test('lost signup commit acknowledgement remains unavailable even when the account durably exists', async () => {
    const identity = signupIdentity('signup-uncertain-commit');
    const connection = await database.getConnection();
    const originalCommit = connection.commit.bind(connection);
    connection.commit = async () => { await originalCommit(); throw new Error('synthetic lost acknowledgement'); };
    await assert.rejects(createProviderAccount({ getConnection: async () => connection }, identity, 'signup-uncertain-commit'),
        ProviderAccountUnavailableError);
    assert.ok(await findProviderAccount(database, identity));
    assert.deepEqual(await createProviderAccount(database, identity, 'signup-uncertain-retry'), { created: false, reason: 'ALREADY_LINKED' });
});

test('fresh Google deletion rejects another subject and removes the exact passwordless account plus dependent rows', async () => {
    const { account, identity } = await createPasswordlessFixture('provider-delete-passwordless');
    const session = await createPasswordlessSession(account);
    await submitP4VegaScore(database, account.userId, 750);
    await submitThreeBossesRun(database, account.userId, randomUUID(), 60_000);
    const intents: string[] = [];
    const journal = { async recordAccountDeletion(accountId: string) { intents.push(accountId); } };
    await preservesUsersAndScores(async () => {
        assert.equal(await deleteProviderAccount(database, account.userId,
            signupIdentity(identity.subject.toUpperCase()), journal, session), 'invalid-password');
        assert.deepEqual(intents, []);
    });
    assert.equal(await deleteProviderAccount(database, account.userId, identity, journal, session), 'deleted');
    assert.deepEqual(intents, [account.accountId]);
    assert.equal(await findProviderAccount(database, identity), null);
    assert.equal(await readProviderAccountMethods(database, account.accountId), null);
    assert.equal(await readLiveSession(database, account.userId, account.accountId, session.sessionId), null);
    for (const table of ['game_personal_bests', 'game_submission_receipts']) {
        const [rows] = await administrator.query<RowDataPacket[]>(`SELECT user_id FROM ${table} WHERE user_id = ?`, [account.userId]);
        assert.equal(rows.length, 0);
    }
});

test('logout, expiry and account-incarnation replacement prevent provider deletion before journaling', async () => {
    for (const invalidation of ['logout', 'expiry', 'replacement'] as const) {
        const { account, identity } = await createPasswordlessFixture(`provider-delete-${invalidation}`);
        const session = await createPasswordlessSession(account);
        assert.ok(await readLiveSession(database, account.userId, account.accountId, session.sessionId));
        if (invalidation === 'logout') await revokeAccountSession(database, account.userId, account.accountId, session.sessionId);
        else if (invalidation === 'expiry') {
            await administrator.query('UPDATE account_sessions SET expires_at = UTC_TIMESTAMP(6) WHERE session_hash = ?',
                [createHash('sha256').update(session.sessionId, 'ascii').digest()]);
        } else {
            await administrator.query('DELETE FROM users WHERE user_id = ?', [account.userId]);
            await createAccount('provider-delete-replacement-current', { userId: account.userId, scores: false });
        }
        const intents: string[] = [];
        await preservesUsersAndScores(async () => {
            assert.equal(await deleteProviderAccount(database, account.userId, identity,
                { async recordAccountDeletion(accountId) { intents.push(accountId); } }, session), 'not-found');
            assert.deepEqual(intents, []);
        });
    }
});

test('Apple relay signup stores its exact provider subject; fresh proof without email deletes only that account', async () => {
    const unrelated = await createAccount('apple-proof-unrelated-player', { scores: false });
    const identity = { provider: 'apple', subject: 'NativeAppleSignupSubject',
        email: 'native-apple@privaterelay.appleid.com' } as VerifiedProviderIdentity;
    const created = await createProviderAccount(database, identity, 'native-apple-player');
    assert.ok(created.created);
    const { account } = created;
    assert.deepEqual(await readProviderAccountMethods(database, account.accountId),
        { hasPassword: false, googleLinked: false, appleLinked: true });
    const proof = { provider: 'apple', subject: identity.subject } as VerifiedProviderIdentity;
    assert.deepEqual(await findProviderAccount(database, proof), account);
    assert.equal(await findProviderAccount(database, { ...proof, provider: 'google' }), null);
    await preservesUsersAndScores(async () => {
        assert.deepEqual(await createProviderAccount(database, { ...identity, subject: 'AnotherAppleSubject' }, 'other-apple-player'),
            { created: false, reason: 'DUPLICATE_USER' });
        assert.equal(await findProviderAccount(database, { ...proof, subject: 'AnotherAppleSubject' }), null);
    });
    const session = await createPasswordlessSession(account);
    const intents: string[] = [];
    const journal = { async recordAccountDeletion(accountId: string) { intents.push(accountId); } };
    assert.equal(await deleteProviderAccount(database, account.userId, { ...proof, provider: 'google' }, journal, session), 'invalid-password');
    assert.equal(await deleteProviderAccount(database, account.userId, { ...proof, subject: identity.subject.toLowerCase() }, journal, session), 'invalid-password');
    assert.deepEqual(intents, []);
    assert.equal(await deleteProviderAccount(database, account.userId, proof, journal, session), 'deleted');
    assert.deepEqual(intents, [account.accountId]);
    assert.equal(await findProviderAccount(database, proof), null);
    assert.equal(await readLiveSession(database, account.userId, account.accountId, session.sessionId), null);
    const [remaining] = await administrator.query<RowDataPacket[]>(
        'SELECT account_uuid FROM users WHERE user_id = ?', [unrelated.userId]);
    assert.equal(remaining[0]?.account_uuid, unrelated.accountId);
});
