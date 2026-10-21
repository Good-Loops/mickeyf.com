import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import bcrypt from 'bcryptjs';
import mysql, { type Connection, type Pool, type RowDataPacket } from 'mysql2/promise';
import { loadMigrationConfig } from '../config/migrationConfig';
import { loadRegistrationPolicy } from '../config/registrationPolicy';
import { loadMigrationManifest } from '../migrations/migrationManifest';
import { applyMigrations, planMigrations } from '../migrations/migrationRunner';
import { verifyRegistrationReadiness } from '../migrations/registrationSchema';
import type { MigrationConnection } from '../migrations/leaderboardSchema';
import type { ProviderAuthContext } from '../auth/providerAuthContext';
import type { VerifiedProviderIdentity } from '../auth/providerIdentity';
import { createAccountSession } from '../auth/accountSessionRepository';
import { readP4VegaLeaderboard, submitP4VegaScore } from '../leaderboards/p4VegaScoreRepository';
import { readThreeBossesLeaderboard, submitThreeBossesRun } from '../leaderboards/threeBossesRunRepository';
import { createRegisteredPasswordAccount } from './registeredPasswordAccount';
import { createProviderAccount } from './providerAccountRepository';
import { createRegistrationAuthorization } from './registrationAuthorization';
import { deleteAccount } from './accountDeletionRepository';
import { renderRuntimeGrantStatements } from '../security/runtimeGrantManifest';

const config = loadMigrationConfig();
let administrator: Connection;
let database: Pool;
let generalDatabase: Pool;
const password = 'registration-synthetic-only';
let passwordHash: string;
const policy = loadRegistrationPolicy({ REGISTRATION_ENABLED: 'true', REGISTRATION_POLICY_REVIEWED: 'true',
    REGISTRATION_POLICY_VERSION: 'synthetic-v1', REGISTRATION_COUNTRY_RULES: '{"ZZ":{"parentRequiredBelow":15}}' })!;
const generalPolicy = loadRegistrationPolicy({ REGISTRATION_ENABLED: 'true', REGISTRATION_POLICY_REVIEWED: 'true',
    REGISTRATION_POLICY_VERSION: policy.version, REGISTRATION_COUNTRY_RULES: '{"ZZ":{"parentRequiredBelow":15}}',
    REGISTRATION_GENERAL_AUDIENCE_ENABLED: 'true', REGISTRATION_GENERAL_AUDIENCE_POLICY_REVIEWED: 'true',
    REGISTRATION_GENERAL_AUDIENCE_POLICY_VERSION: 'synthetic-general-v1' })!;
const context = () => ({ bindingHash: randomBytes(32), account: null, session: null,
    bindingExpiresAt: Date.now() + 300_000, anonymousCookie: null }) as ProviderAuthContext;
const identity = (name: string) => ({ provider: 'google', subject: name, email: `${name}@example.test` }) as VerifiedProviderIdentity;

