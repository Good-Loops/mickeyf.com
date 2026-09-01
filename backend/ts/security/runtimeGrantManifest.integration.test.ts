import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import mysql, {
    Connection,
    Pool,
    RowDataPacket,
} from 'mysql2/promise';
import { loadMigrationConfig } from '../config/migrationConfig';
import {
    readP4VegaLeaderboard,
    submitP4VegaScore,
} from '../leaderboards/p4VegaScoreRepository';
import {
    readThreeBossesLeaderboard,
    submitThreeBossesRun,
} from '../leaderboards/threeBossesRunRepository';
import type { MigrationConnection } from '../migrations/leaderboardSchema';
import { loadMigrationManifest } from '../migrations/migrationManifest';
import { applyMigrations } from '../migrations/migrationRunner';
import {
    renderRuntimeGrantStatements,
    runtimeColumnPrivilegeInventory,
    type RuntimeColumnPrivilege,
    type RuntimeDatabaseAccount,
} from './runtimeGrantManifest';

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
                game_personal_bests,
                game_runs,
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
}

async function resetData(): Promise<void> {
    await administrator.query('SET FOREIGN_KEY_CHECKS = 0');
    try {
        await administrator.query('TRUNCATE TABLE game_personal_bests');
        await administrator.query('TRUNCATE TABLE game_runs');
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
    if (root) {
        await root.query("DROP USER IF EXISTS 'runtime_grant_test'@'%'");
        await root.end();
    }
    if (administrator) await administrator.end();
});

test('installs only the exact column-level manifest with no active role', async () => {
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
        'TABLE_PRIVILEGES',
    ] as const) {
        const [rows] = await root.query<Array<RowDataPacket & { privilegeCount: number }>>(
            `SELECT COUNT(*) AS privilegeCount
             FROM information_schema.${scope}
             WHERE GRANTEE = ? AND PRIVILEGE_TYPE <> 'USAGE'`,
            [TEST_RUNTIME_GRANTEE]
        );
        assert.equal(Number(rows[0].privilegeCount), 0, `${scope} must be empty`);
    }

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
        `SELECT user_id, user_name, user_password
         FROM users
         WHERE user_name = ?
         LIMIT 1`,
        ['player-2']
    );
    assert.equal(loginRows.length, 1);

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

test('denies migration history, ledger mutation, destructive DML, and DDL', async () => {
    await assertPrivilegeDenied(() =>
        runtimePool.query('SELECT version FROM schema_migrations LIMIT 1'));
    await assertPrivilegeDenied(() =>
        runtimePool.query('SELECT source_game_run_id FROM game_personal_bests LIMIT 1'));
    await assertPrivilegeDenied(() =>
        runtimePool.query('UPDATE users SET email = email WHERE user_id = 1'));
    await assertPrivilegeDenied(() =>
        runtimePool.query('SELECT user_id FROM users WHERE user_id = 1 FOR UPDATE'));
    await assertPrivilegeDenied(() =>
        runtimePool.query('UPDATE game_runs SET score = score WHERE 1 = 0'));
    await assertPrivilegeDenied(() =>
        runtimePool.query('DELETE FROM game_runs WHERE 1 = 0'));
    await assertPrivilegeDenied(() =>
        runtimePool.query('ALTER TABLE users ADD COLUMN forbidden INT NULL'));
    await assertPrivilegeDenied(() =>
        runtimePool.query("CREATE USER 'forbidden_runtime_user'@'%'"));
    await assertPrivilegeDenied(() =>
        runtimePool.query(
            "GRANT SELECT ON mickeyf_migration_test.users TO 'runtime_grant_test'@'%'"
        ));
});
