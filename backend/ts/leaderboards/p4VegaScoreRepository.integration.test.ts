import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import mysql, {
    type Connection,
    type Pool,
    type PoolConnection,
    type RowDataPacket,
} from 'mysql2/promise';
import { loadMigrationConfig } from '../config/migrationConfig';
import type { MigrationConnection } from '../migrations/leaderboardSchema';
import { loadMigrationManifest } from '../migrations/migrationManifest';
import { applyMigrations } from '../migrations/migrationRunner';
import {
    readP4VegaLeaderboard,
    submitP4VegaScore,
} from './p4VegaScoreRepository';

const migrationTestPort = Number(process.env.MIGRATION_TEST_PORT);
const EXPECTED_TEST_TARGET = Object.freeze({
    host: '127.0.0.1',
    port: migrationTestPort,
    database: 'mickeyf_migration_test',
    user: 'migration_test',
});

const config = loadMigrationConfig();
const migrations = loadMigrationManifest();
let observer: Connection;
let applicationPool: Pool;

type StoredScoreRow = RowDataPacket & {
    legacyScore: number | null;
    genericScore: number | null;
    recordedAt: string | null;
    completionTimeMs: number | null;
    sourceGameRunId: number | null;
};

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
        'p4-Vega repository integration tests may run only against the isolated Docker target'
    );
    assert.equal(process.env.MIGRATION_TEST_HOST, EXPECTED_TEST_TARGET.host);
    assert.equal(Number(process.env.MIGRATION_TEST_PORT), EXPECTED_TEST_TARGET.port);
    assert.equal(process.env.MIGRATION_TEST_DATABASE, EXPECTED_TEST_TARGET.database);
    assert.equal(process.env.MIGRATION_TEST_USER, EXPECTED_TEST_TARGET.user);
}

function withFirstQueryBarrier(
    pool: Pool,
    participantCount: number
): Pick<Pool, 'getConnection'> {
    let arrived = 0;
    let openBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => {
        openBarrier = resolve;
    });

    return {
        async getConnection() {
            const connection = await pool.getConnection();
            const query = connection.query.bind(connection) as (
                options: unknown,
                values?: unknown[]
            ) => Promise<unknown>;
            let firstQuery = true;
            return {
                beginTransaction: () => connection.beginTransaction(),
                async query(options: unknown, values?: unknown[]) {
                    if (firstQuery) {
                        firstQuery = false;
                        arrived += 1;
                        if (arrived === participantCount) openBarrier();
                        await barrier;
                    }
                    return query(options, values);
                },
                commit: () => connection.commit(),
                rollback: () => connection.rollback(),
                release: () => connection.release(),
                destroy: () => connection.destroy(),
            } as unknown as PoolConnection;
        },
    } as Pick<Pool, 'getConnection'>;
}

function withCommitFailure(
    pool: Pool,
    commitError: Error
): Pick<Pool, 'getConnection'> {
    return {
        async getConnection() {
            const connection = await pool.getConnection();
            return {
                beginTransaction: () => connection.beginTransaction(),
                query: connection.query.bind(connection),
                async commit() {
                    throw commitError;
                },
                rollback: () => connection.rollback(),
                release: () => connection.release(),
                destroy: () => connection.destroy(),
            } as unknown as PoolConnection;
        },
    } as Pick<Pool, 'getConnection'>;
}

