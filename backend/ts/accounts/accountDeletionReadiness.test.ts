import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool, PoolConnection } from 'mysql2/promise';
import { AccountDeletionReadinessError, AccountSessionReadinessError, verifyAccountDeletionReadiness, verifyAccountSessionReadiness } from './accountDeletionReadiness';

const EPOCH = '2026-09-11 19:00:00.123456';

function fakeDatabase(options: { epoch?: string; badColumn?: boolean; invalidCount?: number;
    providerTable?: 'absent' | 'malformed'; providerMigrationRecorded?: boolean;
    attemptTable?: 'absent' | 'malformed'; attemptMigrationRecorded?: boolean;
    sessionTable?: 'absent' | 'malformed'; sessionMigrationRecorded?: boolean;
    renewalMigrationRecorded?: boolean;
    queryError?: Error; queryPending?: boolean } = {}) {
    const queries: Array<{ sql: string; timeout: number; values?: unknown[] }> = [];
    const cleanup: string[] = [];
    const connection = {
        async query(query: { sql: string; timeout: number }, values?: unknown[]) {
            queries.push({ ...query, values });
            if (options.queryError) throw options.queryError;
            if (options.queryPending) return new Promise(() => {});
            if (query.sql.startsWith('SELECT version FROM schema_migrations')) {
                const recorded = (values ?? []).filter(version => version === '0011_create_account_sessions'
                    ? options.sessionMigrationRecorded : version === '0012_add_session_renewal'
                        ? options.renewalMigrationRecorded : version === '0010_create_provider_auth_attempts'
                            ? options.attemptMigrationRecorded : options.providerMigrationRecorded);
                return [recorded.map(version => ({ version })), []];
            }
            if (values?.[0] === 'account_provider_identities') {
                return [query.sql.includes('COUNT(*)')
                    ? [{ tableCount: options.providerTable === 'malformed' ? 1 : 0 }]
                    : [{ engine: 'MyISAM', collation: 'utf8mb4_unicode_ci', tableType: 'BASE TABLE' }], []];
            }
            if (values?.[0] === 'provider_auth_attempts') {
                return [query.sql.includes('COUNT(*)')
                    ? [{ tableCount: options.attemptTable === 'malformed' ? 1 : 0 }]
                    : [{ engine: 'MyISAM', collation: 'utf8mb4_unicode_ci', tableType: 'BASE TABLE' }], []];
            }
            if (values?.[0] === 'account_sessions') {
                return [query.sql.includes('COUNT(*)')
                    ? [{ tableCount: options.sessionTable === 'malformed' ? 1 : 0 }]
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
    assert.equal(queries.length, 11);
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

test('deletion readiness allows pre-0010 backups but fails closed on missing recorded or malformed attempts', async () => {
    const legacy = fakeDatabase({ attemptTable: 'absent' });
    await verifyAccountDeletionReadiness(legacy.database, EPOCH);
    assert.ok(legacy.queries.some(({ sql, values }) => sql.startsWith('SELECT version FROM schema_migrations')
        && values?.[0] === '0010_create_provider_auth_attempts'));
    assert.deepEqual(legacy.cleanup, ['release']);
    for (const options of [
        { attemptMigrationRecorded: true }, { attemptTable: 'malformed' as const },
    ]) {
        const { database, queries, cleanup } = fakeDatabase(options);
        await assert.rejects(verifyAccountDeletionReadiness(database, EPOCH), AccountDeletionReadinessError);
        assert.ok(queries.every(({ sql }) => /^SELECT/u.test(sql.trim())));
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

test('pre-0011 deletion readiness accepts absent sessions but rejects unsafe recorded storage', async () => {
    const legacy = fakeDatabase();
    await verifyAccountDeletionReadiness(legacy.database, EPOCH);
    assert.ok(legacy.queries.some(({ values }) => values?.[0] === '0011_create_account_sessions'));
    for (const options of [{ sessionMigrationRecorded: true }, { sessionTable: 'malformed' as const }]) {
        const fake = fakeDatabase(options);
        await assert.rejects(verifyAccountDeletionReadiness(fake.database, EPOCH), AccountDeletionReadinessError);
        assert.deepEqual(fake.cleanup, ['release']);
    }
});

test('session startup requires recorded migrations 0011 and 0012 and rejects unsafe storage', async () => {
    for (const options of [{}, { sessionTable: 'malformed' as const },
        { sessionMigrationRecorded: true },
        { sessionMigrationRecorded: true, renewalMigrationRecorded: true, sessionTable: 'malformed' as const }]) {
        const fake = fakeDatabase(options);
        await assert.rejects(verifyAccountSessionReadiness(fake.database), AccountSessionReadinessError);
        assert.deepEqual(fake.queries[0].values, ['0011_create_account_sessions']);
        if (options.sessionMigrationRecorded) {
            assert.deepEqual(fake.queries[1].values, ['0012_add_session_renewal']);
        }
        assert.ok(fake.queries.every(({ sql, timeout }) => /^SELECT/u.test(sql.trim()) && timeout === 10_000));
        assert.deepEqual(fake.cleanup, ['release']);
    }
});

test('deletion readiness rejects a recorded renewal migration without session storage', async () => {
    const fake = fakeDatabase({ renewalMigrationRecorded: true });
    await assert.rejects(verifyAccountDeletionReadiness(fake.database, EPOCH), AccountDeletionReadinessError);
    assert.ok(fake.queries.some(({ values }) => values?.includes('0012_add_session_renewal')));
    assert.deepEqual(fake.cleanup, ['release']);
});

test('session startup failures are sanitized and destroy a failed query connection', async () => {
    const fake = fakeDatabase({ queryError: new Error('driver secret') });
    await assert.rejects(verifyAccountSessionReadiness(fake.database), error => {
        assert.ok(error instanceof AccountSessionReadinessError);
        assert.doesNotMatch(String(error), /secret/);
        return true;
    });
    assert.deepEqual(fake.cleanup, ['destroy']);
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
