import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { after, before, beforeEach, test } from 'node:test';
import mysql, {
    type Connection,
    type ResultSetHeader,
    type RowDataPacket,
} from 'mysql2/promise';
import { loadMigrationConfig } from '../config/migrationConfig';
import type { MigrationConnection } from './leaderboardSchema';
import { loadMigrationManifest, type MigrationDefinition } from './migrationManifest';
import {
    applyMigrations,
    migrationLockName,
    planMigrations,
    rollbackEmptyLeaderboardSchema,
} from './migrationRunner';

const migrationTestPort = Number(process.env.MIGRATION_TEST_PORT);
const EXPECTED_TEST_TARGET = Object.freeze({
    host: '127.0.0.1',
    port: migrationTestPort,
    database: 'mickeyf_migration_test',
    user: 'migration_test',
});

const config = loadMigrationConfig();
const migrations = loadMigrationManifest();
let connection: Connection;

type CliResult = Readonly<{
    exitCode: number | null;
    stdout: string;
    stderr: string;
}>;

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
        'migration integration tests may run only against the isolated Docker target'
    );
    assert.equal(process.env.MIGRATION_TEST_HOST, EXPECTED_TEST_TARGET.host);
    assert.equal(Number(process.env.MIGRATION_TEST_PORT), EXPECTED_TEST_TARGET.port);
    assert.equal(process.env.MIGRATION_TEST_DATABASE, EXPECTED_TEST_TARGET.database);
    assert.equal(process.env.MIGRATION_TEST_USER, EXPECTED_TEST_TARGET.user);
}

function runMigrationCli(
    command: 'plan' | 'apply' | 'rollback-empty',
    overrides: Readonly<Record<string, string | undefined>> = {}
): Promise<CliResult> {
    const environment = { ...process.env };
    for (const [name, value] of Object.entries(overrides)) {
        if (value === undefined) delete environment[name];
        else environment[name] = value;
    }

    return new Promise((resolve, reject) => {
        const child = spawn(
            process.execPath,
            [
                '-r',
                'ts-node/register',
                'ts/migrations/runMigrations.ts',
                command,
            ],
            {
                cwd: process.cwd(),
                env: environment,
                shell: false,
                windowsHide: true,
                stdio: ['ignore', 'pipe', 'pipe'],
            }
        );
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
        child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
        child.once('error', reject);
        child.once('close', (exitCode) => resolve(Object.freeze({
            exitCode,
            stdout: Buffer.concat(stdout).toString('utf8'),
            stderr: Buffer.concat(stderr).toString('utf8'),
        })));
    });
}

async function resetFixture(): Promise<void> {
    await connection.query('SET FOREIGN_KEY_CHECKS = 0');
    try {
        await connection.query(`
            DROP TABLE IF EXISTS
                game_personal_bests,
                game_runs,
                schema_migrations,
                users
        `);
    } finally {
        await connection.query('SET FOREIGN_KEY_CHECKS = 1');
    }

    await connection.query(`
        CREATE TABLE users (
            user_id INT NOT NULL AUTO_INCREMENT,
            user_name VARCHAR(255) NOT NULL,
            email VARCHAR(255) NOT NULL,
            user_password VARCHAR(255) NOT NULL,
            p4_score INT NULL,
            CONSTRAINT pk_users PRIMARY KEY (user_id),
            UNIQUE KEY uq_users_email (email)
        ) ENGINE = InnoDB
          DEFAULT CHARACTER SET = utf8mb4
          COLLATE = utf8mb4_unicode_ci
    `);
    await connection.query(
        `INSERT INTO users (user_name, email, user_password, p4_score)
         VALUES
            ('null-score', 'null@example.test', 'test-only-hash', NULL),
            ('scored', 'scored@example.test', 'test-only-hash', 990)`
    );
}

async function tableCount(tableName: string): Promise<number> {
    const [rows] = await connection.query<Array<RowDataPacket & { tableCount: number }>>(`
        SELECT COUNT(*) AS tableCount
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = ?
    `, [tableName]);
    return Number(rows[0].tableCount);
}

before(async () => {
    assertSafeTestEnvironment();
    connection = await mysql.createConnection({
        host: config.host,
        port: config.port,
        user: config.user,
        password: config.password,
        database: config.database,
        dateStrings: true,
        multipleStatements: false,
    });

    const [rows] = await connection.query<Array<RowDataPacket & {
        version: string;
        versionComment: string;
        databaseName: string;
    }>>(`
        SELECT
            @@version AS version,
            @@version_comment AS versionComment,
            DATABASE() AS databaseName
    `);
    assert.match(rows[0].version, /^8\.0\.31(?:-|$)/);
    assert.doesNotMatch(rows[0].versionComment, /Google/i);
    assert.equal(rows[0].databaseName, EXPECTED_TEST_TARGET.database);
});

