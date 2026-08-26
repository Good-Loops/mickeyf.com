import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import mysql, {
    Connection,
    Pool,
    PoolConnection,
    RowDataPacket,
} from 'mysql2/promise';
import { loadMigrationConfig } from '../config/migrationConfig';
import type { MigrationConnection } from '../migrations/leaderboardSchema';
import { loadMigrationManifest } from '../migrations/migrationManifest';
import { applyMigrations } from '../migrations/migrationRunner';
import { calculateThreeBossesScore } from './leaderboardContract';
import {
    readThreeBossesLeaderboard,
    submitThreeBossesRun,
} from './threeBossesRunRepository';

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
        'Three Bosses integration tests may run only against the isolated Docker target'
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

function withRejectedPersonalBestWrite(
    pool: Pool,
    failure: Error
): Pick<Pool, 'getConnection'> {
    return {
        async getConnection() {
            const connection = await pool.getConnection();
            const query = connection.query.bind(connection) as (
                options: { sql: string },
                values?: unknown[]
            ) => Promise<unknown>;
            return {
                beginTransaction: () => connection.beginTransaction(),
                async query(options: { sql: string }, values?: unknown[]) {
                    const sql = options.sql.replace(/\s+/g, ' ').trim();
                    if (sql.startsWith('INSERT INTO game_personal_bests')) {
                        throw failure;
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
    for (let userId = 1; userId <= 15; userId += 1) {
        await observer.query(
            `INSERT INTO users (user_name, email, user_password, p4_score)
             VALUES (?, ?, 'test-only-hash', NULL)`,
            [`player-${userId}`, `player-${userId}@example.test`]
        );
    }

    await applyMigrations(asMigrationConnection(observer), migrations, config);
}

async function countRows(table: 'game_runs' | 'game_personal_bests'): Promise<number> {
    const [rows] = await observer.query<Array<RowDataPacket & { count: number }>>(
        `SELECT COUNT(*) AS count FROM ${table}`
    );
    return Number(rows[0].count);
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
        connectionLimit: 6,
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

test('reads the ten current-rule personal bests in deterministic completion order', async () => {
    const rows = [
        [1, 50_000, '2000-01-01 00:00:03.000000'],
        [2, 60_000, '2000-01-01 00:00:01.000000'],
        [3, 60_000, '2000-01-01 00:00:01.000000'],
        [4, 60_000, '2000-01-01 00:00:02.000000'],
        [5, 70_000, '2000-01-01 00:00:05.000000'],
        [6, 80_000, '2000-01-01 00:00:06.000000'],
        [7, 90_000, '2000-01-01 00:00:07.000000'],
        [8, 100_000, '2000-01-01 00:00:08.000000'],
        [9, 110_000, '2000-01-01 00:00:09.000000'],
        [10, 120_000, '2000-01-01 00:00:10.000000'],
        [11, 130_000, '2000-01-01 00:00:11.000000'],
        [12, 140_000, '2000-01-01 00:00:12.000000'],
    ] as const;
    for (const [userId, completionTimeMs, recordedAt] of rows) {
        await observer.query(
            `INSERT INTO game_personal_bests (
                game_id,
                rules_version,
                user_id,
                score,
                completion_time_ms,
                recorded_at,
                source_game_run_id
             ) VALUES ('three-bosses', 1, ?, ?, ?, ?, NULL)`,
            [
                userId,
                calculateThreeBossesScore(completionTimeMs),
                completionTimeMs,
                recordedAt,
            ]
        );
    }
    await observer.query(
        `INSERT INTO game_personal_bests (
            game_id, rules_version, user_id, score,
            completion_time_ms, recorded_at, source_game_run_id
         ) VALUES
            ('three-bosses', 2, 13, 100000000, 1, '1999-01-01 00:00:00.000000', NULL),
            ('p4-vega', 1, 14, 2147483647, NULL, '1999-01-01 00:00:00.000000', NULL)`
    );

    assert.deepEqual(await readThreeBossesLeaderboard(applicationPool), [
        { userName: 'player-1', score: 2_000, completionTimeMs: 50_000 },
        { userName: 'player-2', score: 1_667, completionTimeMs: 60_000 },
        { userName: 'player-3', score: 1_667, completionTimeMs: 60_000 },
        { userName: 'player-4', score: 1_667, completionTimeMs: 60_000 },
        { userName: 'player-5', score: 1_429, completionTimeMs: 70_000 },
        { userName: 'player-6', score: 1_250, completionTimeMs: 80_000 },
        { userName: 'player-7', score: 1_111, completionTimeMs: 90_000 },
        { userName: 'player-8', score: 1_000, completionTimeMs: 100_000 },
        { userName: 'player-9', score: 909, completionTimeMs: 110_000 },
        { userName: 'player-10', score: 833, completionTimeMs: 120_000 },
    ]);
});

test('stores immutable runs, strict personal bests, exact replays, and conflicts', async () => {
    const firstRunId = randomUUID();
    const first = await submitThreeBossesRun(applicationPool, 1, firstRunId, 60_000);
    assert.deepEqual(first, {
        kind: 'accepted',
        replayed: false,
        personalBest: true,
        runId: firstRunId,
        score: 1_667,
        completionTimeMs: 60_000,
    });
    assert.deepEqual(
        await submitThreeBossesRun(applicationPool, 1, firstRunId, 60_000),
        { ...first, replayed: true }
    );
    assert.deepEqual(
        await submitThreeBossesRun(applicationPool, 1, firstRunId, 59_000),
        { kind: 'idempotency-conflict' }
    );

    const worseRunId = randomUUID();
    const worse = await submitThreeBossesRun(applicationPool, 1, worseRunId, 70_000);
    assert.equal(worse.kind, 'accepted');
    if (worse.kind !== 'accepted') assert.fail('expected accepted worse run');
    assert.equal(worse.personalBest, false);
    assert.deepEqual(
        await submitThreeBossesRun(applicationPool, 1, worseRunId, 70_000),
        { ...worse, replayed: true }
    );

    const equal = await submitThreeBossesRun(applicationPool, 1, randomUUID(), 60_000);
    assert.equal(equal.kind, 'accepted');
    if (equal.kind !== 'accepted') assert.fail('expected accepted equal run');
    assert.equal(equal.personalBest, false);

    const bestRunId = randomUUID();
    const best = await submitThreeBossesRun(applicationPool, 1, bestRunId, 50_000);
    assert.equal(best.kind, 'accepted');
    if (best.kind !== 'accepted') assert.fail('expected accepted best run');
    assert.equal(best.personalBest, true);

    const [personalBests] = await observer.query<Array<RowDataPacket & {
        score: number;
        completionTimeMs: number;
        runId: string;
    }>>(`
        SELECT
            game_personal_bests.score,
            game_personal_bests.completion_time_ms AS completionTimeMs,
            game_runs.run_id AS runId
        FROM game_personal_bests
        INNER JOIN game_runs
          ON game_runs.game_run_id = game_personal_bests.source_game_run_id
        WHERE game_personal_bests.game_id = 'three-bosses'
          AND game_personal_bests.rules_version = 1
          AND game_personal_bests.user_id = 1
    `);
    assert.deepEqual(personalBests, [{
        score: 2_000,
        completionTimeMs: 50_000,
        runId: bestRunId,
    }]);
    assert.equal(await countRows('game_runs'), 4);
    assert.equal(await countRows('game_personal_bests'), 1);
});

test('ten new runs consume the shared window while exact replay consumes no slot', async () => {
    const accepted: Array<{ runId: string; completionTimeMs: number }> = [];
    for (let index = 0; index < 10; index += 1) {
        const input = { runId: randomUUID(), completionTimeMs: 50_000 + index };
        accepted.push(input);
        const result = await submitThreeBossesRun(
            applicationPool,
            1,
            input.runId,
            input.completionTimeMs
        );
        assert.equal(result.kind, 'accepted');
        if (result.kind !== 'accepted') assert.fail('expected accepted rate-window run');
        assert.equal(result.replayed, false);
    }

    const replay = await submitThreeBossesRun(
        applicationPool,
        1,
        accepted[0].runId,
        accepted[0].completionTimeMs
    );
    assert.equal(replay.kind, 'accepted');
    if (replay.kind !== 'accepted') assert.fail('expected replay inside full rate window');
    assert.equal(replay.replayed, true);
    assert.deepEqual(
        await submitThreeBossesRun(applicationPool, 1, randomUUID(), 49_000),
        { kind: 'rate-limited' }
    );
    assert.equal(await countRows('game_runs'), 10);
});

test('concurrent exact retries create one row and return one original plus one replay', {
    timeout: 5_000,
}, async () => {
    const database = withFirstQueryBarrier(applicationPool, 2);
    const concurrentRunId = randomUUID();
    const outcomes = await Promise.all([
        submitThreeBossesRun(database, 1, concurrentRunId, 50_000),
        submitThreeBossesRun(database, 1, concurrentRunId, 50_000),
    ]);

    assert.equal(outcomes.every(({ kind }) => kind === 'accepted'), true);
    const accepted = outcomes.filter((result) => result.kind === 'accepted');
    assert.equal(accepted.filter(({ replayed }) => replayed).length, 1);
    assert.equal(accepted.filter(({ replayed }) => !replayed).length, 1);
    assert.equal(await countRows('game_runs'), 1);
    assert.equal(await countRows('game_personal_bests'), 1);
});

test('concurrent distinct runs serialize personal bests and preserve replay outcomes', {
    timeout: 5_000,
}, async () => {
    const database = withFirstQueryBarrier(applicationPool, 2);
    const slowRunId = randomUUID();
    const fastRunId = randomUUID();
    const outcomes = await Promise.all([
        submitThreeBossesRun(database, 1, slowRunId, 60_000),
        submitThreeBossesRun(database, 1, fastRunId, 50_000),
    ]);
    assert.equal(outcomes.every(({ kind }) => kind === 'accepted'), true);

    const [personalBests] = await observer.query<Array<RowDataPacket & {
        completionTimeMs: number;
    }>>(`
        SELECT completion_time_ms AS completionTimeMs
        FROM game_personal_bests
        WHERE game_id = 'three-bosses' AND rules_version = 1 AND user_id = 1
    `);
    assert.deepEqual(personalBests, [{ completionTimeMs: 50_000 }]);
    assert.equal(await countRows('game_runs'), 2);

    for (const [index, input] of [
        { runId: slowRunId, completionTimeMs: 60_000 },
        { runId: fastRunId, completionTimeMs: 50_000 },
    ].entries()) {
        const replay = await submitThreeBossesRun(
            applicationPool,
            1,
            input.runId,
            input.completionTimeMs
        );
        assert.equal(replay.kind, 'accepted');
        if (replay.kind !== 'accepted' || outcomes[index].kind !== 'accepted') {
            assert.fail('expected accepted concurrent replay');
        }
        assert.equal(replay.replayed, true);
        assert.equal(replay.personalBest, outcomes[index].personalBest);
    }
});

test('concurrent rate admission allows only the tenth new run', {
    timeout: 5_000,
}, async () => {
    for (let index = 0; index < 9; index += 1) {
        const result = await submitThreeBossesRun(
            applicationPool,
            1,
            randomUUID(),
            70_000 + index
        );
        assert.equal(result.kind, 'accepted');
    }

    const database = withFirstQueryBarrier(applicationPool, 2);
    const outcomes = await Promise.all([
        submitThreeBossesRun(database, 1, randomUUID(), 60_000),
        submitThreeBossesRun(database, 1, randomUUID(), 50_000),
    ]);
    assert.equal(outcomes.filter(({ kind }) => kind === 'accepted').length, 1);
    assert.equal(outcomes.filter(({ kind }) => kind === 'rate-limited').length, 1);
    assert.equal(await countRows('game_runs'), 10);
});

test('a personal-best write failure rolls the preceding ledger insert back', async () => {
    const forcedFailure = new Error('forced personal-best failure');
    const database = withRejectedPersonalBestWrite(applicationPool, forcedFailure);

    await assert.rejects(
        () => submitThreeBossesRun(database, 1, randomUUID(), 50_000),
        forcedFailure
    );
    assert.equal(await countRows('game_runs'), 0);
    assert.equal(await countRows('game_personal_bests'), 0);
});

test('a valid token for a deleted user is rejected without creating history', async () => {
    assert.deepEqual(
        await submitThreeBossesRun(applicationPool, 999, randomUUID(), 50_000),
        { kind: 'user-not-found' }
    );
    assert.equal(await countRows('game_runs'), 0);
    assert.equal(await countRows('game_personal_bests'), 0);
});