before(async () => {
    assert.equal(process.env.NODE_ENV, 'test');
    assert.equal(process.env.MIGRATION_TEST_ENABLED, '1');
    for (const key of ['DATABASE_URL', 'DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASS', 'CLOUD_SQL_CONNECTION_NAME']) assert.equal(process.env[key], undefined);
    assert.equal(config.host, '127.0.0.1');
    assert.equal(config.database, 'mickeyf_migration_test');
    assert.equal(config.user, 'migration_test');
    assert.equal(config.password, 'migration-test-only');
    assert.equal(config.port, Number(process.env.MIGRATION_TEST_PORT));
    assert.ok(config.port && config.port !== 3306);
    administrator = await mysql.createConnection({ host: config.host, port: config.port, database: config.database,
        user: config.user, password: config.password, multipleStatements: false, dateStrings: true, timezone: 'Z' });
    const [target] = await administrator.query<RowDataPacket[]>('SELECT DATABASE() AS db, CURRENT_USER() AS user, @@version AS version, @@version_comment AS vendor');
    assert.equal(target[0].db, 'mickeyf_migration_test');
    assert.equal(target[0].user, 'migration_test@%');
    assert.match(target[0].version, /^8\.0\.31(?:-|$)/u);
    assert.doesNotMatch(target[0].vendor, /Google/iu);
    await administrator.query('SET FOREIGN_KEY_CHECKS = 0');
    try {
        await administrator.query(`DROP TABLE IF EXISTS parent_signed_forms, account_score_permissions, parent_child_consents, parent_registration_attempts, account_registration_profiles, registration_authorizations,
            apple_auth_revocations, apple_provider_tokens, account_sessions, provider_auth_attempts, account_provider_identities,
            game_personal_bests, game_runs, game_submission_receipts, schema_migrations, users`);
    } finally { await administrator.query('SET FOREIGN_KEY_CHECKS = 1'); }
    await administrator.query(`CREATE TABLE users (user_id INT NOT NULL AUTO_INCREMENT, user_name VARCHAR(255) NOT NULL,
        email VARCHAR(255) NOT NULL, user_password VARCHAR(255) NOT NULL, PRIMARY KEY (user_id), UNIQUE KEY uq_users_email (email))
        ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    const migrations = loadMigrationManifest();
    for (const allowedEffectKinds of [
        ['create-table'] as const, ['drop-column'] as const,
        [...new Set(migrations.filter(migration => migration.version > '0003').map(migration => migration.effect))],
    ]) await applyMigrations(administrator as unknown as MigrationConnection, migrations, config, { allowedEffectKinds });
    await verifyRegistrationReadiness(administrator as unknown as MigrationConnection);
    database = mysql.createPool({ host: config.host, port: config.port, database: config.database,
        user: config.user, password: config.password, multipleStatements: false, connectionLimit: 6, dateStrings: true, timezone: 'Z' });
    assert.equal(process.env.MIGRATION_TEST_ROOT_PASSWORD, 'migration-test-root-only');
    const owner = await mysql.createConnection({ host: config.host, port: config.port, database: config.database,
        user: 'root', password: 'migration-test-root-only', multipleStatements: false, dateStrings: true, timezone: 'Z' });
    try {
        await owner.query("CREATE USER 'registration_runtime_test'@'%' IDENTIFIED BY 'registration-runtime-test-only'");
        for (const sql of renderRuntimeGrantStatements(config.database,
            { user: 'registration_runtime_test', host: '%' }, 'google-apple-parent-signed')) await owner.query(sql);
    } finally { await owner.end(); }
    generalDatabase = mysql.createPool({ host: config.host, port: config.port, database: config.database,
        user: 'registration_runtime_test', password: 'registration-runtime-test-only', multipleStatements: false,
        connectionLimit: 6, dateStrings: true, timezone: 'Z' });
    passwordHash = await bcrypt.hash(password, 4);
});
after(async () => { if (generalDatabase) await generalDatabase.end();
    if (database) await database.end(); if (administrator) await administrator.end(); });

async function grant(ageBand: 'minor' | 'adult' = 'minor') {
    const registration = createRegistrationAuthorization(database, policy);
    const binding = context();
    assert.equal((await registration.begin(binding, { country: 'ZZ', ageBand, policyVersion: policy.version })).allowed, true);
    return { registration, binding, consume: (connection: Parameters<typeof registration.consume>[0], accountId: string) =>
        registration.consume(connection, binding, accountId) };
}
async function account(name: string) {
    const [rows] = await administrator.query<RowDataPacket[]>('SELECT user_id AS userId, account_uuid AS accountId FROM users WHERE user_name = ?', [name]);
    assert.equal(rows.length, 1);
    return { userId: Number(rows[0].userId), accountId: String(rows[0].accountId) };
}
function passwordInput(name: string) { return { userName: name, email: `${name}@example.test`, passwordHash }; }

async function generalGrant() {
    const registration = createRegistrationAuthorization(generalDatabase, generalPolicy);
    const binding = context();
    assert.deepEqual(await registration.begin(binding, { policyVersion: generalPolicy.version }),
        { allowed: true, country: null, ageBand: null });
    return { registration, binding, consume: (connection: Parameters<typeof registration.consume>[0], accountId: string) =>
        registration.consume(connection, binding, accountId) };
}

async function assertGeneralPrivate(name: string) {
    const user = await account(name);
    const [permissions] = await administrator.query<RowDataPacket[]>(`SELECT visibility, policy_digest, registration_policy_version,
        country_code, age_band, authorizer_uuid FROM account_score_permissions WHERE account_uuid=?`, [user.accountId]);
    assert.deepEqual(permissions.map(row => ({ ...row })), [{ visibility: 'private', policy_digest: null,
        registration_policy_version: null, country_code: null, age_band: null, authorizer_uuid: null }]);
    assert.equal((await administrator.query<RowDataPacket[]>(
        'SELECT account_uuid FROM account_registration_profiles WHERE account_uuid=?', [user.accountId]))[0].length, 0);
    return user;
}

test('fresh schema records all migrations and enforces the private-minor database constraint', async () => {
    const plan = await planMigrations(administrator as unknown as MigrationConnection, loadMigrationManifest(), config);
    assert.equal(plan.applied.length, loadMigrationManifest().length);
    assert.deepEqual(plan.pending, []);
    const g = await grant();
    await createRegisteredPasswordAccount(database, passwordInput('constraint-minor'), g.consume);
    const user = await account('constraint-minor');
    await assert.rejects(administrator.query("UPDATE account_registration_profiles SET score_visibility = 'public' WHERE account_uuid = ?", [user.accountId]),
        (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === 'ER_CHECK_CONSTRAINT_VIOLATED');
});

test('password and provider racing one authorization create exactly one complete account with no orphan user', async () => {
    const g = await grant();
    const results = await Promise.allSettled([
        createRegisteredPasswordAccount(database, passwordInput('race-password'), g.consume),
        createProviderAccount(database, identity('race-provider'), 'race-provider', (connection, user) => g.consume(connection, user.accountId)),
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const [users] = await administrator.query<RowDataPacket[]>("SELECT u.user_name, p.score_visibility FROM users u LEFT JOIN account_registration_profiles p ON p.account_uuid=u.account_uuid WHERE u.user_name IN ('race-password','race-provider')");
    assert.equal(users.length, 1);
    assert.equal(users[0].score_visibility, 'private');
    await assert.rejects(createRegisteredPasswordAccount(database, passwordInput('replay-password'), g.consume));
    assert.equal((await administrator.query<RowDataPacket[]>("SELECT user_id FROM users WHERE user_name='replay-password'"))[0].length, 0);
});

test('failure after authorization consumption rolls back user, identity, privacy evidence and consumption', async () => {
    const g = await grant();
    await assert.rejects(createProviderAccount(database, identity('rollback-provider'), 'rollback-provider', async (connection, user) => {
        await g.consume(connection, user.accountId);
        throw new Error('synthetic downstream credential failure');
    }));
    assert.equal((await administrator.query<RowDataPacket[]>("SELECT user_id FROM users WHERE user_name='rollback-provider'"))[0].length, 0);
    await g.registration.assertAvailable(g.binding);
    assert.equal(await createRegisteredPasswordAccount(database, passwordInput('retry-after-rollback'), g.consume), 'created');
});

test('expiry, another browser and a changed reviewed policy cannot authorize account creation', async () => {
    const g = await grant();
    await assert.rejects(g.registration.assertAvailable(context()));
    const changed = loadRegistrationPolicy({ REGISTRATION_ENABLED: 'true', REGISTRATION_POLICY_REVIEWED: 'true',
        REGISTRATION_POLICY_VERSION: policy.version, REGISTRATION_COUNTRY_RULES: '{"ZZ":{"parentRequiredBelow":16}}' });
    await assert.rejects(createRegistrationAuthorization(database, changed).assertAvailable(g.binding));
    await administrator.query('UPDATE registration_authorizations SET expires_at = UTC_TIMESTAMP(6) WHERE binding_hash = ?', [g.binding.bindingHash]);
    await assert.rejects(createRegisteredPasswordAccount(database, passwordInput('expired-password'), g.consume));
    assert.equal((await administrator.query<RowDataPacket[]>("SELECT user_id FROM users WHERE user_name='expired-password'"))[0].length, 0);
});

test('both public leaderboards keep new minor and adult profiles private and preserve unclassified legacy scores', async () => {
    for (const age of ['minor', 'adult'] as const) {
        const g = await grant(age);
        await createRegisteredPasswordAccount(database, passwordInput(`leaderboard-${age}`), g.consume);
    }
    await administrator.query('INSERT INTO users (user_name,email,user_password) VALUES (?,?,?)',
        ['leaderboard-legacy', 'leaderboard-legacy@example.test', passwordHash]);
    for (const name of ['leaderboard-minor', 'leaderboard-adult', 'leaderboard-legacy']) {
        const user = await account(name);
        await submitP4VegaScore(database, user.userId, 1000);
        await submitThreeBossesRun(database, user.userId, randomUUID(), 60_000);
    }
    for (const rows of [await readP4VegaLeaderboard(database), await readThreeBossesLeaderboard(database)]) {
        assert.deepEqual(rows.map(row => row.userName).sort(), ['leaderboard-legacy']);
    }
});

test('normal account deletion cascades the coarse profile but cannot revive its consumed authorization', async () => {
    const g = await grant();
    await createRegisteredPasswordAccount(database, passwordInput('delete-registration'), g.consume);
    const user = await account('delete-registration');
    const sessionId = randomBytes(32).toString('base64url');
    assert.equal(await createAccountSession(database, user, sessionId, Math.floor(Date.now() / 1000) + 300, passwordHash), true);
    const intents: string[] = [];
    assert.equal(await deleteAccount(database, user.userId, password, { async recordAccountDeletion(id) { intents.push(id); } },
        { accountId: user.accountId, sessionId }), 'deleted');
    assert.deepEqual(intents, [user.accountId]);
    assert.equal((await administrator.query<RowDataPacket[]>('SELECT account_uuid FROM account_registration_profiles WHERE account_uuid=?', [user.accountId]))[0].length, 0);
    await assert.rejects(g.registration.assertAvailable(g.binding));
});

test('general password and provider accounts use existing restricted grants with private permissions and no invented profile', async () => {
    const [target] = await generalDatabase.query<RowDataPacket[]>('SELECT CURRENT_USER() AS currentUser');
    assert.equal(target[0].currentUser, 'registration_runtime_test@%');
    await assert.rejects(generalDatabase.query('UPDATE users SET email=email WHERE user_id=-1'),
        (error: unknown) => ['ER_COLUMNACCESS_DENIED_ERROR', 'ER_TABLEACCESS_DENIED_ERROR']
            .includes((error as { code?: string }).code ?? ''));
    const passwordGrant = await generalGrant();
    assert.equal(await createRegisteredPasswordAccount(generalDatabase, passwordInput('general-password'), passwordGrant.consume), 'created');
    const providerGrant = await generalGrant();
    assert.equal((await createProviderAccount(generalDatabase, identity('general-provider'), 'general-provider',
        (connection, user) => providerGrant.consume(connection, user.accountId))).created, true);
    await assertGeneralPrivate('general-password');
    await assertGeneralPrivate('general-provider');
    await assert.rejects(passwordGrant.registration.assertAvailable(passwordGrant.binding));
    await assert.rejects(providerGrant.registration.assertAvailable(providerGrant.binding));
});

test('current compatible public readers exclude unprofiled general accounts with explicit private permissions', async () => {
    for (const name of ['general-password', 'general-provider']) {
        const user = await assertGeneralPrivate(name);
        await submitP4VegaScore(generalDatabase, user.userId, 1000);
        await submitThreeBossesRun(generalDatabase, user.userId, randomUUID(), 30_000);
    }
    // Matches app.ts wiring. Older public revisions must be replaced before real general signup is enabled.
    for (const entries of [await readP4VegaLeaderboard(generalDatabase, undefined, true),
        await readThreeBossesLeaderboard(generalDatabase, undefined, true)]) {
        assert(entries.some(row => row.userName === 'leaderboard-legacy'));
        assert(entries.every(row => !row.userName.startsWith('general-')));
    }
});

test('general password/provider concurrency consumes exactly one grant with no orphan user or privacy row', async () => {
    const g = await generalGrant();
    const names = ['general-race-password', 'general-race-provider'];
    const results = await Promise.allSettled([
        createRegisteredPasswordAccount(generalDatabase, passwordInput(names[0]), g.consume),
        createProviderAccount(generalDatabase, identity(names[1]), names[1], (connection, user) => g.consume(connection, user.accountId)),
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const [users] = await administrator.query<RowDataPacket[]>(
        'SELECT user_name FROM users WHERE user_name IN (?,?)', names);
    assert.equal(users.length, 1);
    await assertGeneralPrivate(String(users[0].user_name));
    await assert.rejects(g.registration.assertAvailable(g.binding));
    await assert.rejects(createRegisteredPasswordAccount(generalDatabase, passwordInput('general-replay'), g.consume));
    assert.equal((await administrator.query<RowDataPacket[]>(
        "SELECT user_id FROM users WHERE user_name='general-replay'"))[0].length, 0);
    const [orphans] = await administrator.query<RowDataPacket[]>(`SELECT p.account_uuid FROM account_score_permissions p
        LEFT JOIN users u ON u.account_uuid=p.account_uuid WHERE u.account_uuid IS NULL`);
    assert.equal(orphans.length, 0);
});

test('downstream failure rolls back general account, identity, private permission and single-use consumption', async () => {
    const g = await generalGrant();
    let rolledBackAccount: string | undefined;
    await assert.rejects(createProviderAccount(generalDatabase, identity('general-rollback'), 'general-rollback', async (connection, user) => {
        rolledBackAccount = user.accountId;
        await g.consume(connection, user.accountId);
        throw new Error('synthetic downstream credential failure');
    }));
    assert(rolledBackAccount);
    for (const table of ['users', 'account_provider_identities', 'account_score_permissions', 'account_registration_profiles']) {
        const [remainingRows]: [RowDataPacket[], unknown] = await administrator.query<RowDataPacket[]>(
            'SELECT account_uuid FROM ?? WHERE account_uuid=?', [table, rolledBackAccount]);
        assert.equal(remainingRows.length, 0, `${table} must roll back with the account transaction`);
    }
    await g.registration.assertAvailable(g.binding);
    assert.equal(await createRegisteredPasswordAccount(generalDatabase, passwordInput('general-retry'), g.consume), 'created');
    await assertGeneralPrivate('general-retry');
    await assert.rejects(g.registration.assertAvailable(g.binding));
});
