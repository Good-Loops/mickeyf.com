import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import bcrypt from 'bcryptjs';
import mysql, {
    Connection,
    Pool,
    RowDataPacket,
} from 'mysql2/promise';
import { loadMigrationConfig } from '../config/migrationConfig';
import { deleteAccount } from '../accounts/accountDeletionRepository';
import { findProviderAccount, linkProviderAccount, readProviderAccountMethods } from '../accounts/providerAccountRepository';
import { createAccountSession, readLiveSession, renewAccountSession, revokeAccountSession } from '../auth/accountSessionRepository';
import { consumeProviderAttempt, createProviderAttempt, type ProviderAttempt } from '../auth/providerAttemptRepository';
import type { VerifiedProviderIdentity } from '../auth/providerIdentity';
import { deriveRenewedSessionId } from './sessionPolicy';
import { verifyAccountSessionReadiness, verifyProviderAuthReadiness } from '../accounts/accountDeletionReadiness';
import {
    readP4VegaLeaderboard,
    submitP4VegaScore,
} from '../leaderboards/p4VegaScoreRepository';
import {
    readThreeBossesLeaderboard,
    submitThreeBossesRun,
} from '../leaderboards/threeBossesRunRepository';
import type { MigrationConnection } from '../migrations/leaderboardSchema';
import { cleanupSubmissionReceipts } from '../leaderboards/submissionReceiptCleanup';
import { loadMigrationManifest } from '../migrations/migrationManifest';
import { ACCOUNT_IDENTITY_MIGRATION_VERSION, assertAccountIdentityEpoch, verifyAccountIdentitySchema } from '../migrations/accountIdentitySchema';
import { applyMigrations } from '../migrations/migrationRunner';
import {
    renderRuntimeGrantStatements,
    runtimeColumnPrivilegeInventory,
    runtimeTablePrivilegeInventory,
    type RuntimeColumnPrivilege,
    type RuntimeDatabaseAccount,
} from './runtimeGrantManifest';
import { renderReceiptCleanupGrantStatements, verifyReceiptCleanupConnection } from './receiptCleanupGrantManifest';

const migrationTestPort = Number(process.env.MIGRATION_TEST_PORT);
const EXPECTED_TEST_TARGET = Object.freeze({
    host: '127.0.0.1',
    port: migrationTestPort,
    database: 'mickeyf_migration_test',
    user: 'migration_test',
});
const TEST_RUNTIME_ACCOUNT: RuntimeDatabaseAccount = Object.freeze({
    user: 'runtime_grant_test',
    host: '%',
});
const TEST_RUNTIME_PASSWORD = 'runtime-grant-test-only';
const TEST_RUNTIME_GRANTEE = "'runtime_grant_test'@'%'";
const TEST_CLEANUP_ACCOUNT = Object.freeze({ user: 'receipt_cleanup_grant_test', host: '%' });
const TEST_CLEANUP_GRANTEE = "'receipt_cleanup_grant_test'@'%'";
const TEST_CLEANUP_PASSWORD = 'receipt-cleanup-grant-test-only';
const DENIED_PRIVILEGE_ERROR_CODES = new Set([
    'ER_ACCESS_DENIED_ERROR',
    'ER_COLUMNACCESS_DENIED_ERROR',
    'ER_DBACCESS_DENIED_ERROR',
    'ER_SPECIFIC_ACCESS_DENIED_ERROR',
    'ER_TABLEACCESS_DENIED_ERROR',
]);

const config = loadMigrationConfig();
const migrations = loadMigrationManifest();
let administrator: Connection;
let root: Connection;
let runtimePool: Pool;
let cleanupPool: Pool;

type MysqlError = Error & { code?: string };

function asMigrationConnection(value: Connection): MigrationConnection {
    return value as unknown as MigrationConnection;
}

function assertSafeTestEnvironment(): void {
    assert.equal(process.env.NODE_ENV, 'test');
    assert.equal(process.env.MIGRATION_TEST_ENABLED, '1');
    assert.equal(process.env.CLOUD_SQL_CONNECTION_NAME, undefined);
    assert.equal(Number.isSafeInteger(migrationTestPort), true);
    assert.ok(migrationTestPort >= 1 && migrationTestPort <= 65_535);
    assert.notEqual(migrationTestPort, 3306);
    assert.deepEqual(
        {
            host: config.host,
            port: config.port,
            database: config.database,
            user: config.user,
        },
        EXPECTED_TEST_TARGET,
        'runtime-grant tests may run only against the isolated Docker target'
    );
    assert.equal(process.env.MIGRATION_TEST_ROOT_USER, 'root');
    assert.equal(
        process.env.MIGRATION_TEST_ROOT_PASSWORD,
        'migration-test-root-only'
    );
}

