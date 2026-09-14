import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool, PoolConnection } from 'mysql2/promise';
import {
    consumeProviderAttempt, createProviderAttempt, ProviderAttemptUnavailableError, type ProviderAttempt,
} from './providerAttemptRepository';

const accountId = '123e4567-e89b-42d3-a456-426614174000';
const loginAttempt: ProviderAttempt = {
    stateHash: Buffer.alloc(32, 1), bindingHash: Buffer.alloc(32, 2), nonce: Buffer.alloc(32, 3).toString('base64url'),
    clientKey: 'google-web', action: 'login', userId: null, accountId: null,
};
const linkAttempt: ProviderAttempt = { ...loginAttempt, action: 'link', userId: 7, accountId };
const signupAttempt: ProviderAttempt = { ...loginAttempt, action: 'signup' };
const deleteAttempt: ProviderAttempt = { ...linkAttempt, action: 'delete' };
const storedLogin = { nonce: loginAttempt.nonce, userId: null, accountId: null };

type FixtureOptions = {
    row?: Record<string, unknown> | null;
    count?: unknown;
    acquire?: unknown;
    unlock?: unknown;
    live?: boolean;
    fail?: string;
    rollbackFails?: boolean;
    affectedRows?: number;
};

function fixture(options: FixtureOptions = {}) {
    const events: string[] = [];
    const queries: Array<{ sql: string; timeout: number; values?: unknown[] }> = [];
    const sensitiveFailure = new Error('sensitive driver credentials, identity and raw statement');
    function step(name: string): void {
        events.push(name);
        if (options.fail === name) throw sensitiveFailure;
    }
    const connection = {
        release() { step('release'); },
        destroy() { step('destroy'); },
        async query(query: { sql: string; timeout: number }, values?: unknown[]) {
            const sql = query.sql.replace(/\s+/g, ' ').trim();
            queries.push({ ...query, sql, values });
            if (sql.includes('GET_LOCK')) { step('lock'); return [[{ acquired: options.acquire === undefined ? 1 : options.acquire }]]; }
            if (sql.includes('RELEASE_LOCK')) { step('unlock'); return [[{ released: options.unlock === undefined ? 1 : options.unlock }]]; }
            if (sql === 'START TRANSACTION') { step('begin'); return [[]]; }
            if (sql === 'COMMIT') { step('commit'); return [[]]; }
            if (sql === 'ROLLBACK') {
                step('rollback');
                if (options.rollbackFails) throw sensitiveFailure;
                return [[]];
            }
            if (sql.startsWith('SELECT COUNT(*)')) { step('count'); return [[{ pendingCount: options.count ?? 0 }]]; }
            if (sql.startsWith('SELECT nonce')) {
                step('select');
                return [options.row === null ? [] : [options.row ?? storedLogin]];
            }
            if (sql.startsWith('INSERT')) { step('insert'); return [{ affectedRows: options.affectedRows ?? 1 }]; }
            if (sql.includes('ORDER BY expires_at')) { step('cleanup'); return [{ affectedRows: 0 }]; }
            if (sql.includes('WHERE binding_hash')) { step('replace'); return [{ affectedRows: 0 }]; }
            if (sql.includes('expires_at >')) { step('consume'); return [{ affectedRows: options.affectedRows ?? (options.live === false ? 0 : 1) }]; }
            if (sql.startsWith('DELETE')) { step('expire'); return [{ affectedRows: options.affectedRows ?? 1 }]; }
            throw new Error('Unexpected fixture query');
        },
    } as unknown as PoolConnection;
    const database = {
        async getConnection() { step('acquire'); return connection; },
    } as Pick<Pool, 'getConnection'>;
    return { events, queries, database };
}

function consume(database: Pick<Pool, 'getConnection'>, attempt = loginAttempt) {
    return consumeProviderAttempt(database, attempt.stateHash, attempt.bindingHash, attempt.clientKey, attempt.action);
}

function sanitized(error: unknown): boolean {
    assert(error instanceof ProviderAttemptUnavailableError);
    assert.equal(error.message, 'The provider attempt operation could not be confirmed.');
    assert.equal('cause' in error, false);
    assert.doesNotMatch(JSON.stringify(error), /sensitive|credentials|raw statement/);
    return true;
}

