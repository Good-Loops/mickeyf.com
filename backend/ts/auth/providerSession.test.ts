import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import type { CookieOptions, Response } from 'express';
import jwt from 'jsonwebtoken';
import type { Pool, PoolConnection, QueryOptions } from 'mysql2/promise';
import type { ProviderAccount } from '../accounts/providerAccountRepository';
import { verifyRequestToken } from '../security/requestAuthentication';
import { AccountSessionUnavailableError, readLiveSession } from './accountSessionRepository';
import { establishProviderSession } from './providerSession';

const account: ProviderAccount = { userId: 7, userName: 'provider-player', accountId: randomUUID() };
const sessionSecret = 'unit-test-provider-session-secret-not-a-credential';
const providerToken = 'unit-test-provider-id-token-never-returned';
const appleProof = { clientId: 'com.example.app', subject: 'apple-subject', issuedAt: Math.floor(Date.now() / 1000) - 5 };
type QueryCall = { sql: string; values: unknown[] };
type CookieCall = { name: string; value: string; options: CookieOptions };

function fixture(options: { user?: Record<string, unknown> | null; fail?: string } = {}) {
    const calls: QueryCall[] = [];
    const cookies: CookieCall[] = [];
    const cleared: string[] = [];
    const bodies: unknown[] = [];
    let committed = false;
    let destroyed = false;
    let stored: unknown[] | undefined;
    const connection = {
        async query(query: QueryOptions, values: unknown[] = []) {
            assert.equal(query.timeout, 10_000);
            const sql = query.sql;
            calls.push({ sql, values });
            if (options.fail && sql.includes(options.fail)) throw new Error('private database credentials');
            if (sql.includes('GET_LOCK') || sql.includes('RELEASE_LOCK')) return [[{ lockResult: 1 }], []];
            if (sql === 'COMMIT') committed = true;
            if (sql.startsWith('SELECT account_uuid')) return [options.user === null ? []
                : [options.user ?? { accountId: account.accountId, passwordHash: null }], []];
            if (sql.startsWith('SELECT session_hash')) return [[], []];
            if (sql.startsWith('SELECT subject FROM account_provider_identities')) return [[{ subject: Buffer.from(appleProof.subject) }], []];
            if (sql.startsWith('SELECT revoked_at')) return [[], []];
            if (sql.startsWith('SELECT TIMESTAMPDIFF')) return [[{ now: Math.floor(Date.now() / 1000) }], []];
            if (sql.startsWith('INSERT INTO account_sessions')) stored = values;
            if (sql.startsWith('SELECT u.user_name')) {
                const live = committed && stored && values[0] === account.userId
                    && values[1] === stored[1] && Buffer.isBuffer(values[2])
                    && values[2].equals(stored[0] as Buffer);
                return [live ? [{ userName: account.userName }] : [], []];
            }
            return [{ affectedRows: 1 }, []];
        },
        release() {},
        destroy() { destroyed = true; },
    } as unknown as PoolConnection;
    const database = { getConnection: async () => {
        if (options.fail === 'getConnection') throw new Error('private database credentials');
        return connection;
    } } as Pick<Pool, 'getConnection'>;
    const response = {
        cookie(name: string, value: string, cookieOptions: CookieOptions) {
            assert.equal(committed, true, 'authentication cookie requires a confirmed commit');
            cookies.push({ name, value, options: cookieOptions });
            return this;
        },
        clearCookie(name: string) { cleared.push(name); return this; },
        json(body: unknown) { bodies.push(body); return this; },
    } as unknown as Response;
    return { database, connection, response, calls, cookies, cleared, bodies, destroyed: () => destroyed };
}

for (const rememberMe of [false, true]) {
    test(`provider login persists a ${rememberMe ? 'remembered thirty-day' : 'default four-hour'} usable account session`, async () => {
        const f = fixture();
        const result = await establishProviderSession(f.database, {
            headers: { origin: 'https://mickeyf.com', authorization: `Bearer ${providerToken}` },
        }, f.response, account, rememberMe, sessionSecret, true);

        assert.equal(result, true);
        assert.equal(f.cookies.length, 1);
        const cookie = f.cookies[0];
        const authentication = verifyRequestToken(cookie.value, sessionSecret);
        assert.equal(authentication.authenticated, true);
        if (!authentication.authenticated) throw new Error('Expected a valid application session');
        assert.deepEqual(authentication.identity, { ...account, sessionId: authentication.identity.sessionId });
        const payload = jwt.decode(cookie.value);
        assert(payload && typeof payload === 'object');
        const lifetime = rememberMe ? 30 * 24 * 60 * 60 : 4 * 60 * 60;
        assert.equal(payload.exp! - payload.iat!, lifetime);
        assert.equal(cookie.options.maxAge, lifetime * 1000);
        const insert = f.calls.find(call => call.sql.startsWith('INSERT INTO account_sessions'));
        assert(insert);
        assert.deepEqual(insert.values, [
            createHash('sha256').update(authentication.identity.sessionId, 'ascii').digest(),
            account.accountId, payload.exp, rememberMe ? 1 : 0, payload.exp, payload.exp,
        ]);
        assert.deepEqual(await readLiveSession(f.connection, account.userId, account.accountId,
            authentication.identity.sessionId), { userName: account.userName });
        assert.deepEqual(f.bodies, []);
        assert.deepEqual(Object.keys(payload).sort(),
            ['account_uuid', 'exp', 'iat', 'jti', 'purpose', 'user_id', 'user_name', 'version']);
        assert.notEqual(cookie.value, providerToken);
        assert.equal(f.calls.flatMap(call => call.values).includes(providerToken), false);
    });
}