async function assertPrivilegeDenied(operation: () => Promise<unknown>): Promise<void> {
    await assert.rejects(operation, (error: unknown) => {
        const code = (error as MysqlError).code;
        assert.equal(
            DENIED_PRIVILEGE_ERROR_CODES.has(code ?? ''),
            true,
            `expected a privilege error, received ${String(code)}`
        );
        return true;
    });
}

async function createSchema(): Promise<void> {
    await administrator.query('SET FOREIGN_KEY_CHECKS = 0');
    try {
        await administrator.query(`
            DROP TABLE IF EXISTS
                account_sessions,
                provider_auth_attempts,
                account_provider_identities,
                game_personal_bests,
                game_runs,
                game_submission_receipts,
                schema_migrations,
                users
        `);
    } finally {
        await administrator.query('SET FOREIGN_KEY_CHECKS = 1');
    }

    await administrator.query(`
        CREATE TABLE users (
            user_id INT NOT NULL AUTO_INCREMENT,
            user_name VARCHAR(255) NOT NULL,
            email VARCHAR(255) NOT NULL,
            user_password VARCHAR(255) NOT NULL,
            CONSTRAINT pk_users PRIMARY KEY (user_id),
            UNIQUE KEY uq_users_email (email)
        ) ENGINE = InnoDB
          DEFAULT CHARACTER SET = utf8mb4
          COLLATE = utf8mb4_unicode_ci
    `);
    await applyMigrations(asMigrationConnection(administrator), migrations, config);
    await applyMigrations(asMigrationConnection(administrator), migrations, config, {
        allowedEffectKinds: ['drop-column'],
    });
    await applyMigrations(asMigrationConnection(administrator), migrations, config, {
        allowedEffectKinds: ['detach-best-source', 'retain-receipts'],
    });
    await applyMigrations(asMigrationConnection(administrator), migrations, config, {
        allowedEffectKinds: ['add-account-identity'],
    });
    await applyMigrations(asMigrationConnection(administrator), migrations, config, {
        allowedEffectKinds: ['add-provider-identities', 'add-provider-attempts', 'add-account-sessions', 'add-session-renewal'],
    });
}

async function resetData(): Promise<void> {
    await administrator.query('SET FOREIGN_KEY_CHECKS = 0');
    try {
        await administrator.query('TRUNCATE TABLE account_sessions');
        await administrator.query('TRUNCATE TABLE provider_auth_attempts');
        await administrator.query('TRUNCATE TABLE account_provider_identities');
        await administrator.query('TRUNCATE TABLE game_personal_bests');
        await administrator.query('TRUNCATE TABLE game_submission_receipts');
        await administrator.query('TRUNCATE TABLE users');
    } finally {
        await administrator.query('SET FOREIGN_KEY_CHECKS = 1');
    }
    await administrator.query(`
        INSERT INTO users (user_name, email, user_password)
        VALUES ('player-1', 'player-1@example.test', 'test-only-hash')
    `);
}

function sortInventory(
    inventory: readonly RuntimeColumnPrivilege[]
): RuntimeColumnPrivilege[] {
    return [...inventory].sort((left, right) =>
        left.tableName.localeCompare(right.tableName)
        || left.columnName.localeCompare(right.columnName)
        || left.privilegeType.localeCompare(right.privilegeType)
    );
}

