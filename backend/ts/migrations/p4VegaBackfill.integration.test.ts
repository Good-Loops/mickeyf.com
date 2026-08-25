import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { after, before, beforeEach, test } from 'node:test';
import mysql, {
    type Connection,
    type RowDataPacket,
} from 'mysql2/promise';
import { loadMigrationConfig } from '../config/migrationConfig';
import type { MigrationConnection } from './leaderboardSchema';
import { loadMigrationManifest } from './migrationManifest';
import { applyMigrations, migrationLockName } from './migrationRunner';
import {
    backfillP4VegaScores,
    type P4VegaBackfillConnection,
    reconcileP4VegaScores,
} from './p4VegaBackfill';

const migrationTestPort = Number(process.env.MIGRATION_TEST_PORT);
const EXPECTED_TEST_TARGET = Object.freeze({
    host: '127.0.0.1',
    port: migrationTestPort,
    database: 'mickeyf_migration_test',
    user: 'migration_test',
});

const config = loadMigrationConfig();
const migrations = loadMigrationManifest();
const migrationTestRootUser = process.env.MIGRATION_TEST_ROOT_USER;
const migrationTestRootPassword = process.env.MIGRATION_TEST_ROOT_PASSWORD;
let connection: Connection;

type BackfillConnection = Parameters<typeof backfillP4VegaScores>[0];
type BackfillSettings = Parameters<typeof backfillP4VegaScores>[2];
type ReconciliationReport = Awaited<ReturnType<typeof reconcileP4VegaScores>>;

type CliResult = Readonly<{
    exitCode: number | null;
    stdout: string;
    stderr: string;
}>;

type StoredBestRow = RowDataPacket & {
    gameId: string;
    rulesVersion: number;
    userId: number;
    score: number;
    completionTimeMs: number | null;
    recordedAt: string;
    sourceGameRunId: number | null;
};

function asMigrationConnection(value: Connection): MigrationConnection {
    return value as unknown as MigrationConnection;
}

function asBackfillConnection(value: Connection): BackfillConnection {
    return value as unknown as BackfillConnection;
}

function backfillSettings(chunkSize: number): BackfillSettings {
    return {
        database: config.database,
        advisoryLockTimeoutSeconds: config.advisoryLockTimeoutSeconds,
        lockWaitTimeoutSeconds: config.lockWaitTimeoutSeconds,
        p4VegaBackfillChunkSize: chunkSize,
    };
}

function runMigrationCli(
    command: 'backfill-p4-vega' | 'reconcile-p4-vega',
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
            ['-r', 'ts-node/register', 'ts/migrations/runMigrations.ts', command],
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
        'backfill integration tests may run only against the isolated Docker target'
    );
    assert.equal(process.env.MIGRATION_TEST_HOST, EXPECTED_TEST_TARGET.host);
    assert.equal(Number(process.env.MIGRATION_TEST_PORT), EXPECTED_TEST_TARGET.port);
    assert.equal(process.env.MIGRATION_TEST_DATABASE, EXPECTED_TEST_TARGET.database);
    assert.equal(process.env.MIGRATION_TEST_USER, EXPECTED_TEST_TARGET.user);
    assert.equal(migrationTestRootUser, 'root');
    assert.equal(typeof migrationTestRootPassword, 'string');
    assert.ok((migrationTestRootPassword?.length ?? 0) > 0);
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

    await applyMigrations(asMigrationConnection(connection), migrations, config);
}

async function migrationTimestamp(): Promise<string> {
    const [rows] = await connection.query<Array<RowDataPacket & { appliedAt: string }>>(
        `SELECT applied_at AS appliedAt
         FROM schema_migrations
         WHERE version = '0002_create_game_personal_bests'`
    );
    assert.equal(rows.length, 1);
    assert.equal(typeof rows[0].appliedAt, 'string');
    return rows[0].appliedAt;
}

