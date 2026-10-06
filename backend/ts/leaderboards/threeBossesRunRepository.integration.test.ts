import assert from 'node:assert/strict';
import { once } from 'node:events';
import { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import express from 'express';
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
import { createAccountSession } from '../auth/accountSessionRepository';
import { createLeaderboardRouter } from '../routers/leaderboardRouter';
import { issueSessionToken } from '../security/sessionPolicy';
import { calculateThreeBossesScore } from './leaderboardContract';
import { cleanupSubmissionReceipts } from './submissionReceiptCleanup';
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

function withQueryBarrier(
    pool: Pool,
    participantCount: number,
    matchesQuery: (sql: string) => boolean,
    position: 'before' | 'after'
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
            let barrierReached = false;
            async function waitAtBarrier(): Promise<void> {
                arrived += 1;
                if (arrived === participantCount) openBarrier();
                await barrier;
            }
            return {
                beginTransaction: () => connection.beginTransaction(),
                async query(options: unknown, values?: unknown[]) {
                    const sql = typeof options === 'object' && options !== null
                        && 'sql' in options
                        ? String(options.sql).replace(/\s+/g, ' ').trim()
                        : String(options);
                    const useBarrier = !barrierReached && matchesQuery(sql);
                    if (useBarrier) {
                        barrierReached = true;
                        if (position === 'before') await waitAtBarrier();
                    }
                    const result = await query(options, values);
                    if (useBarrier && position === 'after') await waitAtBarrier();
                    return result;
                },
                commit: () => connection.commit(),
                rollback: () => connection.rollback(),
                release: () => connection.release(),
                destroy: () => connection.destroy(),
            } as unknown as PoolConnection;
        },
    } as Pick<Pool, 'getConnection'>;
}

function withFirstQueryBarrier(
    pool: Pool,
    participantCount: number
): Pick<Pool, 'getConnection'> {
    return withQueryBarrier(pool, participantCount, () => true, 'before');
}

