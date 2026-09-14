import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool, PoolConnection } from 'mysql2/promise';
import { AccountDeletionReadinessError, verifyAccountDeletionReadiness } from './accountDeletionReadiness';

const EPOCH = '2026-09-11 19:00:00.123456';

function fakeDatabase(options: { epoch?: string; badColumn?: boolean; invalidCount?: number;
    providerTable?: 'absent' | 'malformed'; providerMigrationRecorded?: boolean;
    queryError?: Error; queryPending?: boolean } = {}) {
    const queries: Array<{ sql: string; timeout: number }> = [];
    const cleanup: string[] = [];
    const connection = {
        async query(query: { sql: string; timeout: number }, values?: unknown[]) {
            queries.push(query);
            if (options.queryError) throw options.queryError;
            if (options.queryPending) return new Promise(() => {});
            if (query.sql.startsWith('SELECT version FROM schema_migrations')) {
                return [options.providerMigrationRecorded ? [{ version: '0009_create_account_provider_identities' }] : [], []];
            }
            if (values?.[0] === 'account_provider_identities') {
                return [query.sql.includes('COUNT(*)')
                    ? [{ tableCount: options.providerTable === 'malformed' ? 1 : 0 }]
                    : [{ engine: 'MyISAM', collation: 'utf8mb4_unicode_ci', tableType: 'BASE TABLE' }], []];
            }
            if (query.sql.includes('schema_migrations')) return [[{ epoch: options.epoch ?? EPOCH }], []];
            if (query.sql.includes('information_schema.TABLES')) return [[{ engine: 'InnoDB' }], []];
            if (query.sql.includes('information_schema.COLUMNS')) return [[{
                type: options.badColumn ? 'varchar(36)' : 'char(36)', nullable: 'NO',
                characterSet: 'ascii', collation: 'ascii_bin', defaultValue: 'uuid()',
                extra: 'DEFAULT_GENERATED', generationExpression: '',
            }], []];
            if (query.sql.includes('information_schema.STATISTICS')) return [[{
                columnName: 'account_uuid', nonUnique: 0, sequence: 1, subPart: null,
                visible: 'YES', indexType: 'BTREE',
            }], []];
            if (query.sql.includes('COUNT(*)')) return [[{ invalidCount: options.invalidCount ?? 0 }], []];
            throw new Error('Unexpected SQL');
        },
        release() { cleanup.push('release'); },
        destroy() { cleanup.push('destroy'); },
    } as unknown as PoolConnection;
    const database = { async getConnection() { return connection; } } as Pick<Pool, 'getConnection'>;
    return { database, connection, queries, cleanup };
}

test('readiness verifies the independently pinned epoch and identity schema using read-only timed queries', async () => {
    const { database, queries, cleanup } = fakeDatabase();
    await verifyAccountDeletionReadiness(database, EPOCH);
    assert.equal(queries.length, 7);
    assert.ok(queries[0].sql.includes('schema_migrations'));
    assert.ok(queries.some(query => query.sql.startsWith('SELECT version FROM schema_migrations')));
    for (const query of queries) {
        assert.match(query.sql.trim(), /^SELECT/);
        assert.equal(query.timeout, 10_000);
    }
    assert.deepEqual(cleanup, ['release']);
});

test('deletion readiness rejects missing recorded provider storage and malformed present storage', async () => {
    for (const options of [
        { providerMigrationRecorded: true }, { providerTable: 'malformed' as const },
    ]) {
        const { database, cleanup } = fakeDatabase(options);
        await assert.rejects(verifyAccountDeletionReadiness(database, EPOCH), AccountDeletionReadinessError);
        assert.deepEqual(cleanup, ['release']);
    }
});

test('invalid or different epoch and malformed identities cannot enable deletion', async () => {
    for (const options of [
        { epoch: '2026-09-12 19:00:00.123456' }, { badColumn: true }, { invalidCount: 1 },
    ]) {
        const { database, cleanup } = fakeDatabase(options);
        await assert.rejects(verifyAccountDeletionReadiness(database, EPOCH), AccountDeletionReadinessError);
        assert.deepEqual(cleanup, ['release']);
    }
    const { database, queries, cleanup } = fakeDatabase();
    await assert.rejects(verifyAccountDeletionReadiness(database, 'invalid epoch'), AccountDeletionReadinessError);
    assert.equal(queries.length, 0);
    assert.deepEqual(cleanup, ['release']);
});

test('query failures destroy the connection and do not leak the driver error', async () => {
    const { database, cleanup } = fakeDatabase({ queryError: new Error('driver secret and SQL account details') });
    await assert.rejects(verifyAccountDeletionReadiness(database, EPOCH), error => {
        assert.ok(error instanceof AccountDeletionReadinessError);
        assert.doesNotMatch(String(error), /secret|SQL account/);
        assert.equal(Object.prototype.hasOwnProperty.call(error, 'cause'), false);
        return true;
    });
    assert.deepEqual(cleanup, ['destroy']);
});

test('the whole readiness operation has a deadline and destroys a stuck query session', async context => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const { database, queries, cleanup } = fakeDatabase({ queryPending: true });
    const verifying = verifyAccountDeletionReadiness(database, EPOCH);
    const rejected = assert.rejects(verifying, AccountDeletionReadinessError);
    await Promise.resolve();
    assert.equal(queries.length, 1);
    context.mock.timers.tick(10_000);
    await rejected;
    assert.deepEqual(cleanup, ['destroy']);
});

test('a pool acquisition completing after the deadline is released without queries', async context => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const { connection, queries, cleanup } = fakeDatabase();
    let acquire!: (connection: PoolConnection) => void;
    const database = { getConnection: () => new Promise(resolve => { acquire = resolve; }) } as Pick<Pool, 'getConnection'>;
    const rejected = assert.rejects(verifyAccountDeletionReadiness(database, EPOCH), AccountDeletionReadinessError);
    context.mock.timers.tick(10_000);
    await rejected;
    acquire(connection);
    await Promise.resolve();
    assert.equal(queries.length, 0);
    assert.deepEqual(cleanup, ['release']);
});