beforeEach(resetFixture);

after(async () => {
    if (connection) await connection.end();
});

test('clean apply is additive, checksum-recorded, and idempotent', async () => {
    const migrationConnection = asMigrationConnection(connection);
    const [usersCreateBefore] = await connection.query<RowDataPacket[]>('SHOW CREATE TABLE users');
    const [usersBefore] = await connection.query<RowDataPacket[]>(
        'SELECT * FROM users ORDER BY user_id'
    );

    const initialPlan = await planMigrations(migrationConnection, migrations, config);
    assert.deepEqual(initialPlan.pending, migrations.map(({ version }) => version));
    assert.equal(await tableCount('schema_migrations'), 0);

    const appliedPlan = await applyMigrations(migrationConnection, migrations, config);
    assert.deepEqual(appliedPlan.applied, migrations.map(({ version }) => version));
    assert.deepEqual(appliedPlan.pending, []);

    const [historyBefore] = await connection.query<RowDataPacket[]>(`
        SELECT version, HEX(checksum) AS checksum, applied_at AS appliedAt
        FROM schema_migrations
        ORDER BY version
    `);
    assert.deepEqual(
        historyBefore.map(({ version, checksum }) => ({ version, checksum })),
        migrations.map(({ version, checksum }) => ({
            version,
            checksum: checksum.toString('hex').toUpperCase(),
        }))
    );

    const secondPlan = await applyMigrations(migrationConnection, migrations, config);
    assert.deepEqual(secondPlan.applied, migrations.map(({ version }) => version));
    const [historyAfter] = await connection.query<RowDataPacket[]>(`
        SELECT version, HEX(checksum) AS checksum, applied_at AS appliedAt
        FROM schema_migrations
        ORDER BY version
    `);
    assert.deepEqual(historyAfter, historyBefore);

    const [usersCreateAfter] = await connection.query<RowDataPacket[]>('SHOW CREATE TABLE users');
    const [usersAfter] = await connection.query<RowDataPacket[]>(
        'SELECT * FROM users ORDER BY user_id'
    );
    assert.deepEqual(usersCreateAfter, usersCreateBefore);
    assert.deepEqual(usersAfter, usersBefore);
    assert.equal((await connection.query<RowDataPacket[]>('SELECT * FROM game_runs'))[0].length, 0);
    assert.equal(
        (await connection.query<RowDataPacket[]>('SELECT * FROM game_personal_bests'))[0].length,
        0
    );
});

test('checksum drift and an existing wrong-shaped table fail closed', async () => {
    const migrationConnection = asMigrationConnection(connection);
    await applyMigrations(migrationConnection, migrations, config);
    const changedMigrations: readonly MigrationDefinition[] = migrations.map((migration, index) =>
        index === 0
            ? Object.freeze({ ...migration, checksum: Buffer.alloc(32, 0xff) })
            : migration
    );

    await assert.rejects(
        () => planMigrations(migrationConnection, changedMigrations, config),
        /Checksum mismatch/
    );

    await resetFixture();
    await connection.query(`
        CREATE TABLE game_runs (
            game_run_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            CONSTRAINT pk_game_runs PRIMARY KEY (game_run_id)
        ) ENGINE = InnoDB
          DEFAULT CHARACTER SET = utf8mb4
          COLLATE = utf8mb4_unicode_ci
    `);
    await assert.rejects(
        () => applyMigrations(migrationConnection, migrations, config),
        /does not match the reviewed migration schema/
    );
    const [history] = await connection.query<RowDataPacket[]>('SELECT * FROM schema_migrations');
    assert.equal(history.length, 0);
    assert.equal(await tableCount('game_personal_bests'), 0);
});

test('recovery rejects a same-named but weakened check constraint', async () => {
    const weakenedSql = migrations[0].sql.replace(
        'CHECK (rules_version > 0)',
        'CHECK (rules_version >= 0)'
    );
    assert.notEqual(weakenedSql, migrations[0].sql);
    await connection.query(weakenedSql);

    await assert.rejects(
        () => planMigrations(asMigrationConnection(connection), migrations, config),
        /game_runs checks does not match the reviewed migration schema/
    );
    assert.equal(await tableCount('schema_migrations'), 0);
});

