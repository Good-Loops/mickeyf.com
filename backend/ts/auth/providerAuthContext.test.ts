import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { issueSessionToken } from '../security/sessionPolicy';
import { authenticateRequest, verifyRequestToken } from '../security/requestAuthentication';
import { NATIVE_SESSION_COOKIE, WEB_SESSION_COOKIE } from '../security/sessionCookie';
import type { Pool } from 'mysql2/promise';
import { createProviderAuthContextReader, type ProviderAuthContext } from './providerAuthContext';

const secret = 'synthetic-context-test-only';
const accountId = '11111111-2222-4333-8444-555555555555';
const otherAccountId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const origin = 'https://example.test';
const nativeOrigin = 'capacitor://localhost';
const row = { userId: 7, userName: 'context-fixture', accountId };
const issued = issueSessionToken(row, secret);
const session = issued.token;
const bindingLifetime = 5 * 60 * 1000;
const bindingValue = (issuedAt = Date.now(), byte = 1) =>
    ['provider', 'v1', issuedAt, Buffer.alloc(32, byte).toString('base64url')].join(':');

function request(token?: unknown, requestOrigin = origin) {
    const name = requestOrigin === nativeOrigin ? NATIVE_SESSION_COOKIE : WEB_SESSION_COOKIE;
    return {
        method: 'POST', headers: { origin: requestOrigin, 'content-type': 'application/json' },
        signedCookies: (token === undefined ? {} : { [name]: token }) as Record<string, unknown>,
        cookies: {} as Record<string, unknown>,
    };
}

function fixture(rows: unknown = [{ userName: row.userName }], fail = false) {
    const calls: unknown[][] = [];
    const database = { async query(...args: unknown[]) {
        calls.push(args);
        if (fail) throw new Error('private database details');
        return [rows, []];
    } } as unknown as Pick<Pool, 'query'>;
    return { calls, read: createProviderAuthContextReader({ database, sessionSecret: secret,
        allowedOrigins: [origin, nativeOrigin] }) };
}

test('only the server context reader can brand trusted context', () => {
    const plain = { bindingHash: Buffer.alloc(32), account: null, session: null,
        bindingExpiresAt: null, anonymousCookie: null };
    // @ts-expect-error Request data cannot claim the private context brand.
    const context: ProviderAuthContext = plain;
    assert.equal(context, plain);
});

test('begin creates or refreshes the origin-selected canonical cookie and complete verifies its roundtrip', async t => {
    const now = Date.now();
    t.mock.method(Date, 'now', () => now);
    const { read, calls } = fixture();
    for (const requestOrigin of [origin, nativeOrigin]) {
        assert.equal(await read(request(undefined, requestOrigin)), null, 'completion never bootstraps a cookie');
        const started = await read(request(undefined, requestOrigin), 'begin');
        assert.ok(started?.anonymousCookie);
        assert.equal(started.account, null);
        assert.equal(started.session, null);
        assert.equal(started.bindingHash.length, 32);
        assert.equal(started.bindingExpiresAt, now + bindingLifetime);
        assert.equal(started.anonymousCookie.name, requestOrigin === origin ? WEB_SESSION_COOKIE : NATIVE_SESSION_COOKIE);
        assert.equal(started.anonymousCookie.maxAge, bindingLifetime);
        assert.match(started.anonymousCookie.value, /^provider:v1:\d{13}:[A-Za-z0-9_-]{43}$/);
        assert.equal(Object.isFrozen(started), true);
        assert.equal(Object.isFrozen(started.anonymousCookie), true);
        assert.deepEqual(Object.keys(started).sort(), ['account', 'anonymousCookie', 'bindingExpiresAt', 'bindingHash', 'session']);
        const roundtrip = request(started.anonymousCookie.value, requestOrigin);
        const completed = await read(roundtrip);
        assert.ok(completed);
        assert.deepEqual(completed.bindingHash, started.bindingHash);
        assert.equal(completed.bindingExpiresAt, started.bindingExpiresAt);
        assert.equal(completed.anonymousCookie, null);
        const refreshed = await read(roundtrip, 'begin');
        assert.ok(refreshed?.anonymousCookie);
        assert.notEqual(refreshed.anonymousCookie.value, started.anonymousCookie.value);
        assert.notDeepEqual(refreshed.bindingHash, started.bindingHash);
    }
    assert.deepEqual(calls, []);
});

