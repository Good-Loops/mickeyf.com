import assert from 'node:assert/strict';
import test from 'node:test';
import type { MigrationConnection } from './leaderboardSchema';
import { loadMigrationManifest } from './migrationManifest';
import { migrationLockName, planMigrations } from './migrationRunner';

type QueryResultFactory = (
    sql: string,
    values: unknown[]
) => unknown;

class FakeConnection implements MigrationConnection {
    readonly calls: Array<{ sql: string; values: unknown[] }> = [];

    constructor(private readonly resultFactory: QueryResultFactory) {}

    async query(sql: string, values: unknown[] = []): Promise<[unknown, unknown]> {
        this.calls.push({ sql, values });
        return [this.resultFactory(sql, values), []];
    }
}

const settings = {
    database: 'migration_test',
    advisoryLockTimeoutSeconds: 2,
    lockWaitTimeoutSeconds: 7,
};

function emptyDatabaseResults(sql: string): unknown {
    if (sql.includes('GET_LOCK')) return [{ acquired: 1 }];
    if (sql.includes('RELEASE_LOCK')) return [{ released: 1 }];
    if (sql.includes('information_schema.TABLES')) return [{ tableCount: 0 }];
    return {};
}

test('plan is read-only, configures short waits, and releases its advisory lock', async () => {
    const connection = new FakeConnection(emptyDatabaseResults);
    const migrations = loadMigrationManifest();

    const plan = await planMigrations(connection, migrations, settings);

    assert.deepEqual(plan, {
        applied: [],
        pending: ['0001_create_game_runs', '0002_create_game_personal_bests'],
        recoverable: [],
    });
    assert.equal(connection.calls.some(({ sql }) => /CREATE|INSERT|DROP/.test(sql)), false);
    assert.equal(
        connection.calls.some(({ sql, values }) =>
            sql.includes('lock_wait_timeout') && values[0] === 7
        ),
        true
    );
    assert.equal(
        connection.calls.some(({ sql }) => sql.includes('autocommit = 1')),
        true
    );
    assert.equal(connection.calls.at(-1)?.sql.includes('RELEASE_LOCK'), true);
});

test('plan fails closed when the advisory lock is unavailable', async () => {
    const connection = new FakeConnection((sql) => {
        if (sql.includes('GET_LOCK')) return [{ acquired: 0 }];
        return {};
    });

    await assert.rejects(
        () => planMigrations(connection, loadMigrationManifest(), settings),
        /Could not acquire/
    );
    assert.equal(
        connection.calls.some(({ sql }) => sql.includes('information_schema.TABLES')),
        false
    );
});

test('plan releases the advisory lock when inspection fails', async () => {
    const connection = new FakeConnection((sql) => {
        if (sql.includes('GET_LOCK')) return [{ acquired: 1 }];
        if (sql.includes('RELEASE_LOCK')) return [{ released: 1 }];
        if (sql.includes('information_schema.TABLES')) {
            throw new Error('synthetic metadata failure');
        }
        return {};
    });

    await assert.rejects(
        () => planMigrations(connection, loadMigrationManifest(), settings),
        /synthetic metadata failure/
    );
    assert.equal(connection.calls.at(-1)?.sql.includes('RELEASE_LOCK'), true);
});

test('migration lock name is stable, scoped, and within MySQL limits', () => {
    const name = migrationLockName('migration_test');

    assert.equal(name, migrationLockName('migration_test'));
    assert.notEqual(name, migrationLockName('another_database'));
    assert.match(name, /^mickeyf:leaderboard:[0-9a-f]{24}$/);
    assert.ok(name.length <= 64);
});