test('production provider sessions use signed HttpOnly web or native cookies and clear prior authentication', async () => {
    for (const [origin, name, sameSite] of [
        ['https://mickeyf.com', '__session', 'lax'],
        ['capacitor://localhost', 'session', 'none'],
    ] as const) {
        const f = fixture();
        await establishProviderSession(f.database, { headers: { origin } }, f.response,
            account, false, sessionSecret, true);
        assert.equal(f.cookies[0].name, name);
        assert.deepEqual(f.cookies[0].options, { httpOnly: true, secure: true, sameSite,
            signed: true, priority: 'high', path: '/', maxAge: 4 * 60 * 60 * 1000 });
        assert.deepEqual(f.cleared, ['__session', 'session']);
    }
});

test('Apple session provenance comes from the verified flow, not incoming session headers or account fields', async () => {
    for (const method of [undefined, 'apple'] as const) {
        const f = fixture();
        await establishProviderSession(f.database, { headers: { origin: 'capacitor://localhost',
            authenticationMethod: 'apple', authorization: 'Bearer previous-apple-session' } }, f.response,
        { ...account, authenticationMethod: 'apple' } as ProviderAccount, true, sessionSecret, true, method,
        method === 'apple' ? appleProof : undefined);
        const authentication = verifyRequestToken(f.cookies[0].value, sessionSecret);
        assert.ok(authentication.authenticated);
        assert.equal(authentication.identity.authenticationMethod, method);
    }
});

test('Apple provenance cannot issue a session without original proof or attach to a non-Apple login', async () => {
    for (const [method, proof] of [['apple', undefined], [undefined, appleProof]] as const) {
        const f = fixture();
        await assert.rejects(establishProviderSession(f.database, { headers: {} }, f.response,
            account, false, sessionSecret, true, method, proof), /verified original authentication proof/);
        assert.equal(f.calls.length, 0);
        assert.equal(f.cookies.length, 0);
    }
});

test('Apple proof is checked inside the locked transaction and stored independently of renewable token timestamps', async () => {
    const f = fixture();
    assert.equal(await establishProviderSession(f.database, { headers: {} }, f.response,
        account, true, sessionSecret, true, 'apple', appleProof), true);
    const sql = f.calls.map(call => call.sql);
    const proofRead = sql.findIndex(value => value.startsWith('SELECT subject FROM account_provider_identities'));
    const inserted = f.calls.find(call => call.sql.startsWith('INSERT INTO account_sessions'))!;
    assert.ok(proofRead > sql.indexOf('START TRANSACTION'));
    assert.match(inserted.sql, /apple_subject_hash, apple_authenticated_at/);
    assert.equal((inserted.values[4] as Buffer).length, 32);
    assert.equal(inserted.values[5], appleProof.issuedAt);
    const stale = fixture();
    assert.equal(await establishProviderSession(stale.database, { headers: {} }, stale.response,
        account, true, sessionSecret, true, 'apple', { ...appleProof, issuedAt: appleProof.issuedAt - 300 }), false);
    assert.deepEqual(stale.cookies, []);
});

test('missing account UUIDs and removed or replaced accounts cannot issue provider session cookies', async () => {
    const invalid = fixture();
    await assert.rejects(establishProviderSession(invalid.database, { headers: {} }, invalid.response,
        { userId: account.userId, userName: account.userName } as ProviderAccount,
        false, sessionSecret, true), TypeError);
    assert.deepEqual(invalid.calls, []);
    assert.deepEqual(invalid.cookies, []);
    assert.deepEqual(invalid.cleared, []);
    for (const user of [null, { accountId: randomUUID(), passwordHash: null }]) {
        const f = fixture({ user });
        assert.equal(await establishProviderSession(f.database, { headers: {} }, f.response,
            account, false, sessionSecret, true), false);
        assert.deepEqual(f.cookies, []);
        assert.deepEqual(f.cleared, []);
        assert.equal(f.calls.some(call => call.sql.startsWith('INSERT')), false);
    }
});

test('database failures and uncertain commits expose no usable cookie or private driver details', async () => {
    for (const fail of ['getConnection', 'SELECT account_uuid', 'INSERT INTO account_sessions', 'COMMIT']) {
        const f = fixture({ fail });
        await assert.rejects(establishProviderSession(f.database, { headers: {} }, f.response,
            account, true, sessionSecret, true), error => {
            assert(error instanceof AccountSessionUnavailableError);
            assert.equal('cause' in error, false);
            assert.doesNotMatch(error.message, /private|credentials/u);
            return true;
        });
        assert.deepEqual(f.cookies, []);
        assert.deepEqual(f.cleared, []);
        assert.deepEqual(f.bodies, []);
        assert.equal(f.destroyed(), fail === 'COMMIT');
        if (fail === 'INSERT INTO account_sessions') assert(f.calls.some(call => call.sql === 'ROLLBACK'));
    }
});