test('all context modes require approved Origin, JSON POST and unambiguous signed canonical cookies', async () => {
    const { read, calls } = fixture();
    const value = bindingValue();
    for (const change of [
        { method: 'GET' }, { headers: { 'content-type': 'application/json' } },
        { headers: { origin: 'null', 'content-type': 'application/json' } },
        { headers: { origin: origin + '.attacker.test', 'content-type': 'application/json' } },
        { headers: { origin, 'content-type': 'text/plain' } },
        { headers: { origin, 'content-type': 'application/json', authorization: 'Bearer any' } },
        { signedCookies: { [WEB_SESSION_COOKIE]: false } },
        { signedCookies: { [NATIVE_SESSION_COOKIE]: value } },
        { signedCookies: { [WEB_SESSION_COOKIE]: value, [NATIVE_SESSION_COOKIE]: value } },
        { signedCookies: { [WEB_SESSION_COOKIE]: value, [NATIVE_SESSION_COOKIE]: false } },
        { cookies: { [WEB_SESSION_COOKIE]: value } },
        { cookies: { [NATIVE_SESSION_COOKIE]: value } },
    ]) {
        for (const mode of ['begin', 'complete'] as const) {
            assert.equal(await read({ ...request(value), ...change }, mode), null);
        }
    }
    for (const mode of ['begin', 'complete'] as const) {
        assert.equal(await read({ ...request(undefined, nativeOrigin), signedCookies: { [WEB_SESSION_COOKIE]: value } }, mode), null);
    }
    assert.equal(await read({ ...request(), signedCookies: { provider_auth_binding: value } }), null);
    assert.deepEqual(calls, []);
});

test('signed anonymous expiry is checked by server time and only begin can replace an expired binding', async t => {
    const now = Date.now();
    t.mock.method(Date, 'now', () => now);
    const { read, calls } = fixture();
    assert.ok(await read(request(bindingValue(now - bindingLifetime + 1))));
    for (const issuedAt of [now - bindingLifetime, now - bindingLifetime - 1]) {
        assert.equal(await read(request(bindingValue(issuedAt))), null);
        const refreshed = await read(request(bindingValue(issuedAt)), 'begin');
        assert.ok(refreshed?.anonymousCookie);
        assert.equal(refreshed.bindingExpiresAt, now + bindingLifetime);
    }
    for (const value of [bindingValue(now + 1), 'provider:v1:not-a-time:' + Buffer.alloc(32).toString('base64url'),
        'provider:v1:' + now + ':short', 'provider:v1:' + now + ':' + 'a'.repeat(43),
        bindingValue(now) + ':extra', 'provider:v1:', 'provider:v2:invalid']) {
        for (const mode of ['begin', 'complete'] as const) assert.equal(await read(request(value), mode), null);
    }
    assert.deepEqual(calls, []);
});

test('anonymous canonical cookies cannot authenticate as account sessions', async () => {
    const { read, calls } = fixture();
    for (const requestOrigin of [origin, nativeOrigin]) {
        const started = await read(request(undefined, requestOrigin), 'begin');
        assert.ok(started?.anonymousCookie);
        const req = request(started.anonymousCookie.value, requestOrigin);
        assert.deepEqual(authenticateRequest(req, secret), { authenticated: false, reason: 'INVALID_CREDENTIALS' });
        assert.deepEqual(verifyRequestToken(started.anonymousCookie.value, secret), { authenticated: false, reason: 'INVALID_CREDENTIALS' });
        assert.equal((await read(req))?.account, null);
    }
    assert.deepEqual(calls, []);
});