test('creates one bounded five-minute attempt and commits before releasing the database creation lock', async () => {
    for (const attempt of [loginAttempt, linkAttempt, signupAttempt, deleteAttempt]) {
        const f = fixture();
        assert.equal(await createProviderAttempt(f.database, attempt), 'created');
        assert.deepEqual(f.events, ['acquire', 'lock', 'begin', 'cleanup', 'replace', 'count', 'insert', 'commit', 'unlock', 'release']);
        assert(f.queries.every(query => query.timeout === 10_000));
        assert.match(f.queries[0].sql, /SHA2\(DATABASE\(\), 256\)/);
        assert.match(f.queries.find(query => query.sql.includes('ORDER BY'))!.sql, /expires_at <= UTC_TIMESTAMP\(6\) ORDER BY expires_at LIMIT 100$/);
        assert.match(f.queries.find(query => query.sql.includes('COUNT'))!.sql, /LIMIT 10000/);
        assert.deepEqual(f.queries.find(query => query.sql.includes('WHERE binding_hash'))!.values, [attempt.bindingHash]);
        const insert = f.queries.find(query => query.sql.startsWith('INSERT'))!;
        assert.match(insert.sql, /UTC_TIMESTAMP\(6\) \+ INTERVAL 5 MINUTE/);
        assert.deepEqual(insert.values, [attempt.stateHash, attempt.bindingHash, attempt.nonce, attempt.clientKey,
            attempt.action, attempt.userId, attempt.accountId]);
        assert(f.queries.every(query => !/\b(?:users|account_provider_identities|game_personal_bests|UPDATE)\b/i.test(query.sql)));
    }
});

test('capacity and creation-lock contention fail closed without adding a row', async () => {
    const full = fixture({ count: 10_000 });
    assert.equal(await createProviderAttempt(full.database, loginAttempt), 'busy');
    assert(!full.events.includes('insert'));
    assert.deepEqual(full.events.slice(-3), ['commit', 'unlock', 'release']);
    const contended = fixture({ acquire: 0 });
    assert.equal(await createProviderAttempt(contended.database, loginAttempt), 'busy');
    assert.deepEqual(contended.events, ['acquire', 'lock', 'release']);
    const lastSlot = fixture({ count: 9_999 });
    assert.equal(await createProviderAttempt(lastSlot.database, loginAttempt), 'created');
});

test('consumes only an exactly bound row and returns its trusted values after commit', async () => {
    for (const attempt of [loginAttempt, linkAttempt, signupAttempt, deleteAttempt]) {
        const row = { nonce: attempt.nonce, accountId: attempt.accountId, userId: attempt.userId };
        const f = fixture({ row });
        assert.deepEqual(await consume(f.database, attempt), row);
        assert.deepEqual(f.events, ['acquire', 'begin', 'select', 'consume', 'commit', 'release']);
        const select = f.queries.find(query => query.sql.startsWith('SELECT nonce'))!;
        assert.match(select.sql, /state_hash = \? AND binding_hash = \? AND BINARY client_key = BINARY \? AND BINARY action = BINARY \? LIMIT 1 FOR UPDATE/);
        assert.deepEqual(select.values, [attempt.stateHash, attempt.bindingHash, attempt.clientKey, attempt.action]);
        assert.match(f.queries.find(query => query.sql.startsWith('DELETE'))!.sql, /expires_at > UTC_TIMESTAMP\(6\)/);
        assert(f.queries.every(query => query.timeout === 10_000));
    }
});

test('absent or mismatched attempts are not deleted; matched expired attempts are removed', async () => {
    const absent = fixture({ row: null });
    assert.equal(await consume(absent.database), null);
    assert.deepEqual(absent.events, ['acquire', 'begin', 'select', 'commit', 'release']);
    const expired = fixture({ live: false });
    assert.equal(await consume(expired.database), null);
    assert.deepEqual(expired.events, ['acquire', 'begin', 'select', 'consume', 'expire', 'commit', 'release']);
});

test('rejects malformed input and mismatched login/link identity shapes before database acquisition', async () => {
    const invalidAttempts: ProviderAttempt[] = [
        { ...loginAttempt, stateHash: Buffer.alloc(31) }, { ...loginAttempt, bindingHash: Buffer.alloc(33) },
        { ...loginAttempt, clientKey: '' }, { ...loginAttempt, clientKey: 'google-web ' },
        { ...loginAttempt, clientKey: 'a'.repeat(65) }, { ...loginAttempt, clientKey: 'non-ascii-ç' },
        { ...loginAttempt, action: 'Login' as 'login' }, { ...loginAttempt, nonce: 'x'.repeat(42) },
        { ...loginAttempt, nonce: 'a'.repeat(43) }, { ...loginAttempt, accountId },
        { ...loginAttempt, userId: 7 }, { ...linkAttempt, userId: null },
        { ...linkAttempt, accountId: null }, { ...linkAttempt, userId: 0 },
        { ...linkAttempt, userId: 2_147_483_648 }, { ...linkAttempt, accountId: 'invalid-uuid' },
    ];
    for (const attempt of invalidAttempts) {
        const f = fixture();
        await assert.rejects(createProviderAttempt(f.database, attempt), TypeError);
        assert.deepEqual(f.events, []);
    }
    const invalidConsume = fixture();
    await assert.rejects(consume(invalidConsume.database, { ...loginAttempt, stateHash: Buffer.alloc(0) }), TypeError);
    assert.deepEqual(invalidConsume.events, []);
});

