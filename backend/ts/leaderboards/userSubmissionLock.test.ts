import assert from 'node:assert/strict';
import test from 'node:test';
import { Pool, PoolConnection } from 'mysql2/promise';
import {
    UserSubmissionLockError,
    withUserSubmissionLock,
} from './userSubmissionLock';

type FakeOptions = Readonly<{
    acquireError?: Error;
    acquireResult?: number | null;
    releaseError?: Error;
    releaseResult?: number | null;
}>;

function createFakeDatabase(options: FakeOptions = {}) {
    const events: string[] = [];
    const queries: Array<Readonly<{
        sql: string;
        timeout: number | undefined;
        values: unknown[] | undefined;
    }>> = [];
    const connection = {
        async query(
            queryOptions: { sql: string; timeout?: number },
            values?: unknown[]
        ) {
            const sql = queryOptions.sql.replace(/\s+/g, ' ').trim();
            queries.push({ sql, timeout: queryOptions.timeout, values });
            if (sql.includes('GET_LOCK')) {
                events.push('acquire');
                if (options.acquireError) throw options.acquireError;
                return [[{
                    lockResult: options.acquireResult === undefined
                        ? 1
                        : options.acquireResult,
                }], []];
            }

            events.push('release-lock');
            if (options.releaseError) throw options.releaseError;
            return [[{
                lockResult: options.releaseResult === undefined
                    ? 1
                    : options.releaseResult,
            }], []];
        },
        release() {
            events.push('release-connection');
        },
        destroy() {
            events.push('destroy-connection');
        },
    } as unknown as PoolConnection;
    let acquisitions = 0;
    const database = {
        async getConnection() {
            acquisitions += 1;
            return connection;
        },
    } as Pick<Pool, 'getConnection'>;

    return { database, events, queries, acquisitions: () => acquisitions };
}

test('holds one database-scoped user lock around a successful operation', async () => {
    const fake = createFakeDatabase();

    const result = await withUserSubmissionLock(fake.database, 42, async ({ connection }) => {
        assert.ok(connection);
        fake.events.push('operation');
        return 'accepted';
    });

    assert.equal(result, 'accepted');
    assert.deepEqual(fake.events, [
        'acquire',
        'operation',
        'release-lock',
        'release-connection',
    ]);
    assert.deepEqual(fake.queries.map(({ values }) => values), [[42, 5], [42]]);
    assert.equal(fake.queries.every(({ timeout }) => timeout === 10_000), true);
    assert.match(fake.queries[0].sql, /GET_LOCK/);
    assert.match(fake.queries[0].sql, /SHA2\(DATABASE\(\), 256\)/);
    assert.match(fake.queries[1].sql, /RELEASE_LOCK/);
});

test('releases the named lock while preserving an operation failure', async () => {
    const fake = createFakeDatabase();
    const operationError = new Error('operation failed');

    await assert.rejects(
        () => withUserSubmissionLock(fake.database, 42, async () => {
            fake.events.push('operation');
            throw operationError;
        }),
        operationError
    );
    assert.deepEqual(fake.events, [
        'acquire',
        'operation',
        'release-lock',
        'release-connection',
    ]);
});

test('returns a timed-out connection to the pool without running the operation', async () => {
    const fake = createFakeDatabase({ acquireResult: 0 });
    let operationCalled = false;

    await assert.rejects(
        () => withUserSubmissionLock(fake.database, 42, async () => {
            operationCalled = true;
        }),
        /Timed out waiting/
    );
    assert.equal(operationCalled, false);
    assert.deepEqual(fake.events, ['acquire', 'release-connection']);
});

test('destroys connections after indeterminate acquisition or release', async () => {
    const acquisition = createFakeDatabase({
        acquireError: new Error('connection interrupted'),
    });
    await assert.rejects(
        () => withUserSubmissionLock(acquisition.database, 42, async () => undefined),
        (error: unknown) => {
            assert.ok(error instanceof UserSubmissionLockError);
            assert.match(error.message, /acquisition was indeterminate/);
            return true;
        }
    );
    assert.deepEqual(acquisition.events, ['acquire', 'destroy-connection']);

    const release = createFakeDatabase({ releaseResult: null });
    await assert.rejects(
        () => withUserSubmissionLock(release.database, 42, async () => undefined),
        /not released cleanly/
    );
    assert.deepEqual(release.events, [
        'acquire',
        'release-lock',
        'destroy-connection',
    ]);
});

test('wraps a release query failure and destroys the uncertain session', async () => {
    const releaseError = new Error('release interrupted');
    const fake = createFakeDatabase({ releaseError });

    await assert.rejects(
        () => withUserSubmissionLock(fake.database, 42, async () => undefined),
        (error: unknown) => {
            assert.ok(error instanceof UserSubmissionLockError);
            assert.match(error.message, /release was indeterminate/);
            assert.equal(error.lockError, releaseError);
            return true;
        }
    );
    assert.deepEqual(fake.events, [
        'acquire',
        'release-lock',
        'destroy-connection',
    ]);
});

test('preserves an operation error when release also fails', async () => {
    const operationError = new Error('operation failed');
    const fake = createFakeDatabase({
        releaseError: new Error('release interrupted'),
    });

    await assert.rejects(
        () => withUserSubmissionLock(fake.database, 42, async () => {
            fake.events.push('operation');
            throw operationError;
        }),
        operationError
    );
    assert.deepEqual(fake.events, [
        'acquire',
        'operation',
        'release-lock',
        'destroy-connection',
    ]);
});

test('destroys an explicitly invalidated session and relies on disconnect release', async () => {
    const fake = createFakeDatabase();
    const operationError = new Error('rollback failed');

    await assert.rejects(
        () => withUserSubmissionLock(
            fake.database,
            42,
            async ({ invalidateConnection }) => {
                fake.events.push('operation');
                invalidateConnection();
                throw operationError;
            }
        ),
        operationError
    );
    assert.deepEqual(fake.events, [
        'acquire',
        'operation',
        'destroy-connection',
    ]);
});

test('rejects invalid user IDs before acquiring a connection', async () => {
    const fake = createFakeDatabase();

    await assert.rejects(
        () => withUserSubmissionLock(fake.database, 0, async () => undefined),
        TypeError
    );
    assert.equal(fake.acquisitions(), 0);
});