before(async () => {
    assertSafeTestEnvironment();
    administrator = await mysql.createConnection({
        host: config.host,
        port: config.port,
        user: config.user,
        password: config.password,
        database: config.database,
        dateStrings: true,
        multipleStatements: false,
    });
    root = await mysql.createConnection({
        host: config.host,
        port: config.port,
        user: process.env.MIGRATION_TEST_ROOT_USER,
        password: process.env.MIGRATION_TEST_ROOT_PASSWORD,
        database: config.database,
        dateStrings: true,
        multipleStatements: false,
    });

    const [versionRows] = await root.query<Array<RowDataPacket & {
        version: string;
        versionComment: string;
    }>>('SELECT @@version AS version, @@version_comment AS versionComment');
    assert.match(versionRows[0].version, /^8\.0\.31(?:-|$)/u);
    assert.doesNotMatch(versionRows[0].versionComment, /Google/iu);

    await createSchema();
    await root.query("DROP USER IF EXISTS 'runtime_grant_test'@'%'");
    await root.query(
        "CREATE USER 'runtime_grant_test'@'%' IDENTIFIED BY ?",
        [TEST_RUNTIME_PASSWORD]
    );
    for (const statement of renderRuntimeGrantStatements(
        config.database,
        TEST_RUNTIME_ACCOUNT
    )) {
        await root.query(statement);
    }
    await root.query(`DROP USER IF EXISTS ${TEST_CLEANUP_GRANTEE}`);
    await root.query(`CREATE USER ${TEST_CLEANUP_GRANTEE} IDENTIFIED BY ?`, [TEST_CLEANUP_PASSWORD]);
    for (const statement of renderReceiptCleanupGrantStatements(config.database, TEST_CLEANUP_ACCOUNT)) {
        await root.query(statement);
    }
    cleanupPool = mysql.createPool({
        host: config.host,
        port: config.port,
        user: TEST_CLEANUP_ACCOUNT.user,
        password: TEST_CLEANUP_PASSWORD,
        database: config.database,
        dateStrings: true,
        multipleStatements: false,
        connectionLimit: 1,
    });

    runtimePool = mysql.createPool({
        host: config.host,
        port: config.port,
        user: TEST_RUNTIME_ACCOUNT.user,
        password: TEST_RUNTIME_PASSWORD,
        database: config.database,
        dateStrings: true,
        multipleStatements: false,
        connectionLimit: 4,
        waitForConnections: true,
    });
});

beforeEach(resetData);

after(async () => {
    if (runtimePool) await runtimePool.end();
    if (cleanupPool) await cleanupPool.end();
    if (root) {
        await root.query("DROP USER IF EXISTS 'runtime_grant_test'@'%'");
        await root.query(`DROP USER IF EXISTS ${TEST_CLEANUP_GRANTEE}`);
        await root.end();
    }
    if (administrator) await administrator.end();
});

test('limited runtime session grants support rotation without rewriting immutable session properties', async () => {
    await verifyAccountSessionReadiness(runtimePool);
    const [accounts] = await runtimePool.query<RowDataPacket[]>(
        'SELECT account_uuid AS accountId FROM users WHERE user_id = 1');
    const accountId = accounts[0].accountId as string;
    const sessionId = Buffer.alloc(32, 3).toString('base64url');
    assert.equal(await createAccountSession(runtimePool, { userId: 1, accountId }, sessionId,
        Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60, undefined, true), true);
    assert.deepEqual(await readLiveSession(runtimePool, 1, accountId, sessionId), { userName: 'player-1' });
    for (const column of ['account_uuid', 'created_at', 'remembered']) {
        await assertPrivilegeDenied(() => runtimePool.query(`UPDATE account_sessions SET ${column} = ${column} WHERE 1 = 0`));
    }
    // Only the isolated fixture administrator advances eligibility; the runtime performs the actual rotation.
    await administrator.query('UPDATE account_sessions SET renewed_at = UTC_TIMESTAMP(6) - INTERVAL 16 MINUTE WHERE account_uuid = ?',
        [accountId]);
    const renewed = await renewAccountSession(runtimePool, 1, accountId, sessionId,
        oldId => deriveRenewedSessionId(oldId, 'isolated-session-renewal-secret'));
    assert.ok(renewed?.renewal);
    assert.deepEqual(await readLiveSession(runtimePool, 1, accountId, renewed.renewal.sessionId), { userName: 'player-1' });
    await revokeAccountSession(runtimePool, 1, accountId, sessionId);
    assert.equal(await readLiveSession(runtimePool, 1, accountId, sessionId), null);
    assert.equal(await readLiveSession(runtimePool, 1, accountId, renewed.renewal.sessionId), null);
});