test('signed account sessions retain their cookie and expose only verified UUID and device proof', async () => {
    for (const requestOrigin of [origin, nativeOrigin]) {
        const { read, calls } = fixture();
        const req = request(session, requestOrigin);
        const context = await read({ ...req, ...{ body: { userId: 999, accountId: otherAccountId, sessionId: 'submitted' } } });
        assert.ok(context);
        assert.deepEqual(context.account, { userId: row.userId, accountId });
        assert.deepEqual(context.session, { accountId, sessionId: issued.sessionId });
        assert.equal(context.bindingExpiresAt, null);
        assert.equal(context.anonymousCookie, null);
        assert.equal(Object.isFrozen(context.account), true);
        assert.equal(Object.isFrozen(context.session), true);
        const hash = createHash('sha256').update(issued.sessionId).digest();
        assert.deepEqual(calls[0][1], [row.userId, accountId, hash, hash]);
        assert.equal((calls[0][0] as { timeout: number }).timeout, 10_000);
        const started = await read(req, 'begin');
        assert.deepEqual(started?.bindingHash, context.bindingHash);
        assert.equal(started?.anonymousCookie, null);
    }
});

test('malformed, expired and wrong-secret sessions cannot downgrade to anonymous in either mode', async () => {
    const { read, calls } = fixture();
    for (const token of [false, '', 'a'.repeat(8193), 'not-a-token',
        issueSessionToken(row, 'different-secret').token,
        issueSessionToken(row, secret, false, Date.now() - 5 * 60 * 60 * 1000).token,
    ]) {
        for (const mode of ['begin', 'complete'] as const) assert.equal(await read(request(token), mode), null);
    }
    assert.deepEqual(calls, []);
});

test('revoked, expired or renamed live-session rows reject context and storage failures stay sanitized', async () => {
    const req = request(session);
    for (const rows of [[], [{ userName: 'renamed' }]]) {
        for (const mode of ['begin', 'complete'] as const) assert.equal(await fixture(rows).read(req, mode), null);
    }
    for (const rows of [null, [row, row], [{ userName: 999 }], [{ userName: '' }]]) {
        await assert.rejects(fixture(rows).read(req), { message: 'The provider account operation could not be confirmed.' });
    }
    await assert.rejects(fixture([row], true).read(req), { message: 'The provider account operation could not be confirmed.' });
});

test('login and logout replace the canonical binding so a new anonymous flow cannot reuse the old hash', async () => {
    const { read } = fixture();
    const anonymous = await read(request(), 'begin');
    assert.ok(anonymous?.anonymousCookie);
    assert.deepEqual((await read(request(anonymous.anonymousCookie.value)))?.bindingHash, anonymous.bindingHash);
    const authenticated = await read(request(session));
    assert.ok(authenticated);
    assert.notDeepEqual(authenticated.bindingHash, anonymous.bindingHash);
    assert.equal(await read(request()), null, 'logout cleared the canonical cookie');
    const afterLogout = await read(request(), 'begin');
    assert.ok(afterLogout?.anonymousCookie);
    assert.notDeepEqual(afterLogout.bindingHash, anonymous.bindingHash);
    assert.notDeepEqual(afterLogout.bindingHash, authenticated.bindingHash);
    const anotherDevice = await read(request(issueSessionToken(row, secret).token));
    assert.notDeepEqual(anotherDevice?.bindingHash, authenticated.bindingHash);
    const otherOrigin = await read(request(anonymous.anonymousCookie.value, nativeOrigin));
    assert.notDeepEqual(otherOrigin?.bindingHash, anonymous.bindingHash);
    const otherIdentity = await read(request(issueSessionToken({ ...row, accountId: otherAccountId }, secret).token));
    assert.notDeepEqual(otherIdentity?.bindingHash, authenticated.bindingHash);
});

test('missing signing configuration is rejected before reading any requests', () => {
    assert.throws(() => createProviderAuthContextReader({ database: {} as Pool,
        sessionSecret: '', allowedOrigins: [origin] }), /session configuration/);
});