test('history rows are durable even when the server session began with autocommit off', async () => {
    await connection.query('SET SESSION autocommit = 0');
    await applyMigrations(asMigrationConnection(connection), migrations, config);

    const [autocommitRows] = await connection.query<Array<RowDataPacket & {
        autocommitEnabled: number;
    }>>('SELECT @@session.autocommit AS autocommitEnabled');
    assert.equal(Number(autocommitRows[0].autocommitEnabled), 1);

    const observer = await mysql.createConnection({
        host: config.host,
        port: config.port,
        user: config.user,
        password: config.password,
        database: config.database,
    });
    try {
        const [historyRows] = await observer.query<RowDataPacket[]>(
            'SELECT version FROM schema_migrations ORDER BY version'
        );
        assert.deepEqual(
            historyRows.map(({ version }) => version),
            migrations.map(({ version }) => version)
        );
    } finally {
        await observer.end();
    }
});

test('unrecorded atomic DDL is verified and safely resumed', async () => {
    const migrationConnection = asMigrationConnection(connection);
    await connection.query(migrations[0].sql);

    const plan = await planMigrations(migrationConnection, migrations, config);
    assert.deepEqual(plan.recoverable, [migrations[0].version]);
    assert.deepEqual(plan.pending, migrations.map(({ version }) => version));

    const applied = await applyMigrations(migrationConnection, migrations, config);
    assert.deepEqual(applied.applied, migrations.map(({ version }) => version));
    assert.equal(await tableCount('game_personal_bests'), 1);
});

test('advisory lock contention fails without applying partial schema', async () => {
    const lockHolder = await mysql.createConnection({
        host: config.host,
        port: config.port,
        user: config.user,
        password: config.password,
        database: config.database,
    });
    const lockName = migrationLockName(config.database);
    try {
        const [lockRows] = await lockHolder.query<Array<RowDataPacket & { acquired: number }>>(
            'SELECT GET_LOCK(?, 0) AS acquired',
            [lockName]
        );
        assert.equal(Number(lockRows[0].acquired), 1);

        await assert.rejects(
            () => applyMigrations(asMigrationConnection(connection), migrations, {
                ...config,
                advisoryLockTimeoutSeconds: 0,
            }),
            /Could not acquire/
        );
        assert.equal(await tableCount('schema_migrations'), 0);
        assert.equal(await tableCount('game_runs'), 0);
    } finally {
        await lockHolder.query('SELECT RELEASE_LOCK(?)', [lockName]);
        await lockHolder.end();
    }
});

test('shipped CLI enforces action-specific gates before applying or rolling back', async () => {
    const deniedApply = await runMigrationCli('apply', {
        MIGRATION_DB_PORT: '9',
        MIGRATION_CONFIRM_TARGET: `127.0.0.1:9/${config.database}`,
        MIGRATION_ALLOW_APPLY: undefined,
    });
    assert.equal(deniedApply.exitCode, 1);
    assert.match(deniedApply.stderr, /MIGRATION_ALLOW_APPLY=1/);
    assert.equal(await tableCount('schema_migrations'), 0);

    const applied = await runMigrationCli('apply');
    assert.equal(applied.exitCode, 0, applied.stderr);
    assert.match(applied.stdout, /Pending migrations: none/);
    assert.equal(await tableCount('game_runs'), 1);

    const planned = await runMigrationCli('plan', {
        MIGRATION_CONFIRM_DATABASE: undefined,
        MIGRATION_CONFIRM_TARGET: undefined,
        MIGRATION_ALLOW_APPLY: undefined,
        MIGRATION_ALLOW_ROLLBACK_EMPTY: undefined,
    });
    assert.equal(planned.exitCode, 0, planned.stderr);
    assert.match(planned.stdout, /Pending migrations: none/);

    const deniedRollback = await runMigrationCli('rollback-empty', {
        MIGRATION_DB_PORT: '9',
        MIGRATION_CONFIRM_TARGET: `127.0.0.1:9/${config.database}`,
        MIGRATION_ALLOW_ROLLBACK_EMPTY: undefined,
    });
    assert.equal(deniedRollback.exitCode, 1);
    assert.match(deniedRollback.stderr, /MIGRATION_ALLOW_ROLLBACK_EMPTY=1/);
    assert.equal(await tableCount('game_runs'), 1);

    const rolledBack = await runMigrationCli('rollback-empty');
    assert.equal(rolledBack.exitCode, 0, rolledBack.stderr);
    assert.match(rolledBack.stdout, /schema rolled back/);
    assert.equal(await tableCount('schema_migrations'), 0);
});