test('limited provider grants support schema readiness, linking and login without identity reassignment', async () => {
    await verifyProviderAuthReadiness(runtimePool);
    const password = 'provider-grant-test-only';
    await administrator.query('UPDATE users SET user_password = ? WHERE user_id = 1', [await bcrypt.hash(password, 4)]);
    const [accounts] = await runtimePool.query<RowDataPacket[]>('SELECT account_uuid AS accountId FROM users WHERE user_id = 1');
    const target = { userId: 1, accountId: accounts[0].accountId as string };
    const proof = { accountId: target.accountId, sessionId: Buffer.alloc(32, 4).toString('base64url') };
    assert.equal(await createAccountSession(runtimePool, target, proof.sessionId,
        Math.floor(Date.now() / 1000) + 3_600), true);
    const identity = { provider: 'google', subject: 'isolated-grant-subject' } as VerifiedProviderIdentity;
    assert.equal(await findProviderAccount(runtimePool, identity), null);
    assert.equal(await linkProviderAccount(runtimePool, target, password, identity, proof), 'linked');
    // The duplicate path performs SELECT ... FOR UPDATE and must work without granting identity reassignment.
    assert.equal(await linkProviderAccount(runtimePool, target, password, identity, proof), 'already-linked');
    assert.deepEqual(await findProviderAccount(runtimePool, identity), { ...target, userName: 'player-1' });
    assert.deepEqual(await readProviderAccountMethods(runtimePool, target.accountId), { hasPassword: true, googleLinked: true });
    for (const column of ['provider', 'subject', 'account_uuid']) {
        await assertPrivilegeDenied(() => runtimePool.query(
            `UPDATE account_provider_identities SET ${column} = ${column} WHERE 1 = 0`));
    }
    await assertPrivilegeDenied(() => runtimePool.query('DELETE FROM account_provider_identities WHERE 1 = 0'));
});

test('limited attempt grants create and consume login and link challenges without UPDATE', async () => {
    const [accounts] = await runtimePool.query<RowDataPacket[]>('SELECT account_uuid AS accountId FROM users WHERE user_id = 1');
    for (const [index, action] of (['login', 'link'] as const).entries()) {
        const attempt: ProviderAttempt = {
            stateHash: Buffer.alloc(32, index + 10), bindingHash: Buffer.alloc(32, index + 20),
            nonce: Buffer.alloc(32, index + 30).toString('base64url'), clientKey: 'google-web', action,
            userId: action === 'link' ? 1 : null, accountId: action === 'link' ? accounts[0].accountId as string : null,
        };
        assert.equal(await createProviderAttempt(runtimePool, attempt), 'created');
        assert.deepEqual(await consumeProviderAttempt(runtimePool, attempt.stateHash, attempt.bindingHash, attempt.clientKey, action), {
            nonce: attempt.nonce, userId: attempt.userId, accountId: attempt.accountId,
        });
        assert.equal(await consumeProviderAttempt(runtimePool, attempt.stateHash, attempt.bindingHash, attempt.clientKey, action), null);
    }
    await assertPrivilegeDenied(() => runtimePool.query('UPDATE provider_auth_attempts SET nonce = nonce WHERE 1 = 0'));
});

