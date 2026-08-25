import assert from 'node:assert/strict';
import test from 'node:test';
import { Pool, PoolConnection } from 'mysql2/promise';
import {
    P4VegaScoreRollbackError,
    submitP4VegaScore,
} from './p4VegaScoreRepository';

type QueryCall = Readonly<{
    sql: string;
    timeout: number | undefined;
    values: unknown[] | undefined;
}>;

type FakeDatabaseOptions = Readonly<{
    affectedRows?: number;
    beginError?: Error;
    commitError?: Error;
    queryErrorAt?: number;
    queryError?: Error;
    rollbackError?: Error;
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
            queries.push({
                sql: queryOptions.sql.replace(/\s+/g, ' ').trim(),
                timeout: queryOptions.timeout,
                values,
            });
            events.push(`query:${queries.length}`);
            if (options.queryErrorAt === queries.length) {
                throw options.queryError ?? new Error('query failed');
            }
            return [{ affectedRows: options.affectedRows ?? 1 }, []];
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

test('writes an improving score to both stores on one committed connection', async () => {
    const fake = createFakeDatabase({ affectedRows: 1 });

    const personalBest = await submitP4VegaScore(fake.database, 42, 990);

    assert.equal(personalBest, true);
    assert.equal(fake.acquisitions(), 1);
    assert.deepEqual(fake.events, ['begin', 'query:1', 'query:2', 'commit', 'release']);
    assert.equal(fake.queries.length, 2);
    assert.equal(fake.queries[0].timeout, 10_000);
    assert.equal(
        fake.queries[0].sql,
        'UPDATE users SET p4_score = ? WHERE user_id = ? AND (p4_score IS NULL OR p4_score < ?)'
    );
    assert.deepEqual(fake.queries[0].values, [990, 42, 990]);
    assert.equal(fake.queries[1].timeout, 10_000);
    assert.match(fake.queries[1].sql, /^INSERT INTO game_personal_bests/);
    assert.match(fake.queries[1].sql, /ON DUPLICATE KEY UPDATE/);
    assert.deepEqual(fake.queries[1].values, ['p4-vega', 1, 42, 990]);
});

test('commits a non-improving or missing-user result without seeding generic history', async () => {
    const fake = createFakeDatabase({ affectedRows: 0 });

    const personalBest = await submitP4VegaScore(fake.database, 42, 900);

    assert.equal(personalBest, false);
    assert.deepEqual(fake.events, ['begin', 'query:1', 'commit', 'release']);
    assert.equal(fake.queries.length, 1);
});

test('rolls the legacy update back when the generic write fails', async () => {
    const queryError = new Error('generic write failed');
    const fake = createFakeDatabase({
        affectedRows: 1,
        queryErrorAt: 2,
        queryError,
    });

    await assert.rejects(
        () => submitP4VegaScore(fake.database, 42, 990),
        queryError
    );
    assert.deepEqual(
        fake.events,
        ['begin', 'query:1', 'query:2', 'rollback', 'release']
    );
});

test('rolls back and skips the generic write when the legacy update fails', async () => {
    const queryError = new Error('legacy write failed');
    const fake = createFakeDatabase({
        queryErrorAt: 1,
        queryError,
    });

    await assert.rejects(
        () => submitP4VegaScore(fake.database, 42, 990),
        queryError
    );
    assert.deepEqual(fake.events, ['begin', 'query:1', 'rollback', 'release']);
    assert.equal(fake.queries.length, 1);
});

test('rolls back a failed commit and always releases a reusable connection', async () => {
    const commitError = new Error('commit failed');
    const fake = createFakeDatabase({ affectedRows: 1, commitError });

    await assert.rejects(
        () => submitP4VegaScore(fake.database, 42, 990),
        commitError
    );
    assert.deepEqual(
        fake.events,
        ['begin', 'query:1', 'query:2', 'commit', 'rollback', 'release']
    );
});

test('destroys a connection when rollback fails instead of returning it to the pool', async () => {
    const queryError = new Error('generic write failed');
    const rollbackError = new Error('rollback failed');
    const fake = createFakeDatabase({
        affectedRows: 1,
        queryErrorAt: 2,
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
        ['begin', 'query:1', 'query:2', 'rollback', 'destroy']
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
    assert.deepEqual(fake.events, ['begin', 'release']);
});
