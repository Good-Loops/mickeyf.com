import assert from 'node:assert/strict';
import test from 'node:test';
import { Pool, PoolConnection } from 'mysql2/promise';
import {
    P4VegaScoreRollbackError,
    readP4VegaLeaderboard,
    submitP4VegaScore,
} from './p4VegaScoreRepository';

type QueryCall = Readonly<{
    sql: string;
    timeout: number | undefined;
    values: unknown[] | undefined;
}>;

type FakeDatabaseOptions = Readonly<{
    beginError?: Error;
    commitError?: Error;
    queryErrorAt?: number;
    queryError?: Error;
    rollbackError?: Error;
    storedScore?: number | null;
    userExists?: boolean;
    writeAffectedRows?: number;
}>;

function createFakeDatabase(options: FakeDatabaseOptions = {}) {
    const events: string[] = [];
    const queries: QueryCall[] = [];
    const connection = {
        async beginTransaction() {
            events.push('begin');
            if (options.beginError) throw options.beginError;
        },
        async query(
            queryOptions: { sql: string; timeout?: number },
            values?: unknown[]
        ) {
            const sql = queryOptions.sql.replace(/\s+/g, ' ').trim();
            queries.push({
                sql,
                timeout: queryOptions.timeout,
                values,
            });
            events.push(`query:${queries.length}`);
            if (options.queryErrorAt === queries.length) {
                throw options.queryError ?? new Error('query failed');
            }
            if (sql.includes('GET_LOCK') || sql.includes('RELEASE_LOCK')) {
                return [[{ lockResult: 1 }], []];
            }
            if (sql.startsWith('SELECT users.user_id AS userId')) {
                return [options.userExists === false
                    ? []
                    : [{ userId: 42, score: options.storedScore ?? null }], []];
            }
            return [{ affectedRows: options.writeAffectedRows ?? 1 }, []];
        },
        async commit() {
            events.push('commit');
            if (options.commitError) throw options.commitError;
        },
        async rollback() {
            events.push('rollback');
            if (options.rollbackError) throw options.rollbackError;
        },
        release() {
            events.push('release');
        },
        destroy() {
            events.push('destroy');
        },
    } as unknown as PoolConnection;
    let acquisitions = 0;
    const database = {
        async getConnection() {
            acquisitions += 1;
            return connection;
        },
    } as Pick<Pool, 'getConnection'>;

    return {
        database,
        events,
        queries,
        acquisitions: () => acquisitions,
    };
}

function createFakeLeaderboardDatabase(
    rows: readonly Record<string, unknown>[] = [],
    queryError?: Error
) {
    const queries: QueryCall[] = [];
    const database = {
        async query(
            queryOptions: { sql: string; timeout?: number },
            values?: unknown[]
        ) {
            queries.push({
                sql: queryOptions.sql.replace(/\s+/g, ' ').trim(),
                timeout: queryOptions.timeout,
                values,
            });
            if (queryError) throw queryError;
            return [rows, []];
        },
    } as unknown as Pick<Pool, 'query'>;

    return { database, queries };
}

test('reads the bounded current p4-Vega leaderboard from generic storage', async () => {
    const fake = createFakeLeaderboardDatabase([
        { userName: 'legacy-outlier', score: 1_200, internalId: 88 },
        { userName: 'player', score: 990, internalId: 42 },
    ]);

    const rows = await readP4VegaLeaderboard(fake.database);

    assert.deepEqual(rows, [
        { userName: 'legacy-outlier', score: 1_200 },
        { userName: 'player', score: 990 },
    ]);
    assert.equal(fake.queries.length, 1);
    assert.equal(fake.queries[0].timeout, 10_000);
    assert.equal(
        fake.queries[0].sql,
        'SELECT users.user_name AS userName, game_personal_bests.score AS score FROM game_personal_bests INNER JOIN users ON users.user_id = game_personal_bests.user_id WHERE game_personal_bests.game_id = ? AND game_personal_bests.rules_version = ? ORDER BY game_personal_bests.score DESC, game_personal_bests.recorded_at ASC, game_personal_bests.user_id ASC LIMIT 10'
    );
    assert.deepEqual(fake.queries[0].values, ['p4-vega', 1]);
});

test('returns an empty generic leaderboard unchanged', async () => {
    const fake = createFakeLeaderboardDatabase();

    assert.deepEqual(await readP4VegaLeaderboard(fake.database), []);
    assert.equal(fake.queries.length, 1);
});

test('propagates generic leaderboard query failures', async () => {
    const queryError = new Error('leaderboard query failed');
    const fake = createFakeLeaderboardDatabase([], queryError);

    await assert.rejects(
        () => readP4VegaLeaderboard(fake.database),
        queryError
    );
});