test('installs exact column grants and account-deletion table grants with no active role', async () => {
    const [columnRows] = await root.query<Array<RowDataPacket & {
        tableName: RuntimeColumnPrivilege['tableName'];
        columnName: string;
        privilegeType: RuntimeColumnPrivilege['privilegeType'];
        isGrantable: string;
    }>>(
        `SELECT
            TABLE_NAME AS tableName,
            COLUMN_NAME AS columnName,
            PRIVILEGE_TYPE AS privilegeType,
            IS_GRANTABLE AS isGrantable
        FROM information_schema.COLUMN_PRIVILEGES
        WHERE GRANTEE = ? AND TABLE_SCHEMA = ?`,
        [TEST_RUNTIME_GRANTEE, config.database]
    );
    assert.equal(columnRows.every(({ isGrantable }) => isGrantable === 'NO'), true);
    assert.deepEqual(
        sortInventory(columnRows.map(({ tableName, columnName, privilegeType }) => ({
            tableName,
            columnName,
            privilegeType,
        }))),
        sortInventory(runtimeColumnPrivilegeInventory())
    );

    for (const scope of [
        'SCHEMA_PRIVILEGES',
    ] as const) {
        const [rows] = await root.query<Array<RowDataPacket & { privilegeCount: number }>>(
            `SELECT COUNT(*) AS privilegeCount
             FROM information_schema.${scope}
             WHERE GRANTEE = ? AND PRIVILEGE_TYPE <> 'USAGE'`,
            [TEST_RUNTIME_GRANTEE]
        );
        assert.equal(Number(rows[0].privilegeCount), 0, `${scope} must be empty`);
    }

    const [tableRows] = await root.query<RowDataPacket[]>(
        `SELECT TABLE_SCHEMA AS schemaName, TABLE_NAME AS tableName,
                PRIVILEGE_TYPE AS privilegeType, IS_GRANTABLE AS isGrantable
         FROM information_schema.TABLE_PRIVILEGES
         WHERE GRANTEE = ? ORDER BY TABLE_SCHEMA, TABLE_NAME, PRIVILEGE_TYPE`,
        [TEST_RUNTIME_GRANTEE]
    );
    assert.deepEqual(tableRows, runtimeTablePrivilegeInventory()
        .map((privilege) => ({ schemaName: config.database, ...privilege, isGrantable: 'NO' }))
        .sort((left, right) => left.tableName.localeCompare(right.tableName)));

    const [userPrivilegeRows] = await root.query<Array<RowDataPacket & {
        privilegeType: string;
        isGrantable: string;
    }>>(
        `SELECT
            PRIVILEGE_TYPE AS privilegeType,
            IS_GRANTABLE AS isGrantable
         FROM information_schema.USER_PRIVILEGES
         WHERE GRANTEE = ?`,
        [TEST_RUNTIME_GRANTEE]
    );
    assert.deepEqual(userPrivilegeRows, [{
        privilegeType: 'USAGE',
        isGrantable: 'NO',
    }]);

    const [roleRows] = await runtimePool.query<Array<RowDataPacket & {
        currentRole: string;
    }>>('SELECT CURRENT_ROLE() AS currentRole');
    assert.equal(roleRows[0].currentRole, 'NONE');
});

test('supports every current auth and leaderboard SQL path', async () => {
    const [epochs] = await root.query<Array<RowDataPacket & { epoch: string }>>(
        "SELECT DATE_FORMAT(applied_at, '%Y-%m-%d %H:%i:%s.%f') AS epoch FROM schema_migrations WHERE version = ?",
        [ACCOUNT_IDENTITY_MIGRATION_VERSION]
    );
    await assertAccountIdentityEpoch(runtimePool as unknown as MigrationConnection, epochs[0].epoch);
    await verifyAccountIdentitySchema(runtimePool as unknown as MigrationConnection);
    const [duplicates] = await runtimePool.query<RowDataPacket[]>(
        'SELECT 1 FROM users WHERE user_name = ? OR email = ? LIMIT 1',
        ['player-1', 'unused@example.test']
    );
    assert.equal(duplicates.length, 1);

    await runtimePool.query(
        'INSERT INTO users (user_name, email, user_password) VALUES (?, ?, ?)',
        ['player-2', 'player-2@example.test', 'test-only-hash']
    );
    const [loginRows] = await runtimePool.query<RowDataPacket[]>(
        `SELECT user_id, account_uuid, user_name, user_password
         FROM users
         WHERE user_name = ?
         LIMIT 1`,
        ['player-2']
    );
    assert.equal(loginRows.length, 1);
    assert.match(String(loginRows[0].account_uuid), /^[a-f0-9-]{36}$/u);

    assert.equal(await submitP4VegaScore(runtimePool, 1, 900), true);
    assert.equal(await submitP4VegaScore(runtimePool, 1, 990), true);
    assert.equal(await submitP4VegaScore(runtimePool, 1, 950), false);
    assert.deepEqual(await readP4VegaLeaderboard(runtimePool), [{
        userName: 'player-1',
        score: 990,
    }]);

    const runId = randomUUID();
    const accepted = await submitThreeBossesRun(runtimePool, 1, runId, 60_000);
    assert.equal(accepted.kind, 'accepted');
    assert.deepEqual(
        await submitThreeBossesRun(runtimePool, 1, runId, 60_000),
        accepted.kind === 'accepted' ? { ...accepted, replayed: true } : accepted
    );
    const improvement = await submitThreeBossesRun(
        runtimePool,
        1,
        randomUUID(),
        50_000
    );
    assert.equal(improvement.kind, 'accepted');
    if (improvement.kind !== 'accepted') assert.fail('expected an accepted improvement');
    assert.equal(improvement.personalBest, true);
    assert.deepEqual(await readThreeBossesLeaderboard(runtimePool), [{
        userName: 'player-1',
        score: 200_000,
        completionTimeMs: 50_000,
    }]);
});