async function storedBests(): Promise<StoredBestRow[]> {
    const [rows] = await connection.query<StoredBestRow[]>(`
        SELECT
            game_id AS gameId,
            rules_version AS rulesVersion,
            user_id AS userId,
            score,
            completion_time_ms AS completionTimeMs,
            recorded_at AS recordedAt,
            source_game_run_id AS sourceGameRunId
        FROM game_personal_bests
        ORDER BY game_id, rules_version, user_id
    `);
    return rows;
}

function assertConsistentReport(
    report: ReconciliationReport,
    expected: Readonly<{
        rowCount: string;
        minimumScore: number | null;
        maximumScore: number | null;
        scoreSum: string;
    }>
): void {
    assert.deepEqual(report, {
        legacy: expected,
        generic: expected,
        missingCount: '0',
        mismatchCount: '0',
        genericLowerCount: '0',
        genericHigherCount: '0',
        matchedCount: expected.rowCount,
        extraCount: '0',
        metadataAnomalyCount: '0',
        unexpectedGameRunCount: '0',
        unexpectedRulesVersionCount: '0',
        consistent: true,
    });
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
        supportBigNumbers: true,
        bigNumberStrings: true,
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

test('backfill is monotonic, timestamp-stable, idempotent, and game-scoped', async () => {
    await connection.query(`
        INSERT INTO users (user_name, email, user_password, p4_score)
        VALUES
            ('no-score', 'no-score@example.test', 'test-only-hash', NULL),
            ('missing', 'missing@example.test', 'test-only-hash', 900),
            ('equal', 'equal@example.test', 'test-only-hash', 800),
            ('source-ahead', 'source-ahead@example.test', 'test-only-hash', 900),
            ('historical-invalid', 'invalid@example.test', 'test-only-hash', 995),
            ('zero-score', 'zero@example.test', 'test-only-hash', 0)
    `);
    const equalTimestamp = '2001-01-01 00:00:00.000000';
    const lowerTimestamp = '2002-01-01 00:00:00.000000';
    const unrelatedTimestamp = '2003-01-01 00:00:00.000000';
    await connection.query(
        `INSERT INTO game_personal_bests (
            game_id,
            rules_version,
            user_id,
            score,
            completion_time_ms,
            recorded_at,
            source_game_run_id
        ) VALUES
            ('p4-vega', 1, 3, 800, NULL, ?, NULL),
            ('p4-vega', 1, 4, 800, NULL, ?, NULL),
            ('three-bosses', 1, 1, 1234, 5000, ?, NULL)`,
        [equalTimestamp, lowerTimestamp, unrelatedTimestamp]
    );
    const sharedRecordedAt = await migrationTimestamp();
    const settings = backfillSettings(2);

    const first = await backfillP4VegaScores(
        asBackfillConnection(connection),
        migrations,
        settings
    );

    assert.equal(first.sharedRecordedAt, sharedRecordedAt);
    assert.equal(first.chunksProcessed, 3);
    assertConsistentReport(first.reconciliation, {
        rowCount: '5',
        minimumScore: 0,
        maximumScore: 995,
        scoreSum: '3595',
    });
    const afterFirstPass = await storedBests();
    assert.deepEqual(afterFirstPass, [
        {
            gameId: 'p4-vega',
            rulesVersion: 1,
            userId: 2,
            score: 900,
            completionTimeMs: null,
            recordedAt: sharedRecordedAt,
            sourceGameRunId: null,
        },
        {
            gameId: 'p4-vega',
            rulesVersion: 1,
            userId: 3,
            score: 800,
            completionTimeMs: null,
            recordedAt: equalTimestamp,
            sourceGameRunId: null,
        },
        {
            gameId: 'p4-vega',
            rulesVersion: 1,
            userId: 4,
            score: 900,
            completionTimeMs: null,
            recordedAt: sharedRecordedAt,
            sourceGameRunId: null,
        },
        {
            gameId: 'p4-vega',
            rulesVersion: 1,
            userId: 5,
            score: 995,
            completionTimeMs: null,
            recordedAt: sharedRecordedAt,
            sourceGameRunId: null,
        },
        {
            gameId: 'p4-vega',
            rulesVersion: 1,
            userId: 6,
            score: 0,
            completionTimeMs: null,
            recordedAt: sharedRecordedAt,
            sourceGameRunId: null,
        },
        {
            gameId: 'three-bosses',
            rulesVersion: 1,
            userId: 1,
            score: 1234,
            completionTimeMs: 5000,
            recordedAt: unrelatedTimestamp,
            sourceGameRunId: null,
        },
    ]);

    const second = await backfillP4VegaScores(
        asBackfillConnection(connection),
        migrations,
        settings
    );

    assert.equal(second.sharedRecordedAt, sharedRecordedAt);
    assert.equal(second.chunksProcessed, 3);
    assertConsistentReport(second.reconciliation, {
        rowCount: '5',
        minimumScore: 0,
        maximumScore: 995,
        scoreSum: '3595',
    });
    assert.deepEqual(await storedBests(), afterFirstPass);
});

test('a post-pass legacy-only writer gap is closed by a complete second pass', async () => {
    await connection.query(`
        INSERT INTO users (user_name, email, user_password, p4_score)
        VALUES
            ('late-score', 'late@example.test', 'test-only-hash', NULL),
            ('late-improvement', 'late-improvement@example.test', 'test-only-hash', 800)
    `);
    const settings = backfillSettings(1);
    const first = await backfillP4VegaScores(
        asBackfillConnection(connection),
        migrations,
        settings
    );
    const sharedRecordedAt = first.sharedRecordedAt;
    assertConsistentReport(first.reconciliation, {
        rowCount: '1',
        minimumScore: 800,
        maximumScore: 800,
        scoreSum: '800',
    });

    // These direct updates model a legacy-only Cloud Run revision committing
    // after the first pass: one already-scanned NULL row becomes scored, while
    // one transferred score improves without a matching generic write.
    await connection.query('UPDATE users SET p4_score = 900 WHERE user_id = 1');
    await connection.query('UPDATE users SET p4_score = 990 WHERE user_id = 2');

    const drifted = await reconcileP4VegaScores(
        asBackfillConnection(connection),
        migrations,
        settings
    );
    assert.deepEqual(drifted, {
        legacy: {
            rowCount: '2',
            minimumScore: 900,
            maximumScore: 990,
            scoreSum: '1890',
        },
        generic: {
            rowCount: '1',
            minimumScore: 800,
            maximumScore: 800,
            scoreSum: '800',
        },
        missingCount: '1',
        mismatchCount: '1',
        genericLowerCount: '1',
        genericHigherCount: '0',
        matchedCount: '0',
        extraCount: '0',
        metadataAnomalyCount: '0',
        unexpectedGameRunCount: '0',
        unexpectedRulesVersionCount: '0',
        consistent: false,
    });

    const second = await backfillP4VegaScores(
        asBackfillConnection(connection),
        migrations,
        settings
    );

    assert.equal(second.sharedRecordedAt, sharedRecordedAt);
    assertConsistentReport(second.reconciliation, {
        rowCount: '2',
        minimumScore: 900,
        maximumScore: 990,
        scoreSum: '1890',
    });
    const [rows] = await connection.query<Array<RowDataPacket & {
        userId: number;
        score: number;
        recordedAt: string;
    }>>(`
        SELECT user_id AS userId, score, recorded_at AS recordedAt
        FROM game_personal_bests
        WHERE game_id = 'p4-vega' AND rules_version = 1
        ORDER BY user_id
    `);
    assert.deepEqual(rows, [
        { userId: 1, score: 900, recordedAt: sharedRecordedAt },
        { userId: 2, score: 990, recordedAt: sharedRecordedAt },
    ]);
});

test('real unsafe-state joins report every category and preflight changes nothing', async () => {
    await connection.query(`
        INSERT INTO users (user_name, email, user_password, p4_score)
        VALUES
            ('target-ahead', 'ahead@example.test', 'test-only-hash', 800),
            ('extra-target', 'extra@example.test', 'test-only-hash', NULL),
            ('metadata', 'metadata@example.test', 'test-only-hash', 700),
            ('other-rules', 'rules@example.test', 'test-only-hash', 600),
            ('unexpected-run', 'run@example.test', 'test-only-hash', 500)
    `);
    await connection.query(`
        INSERT INTO game_personal_bests (
            game_id,
            rules_version,
            user_id,
            score,
            completion_time_ms,
            recorded_at,
            source_game_run_id
        ) VALUES
            ('p4-vega', 1, 1, 900, NULL, '2001-01-01 00:00:00.000000', NULL),
            ('p4-vega', 1, 2, 400, NULL, '2001-01-01 00:00:00.000000', NULL),
            ('p4-vega', 1, 3, 700, 1000, '2001-01-01 00:00:00.000000', NULL),
            ('p4-vega', 2, 4, 600, NULL, '2001-01-01 00:00:00.000000', NULL),
            ('p4-vega', 1, 5, 500, NULL, '2001-01-01 00:00:00.000000', NULL)
    `);
    await connection.query(`
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
            'p4-vega',
            1,
            5,
            '00000000-0000-4000-8000-000000000099',
            500,
            NULL,
            UNHEX(SHA2('unexpected-p4-run', 256)),
            0,
            '2001-01-01 00:00:00.000000'
        )
    `);

    const report = await reconcileP4VegaScores(
        asBackfillConnection(connection),
        migrations,
        backfillSettings(10)
    );
    assert.deepEqual(report, {
        legacy: {
            rowCount: '4',
            minimumScore: 500,
            maximumScore: 800,
            scoreSum: '2600',
        },
        generic: {
            rowCount: '4',
            minimumScore: 400,
            maximumScore: 900,
            scoreSum: '2500',
        },
        missingCount: '1',
        mismatchCount: '1',
        genericLowerCount: '0',
        genericHigherCount: '1',
        matchedCount: '2',
        extraCount: '1',
        metadataAnomalyCount: '1',
        unexpectedGameRunCount: '1',
        unexpectedRulesVersionCount: '1',
        consistent: false,
    });

    const [usersBefore] = await connection.query<RowDataPacket[]>(
        'SELECT user_id, p4_score FROM users ORDER BY user_id'
    );
    const bestsBefore = await storedBests();
    const [runsBefore] = await connection.query<RowDataPacket[]>(
        'SELECT * FROM game_runs ORDER BY game_run_id'
    );
    const [historyBefore] = await connection.query<RowDataPacket[]>(
        'SELECT * FROM schema_migrations ORDER BY version'
    );

    await assert.rejects(
        () => backfillP4VegaScores(
            asBackfillConnection(connection),
            migrations,
            backfillSettings(10)
        ),
        /generic-higher rows.*extra generic rows.*metadata.*game runs.*rules versions/u
    );

    assert.deepEqual(
        (await connection.query<RowDataPacket[]>(
            'SELECT user_id, p4_score FROM users ORDER BY user_id'
        ))[0],
        usersBefore
    );
    assert.deepEqual(await storedBests(), bestsBefore);
    assert.deepEqual(
        (await connection.query<RowDataPacket[]>(
            'SELECT * FROM game_runs ORDER BY game_run_id'
        ))[0],
        runsBefore
    );
    assert.deepEqual(
        (await connection.query<RowDataPacket[]>(
            'SELECT * FROM schema_migrations ORDER BY version'
        ))[0],
        historyBefore
    );

    const lockObserver = await mysql.createConnection({
        host: config.host,
        port: config.port,
        user: config.user,
        password: config.password,
        database: config.database,
    });
    try {
        const [lockRows] = await lockObserver.query<Array<RowDataPacket & {
            acquired: number;
        }>>('SELECT GET_LOCK(?, 0) AS acquired', [migrationLockName(config.database)]);
        assert.equal(Number(lockRows[0].acquired), 1);
        await lockObserver.query('SELECT RELEASE_LOCK(?)', [migrationLockName(config.database)]);
    } finally {
        await lockObserver.end();
    }
});

test('checksum drift and advisory-lock contention refuse before backfill writes', async () => {
    await connection.query(`
        INSERT INTO users (user_name, email, user_password, p4_score)
        VALUES ('scored', 'scored@example.test', 'test-only-hash', 900)
    `);
    await connection.query(
        'UPDATE schema_migrations SET checksum = ? WHERE version = ?',
        [Buffer.alloc(32, 0xff), migrations[0].version]
    );
    await assert.rejects(
        () => backfillP4VegaScores(
            asBackfillConnection(connection),
            migrations,
            backfillSettings(10)
        ),
        /Checksum mismatch/u
    );
    assert.equal((await storedBests()).length, 0);

    await connection.query(
        'UPDATE schema_migrations SET checksum = ? WHERE version = ?',
        [migrations[0].checksum, migrations[0].version]
    );
    const lockHolder = await mysql.createConnection({
        host: config.host,
        port: config.port,
        user: config.user,
        password: config.password,
        database: config.database,
    });
    const lockName = migrationLockName(config.database);
    try {
        const [lockRows] = await lockHolder.query<Array<RowDataPacket & {
            acquired: number;
        }>>('SELECT GET_LOCK(?, 0) AS acquired', [lockName]);
        assert.equal(Number(lockRows[0].acquired), 1);
        await assert.rejects(
            () => backfillP4VegaScores(
                asBackfillConnection(connection),
                migrations,
                { ...backfillSettings(10), advisoryLockTimeoutSeconds: 0 }
            ),
            /Could not acquire/u
        );
        assert.equal((await storedBests()).length, 0);
    } finally {
        await lockHolder.query('SELECT RELEASE_LOCK(?)', [lockName]);
        await lockHolder.end();
    }
});

test('source verification requires user_id to remain the exact primary key', async () => {
    await connection.query('SET FOREIGN_KEY_CHECKS = 0');
    try {
        await connection.query(`
            DROP TABLE
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
            UNIQUE KEY uq_users_user_id (user_id),
            UNIQUE KEY uq_users_email (email)
        ) ENGINE = InnoDB
          DEFAULT CHARACTER SET = utf8mb4
          COLLATE = utf8mb4_unicode_ci
    `);
    await applyMigrations(asMigrationConnection(connection), migrations, config);

    await assert.rejects(
        () => reconcileP4VegaScores(
            asBackfillConnection(connection),
            migrations,
            backfillSettings(10)
        ),
        /user_id as its exact primary key/u
    );
});

test('a retry-exhausted chunk rolls back every row in that chunk', async () => {
    await connection.query(`
        INSERT INTO users (user_name, email, user_password, p4_score)
        VALUES
            ('first', 'first@example.test', 'test-only-hash', 800),
            ('second', 'second@example.test', 'test-only-hash', 900)
    `);
    await connection.query('SET @backfill_attempts = 0');
    const ddlConnection = await mysql.createConnection({
        host: config.host,
        port: config.port,
        user: migrationTestRootUser,
        password: migrationTestRootPassword,
        database: config.database,
        multipleStatements: false,
    });
    let triggerInstalled = false;
    const hookedConnection: P4VegaBackfillConnection = {
        query: async (sql, values = []) => {
            if (!triggerInstalled && sql.includes('SELECT MAX(user_id) AS userId')) {
                triggerInstalled = true;
                await ddlConnection.query(`
                    CREATE TRIGGER fail_p4_backfill_chunk
                    BEFORE INSERT ON game_personal_bests
                    FOR EACH ROW
                    BEGIN
                        IF NEW.game_id = 'p4-vega' AND NEW.user_id = 2 THEN
                            SET @backfill_attempts = COALESCE(@backfill_attempts, 0) + 1;
                            SIGNAL SQLSTATE '40001'
                                SET MYSQL_ERRNO = 1213,
                                    MESSAGE_TEXT = 'synthetic backfill deadlock';
                        END IF;
                    END
                `);
            }
            return connection.query(sql, values) as unknown as Promise<[unknown, unknown]>;
        },
        beginTransaction: () => connection.beginTransaction(),
        commit: () => connection.commit(),
        rollback: () => connection.rollback(),
        destroy: () => connection.destroy(),
    };

    try {
        await assert.rejects(
            () => backfillP4VegaScores(
                hookedConnection,
                migrations,
                backfillSettings(10)
            ),
            /synthetic backfill deadlock/u
        );
        assert.equal(triggerInstalled, true);
        const [attemptRows] = await connection.query<Array<RowDataPacket & {
            attempts: number;
        }>>('SELECT @backfill_attempts AS attempts');
        assert.equal(Number(attemptRows[0].attempts), 3);
        assert.equal((await storedBests()).length, 0);
    } finally {
        await ddlConnection.end();
    }
});

test('CLI gates refuse before connecting and reconciliation drift exits with code 2', async () => {
    const deniedBackfill = await runMigrationCli('backfill-p4-vega', {
        MIGRATION_DB_PORT: '9',
        MIGRATION_CONFIRM_TARGET: `127.0.0.1:9/${config.database}`,
        MIGRATION_ALLOW_P4_VEGA_BACKFILL: undefined,
    });
    assert.equal(deniedBackfill.exitCode, 1);
    assert.match(deniedBackfill.stderr, /MIGRATION_ALLOW_P4_VEGA_BACKFILL=1/);
    assert.doesNotMatch(deniedBackfill.stderr, /ECONNREFUSED/);

    const deniedReconciliation = await runMigrationCli('reconcile-p4-vega', {
        MIGRATION_DB_PORT: '9',
        MIGRATION_CONFIRM_TARGET: `127.0.0.1:9/${config.database}`,
        MIGRATION_ALLOW_P4_VEGA_RECONCILE: undefined,
    });
    assert.equal(deniedReconciliation.exitCode, 1);
    assert.match(
        deniedReconciliation.stderr,
        /MIGRATION_ALLOW_P4_VEGA_RECONCILE=1/
    );
    assert.doesNotMatch(deniedReconciliation.stderr, /ECONNREFUSED/);

    await connection.query(
        `INSERT INTO users (user_name, email, user_password, p4_score)
         VALUES ('private-player', 'private@example.test', 'test-only-hash', 900)`
    );
    const drifted = await runMigrationCli('reconcile-p4-vega');
    assert.equal(drifted.exitCode, 2, drifted.stderr);
    const output = JSON.parse(drifted.stdout) as {
        command: string;
        report: ReconciliationReport;
    };
    assert.equal(output.command, 'reconcile-p4-vega');
    assert.equal(output.report.missingCount, '1');
    assert.equal(output.report.consistent, false);
    assert.match(drifted.stderr, /unresolved aggregate drift/);
    assert.doesNotMatch(
        `${drifted.stdout}\n${drifted.stderr}`,
        /private-player|private@example\.test|userId|user_id/u
    );

    const backfilled = await runMigrationCli('backfill-p4-vega');
    assert.equal(backfilled.exitCode, 0, backfilled.stderr);
    const backfillOutput = JSON.parse(backfilled.stdout) as {
        command: string;
        reconciliation: ReconciliationReport;
    };
    assert.equal(backfillOutput.command, 'backfill-p4-vega');
    assert.equal(backfillOutput.reconciliation.consistent, true);

    const reconciled = await runMigrationCli('reconcile-p4-vega');
    assert.equal(reconciled.exitCode, 0, reconciled.stderr);
    assert.equal(
        (JSON.parse(reconciled.stdout) as { report: ReconciliationReport })
            .report.consistent,
        true
    );
});
