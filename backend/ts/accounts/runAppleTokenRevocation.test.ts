import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool, PoolConnection, QueryOptions } from 'mysql2/promise';
import type { AppleTokenLifecycle } from '../config/appleTokenConfig';
import { runAppleTokenRevocation } from './runAppleTokenRevocation';

const environment = {
    NODE_ENV: 'production', APPLE_REVOCATION_RUN_ENABLED: 'true', APPLE_TOKEN_LIFECYCLE_ENABLED: 'true',
    APPLE_REVOCATION_DB_USER: 'cms_mickeyf', APPLE_REVOCATION_DB_PASS: 'private-db-password', APPLE_REVOCATION_DB_NAME: 'cms',
    APPLE_REVOCATION_CLOUD_SQL_CONNECTION_NAME: 'noted-reef-387021:us-central1:cms-mickeyf',
    APPLE_REVOCATION_EXPECTED_ACCOUNT: 'cms_mickeyf@%', APPLE_REVOCATION_EXPECTED_SERVER_UUID: '11111111-2222-3333-4444-555555555555',
};

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}

function fixture(tokens = 0, guards = 0, due = 0) {
    const state = { tokens, guards, due, released: 0, destroyed: 0, socketDestroyed: 0, lifecycleLoads: 0, appleCalls: 0 };
    const events: string[] = [];
    const queries: string[] = [];
    const logs: Record<string, unknown>[] = [];
    let queryOverride: ((sql: string) => Promise<unknown> | undefined) | undefined;
    let revokeOverride: (() => Promise<void>) | undefined;
    const connection = {
        connection: { stream: { destroy() { state.socketDestroyed++; } } },
        async query(input: QueryOptions) {
            const sql = input.sql.replace(/\s+/gu, ' ').trim();
            queries.push(sql);
            assert.equal(input.timeout, 10_000);
            const overridden = queryOverride?.(sql);
            if (overridden) return overridden;
            if (sql === 'SET SESSION autocommit = 1') { events.push('autocommit'); return [{}, []]; }
            if (sql.startsWith('SELECT EXISTS')) {
                assert.match(sql, /revocation_requested_at IS NOT NULL AND retention_deadline <= UTC_TIMESTAMP\(6\)/u);
                assert.match(sql, /apple_auth_revocations WHERE expires_at <= UTC_TIMESTAMP\(6\)/u);
                events.push('probe');
                return [[{ tokens: Number(state.tokens > 0), guards: Number(state.guards > 0) }], []];
            }
            if (sql.startsWith('DELETE FROM apple_auth_revocations')) {
                assert.match(sql, /WHERE expires_at <= UTC_TIMESTAMP\(6\) ORDER BY expires_at, subject_hash LIMIT 100$/u);
                events.push('guards');
                const deleted = Math.min(100, state.guards);
                state.guards -= deleted;
                return [{ affectedRows: deleted }, []];
            }
            if (sql.startsWith('DELETE FROM apple_provider_tokens') && sql.includes('retention_deadline')) {
                assert.match(sql, /WHERE revocation_requested_at IS NOT NULL AND retention_deadline <= UTC_TIMESTAMP\(6\)/u);
                const limit = Number(sql.match(/LIMIT (\d+)$/u)![1]);
                events.push(`tokens:${limit}`);
                const deleted = Math.min(limit, state.tokens);
                state.tokens -= deleted;
                return [{ affectedRows: deleted }, []];
            }
            if (sql.startsWith('SELECT GET_LOCK')) return [[{ acquired: 1 }], []];
            if (sql.startsWith('SELECT RELEASE_LOCK')) return [[{ released: 1 }], []];
            if (sql.startsWith('SELECT token_id')) {
                assert.match(sql, /LIMIT 20$/u);
                return [Array.from({ length: Math.min(20, state.due) }, () => ({
                    token_id: '12345678-1234-4234-8234-123456789abc', account_uuid: '12345678-1234-4234-8234-123456789abd',
                    client_id: 'com.example.apple', encrypted_token: Buffer.from('private-ciphertext'), attempt_count: 0,
                })), []];
            }
            if (sql.startsWith('UPDATE apple_provider_tokens')) return [{ affectedRows: 1 }, []];
            if (sql.startsWith('DELETE FROM apple_provider_tokens WHERE token_id')) {
                state.due--;
                return [{ affectedRows: 1 }, []];
            }
            if (sql.startsWith('SELECT 1 AS pending')) return [state.due || state.tokens ? [{ pending: 1 }] : [], []];
            throw new Error(`Unexpected SQL: ${sql}`);
        },
        release() { state.released++; },
        destroy() { state.destroyed++; },
    } as unknown as PoolConnection;
    const pool = { async getConnection() { events.push('acquire'); return connection; },
        async end() { events.push('end'); } } as Pick<Pool, 'getConnection' | 'end'>;
    const dependencies = {
        environment, createPool: () => pool,
        verifyConnection: async () => { events.push('verify'); },
        loadLifecycle: () => {
            state.lifecycleLoads++;
            events.push('lifecycle');
            return { clientId: 'com.example.apple', repository: { decrypt() { return 'private-refresh-token'; } },
                client: { async revoke() { state.appleCalls++; await revokeOverride?.(); } } } as unknown as AppleTokenLifecycle;
        },
        log: (event: Record<string, unknown>) => { logs.push(event); },
    };
    return { state, events, queries, logs, connection, pool, dependencies,
        overrideQuery(value: typeof queryOverride) { queryOverride = value; },
        overrideRevoke(value: typeof revokeOverride) { revokeOverride = value; } };
}