test('deletes an account and its dependent results transactionally using only runtime grants', async () => {
    const password = 'account-deletion-test-only';
    await administrator.query('UPDATE users SET user_password = ? WHERE user_id = ?', [
        await bcrypt.hash(password, 4), 1,
    ]);
    await administrator.query(
        'INSERT INTO users (user_name, email, user_password) VALUES (?, ?, ?)',
        ['unrelated-player', 'unrelated@example.test', 'test-only-hash']
    );
    await submitP4VegaScore(runtimePool, 1, 900);
    await submitThreeBossesRun(runtimePool, 1, randomUUID(), 60_000);
    await submitP4VegaScore(runtimePool, 2, 500);
    await submitThreeBossesRun(runtimePool, 2, randomUUID(), 70_000);
    const tables = ['users', 'game_submission_receipts', 'game_personal_bests'];
    const rowsBefore = new Map<string, RowDataPacket[]>();
    for (const table of tables) {
        const [rows] = await administrator.query<RowDataPacket[]>(`SELECT * FROM ${table}`);
        rowsBefore.set(table, rows);
    }

    const recordedAccountIds: string[] = [];
    const journal = {
        recordAccountDeletion: async (accountId: string) => { recordedAccountIds.push(accountId); },
    };
    assert.equal(await deleteAccount(runtimePool, 1, 'wrong-test-password', journal), 'invalid-password');
    assert.deepEqual(recordedAccountIds, []);
    for (const table of tables) {
        const [unchanged] = await administrator.query<RowDataPacket[]>(`SELECT * FROM ${table}`);
        assert.deepEqual(unchanged, rowsBefore.get(table), `${table} unchanged after failed reauthentication`);
    }

    assert.equal(await deleteAccount(runtimePool, 1, password, journal), 'deleted');
    assert.equal(await deleteAccount(runtimePool, 1, password, journal), 'not-found');
    const deletedAccount = rowsBefore.get('users')?.find((row) => row.user_id === 1);
    assert.deepEqual(recordedAccountIds, [deletedAccount?.account_uuid]);
    assert.match(recordedAccountIds[0], /^[a-f0-9-]{36}$/u);
    for (const table of tables) {
        const [remaining] = await administrator.query<RowDataPacket[]>(
            `SELECT * FROM ${table}`
        );
        assert.deepEqual(remaining, rowsBefore.get(table)?.filter((row) => row.user_id === 2),
            `${table} preserves all unrelated data and removes all deleted-account data`);
    }
});

test('denies migration history, receipt updates, unrelated deletion, and DDL', async () => {
    await assertPrivilegeDenied(() =>
        runtimePool.query('SELECT checksum FROM schema_migrations LIMIT 1'));
    await assertPrivilegeDenied(() =>
        runtimePool.query('SELECT game_run_id FROM game_submission_receipts LIMIT 1'));
    await assertPrivilegeDenied(() =>
        runtimePool.query('UPDATE users SET email = email WHERE user_id = 1'));
    await assertPrivilegeDenied(() =>
        runtimePool.query('UPDATE users SET account_uuid = UUID() WHERE user_id = 1'));
    await assertPrivilegeDenied(() =>
        runtimePool.query(
            'INSERT INTO users (account_uuid, user_name, email, user_password) VALUES (?, ?, ?, ?)',
            [randomUUID(), 'forbidden-identity', 'forbidden@example.test', 'test-only-hash']
        ));
    await assertPrivilegeDenied(() =>
        runtimePool.query('UPDATE game_submission_receipts SET score = score WHERE 1 = 0'));
    await assertPrivilegeDenied(() =>
        runtimePool.query('DELETE FROM schema_migrations WHERE 1 = 0'));
    await assertPrivilegeDenied(() =>
        runtimePool.query('ALTER TABLE users ADD COLUMN forbidden INT NULL'));
    await assertPrivilegeDenied(() =>
        runtimePool.query("CREATE USER 'forbidden_runtime_user'@'%'"));
    await assertPrivilegeDenied(() =>
        runtimePool.query(
            "GRANT SELECT ON mickeyf_migration_test.users TO 'runtime_grant_test'@'%'"
        ));
});