test('writes an improving score only to generic storage on one committed connection', async () => {
    const fake = createFakeDatabase({ storedScore: 900, writeAffectedRows: 2 });

    const personalBest = await submitP4VegaScore(fake.database, 42, 990);

    assert.equal(personalBest, true);
    assert.equal(fake.acquisitions(), 1);
    assert.deepEqual(fake.events, [
        'query:1',
        'begin',
        'query:2',
        'query:3',
        'commit',
        'query:4',
        'release',
    ]);
    assert.equal(fake.queries.length, 4);
    assert.match(fake.queries[0].sql, /GET_LOCK/);
    assert.equal(fake.queries[1].timeout, 10_000);
    assert.equal(
        fake.queries[1].sql,
        'SELECT users.user_id AS userId, game_personal_bests.score AS score FROM users LEFT JOIN game_personal_bests ON game_personal_bests.game_id = ? AND game_personal_bests.rules_version = ? AND game_personal_bests.user_id = users.user_id WHERE users.user_id = ?'
    );
    assert.deepEqual(fake.queries[1].values, ['p4-vega', 1, 42]);
    assert.equal(fake.queries[2].timeout, 10_000);
    assert.match(fake.queries[2].sql, /^INSERT INTO game_personal_bests/);
    assert.match(fake.queries[2].sql, /ON DUPLICATE KEY UPDATE/);
    assert.deepEqual(fake.queries[2].values, ['p4-vega', 1, 42, 990]);
    assert.match(fake.queries[3].sql, /RELEASE_LOCK/);
    assert.equal(fake.queries.some(({ sql }) => /\bp4_score\b/iu.test(sql)), false);
});

test('inserts the first generic personal best without consulting affected-row semantics', async () => {
    const fake = createFakeDatabase({ storedScore: null, writeAffectedRows: 0 });

    const personalBest = await submitP4VegaScore(fake.database, 42, 900);

    assert.equal(personalBest, true);
    assert.deepEqual(fake.events, [
        'query:1',
        'begin',
        'query:2',
        'query:3',
        'commit',
        'query:4',
        'release',
    ]);
    assert.equal(fake.queries.length, 4);
});

test('commits equal and lower scores without writing generic history', async () => {
    for (const score of [900, 800]) {
        const fake = createFakeDatabase({ storedScore: 900 });

        const personalBest = await submitP4VegaScore(fake.database, 42, score);

        assert.equal(personalBest, false);
        assert.deepEqual(fake.events, [
            'query:1',
            'begin',
            'query:2',
            'commit',
            'query:3',
            'release',
        ]);
        assert.equal(fake.queries.length, 3);
    }
});

test('preserves the missing-user false result without attempting a generic insert', async () => {
    const fake = createFakeDatabase({ userExists: false });

    const personalBest = await submitP4VegaScore(fake.database, 42, 900);

    assert.equal(personalBest, false);
    assert.deepEqual(fake.events, [
        'query:1',
        'begin',
        'query:2',
        'commit',
        'query:3',
        'release',
    ]);
    assert.equal(fake.queries.length, 3);
});

test('rolls back when the generic write fails', async () => {
    const queryError = new Error('generic write failed');
    const fake = createFakeDatabase({
        storedScore: 900,
        queryErrorAt: 3,
        queryError,
    });

    await assert.rejects(
        () => submitP4VegaScore(fake.database, 42, 990),
        queryError
    );
    assert.deepEqual(
        fake.events,
        ['query:1', 'begin', 'query:2', 'query:3', 'rollback', 'query:4', 'release']
    );
});

test('rolls back and skips the generic write when the current-best read fails', async () => {
    const queryError = new Error('current-best read failed');
    const fake = createFakeDatabase({
        queryErrorAt: 2,
        queryError,
    });

    await assert.rejects(
        () => submitP4VegaScore(fake.database, 42, 990),
        queryError
    );
    assert.deepEqual(fake.events, [
        'query:1',
        'begin',
        'query:2',
        'rollback',
        'query:3',
        'release',
    ]);
    assert.equal(fake.queries.length, 3);
});

test('rolls back a failed commit and always releases a reusable connection', async () => {
    const commitError = new Error('commit failed');
    const fake = createFakeDatabase({ storedScore: 900, commitError });

    await assert.rejects(
        () => submitP4VegaScore(fake.database, 42, 990),
        commitError
    );
    assert.deepEqual(
        fake.events,
        [
            'query:1',
            'begin',
            'query:2',
            'query:3',
            'commit',
            'rollback',
            'query:4',
            'release',
        ]
    );
});

test('destroys a connection when rollback fails instead of returning it to the pool', async () => {
    const queryError = new Error('generic write failed');
    const rollbackError = new Error('rollback failed');
    const fake = createFakeDatabase({
        storedScore: 900,
        queryErrorAt: 3,
        queryError,
        rollbackError,
    });

    await assert.rejects(
        () => submitP4VegaScore(fake.database, 42, 990),
        (error: unknown) => {
            assert.ok(error instanceof P4VegaScoreRollbackError);
            assert.equal(error.transactionError, queryError);
            assert.equal(error.rollbackError, rollbackError);
            return true;
        }
    );
    assert.deepEqual(
        fake.events,
        ['query:1', 'begin', 'query:2', 'query:3', 'rollback', 'destroy']
    );
});

test('rejects invalid internal inputs before acquiring a database connection', async () => {
    const fake = createFakeDatabase();

    await assert.rejects(() => submitP4VegaScore(fake.database, 0, 990), TypeError);
    await assert.rejects(() => submitP4VegaScore(fake.database, 42, 995), TypeError);

    assert.equal(fake.acquisitions(), 0);
    assert.deepEqual(fake.events, []);
});

test('releases the connection when beginning the transaction fails', async () => {
    const beginError = new Error('begin failed');
    const fake = createFakeDatabase({ beginError });

    await assert.rejects(
        () => submitP4VegaScore(fake.database, 42, 990),
        beginError
    );
    assert.deepEqual(fake.events, ['query:1', 'begin', 'query:2', 'release']);
});