test('activation or target rejection opens no pool and logs no credential or raw configuration', async () => {
    for (const change of [{ APPLE_REVOCATION_RUN_ENABLED: 'false' }, { APPLE_REVOCATION_DB_USER: 'root' }]) {
        const f = fixture();
        const code = await runAppleTokenRevocation(['apply'], { ...f.dependencies,
            environment: { ...environment, ...change }, createPool() { assert.fail('No DB pool is permitted'); } });
        assert.equal(code, 1);
        assert.equal(f.logs[0].reason, 'configuration');
        assert.equal(f.state.lifecycleLoads, 0);
        assert.doesNotMatch(JSON.stringify(f.logs), /private-|root/u);
    }
});

test('identity/schema rejection precedes cleanup and retry configuration and destroys the borrowed session', async () => {
    const f = fixture(1, 1, 1);
    assert.equal(await runAppleTokenRevocation(['apply'], { ...f.dependencies,
        async verifyConnection() { throw new Error('private-driver-detail'); } }), 1);
    assert.equal(f.queries.length, 0);
    assert.equal(f.state.lifecycleLoads, 0);
    assert.equal(f.state.destroyed, 1);
    assert.equal(f.state.socketDestroyed, 1);
    assert.equal(f.state.released, 0);
    assert.doesNotMatch(JSON.stringify(f.logs), /private-/u);
});

test('expired material drains across batches before disabled or malformed retry keys fail closed', async () => {
    for (const change of [
        { APPLE_TOKEN_LIFECYCLE_ENABLED: 'false' },
        { APPLE_TOKEN_ENCRYPTION_KEYS: 'private-invalid-json' },
        { APPLE_TOKEN_ENCRYPTION_KEYS: JSON.stringify({ v1: Buffer.alloc(32, 9).toString('base64') }),
            APPLE_TOKEN_ACTIVE_KEY_ID: 'v1', APPLE_IOS_BUNDLE_ID: 'com.example.apple',
            APPLE_SIGN_IN_PRIVATE_KEY: 'private-invalid-pem' },
    ]) {
        const f = fixture(201, 205, 1);
        assert.equal(await runAppleTokenRevocation(['apply'], { ...f.dependencies, loadLifecycle: undefined,
            environment: { ...environment, ...change } }), 1);
        assert.deepEqual([f.state.tokens, f.state.guards, f.state.due, f.state.appleCalls], [0, 0, 1, 0]);
        assert.deepEqual(f.events.slice(0, 9), ['acquire', 'verify', 'autocommit',
            'tokens:100', 'guards', 'tokens:100', 'guards', 'tokens:100', 'guards']);
        assert.equal(f.logs[0].expiredTokensPurged, 201);
        assert.equal(f.logs[0].guardsPurged, 205);
        assert.equal(f.logs[0].reason, 'lifecycle');
        assert.doesNotMatch(JSON.stringify(f.logs), /private-|12345678/u);
    }
});

test('an exactly full guard batch uses a real probe and does not invent a remaining backlog', async () => {
    const f = fixture(0, 100);
    assert.equal(await runAppleTokenRevocation(['apply'], f.dependencies), 0);
    assert.equal(f.logs[0].guardsPurged, 100);
    assert.equal(f.logs[0].guardCleanupBacklog, false);
    assert.equal(f.state.released, 1);
    assert.equal(f.state.destroyed, 0);
});

test('cleanup stops at 100 batches per table and remaining expiry is an explicit failure', async () => {
    const f = fixture(10_100, 10_001);
    assert.equal(await runAppleTokenRevocation(['apply'], f.dependencies), 2);
    assert.equal(f.queries.filter(sql => sql.startsWith('DELETE FROM apple_provider_tokens') && sql.endsWith('LIMIT 100')).length, 100);
    assert.equal(f.queries.filter(sql => sql.startsWith('DELETE FROM apple_auth_revocations')).length, 100);
    assert.equal(f.logs[0].expiredTokensPurged, 10_000);
    assert.equal(f.logs[0].guardsPurged, 10_000);
    assert.equal(f.logs[0].tokenCleanupBacklog, true);
    assert.equal(f.logs[0].guardCleanupBacklog, true);
});

