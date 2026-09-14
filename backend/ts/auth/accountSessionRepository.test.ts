import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Pool, PoolConnection, QueryOptions } from 'mysql2/promise';
import { AccountSessionUnavailableError, createAccountSession, readLiveSession, revokeAccountSession } from './accountSessionRepository';

const target = { userId: 7, accountId: randomUUID() };
const sessionId = randomBytes(32).toString('base64url');
const expiresAt = () => Math.floor(Date.now() / 1000) + 3600;
type Call = { sql: string; values: unknown[] };
function fixture(options: {
    user?: Record<string, unknown> | null; sessions?: Record<string, unknown>[];
    live?: Record<string, unknown>[]; fail?: string; affectedRows?: number;
} = {}) {
    const calls: Call[] = [];
    let destroyed = false;
    let released = false;
    const connection = {
        async query(query: QueryOptions, values: unknown[] = []) {
            assert.equal(query.timeout, 10_000);
            const sql = query.sql;
            calls.push({ sql, values });
            if (options.fail && sql.includes(options.fail)) throw new Error('private SQL password and token detail');
            if (sql.includes('GET_LOCK') || sql.includes('RELEASE_LOCK')) return [[{ lockResult: 1 }], []];
            if (sql.startsWith('SELECT account_uuid')) return [options.user === null ? []
                : [options.user ?? { accountId: target.accountId, passwordHash: 'expected-hash' }], []];
            if (sql.startsWith('SELECT session_hash')) return [options.sessions ?? [], []];
            if (sql.startsWith('SELECT u.user_name')) return [options.live ?? [{ userName: 'fixture' }], []];
            return [{ affectedRows: options.affectedRows ?? 1 }, []];
        },
        release() { released = true; }, destroy() { destroyed = true; },
    } as unknown as PoolConnection;
    return { database: { getConnection: async () => connection } as Pick<Pool, 'getConnection'>,
        connection, calls, destroyed: () => destroyed, released: () => released };
}

test('creation hashes the secret, confirms commit, bounds expiry and locks before account proof', async () => {
    const f = fixture();
    const expiry = expiresAt();
    assert.equal(await createAccountSession(f.database, target, sessionId, expiry, 'expected-hash'), true);
    const insert = f.calls.find(call => call.sql.startsWith('INSERT INTO account_sessions'))!;
    assert.deepEqual(insert.values, [createHash('sha256').update(sessionId).digest(), target.accountId, expiry, expiry, expiry]);
    assert.match(insert.sql, /UTC_TIMESTAMP\(6\)[\s\S]*TIMESTAMPADD/u);
    assert.match(insert.sql, /INTERVAL 30 DAY/u);
    assert.equal(f.calls.flatMap(call => call.values).includes(sessionId), false);
    assert.equal(f.calls.flatMap(call => call.values).includes('expected-hash'), false);
    assert(f.calls[0].sql.includes('GET_LOCK'));
    assert.equal(f.calls[1].sql, 'START TRANSACTION');
    assert.match(f.calls[2].sql, /FOR UPDATE/u);
    assert.equal(f.calls.at(-2)?.sql, 'COMMIT');
    assert.match(f.calls.at(-1)!.sql, /RELEASE_LOCK/u);
    assert.equal(f.released(), true);
});

test('deleted/replaced accounts or changed password proof cannot create or evict sessions', async () => {
    for (const user of [null, { accountId: randomUUID(), passwordHash: 'expected-hash' },
        { accountId: target.accountId, passwordHash: 'changed' }]) {
        const f = fixture({ user });
        assert.equal(await createAccountSession(f.database, target, sessionId, expiresAt(), 'expected-hash'), false);
        assert.equal(f.calls.some(call => /INSERT|DELETE/u.test(call.sql)), false);
    }
});