async function resetFixture(): Promise<void> {
    await observer.query('SET FOREIGN_KEY_CHECKS = 0');
    try {
        await observer.query(`
            DROP TABLE IF EXISTS
                game_personal_bests,
                game_runs,
                schema_migrations,
                users
        `);
    } finally {
        await observer.query('SET FOREIGN_KEY_CHECKS = 1');
    }

    await observer.query(`
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
    await observer.query(
        `INSERT INTO users (user_name, email, user_password, p4_score)
         VALUES ('player', 'player@example.test', 'test-only-hash', 700)`
    );

    await applyMigrations(asMigrationConnection(observer), migrations, config);
}

async function storedScore(): Promise<StoredScoreRow> {
    const [rows] = await observer.query<StoredScoreRow[]>(`
        SELECT
            users.p4_score AS legacyScore,
            game_personal_bests.score AS genericScore,
            game_personal_bests.recorded_at AS recordedAt,
            game_personal_bests.completion_time_ms AS completionTimeMs,
            game_personal_bests.source_game_run_id AS sourceGameRunId
        FROM users
        LEFT JOIN game_personal_bests
          ON game_personal_bests.game_id = 'p4-vega'
         AND game_personal_bests.rules_version = 1
         AND game_personal_bests.user_id = users.user_id
        WHERE users.user_id = 1
    `);
    assert.equal(rows.length, 1);
    return rows[0];
}

before(async () => {
    assertSafeTestEnvironment();
    observer = await mysql.createConnection({
        host: config.host,
        port: config.port,
        user: config.user,
        password: config.password,
        database: config.database,
        dateStrings: true,
        multipleStatements: false,
    });
    applicationPool = mysql.createPool({
        host: config.host,
        port: config.port,
        user: config.user,
        password: config.password,
        database: config.database,
        dateStrings: true,
        multipleStatements: false,
        connectionLimit: 4,
        waitForConnections: true,
    });

    const [rows] = await observer.query<Array<RowDataPacket & {
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
    if (applicationPool) await applicationPool.end();
    if (observer) await observer.end();
});

test('strict improvements update generic storage while the legacy score stays static', async () => {
    assert.equal(await submitP4VegaScore(applicationPool, 1, 900), true);
    const initial = await storedScore();
    assert.deepEqual(initial, {
        legacyScore: 700,
        genericScore: 900,
        recordedAt: initial.recordedAt,
        completionTimeMs: null,
        sourceGameRunId: null,
    });
    assert.equal(typeof initial.recordedAt, 'string');

    const fixedRecordedAt = '2000-01-01 00:00:00.000000';
    await observer.query(
        `UPDATE game_personal_bests
         SET recorded_at = ?
         WHERE game_id = 'p4-vega' AND rules_version = 1 AND user_id = 1`,
        [fixedRecordedAt]
    );

    assert.equal(await submitP4VegaScore(applicationPool, 1, 900), false);
    assert.equal(await submitP4VegaScore(applicationPool, 1, 800), false);
    assert.equal((await storedScore()).recordedAt, fixedRecordedAt);

    assert.equal(await submitP4VegaScore(applicationPool, 1, 990), true);
    const improved = await storedScore();
    assert.equal(improved.legacyScore, 700);
    assert.equal(improved.genericScore, 990);
    assert.notEqual(improved.recordedAt, fixedRecordedAt);
    assert.equal(improved.completionTimeMs, null);
    assert.equal(improved.sourceGameRunId, null);

    const [runs] = await observer.query<Array<RowDataPacket & { count: number }>>(
        'SELECT COUNT(*) AS count FROM game_runs'
    );
    assert.equal(Number(runs[0].count), 0);
});

test('generic storage is the sole score source after the gated cutover', async () => {
    await observer.query('UPDATE users SET p4_score = 900 WHERE user_id = 1');

    assert.equal(await submitP4VegaScore(applicationPool, 1, 800), true);
    const stored = await storedScore();
    assert.deepEqual(stored, {
        legacyScore: 900,
        genericScore: 800,
        recordedAt: stored.recordedAt,
        completionTimeMs: null,
        sourceGameRunId: null,
    });
    assert.equal(typeof stored.recordedAt, 'string');
});

test('a missing authenticated user preserves the legacy false result', async () => {
    assert.equal(await submitP4VegaScore(applicationPool, 999, 900), false);

    const [rows] = await observer.query<Array<RowDataPacket & { count: number }>>(`
        SELECT COUNT(*) AS count
        FROM game_personal_bests
        WHERE user_id = 999
    `);
    assert.equal(Number(rows[0].count), 0);
});

test('leaderboard reads only current generic p4-Vega bests in deterministic order', async () => {
    for (let userId = 2; userId <= 13; userId += 1) {
        await observer.query(
            `INSERT INTO users (user_name, email, user_password, p4_score)
             VALUES (?, ?, 'test-only-hash', ?)`,
            [`player-${userId}`, `player-${userId}@example.test`, userId * 10]
        );
    }
    await observer.query(
        `UPDATE users
         SET p4_score = CASE user_id
             WHEN 1 THEN -500
             WHEN 13 THEN 2147483647
             ELSE p4_score
         END
         WHERE user_id IN (1, 13)`
    );

    const currentRows = [
        [1, 1_200, '2000-01-01 00:00:03.000000'],
        [2, 990, '2000-01-01 00:00:02.000000'],
        [3, 900, '2000-01-01 00:00:02.000000'],
        [4, 900, '2000-01-01 00:00:01.000000'],
        [5, 900, '2000-01-01 00:00:01.000000'],
        [6, 800, '2000-01-01 00:00:06.000000'],
        [7, 700, '2000-01-01 00:00:07.000000'],
        [8, 600, '2000-01-01 00:00:08.000000'],
        [9, 500, '2000-01-01 00:00:09.000000'],
        [10, 400, '2000-01-01 00:00:10.000000'],
        [11, 300, '2000-01-01 00:00:11.000000'],
        [12, 200, '2000-01-01 00:00:12.000000'],
    ] as const;
    for (const [userId, score, recordedAt] of currentRows) {
        await observer.query(
            `INSERT INTO game_personal_bests (
                game_id,
                rules_version,
                user_id,
                score,
                completion_time_ms,
                recorded_at,
                source_game_run_id
             ) VALUES ('p4-vega', 1, ?, ?, NULL, ?, NULL)`,
            [userId, score, recordedAt]
        );
    }

    await observer.query(
        `INSERT INTO game_personal_bests (
            game_id,
            rules_version,
            user_id,
            score,
            completion_time_ms,
            recorded_at,
            source_game_run_id
         ) VALUES
            ('p4-vega', 2, 13, 2147483647, NULL, '1999-01-01 00:00:00.000000', NULL),
            ('three-bosses', 1, 13, 2147483646, 1, '1999-01-01 00:00:00.000000', NULL)`
    );

    const expected = [
        { userName: 'player', score: 1_200 },
        { userName: 'player-2', score: 990 },
        { userName: 'player-4', score: 900 },
        { userName: 'player-5', score: 900 },
        { userName: 'player-3', score: 900 },
        { userName: 'player-6', score: 800 },
        { userName: 'player-7', score: 700 },
        { userName: 'player-8', score: 600 },
        { userName: 'player-9', score: 500 },
        { userName: 'player-10', score: 400 },
    ];

    assert.deepEqual(await readP4VegaLeaderboard(applicationPool), expected);
});

test('equal concurrent submissions produce one personal best and one generic row', {
    timeout: 5_000,
}, async () => {
    const concurrentDatabase = withFirstQueryBarrier(applicationPool, 2);
    const outcomes = await Promise.all([
        submitP4VegaScore(concurrentDatabase, 1, 900),
        submitP4VegaScore(concurrentDatabase, 1, 900),
    ]);

    assert.equal(outcomes.filter(Boolean).length, 1);
    const stored = await storedScore();
    assert.equal(stored.legacyScore, 700);
    assert.equal(stored.genericScore, 900);

    const [bestCounts] = await observer.query<Array<RowDataPacket & { count: number }>>(`
        SELECT COUNT(*) AS count
        FROM game_personal_bests
        WHERE game_id = 'p4-vega' AND rules_version = 1 AND user_id = 1
    `);
    assert.equal(Number(bestCounts[0].count), 1);
});

test('concurrent mixed submissions converge generic storage on the higher score', {
    timeout: 5_000,
}, async () => {
    const concurrentDatabase = withFirstQueryBarrier(applicationPool, 2);
    const [, highScoreWasPersonalBest] = await Promise.all([
        submitP4VegaScore(concurrentDatabase, 1, 900),
        submitP4VegaScore(concurrentDatabase, 1, 990),
    ]);

    assert.equal(highScoreWasPersonalBest, true);
    const stored = await storedScore();
    assert.equal(stored.legacyScore, 700);
    assert.equal(stored.genericScore, 990);
});

test('a failed commit rolls an executed generic write back', async () => {
    const commitError = new Error('commit failed before reaching MySQL');
    const failingDatabase = withCommitFailure(applicationPool, commitError);

    await assert.rejects(
        () => submitP4VegaScore(failingDatabase, 1, 990),
        commitError
    );
    assert.deepEqual(await storedScore(), {
        legacyScore: 700,
        genericScore: null,
        recordedAt: null,
        completionTimeMs: null,
        sourceGameRunId: null,
    });
});

test('generic writes remain valid after the legacy score column is dropped', async () => {
    await observer.query('ALTER TABLE users DROP COLUMN p4_score');

    assert.equal(await submitP4VegaScore(applicationPool, 1, 990), true);
    const [rows] = await observer.query<Array<RowDataPacket & { score: number }>>(`
        SELECT score
        FROM game_personal_bests
        WHERE game_id = 'p4-vega' AND rules_version = 1 AND user_id = 1
    `);
    assert.deepEqual(rows, [{ score: 990 }]);
    assert.deepEqual(await readP4VegaLeaderboard(applicationPool), [{
        userName: 'player',
        score: 990,
    }]);
});
