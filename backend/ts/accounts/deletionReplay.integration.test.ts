import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import bcrypt from 'bcryptjs';
import mysql, { type Connection, type Pool, type RowDataPacket } from 'mysql2/promise';
import type { DeletionReplaySettings } from '../config/deletionReplayConfig';
import { loadMigrationConfig } from '../config/migrationConfig';
import { submitP4VegaScore } from '../leaderboards/p4VegaScoreRepository';
import { submitThreeBossesRun } from '../leaderboards/threeBossesRunRepository';
import { ACCOUNT_IDENTITY_MIGRATION_VERSION } from '../migrations/accountIdentitySchema';
import type { MigrationConnection } from '../migrations/leaderboardSchema';
import { loadMigrationManifest } from '../migrations/migrationManifest';
import { applyMigrations } from '../migrations/migrationRunner';
import { deleteAccount } from './accountDeletionRepository';
import type { AccountDeletionJournal, DeletionIntent, DeletionJournalReader } from './deletionJournal';
import { applyDeletionReplay, planDeletionReplay } from './deletionReplay';

const config = loadMigrationConfig();
const testPort = Number(process.env.MIGRATION_TEST_PORT);
const TEST_PASSWORD = 'replay-isolated-test-only';
const TABLES = ['users', 'game_personal_bests', 'game_submission_receipts', 'account_provider_identities', 'provider_auth_attempts', 'account_sessions'] as const;
let administrator: Connection;
let database: Pool;
let settings: DeletionReplaySettings;

function assertIsolatedFixture(): void {
    assert.equal(process.env.NODE_ENV, 'test');
    assert.equal(process.env.MIGRATION_TEST_ENABLED, '1');
    assert.equal(process.env.CLOUD_SQL_CONNECTION_NAME, undefined);
    assert.ok(Number.isSafeInteger(testPort) && testPort >= 1 && testPort <= 65535 && testPort !== 3306);
    assert.deepEqual({ host: config.host, port: config.port, database: config.database, user: config.user }, {
        host: '127.0.0.1', port: testPort, database: 'mickeyf_migration_test', user: 'migration_test',
    }, 'Deletion replay integration runs only inside the pinned disposable MySQL harness');
    assert.equal(config.password, 'migration-test-only');
}