test('retry work stays at 20 Apple calls and reports due backlog for another invocation', async () => {
    const f = fixture(0, 0, 21);
    assert.equal(await runAppleTokenRevocation(['apply'], f.dependencies), 2);
    assert.equal(f.state.appleCalls, 20);
    assert.equal(f.state.due, 1);
    assert.equal(f.logs[0].status, 'backlog');
    assert.ok(f.events.indexOf('lifecycle') > f.events.indexOf('probe'));
    assert.equal(f.queries.filter(sql => sql.startsWith('SELECT EXISTS')).length, 2);
    assert.doesNotMatch(JSON.stringify(f.logs), /private-|12345678/u);
});

test('the final probe detects guard expiry occurring during Apple network work', async () => {
    const f = fixture(0, 0, 1);
    f.overrideRevoke(async () => { f.state.guards = 1; });
    assert.equal(await runAppleTokenRevocation(['apply'], f.dependencies), 2);
    assert.equal(f.logs[0].guardCleanupBacklog, true);
    assert.equal(f.logs[0].guardsPurged, 0);
});

test('invalid purge counts or backlog results prevent network work and are sanitized', async () => {
    for (const scenario of ['count', 'probe']) {
        const f = fixture();
        f.overrideQuery(sql => {
            if (scenario === 'count' && sql.startsWith('DELETE')) return Promise.resolve([{ affectedRows: 101 }, []]);
            if (scenario === 'probe' && sql.startsWith('SELECT EXISTS')) return Promise.resolve([[{ tokens: 0, guards: 2 }], []]);
            return undefined;
        });
        assert.equal(await runAppleTokenRevocation(['apply'], f.dependencies), 1);
        assert.equal(f.logs[0].reason, 'invalid-result');
        assert.equal(f.state.lifecycleLoads, 0);
        assert.equal(f.state.destroyed, 1);
    }
});

test('the command deadline bounds hung SQL and prevents later writes after its result arrives', async () => {
    const f = fixture(100, 100, 1);
    const pending = deferred<unknown>();
    f.overrideQuery(sql => sql.startsWith('DELETE FROM apple_provider_tokens') ? pending.promise : undefined);
    assert.equal(await runAppleTokenRevocation(['apply'], { ...f.dependencies, maxDurationMs: 15 }), 1);
    assert.equal(f.logs[0].reason, 'deadline');
    assert.equal(f.state.destroyed, 1);
    assert.equal(f.state.socketDestroyed, 1);
    const queryCount = f.queries.length;
    pending.resolve([{ affectedRows: 100 }, []]);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.queries.length, queryCount);
    assert.equal(f.state.lifecycleLoads, 0);
    assert.equal(f.state.appleCalls, 0);
});

test('a connection arriving after acquisition timeout is destroyed without verification or SQL', async () => {
    const f = fixture();
    const pending = deferred<PoolConnection>();
    f.pool.getConnection = () => pending.promise;
    assert.equal(await runAppleTokenRevocation(['apply'], { ...f.dependencies, maxDurationMs: 15 }), 1);
    pending.resolve(f.connection);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.queries.length, 0);
    assert.equal(f.events.includes('verify'), false);
    assert.equal(f.state.destroyed, 1);
    assert.equal(f.state.socketDestroyed, 1);
});

test('a late Apple response cannot write or start another retry after the command deadline', async () => {
    const f = fixture(0, 0, 2);
    const pending = deferred<void>();
    f.overrideRevoke(() => pending.promise);
    assert.equal(await runAppleTokenRevocation(['apply'], { ...f.dependencies, maxDurationMs: 15 }), 1);
    assert.equal(f.state.appleCalls, 1);
    const queryCount = f.queries.length;
    pending.resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.state.appleCalls, 1);
    assert.equal(f.queries.length, queryCount);
    assert.equal(f.state.released, 0);
    assert.equal(f.state.destroyed, 1);
});

test('shutdown has its own bounded wait and destroys a session with uncertain driver teardown', async () => {
    const f = fixture();
    f.pool.end = () => new Promise<void>(() => undefined);
    assert.equal(await runAppleTokenRevocation(['apply'], { ...f.dependencies, shutdownTimeoutMs: 15 }), 1);
    assert.equal(f.logs.at(-1)?.reason, 'shutdown');
    assert.equal(f.state.destroyed, 1);
    assert.equal(f.state.socketDestroyed, 1);
});