function withCompletedPersonalBestReadBarrier(
    pool: Pool,
    participantCount: number
): Pick<Pool, 'getConnection'> {
    return withQueryBarrier(
        pool,
        participantCount,
        (sql) => sql.startsWith(
            'SELECT completion_time_ms AS completionTimeMs FROM game_personal_bests'
        ),
        'after'
    );
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
                parent_signed_forms, account_score_permissions, parent_child_consents, parent_registration_attempts, account_registration_profiles, registration_authorizations, apple_auth_revocations, apple_provider_tokens,
                game_personal_bests,
                game_submission_receipts,
                game_runs,
                account_sessions,
                provider_auth_attempts,
                account_provider_identities,
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
            CONSTRAINT pk_users PRIMARY KEY (user_id),
            UNIQUE KEY uq_users_email (email)
        ) ENGINE = InnoDB
          DEFAULT CHARACTER SET = utf8mb4
          COLLATE = utf8mb4_unicode_ci
    `);
    for (let userId = 1; userId <= 15; userId += 1) {
        await observer.query(
            `INSERT INTO users (user_name, email, user_password)
             VALUES (?, ?, 'test-only-hash')`,
            [`player-${userId}`, `player-${userId}@example.test`]
        );
    }

    await applyMigrations(asMigrationConnection(observer), migrations, config);
    await applyMigrations(asMigrationConnection(observer), migrations, config, {
        allowedEffectKinds: ['drop-column'],
    });
    await applyMigrations(asMigrationConnection(observer), migrations, config, {
        allowedEffectKinds: ['detach-best-source', 'retain-receipts'],
    });
    await applyMigrations(asMigrationConnection(observer), migrations, config, {
        allowedEffectKinds: [...new Set(migrations.filter(migration => migration.version > '0005').map(migration => migration.effect))],
    });
}

async function countRows(table: 'game_submission_receipts' | 'game_personal_bests'): Promise<number> {
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
    if (observer) {
        try {
            // Later integration suites own their historical schema fixtures.
            await observer.query('DROP TABLE IF EXISTS parent_signed_forms, account_score_permissions, parent_child_consents, parent_registration_attempts, account_registration_profiles, registration_authorizations, apple_auth_revocations, apple_provider_tokens, account_sessions, provider_auth_attempts, account_provider_identities');
        } finally { await observer.end(); }
    }
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
                recorded_at
             ) VALUES ('three-bosses', 1, ?, ?, ?, ?)`,
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
            completion_time_ms, recorded_at
         ) VALUES
            ('three-bosses', 2, 13, 100000000, 1, '1999-01-01 00:00:00.000000'),
            ('p4-vega', 1, 14, 2147483647, NULL, '1999-01-01 00:00:00.000000')`
    );

    assert.deepEqual(await readThreeBossesLeaderboard(applicationPool), [
        { userName: 'player-1', score: 200_000, completionTimeMs: 50_000 },
        { userName: 'player-2', score: 166_667, completionTimeMs: 60_000 },
        { userName: 'player-3', score: 166_667, completionTimeMs: 60_000 },
        { userName: 'player-4', score: 166_667, completionTimeMs: 60_000 },
        { userName: 'player-5', score: 142_857, completionTimeMs: 70_000 },
        { userName: 'player-6', score: 125_000, completionTimeMs: 80_000 },
        { userName: 'player-7', score: 111_111, completionTimeMs: 90_000 },
        { userName: 'player-8', score: 100_000, completionTimeMs: 100_000 },
        { userName: 'player-9', score: 90_909, completionTimeMs: 110_000 },
        { userName: 'player-10', score: 83_333, completionTimeMs: 120_000 },
    ]);
});

test('stores temporary receipts, strict personal bests, exact replays, and conflicts', async () => {
    const firstRunId = randomUUID();
    const first = await submitThreeBossesRun(applicationPool, 1, firstRunId, 60_000);
    assert.deepEqual(first, {
        kind: 'accepted',
        replayed: false,
        personalBest: true,
        runId: firstRunId,
        score: 166_667,
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
    }>>(`
        SELECT
            game_personal_bests.score,
            game_personal_bests.completion_time_ms AS completionTimeMs
        FROM game_personal_bests
        WHERE game_personal_bests.game_id = 'three-bosses'
          AND game_personal_bests.rules_version = 1
          AND game_personal_bests.user_id = 1
    `);
    assert.deepEqual(personalBests, [{
        score: 200_000,
        completionTimeMs: 50_000,
    }]);
    assert.equal(await countRows('game_submission_receipts'), 4);
    assert.equal(await countRows('game_personal_bests'), 1);
});

test('cleanup removes old receipts for idle users without changing either game best', async () => {
    const oldRunId = randomUUID();
    await submitThreeBossesRun(applicationPool, 1, oldRunId, 60_000);
    await submitThreeBossesRun(applicationPool, 2, randomUUID(), 70_000);
    await observer.query(`UPDATE game_submission_receipts
        SET submitted_at = UTC_TIMESTAMP(6) - INTERVAL 25 HOUR`);
    await submitThreeBossesRun(applicationPool, 1, randomUUID(), 50_000);
    await observer.query(`INSERT INTO game_personal_bests
        (game_id, rules_version, user_id, score, completion_time_ms, recorded_at)
        VALUES ('p4-vega', 1, 1, 1500, NULL, '2020-01-01 00:00:00.000000')`);
    const [beforeBests] = await observer.query(`SELECT * FROM game_personal_bests
        ORDER BY game_id, rules_version, user_id`);

    const cleanup = await cleanupSubmissionReceipts(applicationPool, { batchSize: 1 });
    assert.equal(cleanup.status, 'completed');
    assert.equal(cleanup.deletedReceipts, 2);
    assert.equal(await countRows('game_submission_receipts'), 1);
    const [afterBests] = await observer.query(`SELECT * FROM game_personal_bests
        ORDER BY game_id, rules_version, user_id`);
    assert.deepEqual(afterBests, beforeBests);

    // Retention does not promise forever UUID recognition. A newly authorized
    // submission of an old ID is new, but must not overwrite a faster best.
    const reused = await submitThreeBossesRun(applicationPool, 1, oldRunId, 60_000);
    assert.equal(reused.kind, 'accepted');
    if (reused.kind !== 'accepted') assert.fail('expected accepted submission');
    assert.equal(reused.replayed, false);
    assert.equal(reused.personalBest, false);
    const [unchangedBests] = await observer.query(`SELECT * FROM game_personal_bests
        ORDER BY game_id, rules_version, user_id`);
    assert.deepEqual(unchangedBests, beforeBests);
});

test('cleanup reports bounded backlog and a later sweep drains it', async () => {
    for (const userId of [1, 2, 3]) {
        await submitThreeBossesRun(applicationPool, userId, randomUUID(), 50_000);
    }
    await observer.query(`UPDATE game_submission_receipts
        SET submitted_at = UTC_TIMESTAMP(6) - INTERVAL 25 HOUR`);
    const partial = await cleanupSubmissionReceipts(applicationPool, { batchSize: 1, maxBatches: 1 });
    assert.equal(partial.deletedReceipts, 1);
    assert.equal(partial.status, 'backlog');
    assert.equal(partial.backlog, true);
    const completed = await cleanupSubmissionReceipts(applicationPool);
    assert.equal(completed.deletedReceipts, 2);
    assert.equal(completed.status, 'completed');
    assert.equal(await countRows('game_submission_receipts'), 0);
    assert.equal(await countRows('game_personal_bests'), 3);
});

test('cleanup and a concurrent replay serialize without duplicate receipts or lost bests', {
    timeout: 15_000,
}, async () => {
    const runId = randomUUID();
    await submitThreeBossesRun(applicationPool, 1, runId, 50_000);
    await observer.query(`UPDATE game_submission_receipts
        SET submitted_at = UTC_TIMESTAMP(6) - INTERVAL 25 HOUR`);
    const [beforeBests] = await observer.query('SELECT * FROM game_personal_bests');
    const database = withFirstQueryBarrier(applicationPool, 2);
    const [submission, cleanup] = await Promise.all([
        submitThreeBossesRun(database, 1, runId, 50_000),
        cleanupSubmissionReceipts(database),
    ]);
    assert.equal(submission.kind, 'accepted');
    if (submission.kind !== 'accepted') assert.fail('expected accepted submission');
    assert.equal(submission.personalBest, submission.replayed);
    assert.equal(cleanup.deletedReceipts, 1);
    assert.equal(await countRows('game_submission_receipts'), submission.replayed ? 0 : 1);
    const [afterBests] = await observer.query('SELECT * FROM game_personal_bests');
    assert.deepEqual(afterBests, beforeBests);
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
    assert.equal(await countRows('game_submission_receipts'), 10);
});

test('concurrent exact retries create one row and return one original plus one replay', {
    timeout: 15_000,
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
    assert.equal(await countRows('game_submission_receipts'), 1);
    assert.equal(await countRows('game_personal_bests'), 1);
});

test('concurrent distinct runs serialize personal bests and preserve replay outcomes', {
    timeout: 15_000,
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
    assert.equal(await countRows('game_submission_receipts'), 2);

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

test('concurrent first submissions for different users avoid cross-user range locks', {
    timeout: 15_000,
}, async () => {
    const database = withCompletedPersonalBestReadBarrier(applicationPool, 2);
    const outcomes = await Promise.all([
        submitThreeBossesRun(database, 1, randomUUID(), 60_000),
        submitThreeBossesRun(database, 2, randomUUID(), 50_000),
    ]);

    assert.equal(outcomes.every(({ kind }) => kind === 'accepted'), true);
    assert.equal(await countRows('game_submission_receipts'), 2);
    assert.equal(await countRows('game_personal_bests'), 2);
    assert.deepEqual(await readThreeBossesLeaderboard(applicationPool), [
        { userName: 'player-2', score: 200_000, completionTimeMs: 50_000 },
        { userName: 'player-1', score: 166_667, completionTimeMs: 60_000 },
    ]);
});

test('concurrent rate admission allows only the tenth new run', {
    timeout: 15_000,
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
    assert.equal(await countRows('game_submission_receipts'), 10);
});

test('a personal-best write failure rolls the preceding receipt insert back', async () => {
    const forcedFailure = new Error('forced personal-best failure');
    const database = withRejectedPersonalBestWrite(applicationPool, forcedFailure);

    await assert.rejects(
        () => submitThreeBossesRun(database, 1, randomUUID(), 50_000),
        forcedFailure
    );
    assert.equal(await countRows('game_submission_receipts'), 0);
    assert.equal(await countRows('game_personal_bests'), 0);
});

test('a valid token for a deleted user is rejected without creating history', async () => {
    assert.deepEqual(
        await submitThreeBossesRun(applicationPool, 999, randomUUID(), 50_000),
        { kind: 'user-not-found' }
    );
    assert.equal(await countRows('game_submission_receipts'), 0);
    assert.equal(await countRows('game_personal_bests'), 0);
});

test('signed-in HTTP ticket, submission, replay, and leaderboard form one round trip', {
    timeout: 20_000,
}, async () => {
    const sessionSecret = 'isolated-three-bosses-round-trip-secret';
    const runId = randomUUID();
    await applyMigrations(asMigrationConnection(observer), migrations, config, {
        allowedEffectKinds: ['add-account-identity', 'add-provider-identities',
            'add-provider-attempts', 'add-account-sessions', 'add-session-renewal'],
    });
    const [accounts] = await observer.query<Array<RowDataPacket & { accountId: string }>>(
        'SELECT account_uuid AS accountId FROM users WHERE user_id = 1'
    );
    const account = { userId: 1, userName: 'player-1', accountId: accounts[0].accountId };
    const session = issueSessionToken(account, sessionSecret);
    assert.equal(await createAccountSession(applicationPool, account, session.sessionId, session.expiresAt), true);
    const bearerToken = session.token;
    const app = express();
    app.use('/api/leaderboards', createLeaderboardRouter(applicationPool, {
        sessionSecret,
        allowedMutationOrigins: [],
        threeBossesRunSubmissionsEnabled: true,
    }));

    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address() as AddressInfo;
    const apiOrigin = `http://127.0.0.1:${address.port}`;
    const authenticatedJsonRequest = async (path: string, body: unknown) => {
        const response = await fetch(`${apiOrigin}${path}`, {
            method: 'POST',
            headers: {
                accept: 'application/json',
                authorization: `Bearer ${bearerToken}`,
                'content-type': 'application/json',
            },
            body: JSON.stringify(body),
        });
        return { status: response.status, body: await response.json() };
    };

    try {
        const ticketRequest = { contractVersion: 1, rulesVersion: 1, runId };
        const ticket = await authenticatedJsonRequest(
            '/api/leaderboards/three-bosses/run-tickets',
            ticketRequest
        );
        assert.equal(ticket.status, 201);
        assert.equal((ticket.body as { runId: string }).runId, runId);
        assert.equal(
            typeof (ticket.body as { runTicket: unknown }).runTicket,
            'string'
        );

        // The production check allows 2.5 seconds for ticket issuance. Waiting
        // 7.6 seconds proves the minimum 10-second active-combat result against
        // real wall time without weakening the controller for tests.
        await new Promise((resolve) => setTimeout(resolve, 7_600));

        const submission = {
            ...ticketRequest,
            completionTimeMs: 10_000,
            runTicket: (ticket.body as { runTicket: string }).runTicket,
        };
        const accepted = await authenticatedJsonRequest(
            '/api/leaderboards/three-bosses/runs',
            submission
        );
        assert.deepEqual(accepted, {
            status: 201,
            body: {
                success: true,
                contractVersion: 1,
                gameId: 'three-bosses',
                rulesVersion: 1,
                runId,
                replayed: false,
                personalBest: true,
                result: {
                    score: 1_000_000,
                    completionTimeMs: 10_000,
                    rank: 'S',
                },
            },
        });

        const replay = await authenticatedJsonRequest(
            '/api/leaderboards/three-bosses/runs',
            submission
        );
        assert.equal(replay.status, 200);
        assert.equal((replay.body as { replayed: boolean }).replayed, true);

        const leaderboardResponse = await fetch(
            `${apiOrigin}/api/leaderboards/three-bosses`,
            { headers: { accept: 'application/json' } }
        );
        assert.equal(leaderboardResponse.status, 200);
        assert.deepEqual(await leaderboardResponse.json(), {
            success: true,
            contractVersion: 1,
            gameId: 'three-bosses',
            rulesVersion: 1,
            entries: [{
                position: 1,
                userName: 'player-1',
                score: 1_000_000,
                completionTimeMs: 10_000,
                rank: 'S',
            }],
        });
        assert.equal(await countRows('game_submission_receipts'), 1);
        assert.equal(await countRows('game_personal_bests'), 1);
    } finally {
        await new Promise<void>((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
        });
    }
});