test('empty rollback is complete, while any ledger data makes it refuse', async () => {
    const migrationConnection = asMigrationConnection(connection);
    await applyMigrations(migrationConnection, migrations, config);
    await rollbackEmptyLeaderboardSchema(migrationConnection, migrations, config);

    assert.equal(await tableCount('schema_migrations'), 0);
    assert.equal(await tableCount('game_runs'), 0);
    assert.equal(await tableCount('game_personal_bests'), 0);
    assert.equal(await tableCount('users'), 1);

    await applyMigrations(migrationConnection, migrations, config);
    const [result] = await connection.query<ResultSetHeader>(`
        INSERT INTO game_runs (
            game_id,
            rules_version,
            user_id,
            run_id,
            score,
            completion_time_ms,
            payload_fingerprint,
            personal_best,
            submitted_at
        ) VALUES (
            'three-bosses',
            1,
            1,
            '00000000-0000-4000-8000-000000000001',
            1000,
            100000,
            UNHEX(SHA2('test-only-payload', 256)),
            1,
            UTC_TIMESTAMP(6)
        )
    `);
    assert.equal(result.affectedRows, 1);

    await assert.rejects(
        () => rollbackEmptyLeaderboardSchema(migrationConnection, migrations, config),
        /refused because leaderboard tables contain data/
    );
    assert.equal(await tableCount('schema_migrations'), 1);
    assert.equal(await tableCount('game_runs'), 1);
    const [runs] = await connection.query<RowDataPacket[]>('SELECT * FROM game_runs');
    assert.equal(runs.length, 1);
});

test('rollback refuses personal-best, partial, unknown, and checksum-drifted states', async () => {
    const migrationConnection = asMigrationConnection(connection);
    await applyMigrations(migrationConnection, migrations, config);
    await connection.query(`
        INSERT INTO game_personal_bests (
            game_id,
            rules_version,
            user_id,
            score,
            completion_time_ms,
            source_game_run_id,
            recorded_at
        ) VALUES ('p4-vega', 1, 1, 990, NULL, NULL, UTC_TIMESTAMP(6))
    `);
    await assert.rejects(
        () => rollbackEmptyLeaderboardSchema(migrationConnection, migrations, config),
        /refused because leaderboard tables contain data/
    );
    assert.equal(await tableCount('game_personal_bests'), 1);

    await resetFixture();
    await connection.query(migrations[0].sql);
    await assert.rejects(
        () => rollbackEmptyLeaderboardSchema(migrationConnection, migrations, config),
        /schema_migrations does not exist/
    );
    assert.equal(await tableCount('game_runs'), 1);

    await resetFixture();
    await applyMigrations(migrationConnection, migrations, config);
    await connection.query(
        `INSERT INTO schema_migrations (version, checksum, applied_at)
         VALUES (?, ?, UTC_TIMESTAMP(6))`,
        ['9999_unknown', Buffer.alloc(32)]
    );
    await assert.rejects(
        () => rollbackEmptyLeaderboardSchema(migrationConnection, migrations, config),
        /unknown migration version/
    );
    await connection.query('DELETE FROM schema_migrations WHERE version = ?', ['9999_unknown']);

    await connection.query(
        'UPDATE schema_migrations SET checksum = ? WHERE version = ?',
        [Buffer.alloc(32, 0xff), migrations[0].version]
    );
    await assert.rejects(
        () => rollbackEmptyLeaderboardSchema(migrationConnection, migrations, config),
        /Checksum mismatch/
    );
    assert.equal(await tableCount('game_runs'), 1);
    assert.equal(await tableCount('game_personal_bests'), 1);
});

test('source-run foreign key proves game, rules version, and user ownership', async () => {
    await applyMigrations(asMigrationConnection(connection), migrations, config);
    const [runResult] = await connection.query<ResultSetHeader>(`
        INSERT INTO game_runs (
            game_id,
            rules_version,
            user_id,
            run_id,
            score,
            completion_time_ms,
            payload_fingerprint,
            personal_best,
            submitted_at
        ) VALUES (
            'three-bosses',
            1,
            1,
            '00000000-0000-4000-8000-000000000002',
            1000,
            100000,
            UNHEX(SHA2('test-only-source', 256)),
            1,
            UTC_TIMESTAMP(6)
        )
    `);

    await assert.rejects(
        () => connection.query(`
            INSERT INTO game_personal_bests (
                game_id,
                rules_version,
                user_id,
                score,
                completion_time_ms,
                source_game_run_id,
                recorded_at
            ) VALUES ('three-bosses', 1, 2, 1000, 100000, ?, UTC_TIMESTAMP(6))
        `, [runResult.insertId]),
        /foreign key constraint fails/i
    );

    await connection.query(`
        INSERT INTO game_personal_bests (
            game_id,
            rules_version,
            user_id,
            score,
            completion_time_ms,
            source_game_run_id,
            recorded_at
        ) VALUES ('three-bosses', 1, 1, 1000, 100000, ?, UTC_TIMESTAMP(6))
    `, [runResult.insertId]);
    const [bestRows] = await connection.query<RowDataPacket[]>(
        'SELECT user_id, source_game_run_id FROM game_personal_bests'
    );
    assert.deepEqual(bestRows, [{ user_id: 1, source_game_run_id: runResult.insertId }]);
});
