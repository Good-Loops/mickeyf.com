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
import {
    findProviderAccount, linkProviderAccount, ProviderAccountUnavailableError, type ProviderAccount,
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
    await applyMigrations(connection, migrations, config, { allowedEffectKinds: ['add-account-sessions'] });
    await applyMigrations(connection, migrations, config, { allowedEffectKinds: ['add-session-renewal'] });
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
    const sessions = await Promise.all(accounts.map(createSession));
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