test('cleanup identity deletes receipts without reading gameplay or changing permanent bests', async () => {
    const [serverRows] = await root.query<RowDataPacket[]>('SELECT @@GLOBAL.server_uuid AS serverUuid');
    const cleanupSession = await cleanupPool.getConnection();
    try {
        await verifyReceiptCleanupConnection(cleanupSession, config.database, TEST_CLEANUP_ACCOUNT, String(serverRows[0].serverUuid));
    } finally {
        cleanupSession.release();
    }
    await submitThreeBossesRun(runtimePool, 1, randomUUID(), 60_000);
    const [beforeBest] = await administrator.query<RowDataPacket[]>('SELECT * FROM game_personal_bests');
    const [candidates] = await cleanupPool.query<RowDataPacket[]>(
        'SELECT game_run_id, user_id, submitted_at FROM game_submission_receipts ORDER BY submitted_at, game_run_id LIMIT 100'
    );
    assert.equal(candidates.length, 1);
    await administrator.query(`UPDATE game_submission_receipts
        SET submitted_at = UTC_TIMESTAMP(6) - INTERVAL 25 HOUR`);
    const summary = await cleanupSubmissionReceipts(cleanupPool, {
        verifyConnection: (connection) => verifyReceiptCleanupConnection(
            connection, config.database, TEST_CLEANUP_ACCOUNT, String(serverRows[0].serverUuid)
        ),
    });
    assert.equal(summary.deletedReceipts, 1);
    assert.equal(summary.status, 'completed');
    const [afterBest] = await administrator.query<RowDataPacket[]>('SELECT * FROM game_personal_bests');
    assert.deepEqual(afterBest, beforeBest);
    const [remaining] = await administrator.query<RowDataPacket[]>('SELECT game_run_id FROM game_submission_receipts');
    assert.deepEqual(remaining, []);

    for (const sql of [
        'SELECT user_password FROM users LIMIT 1',
        'SELECT score FROM game_personal_bests LIMIT 1',
        'SELECT version FROM schema_migrations LIMIT 1',
        'SELECT score FROM game_submission_receipts LIMIT 1',
        'SELECT payload_fingerprint FROM game_submission_receipts LIMIT 1',
        'DELETE FROM users WHERE 1 = 0',
        'DELETE FROM game_personal_bests WHERE 1 = 0',
        'UPDATE game_personal_bests SET score = 0 WHERE 1 = 0',
        'UPDATE game_submission_receipts SET submitted_at = NOW() WHERE 1 = 0',
        'INSERT INTO game_submission_receipts (user_id) VALUES (1)',
        'ALTER TABLE game_submission_receipts ADD COLUMN forbidden INT NULL',
        'DROP TABLE game_submission_receipts',
    ]) {
        await assertPrivilegeDenied(() => cleanupPool.query(sql));
    }

    const [tableGrants] = await root.query<RowDataPacket[]>(
        `SELECT TABLE_SCHEMA AS schemaName, TABLE_NAME AS tableName, PRIVILEGE_TYPE AS privilegeType,
                IS_GRANTABLE AS isGrantable
         FROM information_schema.TABLE_PRIVILEGES WHERE GRANTEE = ?`,
        [TEST_CLEANUP_GRANTEE]
    );
    assert.deepEqual(tableGrants, [{
        schemaName: config.database, tableName: 'game_submission_receipts',
        privilegeType: 'DELETE', isGrantable: 'NO',
    }]);
    const [columnGrants] = await root.query<RowDataPacket[]>(
        `SELECT TABLE_SCHEMA AS schemaName, TABLE_NAME AS tableName, COLUMN_NAME AS columnName,
                PRIVILEGE_TYPE AS privilegeType, IS_GRANTABLE AS isGrantable
         FROM information_schema.COLUMN_PRIVILEGES WHERE GRANTEE = ? ORDER BY COLUMN_NAME`,
        [TEST_CLEANUP_GRANTEE]
    );
    assert.deepEqual(columnGrants, ['game_run_id', 'submitted_at', 'user_id'].map((columnName) => ({
        schemaName: config.database, tableName: 'game_submission_receipts', columnName,
        privilegeType: 'SELECT', isGrantable: 'NO',
    })));
    const [roles] = await cleanupPool.query<RowDataPacket[]>('SELECT CURRENT_ROLE() AS currentRole');
    assert.equal(roles[0].currentRole, 'NONE');
});