before(async () => {
    assertIsolatedFixture();
    administrator = await mysql.createConnection({
        host: config.host, port: config.port, database: config.database, user: config.user, password: config.password,
        connectTimeout: 10000, multipleStatements: false, dateStrings: true, timezone: 'Z',
    });
    const [identity] = await administrator.query<RowDataPacket[]>(`SELECT DATABASE() AS databaseName,
        CURRENT_USER() AS currentUser, @@version AS version, @@version_comment AS versionComment,
        @@GLOBAL.server_uuid AS serverUuid`);
    assert.equal(identity[0].databaseName, 'mickeyf_migration_test');
    assert.equal(identity[0].currentUser, 'migration_test@%');
    assert.match(identity[0].version, /^8\.0\.31(?:-|$)/u);
    assert.doesNotMatch(identity[0].versionComment, /Google/iu);
    await administrator.query('SET FOREIGN_KEY_CHECKS = 0');
    try {
        await administrator.query('DROP TABLE IF EXISTS account_sessions, provider_auth_attempts, account_provider_identities, game_personal_bests, game_runs, game_submission_receipts, schema_migrations, users');
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
    await administrator.query("SET SESSION time_zone = '+00:00'");
    const [epoch] = await administrator.query<RowDataPacket[]>(
        "SELECT DATE_FORMAT(applied_at, '%Y-%m-%d %H:%i:%s.%f') AS epoch FROM schema_migrations WHERE version = ?",
        [ACCOUNT_IDENTITY_MIGRATION_VERSION]
    );
    // Capture this original epoch before simulating recovery. The CLI never derives its pin this way.
    settings = {
        mode: 'recovery', database: config.database, expectedCurrentUser: identity[0].currentUser,
        expectedServerUuid: identity[0].serverUuid, expectedIdentityEpoch: epoch[0].epoch,
        sourceServerUuid: '11111111-2222-4333-8444-555555555555', maxIntents: 10, maxDurationMs: 60000,
    };
    database = mysql.createPool({
        host: config.host, port: config.port, database: config.database, user: config.user, password: config.password,
        connectTimeout: 10000, multipleStatements: false, connectionLimit: 2, dateStrings: true, timezone: 'Z',
    });
});

after(async () => {
    if (database) await database.end();
    if (administrator) await administrator.end();
});

async function snapshotRows(): Promise<Record<string, RowDataPacket[]>> {
    const result: Record<string, RowDataPacket[]> = {};
    for (const table of TABLES) {
        const order = table === 'account_provider_identities' ? 'account_uuid, provider'
            : table === 'account_sessions' ? 'account_uuid, session_hash' : 'user_id';
        [result[table]] = await administrator.query<RowDataPacket[]>(`SELECT * FROM ${table} ORDER BY ${order}`);
    }
    return result;
}

async function insertProviderLink(userId: number, provider: 'google' | 'apple', subject: string): Promise<void> {
    await administrator.query(`INSERT INTO account_provider_identities (account_uuid, provider, subject, linked_at)
        SELECT account_uuid, ?, ?, UTC_TIMESTAMP(6) FROM users WHERE user_id = ?`,
    [provider, Buffer.from(subject, 'utf8'), userId]);
}

async function insertPendingAttempt(userId: number): Promise<void> {
    await administrator.query(`INSERT INTO provider_auth_attempts
        (state_hash, binding_hash, nonce, client_key, action, user_id, account_uuid, expires_at)
        SELECT ?, ?, ?, 'google_native', 'link', user_id, account_uuid,
            UTC_TIMESTAMP(6) + INTERVAL 5 MINUTE FROM users WHERE user_id = ?`,
    [Buffer.alloc(32, userId), Buffer.alloc(32, userId + 10), Buffer.alloc(32, userId).toString('base64url'), userId]);
}

async function insertSession(userId: number): Promise<void> {
    await administrator.query(`INSERT INTO account_sessions (session_hash, account_uuid, created_at, expires_at,
        remembered, renewed_at, previous_session_hash, previous_valid_until)
        SELECT ?, account_uuid, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6) + INTERVAL 30 DAY,
            1, UTC_TIMESTAMP(6), ?, UTC_TIMESTAMP(6) + INTERVAL 2 MINUTE FROM users WHERE user_id = ?`,
    [createHash('sha256').update(`isolated-session-${userId}`).digest(),
        createHash('sha256').update(`isolated-previous-session-${userId}`).digest(), userId]);
}

test('reconciles a restored deleted identity, preserves others, and never targets a reused numeric ID', async () => {
    const passwordHash = await bcrypt.hash(TEST_PASSWORD, 4);
    await administrator.query(`INSERT INTO users (user_id,user_name,email,user_password) VALUES
        (1,'deleted-fixture','deleted@example.test',?),(2,'other-fixture','other@example.test',?)`,
    [passwordHash, passwordHash]);
    for (const userId of [1, 2]) {
        await submitP4VegaScore(database, userId, userId === 1 ? 900 : 500);
        await submitThreeBossesRun(database, userId, randomUUID(), userId === 1 ? 60000 : 70000);
        await insertProviderLink(userId, 'google', `google-subject-${userId}`);
        await insertProviderLink(userId, 'apple', `apple-subject-${userId}`);
        await insertPendingAttempt(userId);
        await insertSession(userId);
    }
    const beforeDeletion = await snapshotRows();
    const original = beforeDeletion.users.find(row => row.user_id === 1)!;
    const unrelated = beforeDeletion.users.find(row => row.user_id === 2)!;
    const unrelatedRows = (table: string) => beforeDeletion[table].filter(row =>
        table === 'account_provider_identities' || table === 'account_sessions'
            ? row.account_uuid === unrelated.account_uuid : row.user_id === 2);
    const intents: DeletionIntent[] = [];
    const journal: AccountDeletionJournal & DeletionJournalReader = {
        async recordAccountDeletion(accountId) {
            intents.push({ version: 1, accountId, action: 'delete-account', requestedAt: new Date().toISOString() });
        },
        async readDeletionIntents() {
            return { intents, digest: createHash('sha256').update(JSON.stringify(intents)).digest('hex') };
        },
    };
    assert.equal(await deleteAccount(database, 1, TEST_PASSWORD, journal), 'deleted');
    assert.equal(intents[0].accountId, original.account_uuid);
    assert.deepEqual((await snapshotRows()).account_provider_identities, unrelatedRows('account_provider_identities'),
        'ordinary account deletion cascades both provider links and preserves unrelated links');
    assert.deepEqual((await snapshotRows()).provider_auth_attempts, unrelatedRows('provider_auth_attempts'),
        'ordinary deletion also removes pending linked attempts, but no unrelated attempt');
    assert.deepEqual((await snapshotRows()).account_sessions, unrelatedRows('account_sessions'),
        'ordinary deletion revokes every device belonging to the deleted account');

    // Restore fixture rows with their original UUID, as a post-migration backup would.
    await administrator.query('INSERT INTO users (user_id,account_uuid,user_name,email,user_password) VALUES (?,?,?,?,?)',
        [1, original.account_uuid, original.user_name, original.email, original.user_password]);
    for (const link of beforeDeletion.account_provider_identities.filter(row => row.account_uuid === original.account_uuid)) {
        await administrator.query(`INSERT INTO account_provider_identities (account_uuid, provider, subject, linked_at)
            VALUES (?, ?, ?, ?)`, [link.account_uuid, link.provider, link.subject, link.linked_at]);
    }
    assert.deepEqual((await snapshotRows()).account_provider_identities, beforeDeletion.account_provider_identities,
        'the restored fixture includes the original provider links');
    const attempt = beforeDeletion.provider_auth_attempts.find(row => row.user_id === 1)!;
    await administrator.query(`INSERT INTO provider_auth_attempts
        (state_hash, binding_hash, nonce, client_key, action, user_id, account_uuid, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [attempt.state_hash, attempt.binding_hash, attempt.nonce,
        attempt.client_key, attempt.action, attempt.user_id, attempt.account_uuid, attempt.expires_at]);
    const session = beforeDeletion.account_sessions.find(row => row.account_uuid === original.account_uuid)!;
    await administrator.query(`INSERT INTO account_sessions (session_hash, account_uuid, created_at, expires_at,
        remembered, renewed_at, previous_session_hash, previous_valid_until)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [session.session_hash, session.account_uuid, session.created_at, session.expires_at,
        session.remembered, session.renewed_at, session.previous_session_hash, session.previous_valid_until]);
    await submitP4VegaScore(database, 1, 900);
    await submitThreeBossesRun(database, 1, randomUUID(), 60000);
    const plan = await planDeletionReplay(database, journal, settings);
    const result = await applyDeletionReplay(database, journal, settings, plan.sha256);
    assert.equal(result.deletedAccounts, 1);
    for (const [table, remaining] of Object.entries(await snapshotRows())) {
        assert.deepEqual(remaining, unrelatedRows(table), `${table} preserves the unrelated account exactly`);
    }
    const repeated = await applyDeletionReplay(database, journal, settings, plan.sha256);
    assert.equal(repeated.deletedAccounts, 0);
    assert.equal(repeated.absentAccounts, 1);

    await administrator.query('INSERT INTO users (user_id,user_name,email,user_password) VALUES (1,?,?,?)',
        ['replacement-fixture', 'replacement@example.test', passwordHash]);
    await submitP4VegaScore(database, 1, 300);
    await insertProviderLink(1, 'google', 'replacement-google-subject');
    await insertProviderLink(1, 'apple', 'replacement-apple-subject');
    await insertPendingAttempt(1);
    await insertSession(1);
    const reused = await snapshotRows();
    assert.notEqual(reused.users.find(row => row.user_id === 1)!.account_uuid, original.account_uuid);
    assert.equal(reused.account_provider_identities.length, 4);
    const safe = await applyDeletionReplay(database, journal, settings, plan.sha256);
    assert.equal(safe.deletedAccounts, 0);
    assert.equal(safe.absentAccounts, 1);
    assert.deepEqual(await snapshotRows(), reused);
    await assert.rejects(planDeletionReplay(database, journal, {
        ...settings, expectedIdentityEpoch: '2000-01-01 00:00:00.000000',
    }), /independently/u);
    assert.deepEqual(await snapshotRows(), reused);
});
