import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import mysql, {
    type Connection,
    type RowDataPacket,
} from 'mysql2/promise';
import { loadMigrationConfig } from '../config/migrationConfig';
import type { MigrationConnection } from './leaderboardSchema';
import { loadMigrationManifest } from './migrationManifest';
import { applyMigrations } from './migrationRunner';
import {
    type P4VegaReconciliationConnection,
    reconcileP4VegaScores,
} from './p4VegaReconciliation';

const migrationTestPort = Number(process.env.MIGRATION_TEST_PORT);
const EXPECTED_TEST_TARGET = Object.freeze({
    host: '127.0.0.1',
    port: migrationTestPort,
    database: 'mickeyf_migration_test',
    user: 'migration_test',
});

const config = loadMigrationConfig();
const migrations = loadMigrationManifest().filter(
    ({ effect }) => effect === 'create-table'
);
const reconciliationSettings: Parameters<typeof reconcileP4VegaScores>[2] = {
    database: config.database,
    advisoryLockTimeoutSeconds: config.advisoryLockTimeoutSeconds,
    lockWaitTimeoutSeconds: config.lockWaitTimeoutSeconds,
};
let connection: Connection;

type ReconciliationReport = Awaited<ReturnType<typeof reconcileP4VegaScores>>;

type DatabaseSnapshot = Readonly<{
    users: RowDataPacket[];
    personalBests: RowDataPacket[];
    gameRuns: RowDataPacket[];
    migrationHistory: RowDataPacket[];
}>;

function asMigrationConnection(value: Connection): MigrationConnection {
    return value as unknown as MigrationConnection;
}

function asReconciliationConnection(value: Connection): P4VegaReconciliationConnection {
    return value as unknown as P4VegaReconciliationConnection;
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
        'reconciliation tests may run only against the isolated Docker target'
    );
    assert.equal(process.env.MIGRATION_TEST_HOST, EXPECTED_TEST_TARGET.host);
    assert.equal(Number(process.env.MIGRATION_TEST_PORT), EXPECTED_TEST_TARGET.port);
    assert.equal(process.env.MIGRATION_TEST_DATABASE, EXPECTED_TEST_TARGET.database);
    assert.equal(process.env.MIGRATION_TEST_USER, EXPECTED_TEST_TARGET.user);
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

async function databaseSnapshot(): Promise<DatabaseSnapshot> {
    const [users] = await connection.query<RowDataPacket[]>(
        'SELECT user_id, user_name, email, user_password, p4_score FROM users ORDER BY user_id'
    );
    const [personalBests] = await connection.query<RowDataPacket[]>(`
        SELECT *
        FROM game_personal_bests
        ORDER BY game_id, rules_version, user_id
    `);
    const [gameRuns] = await connection.query<RowDataPacket[]>(`
        SELECT *
        FROM game_runs
        ORDER BY game_run_id
    `);
    const [migrationHistory] = await connection.query<RowDataPacket[]>(`
        SELECT *
        FROM schema_migrations
        ORDER BY version
    `);
    return { users, personalBests, gameRuns, migrationHistory };
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

test('exact p4-Vega data reconciles without changing any persisted row', async () => {
    await connection.query(`
        INSERT INTO users (user_name, email, user_password, p4_score)
        VALUES
            ('no-score', 'no-score@example.test', 'test-only-hash', NULL),
            ('lower-score', 'lower@example.test', 'test-only-hash', 190),
            ('higher-score', 'higher@example.test', 'test-only-hash', 410)
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
            ('p4-vega', 1, 2, 190, NULL, '2001-01-01 00:00:00.000000', NULL),
            ('p4-vega', 1, 3, 410, NULL, '2001-01-01 00:00:00.000000', NULL),
            ('three-bosses', 1, 1, 1234, 5000, '2001-01-01 00:00:00.000000', NULL)
    `);
    const beforeSnapshot = await databaseSnapshot();

    const report = await reconcileP4VegaScores(
        asReconciliationConnection(connection),
        migrations,
        reconciliationSettings
    );

    assertConsistentReport(report, {
        rowCount: '2',
        minimumScore: 190,
        maximumScore: 410,
        scoreSum: '600',
    });
    assert.deepEqual(await databaseSnapshot(), beforeSnapshot);
});

test('reconciliation reports every unsafe category and remains read-only', async () => {
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
    const beforeSnapshot = await databaseSnapshot();

    const report = await reconcileP4VegaScores(
        asReconciliationConnection(connection),
        migrations,
        reconciliationSettings
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
    assert.deepEqual(await databaseSnapshot(), beforeSnapshot);
});

test('reconciliation requires user_id to remain the exact primary key', async () => {
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
            asReconciliationConnection(connection),
            migrations,
            reconciliationSettings
        ),
        /user_id as its exact primary key/u
    );
});
