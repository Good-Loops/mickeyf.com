import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { after, before, beforeEach, test } from 'node:test';
import mysql, {
    type Connection,
    type ResultSetHeader,
    type RowDataPacket,
} from 'mysql2/promise';
import { loadMigrationConfig } from '../config/migrationConfig';
import { verifyAccountIdentitySchema } from './accountIdentitySchema';
import { applyAccountIdentityMigration, planAccountIdentityMigration } from './accountIdentityMigration';
import type { MigrationConnection } from './leaderboardSchema';
import { loadMigrationManifest, type MigrationDefinition } from './migrationManifest';
import {
    applyMigrations,
    migrationLockName,
    planMigrations,
} from './migrationRunner';
import {
    applyReceiptTransition,
    planReceiptTransition,
    type ReceiptMigrationIdentity,
} from './receiptTransition';

const migrationTestPort = Number(process.env.MIGRATION_TEST_PORT);
const EXPECTED_TEST_TARGET = Object.freeze({
    host: '127.0.0.1',
    port: migrationTestPort,
    database: 'mickeyf_migration_test',
    user: 'migration_test',
});

const config = loadMigrationConfig();
// This suite exercises the historical 0001–0008 transitions. Provider identities
// have their own full-manifest integration fixture after the UUID epoch exists.
const allMigrations = loadMigrationManifest().filter(({ version }) => version < '0009_');
// These original tests deliberately preserve the historical recovery contract.
const migrations = allMigrations.filter(({ effect }) =>
    effect === 'create-table' || effect === 'drop-column'
);
const additiveMigrations = migrations.filter(({ effect }) => effect === 'create-table');
const p4ScoreDropMigration = migrations.find(({ effect }) => effect === 'drop-column');
if (!p4ScoreDropMigration || p4ScoreDropMigration.effect !== 'drop-column') {
    throw new Error('The reviewed p4_score drop migration is missing from the manifest');
}
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
    command: 'plan' | 'apply',
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
    await connection.query('DROP VIEW IF EXISTS p4_score_dependency');
    await connection.query('DROP VIEW IF EXISTS receipt_dependency');
    await connection.query('SET FOREIGN_KEY_CHECKS = 0');
    try {
        await connection.query(`
            DROP TABLE IF EXISTS
                game_personal_bests,
                game_submission_receipts,
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

async function columnCount(tableName: string, columnName: string): Promise<number> {
    const [rows] = await connection.query<Array<RowDataPacket & { columnCount: number }>>(`
        SELECT COUNT(*) AS columnCount
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = ?
          AND COLUMN_NAME = ?
    `, [tableName, columnName]);
    return Number(rows[0].columnCount);
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

    const initialPlan = await planMigrations(migrationConnection, additiveMigrations, config);
    assert.deepEqual(initialPlan.pending, additiveMigrations.map(({ version }) => version));
    assert.equal(await tableCount('schema_migrations'), 0);

    const appliedPlan = await applyMigrations(migrationConnection, additiveMigrations, config);
    assert.deepEqual(appliedPlan.applied, additiveMigrations.map(({ version }) => version));
    assert.deepEqual(appliedPlan.pending, []);

    const [historyBefore] = await connection.query<RowDataPacket[]>(`
        SELECT version, HEX(checksum) AS checksum, applied_at AS appliedAt
        FROM schema_migrations
        ORDER BY version
    `);
    assert.deepEqual(
        historyBefore.map(({ version, checksum }) => ({ version, checksum })),
        additiveMigrations.map(({ version, checksum }) => ({
            version,
            checksum: checksum.toString('hex').toUpperCase(),
        }))
    );

    const secondPlan = await applyMigrations(migrationConnection, additiveMigrations, config);
    assert.deepEqual(secondPlan.applied, additiveMigrations.map(({ version }) => version));
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
    await applyMigrations(migrationConnection, additiveMigrations, config);
    const changedMigrations: readonly MigrationDefinition[] = additiveMigrations.map((migration, index) =>
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
        () => applyMigrations(migrationConnection, additiveMigrations, config),
        /does not match the reviewed migration schema/
    );
    assert.equal(await tableCount('schema_migrations'), 0);
    assert.equal(await tableCount('game_personal_bests'), 0);
});

test('recovery rejects a same-named but weakened check constraint', async () => {
    const weakenedSql = additiveMigrations[0].sql.replace(
        'CHECK (rules_version > 0)',
        'CHECK (rules_version >= 0)'
    );
    assert.notEqual(weakenedSql, additiveMigrations[0].sql);
    await connection.query(weakenedSql);

    await assert.rejects(
        () => planMigrations(asMigrationConnection(connection), additiveMigrations, config),
        /game_runs checks does not match the reviewed migration schema/
    );
    assert.equal(await tableCount('schema_migrations'), 0);
});

test('history rows are durable even when the server session began with autocommit off', async () => {
    await connection.query('SET SESSION autocommit = 0');
    await applyMigrations(asMigrationConnection(connection), additiveMigrations, config);

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
            additiveMigrations.map(({ version }) => version)
        );
    } finally {
        await observer.end();
    }
});

test('unrecorded atomic DDL is verified and safely resumed', async () => {
    const migrationConnection = asMigrationConnection(connection);
    await connection.query(additiveMigrations[0].sql);

    const plan = await planMigrations(migrationConnection, additiveMigrations, config);
    assert.deepEqual(plan.recoverable, [additiveMigrations[0].version]);
    assert.deepEqual(plan.pending, additiveMigrations.map(({ version }) => version));

    const applied = await applyMigrations(migrationConnection, additiveMigrations, config);
    assert.deepEqual(applied.applied, additiveMigrations.map(({ version }) => version));
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
            () => applyMigrations(asMigrationConnection(connection), additiveMigrations, {
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

test('shipped generic CLI applies only additive migrations and leaves 0003 pending', async () => {
    const deniedAccount = await runMigrationCli('plan', {
        MIGRATION_CONFIRM_ACCOUNT: 'different-account@%',
    });
    assert.equal(deniedAccount.exitCode, 1);
    assert.match(deniedAccount.stderr, /does not match migration confirmations/);
    assert.equal(await tableCount('schema_migrations'), 0);

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
    assert.match(
        applied.stdout,
        new RegExp(`Pending migrations: ${p4ScoreDropMigration.version}`)
    );
    assert.equal(await tableCount('game_runs'), 1);

    const planned = await runMigrationCli('plan', {
        MIGRATION_CONFIRM_DATABASE: undefined,
        MIGRATION_CONFIRM_TARGET: undefined,
        MIGRATION_ALLOW_APPLY: undefined,
    });
    assert.equal(planned.exitCode, 0, planned.stderr);
    assert.match(
        planned.stdout,
        new RegExp(`Pending migrations: ${p4ScoreDropMigration.version}`)
    );
    assert.equal(await tableCount('game_runs'), 1);
    assert.equal(await tableCount('schema_migrations'), 1);
});

test('explicit authorization applies 0003 once without changing users or generic data', async () => {
    const migrationConnection = asMigrationConnection(connection);
    await applyMigrations(migrationConnection, additiveMigrations, config);
    await connection.query(`
        INSERT INTO game_personal_bests (
            game_id,
            rules_version,
            user_id,
            score,
            completion_time_ms,
            source_game_run_id,
            recorded_at
        ) VALUES ('p4-vega', 1, 2, 990, NULL, NULL, UTC_TIMESTAMP(6))
    `);
    const [usersBefore] = await connection.query<RowDataPacket[]>(`
        SELECT user_id, user_name, email, user_password
        FROM users
        ORDER BY user_id
    `);
    const [bestsBefore] = await connection.query<RowDataPacket[]>(`
        SELECT * FROM game_personal_bests ORDER BY game_id, rules_version, user_id
    `);

    const appliedPlan = await applyMigrations(
        migrationConnection,
        migrations,
        config,
        { allowedEffectKinds: ['drop-column'] }
    );
    assert.deepEqual(appliedPlan.applied, migrations.map(({ version }) => version));
    assert.deepEqual(appliedPlan.pending, []);
    assert.equal(await columnCount('users', 'p4_score'), 0);

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
    const [usersAfter] = await connection.query<RowDataPacket[]>(`
        SELECT user_id, user_name, email, user_password
        FROM users
        ORDER BY user_id
    `);
    const [bestsAfter] = await connection.query<RowDataPacket[]>(`
        SELECT * FROM game_personal_bests ORDER BY game_id, rules_version, user_id
    `);
    assert.deepEqual(usersAfter, usersBefore);
    assert.deepEqual(bestsAfter, bestsBefore);

    const rerunPlan = await applyMigrations(
        migrationConnection,
        migrations,
        config,
        { allowedEffectKinds: ['drop-column'] }
    );
    assert.deepEqual(rerunPlan.applied, migrations.map(({ version }) => version));
    const [historyAfter] = await connection.query<RowDataPacket[]>(`
        SELECT version, HEX(checksum) AS checksum, applied_at AS appliedAt
        FROM schema_migrations
        ORDER BY version
    `);
    assert.deepEqual(historyAfter, historyBefore);
});

test('0003 recovery records an already-absent p4_score without rerunning DDL', async () => {
    const migrationConnection = asMigrationConnection(connection);
    await applyMigrations(migrationConnection, additiveMigrations, config);
    await connection.query(p4ScoreDropMigration.sql);
    const [usersCreateBefore] = await connection.query<RowDataPacket[]>('SHOW CREATE TABLE users');

    const recoveryPlan = await planMigrations(migrationConnection, migrations, config);
    assert.deepEqual(recoveryPlan.recoverable, [p4ScoreDropMigration.version]);
    assert.deepEqual(recoveryPlan.pending, [p4ScoreDropMigration.version]);

    const appliedPlan = await applyMigrations(
        migrationConnection,
        migrations,
        config,
        { allowedEffectKinds: ['drop-column'] }
    );
    assert.deepEqual(appliedPlan.applied, migrations.map(({ version }) => version));
    assert.deepEqual(appliedPlan.pending, []);
    const [usersCreateAfter] = await connection.query<RowDataPacket[]>('SHOW CREATE TABLE users');
    assert.deepEqual(usersCreateAfter, usersCreateBefore);

    const [history] = await connection.query<Array<RowDataPacket & {
        version: string;
        checksum: string;
    }>>(`
        SELECT version, HEX(checksum) AS checksum
        FROM schema_migrations
        WHERE version = ?
    `, [p4ScoreDropMigration.version]);
    assert.deepEqual(history, [{
        version: p4ScoreDropMigration.version,
        checksum: p4ScoreDropMigration.checksum.toString('hex').toUpperCase(),
    }]);
});

test('0003 refuses a p4_score dependency or wrong source column shape', async () => {
    const migrationConnection = asMigrationConnection(connection);
    await applyMigrations(migrationConnection, additiveMigrations, config);
    await connection.query(`
        CREATE VIEW p4_score_dependency AS
        SELECT user_id, p4_score FROM users
    `);

    await assert.rejects(
        () => planMigrations(migrationConnection, migrations, config),
        /p4_score view dependencies/
    );
    assert.equal(await columnCount('users', 'p4_score'), 1);

    await resetFixture();
    await applyMigrations(migrationConnection, additiveMigrations, config);
    await connection.query('ALTER TABLE users MODIFY COLUMN p4_score BIGINT NULL');
    await assert.rejects(
        () => applyMigrations(
            migrationConnection,
            migrations,
            config,
            { allowedEffectKinds: ['drop-column'] }
        ),
        /legacy users\.p4_score column does not match the reviewed migration schema/
    );
    assert.equal(await columnCount('users', 'p4_score'), 1);
    const [history] = await connection.query<RowDataPacket[]>(
        'SELECT version FROM schema_migrations ORDER BY version'
    );
    assert.deepEqual(
        history.map(({ version }) => version),
        additiveMigrations.map(({ version }) => version)
    );
});

test('source-run foreign key proves game, rules version, and user ownership', async () => {
    await applyMigrations(asMigrationConnection(connection), additiveMigrations, config);
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

async function prepareReceiptTransition(): Promise<void> {
    await applyMigrations(asMigrationConnection(connection), migrations, config, {
        allowedEffectKinds: ['create-table', 'drop-column'],
    });
    await connection.query(`
        INSERT INTO game_runs (game_id, rules_version, user_id, run_id, score,
            completion_time_ms, payload_fingerprint, personal_best, submitted_at)
        VALUES ('three-bosses', 1, 1, '00000000-0000-4000-8000-000000000111',
            108513, 92155, UNHEX(SHA2('receipt-one', 256)), 1, '2026-09-07 20:00:00.123456'),
            ('three-bosses', 1, 1, '00000000-0000-4000-8000-000000000112',
            100000, 100000, UNHEX(SHA2('receipt-two', 256)), 0, '2026-09-08 10:00:00.654321')
    `);
    await connection.query(`
        INSERT INTO game_personal_bests (game_id, rules_version, user_id, score,
            completion_time_ms, source_game_run_id, recorded_at)
        VALUES ('three-bosses', 1, 1, 108513, 92155, 1, '2026-09-07 20:00:00.123456'),
            ('p4-vega', 1, 2, 990, NULL, NULL, '2026-08-26 19:14:13.111222')
    `);
}

async function preservedBestRows(): Promise<RowDataPacket[]> {
    return (await connection.query<RowDataPacket[]>(`
        SELECT game_id, rules_version, user_id, score, completion_time_ms, recorded_at
        FROM game_personal_bests ORDER BY game_id, rules_version, user_id
    `))[0];
}

async function receiptIdentity(value: Connection = connection): Promise<ReceiptMigrationIdentity> {
    const [identityRows] = await value.query<RowDataPacket[]>(`
        SELECT DATABASE() AS databaseName, CURRENT_USER() AS currentUser,
            @@GLOBAL.server_uuid AS serverUuid, @@version AS serverVersion,
            @@version_comment AS versionComment
    `);
    return identityRows[0] as ReceiptMigrationIdentity;
}

async function prepareAccountIdentity(): Promise<void> {
    await prepareReceiptTransition();
    await applyMigrations(asMigrationConnection(connection), allMigrations, config, {
        allowedEffectKinds: ['detach-best-source', 'retain-receipts'],
    });
}

test('account identity requires separate approval, preserves old data, and defaults old signup inserts', async () => {
    await prepareAccountIdentity();
    const migrationConnection = asMigrationConnection(connection);
    const before = (await connection.query<RowDataPacket[]>('SELECT * FROM users ORDER BY user_id'))[0];
    const identity = await receiptIdentity();
    const plan = await planAccountIdentityMigration(migrationConnection, allMigrations, config, identity);
    assert.equal(plan.state, 'ready');
    assert.equal(await columnCount('users', 'account_uuid'), 0);
    await assert.rejects(() => applyAccountIdentityMigration(migrationConnection, allMigrations, config, identity, {
        approvedPlanSha256: '0'.repeat(64), confirmedServerUuid: identity.serverUuid,
    }), /approved plan digest/);
    assert.equal(await columnCount('users', 'account_uuid'), 0);
    const applied = await applyAccountIdentityMigration(migrationConnection, allMigrations, config, identity, {
        approvedPlanSha256: plan.sha256, confirmedServerUuid: identity.serverUuid,
    });
    assert.equal(applied.state, 'applied');
    assert.deepEqual(applied.schema.pending, []);
    await verifyAccountIdentitySchema(migrationConnection);
    const after = (await connection.query<RowDataPacket[]>('SELECT * FROM users ORDER BY user_id'))[0];
    assert.deepEqual(after.map(({ account_uuid, ...oldColumns }) => oldColumns), before);
    assert.equal(new Set(after.map(row => row.account_uuid)).size, before.length);
    for (const row of after) assert.match(row.account_uuid, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
    await connection.query(`INSERT INTO users (user_name, email, user_password)
        VALUES ('new-signup', 'new@example.test', 'test-only-hash')`);
    const users = (await connection.query<RowDataPacket[]>('SELECT account_uuid FROM users'))[0];
    assert.equal(new Set(users.map(row => row.account_uuid)).size, before.length + 1);
    await assert.rejects(() => connection.query(`INSERT INTO users (user_name, email, user_password, account_uuid)
        VALUES ('duplicate', 'duplicate@example.test', 'test-only-hash', ?)`, [after[0].account_uuid]),
    /Duplicate entry/);
    await connection.query('UPDATE users SET user_name = ? WHERE user_id = 1', ['renamed']);
    assert.equal((await connection.query<RowDataPacket[]>('SELECT account_uuid FROM users WHERE user_id = 1'))[0][0].account_uuid,
        after[0].account_uuid);
});

for (const interruptedVersion of ['0006_add_account_identity', '0007_backfill_account_identity', '0008_finalize_account_identity']) {
test(`account identity recovers after ${interruptedVersion} without regenerating UUIDs`, async () => {
    await prepareAccountIdentity();
    const failing: MigrationConnection = {
        query: async (sql, values = []) => {
            if (sql.includes('INSERT INTO schema_migrations') && values[0] === interruptedVersion) {
                throw new Error('synthetic identity history interruption');
            }
            return connection.query(sql, values) as Promise<[unknown, unknown]>;
        },
    };
    await assert.rejects(() => applyMigrations(failing, allMigrations, config, {
        allowedEffectKinds: ['add-account-identity'],
    }), /identity history interruption/);
    const users = (await connection.query<RowDataPacket[]>('SELECT * FROM users ORDER BY user_id'))[0];
    const migrationConnection = asMigrationConnection(connection);
    const recovery = await planMigrations(migrationConnection, allMigrations, config);
    assert.deepEqual(recovery.recoverable, [interruptedVersion]);
    await applyMigrations(migrationConnection, allMigrations, config, { allowedEffectKinds: ['add-account-identity'] });
    const recoveredUsers = (await connection.query<RowDataPacket[]>('SELECT * FROM users ORDER BY user_id'))[0];
    if (interruptedVersion !== '0006_add_account_identity') assert.deepEqual(recoveredUsers, users);
    else assert.deepEqual(recoveredUsers.map(({ account_uuid, ...oldColumns }) => oldColumns),
        users.map(({ account_uuid, ...oldColumns }) => oldColumns));
});
}

test('reused numeric IDs receive different identities while explicit restore preserves the saved UUID', async () => {
    await prepareAccountIdentity();
    await applyMigrations(asMigrationConnection(connection), allMigrations, config, {
        allowedEffectKinds: ['add-account-identity'],
    });
    const insert = `INSERT INTO users (user_id, user_name, email, user_password)
        VALUES (50, 'reused', 'reuse@example.test', 'test-only-hash')`;
    await connection.query(insert);
    const read = async () => (await connection.query<RowDataPacket[]>('SELECT * FROM users WHERE user_id = 50'))[0][0];
    const original = await read();
    await connection.query('DELETE FROM users WHERE user_id = 50');
    await connection.query(insert);
    assert.notEqual((await read()).account_uuid, original.account_uuid);
    await connection.query('DELETE FROM users WHERE user_id = 50');
    await connection.query(`INSERT INTO users (user_id, user_name, email, user_password, account_uuid)
        VALUES (?, ?, ?, ?, ?)`, [original.user_id, original.user_name, original.email, original.user_password, original.account_uuid]);
    assert.deepEqual(await read(), original);
});

test('account identity inspection refuses missing, nullable and nonunique restored schemas', async () => {
    await prepareAccountIdentity();
    const migrationConnection = asMigrationConnection(connection);
    await assert.rejects(() => verifyAccountIdentitySchema(migrationConnection), /reviewed schema/);
    await applyMigrations(migrationConnection, allMigrations, config, { allowedEffectKinds: ['add-account-identity'] });
    await connection.query('ALTER TABLE users DROP INDEX uq_users_account_uuid');
    await assert.rejects(() => verifyAccountIdentitySchema(migrationConnection), /unique index/);
    await connection.query('ALTER TABLE users ADD UNIQUE KEY uq_users_account_uuid (account_uuid)');
    await connection.query('ALTER TABLE users MODIFY COLUMN account_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL DEFAULT (UUID())');
    await assert.rejects(() => verifyAccountIdentitySchema(migrationConnection), /reviewed schema/);
});

test('receipt transition preserves exact best metrics and receipts, then receipts can expire independently', async () => {
    await prepareReceiptTransition();
    const beforeBests = await preservedBestRows();
    const migrationConnection = asMigrationConnection(connection);
    const identity = await receiptIdentity();
    const before = await planReceiptTransition(migrationConnection, allMigrations, config, identity);
    assert.equal(before.state, 'ready');
    assert.equal(before.preservedData?.personalBests.count, 2);
    assert.equal(before.preservedData?.receipts.count, 2);

    const skipped = await applyMigrations(migrationConnection, allMigrations, config);
    assert.deepEqual(skipped.pending, allMigrations.slice(3).map(({ version }) => version));
    assert.equal(await tableCount('game_runs'), 1);
    assert.equal(await columnCount('game_personal_bests', 'source_game_run_id'), 1);

    const applied = await applyMigrations(migrationConnection, allMigrations, config, {
        allowedEffectKinds: ['detach-best-source', 'retain-receipts'],
    });
    assert.deepEqual(applied.pending, allMigrations.slice(5).map(({ version }) => version));
    assert.equal(await tableCount('game_runs'), 0);
    assert.equal(await tableCount('game_submission_receipts'), 1);
    assert.equal(await columnCount('game_personal_bests', 'source_game_run_id'), 0);
    assert.equal(await columnCount('game_submission_receipts', 'personal_best'), 0);
    assert.equal(await columnCount('game_submission_receipts', 'improved_personal_best'), 1);
    const after = await planReceiptTransition(migrationConnection, allMigrations, config, identity);
    assert.equal(after.state, 'applied');
    assert.deepEqual(after.preservedData, before.preservedData);
    assert.deepEqual(await preservedBestRows(), beforeBests);

    const rerun = await applyMigrations(migrationConnection, allMigrations, config, {
        allowedEffectKinds: ['detach-best-source', 'retain-receipts'],
    });
    assert.deepEqual(rerun, applied);
    const [history] = await connection.query<RowDataPacket[]>(
        'SELECT version, checksum FROM schema_migrations ORDER BY version'
    );
    assert.deepEqual(history, allMigrations.slice(0, 5).map(({ version, checksum }) => ({ version, checksum })));
    await connection.query('DELETE FROM game_submission_receipts');
    assert.deepEqual(await preservedBestRows(), beforeBests);
});

for (const failedVersion of [3, 4]) {
    test(`receipt transition recovers after ${allMigrations[failedVersion].version} DDL before history insert`, async () => {
        await prepareReceiptTransition();
        const beforeBests = await preservedBestRows();
        let interrupted = false;
        const failingConnection: MigrationConnection = {
            query: async (sql, values = []) => {
                if (!interrupted && sql.includes('INSERT INTO schema_migrations')
                    && values[0] === allMigrations[failedVersion].version) {
                    interrupted = true;
                    throw new Error('synthetic history interruption');
                }
                return connection.query(sql, values) as Promise<[unknown, unknown]>;
            },
        };
        await assert.rejects(() => applyMigrations(failingConnection, allMigrations, config, {
            allowedEffectKinds: ['detach-best-source', 'retain-receipts'],
        }), /synthetic history interruption/);
        const pending = await planMigrations(asMigrationConnection(connection), allMigrations, config);
        assert.deepEqual(pending.recoverable, [allMigrations[failedVersion].version]);
        if (failedVersion === 3) {
            await assert.rejects(() => applyMigrations(asMigrationConnection(connection), allMigrations, config, {
                allowedEffectKinds: ['retain-receipts'],
            }), /recorded personal-best detachment before DDL/);
            assert.equal(await tableCount('game_runs'), 1);
            assert.equal(await tableCount('game_submission_receipts'), 0);
        }
        const recovered = await applyMigrations(asMigrationConnection(connection), allMigrations, config, {
            allowedEffectKinds: ['detach-best-source', 'retain-receipts'],
        });
        assert.deepEqual(recovered.pending, allMigrations.slice(5).map(({ version }) => version));
        assert.deepEqual(await preservedBestRows(), beforeBests);
    });
}

test('receipt transition rejects incomplete history and final schema drift', async () => {
    await applyMigrations(asMigrationConnection(connection), additiveMigrations, config);
    await assert.rejects(() => applyMigrations(asMigrationConnection(connection), allMigrations, config, {
        allowedEffectKinds: ['detach-best-source', 'retain-receipts'],
    }), /all historical migrations/);
    assert.equal(await columnCount('game_personal_bests', 'source_game_run_id'), 1);
    await resetFixture();
    await prepareReceiptTransition();
    await applyMigrations(asMigrationConnection(connection), allMigrations, config, {
        allowedEffectKinds: ['detach-best-source', 'retain-receipts'],
    });
    await connection.query('ALTER TABLE game_submission_receipts DROP INDEX idx_game_submission_receipts_expiry');
    await assert.rejects(() => planMigrations(asMigrationConnection(connection), allMigrations, config),
        /game_submission_receipts indexes does not match/);
});

test('receipt transition refuses a dependent view rather than leaving it broken', async () => {
    await prepareReceiptTransition();
    await connection.query('CREATE VIEW receipt_dependency AS SELECT game_run_id FROM game_runs');
    const identity = await receiptIdentity();
    await assert.rejects(() => planReceiptTransition(
        asMigrationConnection(connection), allMigrations, config, identity
    ), /obsolete dependencies or unreadable views/);
    assert.equal(await columnCount('game_personal_bests', 'source_game_run_id'), 1);
});

test('receipt preservation digest pages BIGINT identifiers above JavaScript integer precision without skipping rows', async () => {
    await prepareReceiptTransition();
    await connection.query(`
        INSERT INTO game_runs (game_run_id, game_id, rules_version, user_id, run_id, score,
            completion_time_ms, payload_fingerprint, personal_best, submitted_at)
        WITH RECURSIVE sequence_values AS (
            SELECT 0 AS sequence_number
            UNION ALL SELECT sequence_number + 1 FROM sequence_values WHERE sequence_number < 500
        )
        SELECT CAST('9007199254741000' AS UNSIGNED) + sequence_number,
            'three-bosses', 1, 2,
            CONCAT('00000000-0000-4000-8000-', LPAD(sequence_number + 1000, 12, '0')),
            100000, 100000, UNHEX(SHA2(CONCAT('large-id-', sequence_number), 256)),
            0, '2026-09-08 10:00:00.654321'
        FROM sequence_values
    `);
    const identity = await receiptIdentity();
    const migrationConnection = asMigrationConnection(connection);
    const before = await planReceiptTransition(migrationConnection, allMigrations, config, identity);
    assert.equal(before.preservedData?.receipts.count, 503);
    await applyMigrations(migrationConnection, allMigrations, config, {
        allowedEffectKinds: ['detach-best-source', 'retain-receipts'],
    });
    const after = await planReceiptTransition(migrationConnection, allMigrations, config, identity);
    assert.deepEqual(after.preservedData, before.preservedData);
});

test('receipt apply refuses missing inspection privileges and disabled instrumentation before DDL', async () => {
    await prepareReceiptTransition();
    const identity = await receiptIdentity();
    const plan = await planReceiptTransition(asMigrationConnection(connection), allMigrations, config, identity);
    const confirmation = { confirmedServerUuid: identity.serverUuid, approvedPlanSha256: plan.sha256 };
    await assert.rejects(() => applyReceiptTransition(
        asMigrationConnection(connection), allMigrations, config, identity, confirmation
    ), /cannot verify effective PROCESS privilege/);

    // This admin connection is restricted to the disposable target verified in before().
    const admin = await mysql.createConnection({
        host: config.host, port: config.port, database: config.database,
        user: process.env.MIGRATION_TEST_ROOT_USER,
        password: process.env.MIGRATION_TEST_ROOT_PASSWORD,
        dateStrings: true, multipleStatements: false,
    });
    try {
        const adminIdentity = await receiptIdentity(admin);
        const adminPlan = await planReceiptTransition(asMigrationConnection(admin), allMigrations, config, adminIdentity);
        for (const [table, name] of [
            ['setup_instruments', 'wait/lock/metadata/sql/mdl'],
            ['setup_consumers', 'global_instrumentation'],
        ]) {
            const [original] = await admin.query<RowDataPacket[]>(
                `SELECT ENABLED FROM performance_schema.${table} WHERE NAME = ?`, [name]
            );
            assert.equal(original.length, 1);
            try {
                await admin.query(`UPDATE performance_schema.${table} SET ENABLED = 'NO' WHERE NAME = ?`, [name]);
                await assert.rejects(() => applyReceiptTransition(
                    asMigrationConnection(admin), allMigrations, config, adminIdentity,
                    { confirmedServerUuid: adminIdentity.serverUuid, approvedPlanSha256: adminPlan.sha256 }
                ), /requires .* enabled/);
            } finally {
                await admin.query(`UPDATE performance_schema.${table} SET ENABLED = ? WHERE NAME = ?`, [original[0].ENABLED, name]);
            }
        }
        assert.equal(await columnCount('game_personal_bests', 'source_game_run_id'), 1);
        assert.equal(await tableCount('game_submission_receipts'), 0);
        const after = await planReceiptTransition(asMigrationConnection(connection), allMigrations, config, identity);
        assert.deepEqual(after, plan, 'Failed preflight must leave schema, history and data unchanged');
    } finally {
        await admin.end();
    }
});

test('receipt apply compares the approved data digest under lock and verifies post-DDL preservation', async () => {
    await prepareReceiptTransition();
    // This privileged connection belongs solely to the already-verified disposable test container.
    const admin = await mysql.createConnection({
        host: config.host, port: config.port, database: config.database,
        user: process.env.MIGRATION_TEST_ROOT_USER,
        password: process.env.MIGRATION_TEST_ROOT_PASSWORD,
        dateStrings: true, multipleStatements: false,
    });
    try {
        const migrationConnection = asMigrationConnection(admin);
        const identity = await receiptIdentity(admin);
        const plan = await planReceiptTransition(migrationConnection, allMigrations, config, identity);
        await assert.rejects(() => applyReceiptTransition(migrationConnection, allMigrations, config, identity, {
            confirmedServerUuid: identity.serverUuid, approvedPlanSha256: '0'.repeat(64),
        }), /does not match the current plan/);
        assert.equal(await columnCount('game_personal_bests', 'source_game_run_id'), 1);
        await connection.query('UPDATE game_personal_bests SET score = score + 1 WHERE game_id = \'p4-vega\'');
        await assert.rejects(() => applyReceiptTransition(migrationConnection, allMigrations, config, identity, {
            confirmedServerUuid: identity.serverUuid, approvedPlanSha256: plan.sha256,
        }), /does not match the current plan/);
        const freshPlan = await planReceiptTransition(migrationConnection, allMigrations, config, identity);
        const applied = await applyReceiptTransition(migrationConnection, allMigrations, config, identity, {
            confirmedServerUuid: identity.serverUuid, approvedPlanSha256: freshPlan.sha256,
        });
        assert.equal(applied.state, 'applied');
        assert.deepEqual(applied.preservedData, freshPlan.preservedData);
    } finally {
        await admin.end();
    }
});