test('invalid stored rows and unexpected write counts cannot authorize a callback', async () => {
    for (const row of [
        { ...storedLogin, nonce: 'invalid' }, { ...storedLogin, userId: 7 }, { ...storedLogin, accountId },
    ]) {
        const f = fixture({ row });
        await assert.rejects(consume(f.database), sanitized);
        assert.deepEqual(f.events, ['acquire', 'begin', 'select', 'rollback', 'release']);
    }
    const malformedLink = fixture({ row: { nonce: loginAttempt.nonce, accountId: null, userId: 7 } });
    await assert.rejects(consume(malformedLink.database, linkAttempt), sanitized);
    const unexpectedDelete = fixture({ affectedRows: 2 });
    await assert.rejects(consume(unexpectedDelete.database), sanitized);
    assert(unexpectedDelete.events.includes('rollback'));
    const unexpectedInsert = fixture({ affectedRows: 0 });
    await assert.rejects(createProviderAttempt(unexpectedInsert.database, loginAttempt), sanitized);
    assert(unexpectedInsert.events.includes('rollback'));
});

test('uncertain transactions, lock failures and driver errors never escape or return a successful attempt', async () => {
    for (const fail of ['acquire', 'lock', 'begin', 'cleanup', 'replace', 'count', 'insert', 'commit', 'unlock', 'release']) {
        const f = fixture({ fail });
        await assert.rejects(createProviderAttempt(f.database, loginAttempt), sanitized);
        if (['lock', 'begin', 'commit', 'unlock'].includes(fail)) {
            assert(f.events.includes('destroy'));
            assert(!f.events.includes('release'));
        }
        if (['cleanup', 'replace', 'count', 'insert'].includes(fail)) assert(f.events.includes('rollback'));
    }
    for (const fail of ['begin', 'select', 'consume', 'expire', 'commit']) {
        const f = fixture({ fail, live: fail === 'expire' ? false : true });
        await assert.rejects(consume(f.database), sanitized);
        if (fail === 'begin' || fail === 'commit') assert(f.events.includes('destroy'));
        else assert(f.events.includes('rollback'));
    }
    const rollback = fixture({ fail: 'consume', rollbackFails: true });
    await assert.rejects(consume(rollback.database), sanitized);
    assert.deepEqual(rollback.events.slice(-2), ['rollback', 'destroy']);
});

test('invalid lock and capacity responses fail closed and discard uncertain named-lock sessions', async () => {
    for (const acquire of [null, 2, '1']) {
        const f = fixture({ acquire });
        await assert.rejects(createProviderAttempt(f.database, loginAttempt), sanitized);
        assert.deepEqual(f.events, ['acquire', 'lock', 'destroy']);
    }
    for (const count of [-1, 10_001, '0', 1.5]) {
        const f = fixture({ count });
        await assert.rejects(createProviderAttempt(f.database, loginAttempt), sanitized);
        assert(f.events.includes('rollback'));
    }
    const unlock = fixture({ unlock: 0 });
    await assert.rejects(createProviderAttempt(unlock.database, loginAttempt), sanitized);
    assert.deepEqual(unlock.events.slice(-3), ['commit', 'unlock', 'destroy']);
});

test('copies mutable hash inputs before asynchronous database acquisition', async () => {
    const f = fixture();
    const attempt = { ...loginAttempt, stateHash: Buffer.alloc(32, 4), bindingHash: Buffer.alloc(32, 5) };
    const original = [Buffer.from(attempt.stateHash), Buffer.from(attempt.bindingHash)];
    const creating = createProviderAttempt(f.database, attempt);
    attempt.stateHash.fill(8);
    attempt.bindingHash.fill(9);
    assert.equal(await creating, 'created');
    assert.deepEqual(f.queries.find(query => query.sql.startsWith('INSERT'))!.values!.slice(0, 2), original);
});