test('only a full account evicts its oldest remaining device after bounded expiry cleanup', async () => {
    for (const count of [9, 10]) {
        const sessions = Array.from({ length: count }, () => ({ session_hash: randomBytes(32) }));
        const f = fixture({ sessions });
        assert.equal(await createAccountSession(f.database, target, sessionId, expiresAt()), true);
        const cleanup = f.calls.find(call => call.sql.startsWith('DELETE FROM account_sessions') && call.sql.includes('expires_at'))!;
        assert.deepEqual(cleanup.values, [target.accountId]);
        assert.match(cleanup.sql, /LIMIT 10/u);
        const eviction = f.calls.find(call => call.sql === 'DELETE FROM account_sessions WHERE account_uuid = ? AND session_hash = ?');
        assert.equal(Boolean(eviction), count === 10);
        if (eviction) assert.deepEqual(eviction.values, [target.accountId, sessions[0].session_hash]);
    }
    const overfull = fixture({ sessions: Array.from({ length: 11 }, () => ({ session_hash: randomBytes(32) })) });
    await assert.rejects(createAccountSession(overfull.database, target, sessionId, expiresAt()), AccountSessionUnavailableError);
    assert.equal(overfull.calls.some(call => call.sql.startsWith('INSERT')), false);
});

test('live session read requires numeric ID plus immutable UUID and database-clock expiry, without writes', async () => {
    const f = fixture();
    assert.deepEqual(await readLiveSession(f.connection, target.userId, target.accountId, sessionId), { userName: 'fixture' });
    assert.deepEqual(f.calls[0].values, [target.userId, target.accountId, createHash('sha256').update(sessionId).digest()]);
    assert.match(f.calls[0].sql, /expires_at > UTC_TIMESTAMP\(6\)/u);
    assert.equal(f.calls.length, 1);
    assert.equal(await readLiveSession(fixture({ live: [] }).connection, target.userId, target.accountId, sessionId), null);
    for (const live of [[{ userName: '' }], [{ userName: 'a' }, { userName: 'b' }]]) {
        await assert.rejects(readLiveSession(fixture({ live }).connection, target.userId, target.accountId, sessionId),
            AccountSessionUnavailableError);
    }
});

test('logout is idempotent, user-serialized and only removes matching UUID and device hash', async () => {
    const f = fixture({ affectedRows: 0 });
    await revokeAccountSession(f.database, target.userId, target.accountId, sessionId);
    const deletion = f.calls.find(call => call.sql.startsWith('DELETE s'))!;
    assert.deepEqual(deletion.values, [target.userId, target.accountId, createHash('sha256').update(sessionId).digest()]);
    assert.match(deletion.sql, /INNER JOIN users/u);
    assert.equal(f.calls.at(-2)?.sql, 'COMMIT');
});

test('invalid credentials and expiries are rejected before acquiring a connection', async () => {
    const f = fixture();
    for (const expiry of [0, expiresAt() + 31 * 86400, Infinity, 1.5]) {
        await assert.rejects(createAccountSession(f.database, target, sessionId, expiry), TypeError);
    }
    for (const [userId, accountId, id] of [[0, target.accountId, sessionId], [7, 'not-a-uuid', sessionId],
        [7, target.accountId, 'a'.repeat(43)], [7, target.accountId, sessionId + '=']] as const) {
        await assert.rejects(readLiveSession(f.connection, userId, accountId, id), TypeError);
    }
    assert.deepEqual(f.calls, []);
});

test('storage failures expose no driver data; uncertain begin/commit/release destroys the connection', async () => {
    for (const fail of ['START TRANSACTION', 'COMMIT', 'RELEASE_LOCK', 'INSERT INTO account_sessions']) {
        const f = fixture({ fail });
        await assert.rejects(createAccountSession(f.database, target, sessionId, expiresAt()), error => {
            assert(error instanceof AccountSessionUnavailableError);
            assert.equal('cause' in error, false);
            assert.doesNotMatch(error.message, /private|password|token/u);
            return true;
        });
        assert.equal(f.destroyed(), fail !== 'INSERT INTO account_sessions');
        if (fail === 'INSERT INTO account_sessions') assert(f.calls.some(call => call.sql === 'ROLLBACK'));
    }
    const f = fixture({ fail: 'SELECT u.user_name' });
    await assert.rejects(readLiveSession(f.connection, target.userId, target.accountId, sessionId), AccountSessionUnavailableError);
});
