import assert from 'node:assert/strict';
import test from 'node:test';
import jwt from 'jsonwebtoken';
import { createHash } from 'node:crypto';
import { issueSessionToken } from '../security/sessionPolicy';
import type { Pool } from 'mysql2/promise';
import { createProviderAuthContextReader, PROVIDER_BINDING_COOKIE, type ProviderAuthContext } from './providerAuthContext';

const secret = 'synthetic-context-test-only';
const accountId = '11111111-2222-4333-8444-555555555555';
const otherAccountId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const origin = 'https://example.test';
const row = { userId: 7, userName: 'context-fixture', accountId };
const issued = issueSessionToken(row, secret);
const session = issued.token;

function request() {
    return {
        method: 'POST', headers: { origin, 'content-type': 'application/json' },
        signedCookies: { [PROVIDER_BINDING_COOKIE]: 'a'.repeat(43) } as Record<string, unknown>,
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
        allowedOrigins: [origin, 'capacitor://localhost'] }) };
}

test('only the server context reader can brand trusted context', () => {
    // @ts-expect-error Request data cannot claim the private context brand.
    const context: ProviderAuthContext = { bindingHash: Buffer.alloc(32), account: null };
    assert.equal(context.account, null);
});

test('anonymous context requires an explicit allowed Origin, JSON POST and a verified binding cookie', async () => {
    const { read, calls } = fixture();
    const valid = await read(request());
    assert.ok(valid);
    assert.equal(valid.account, null);
    assert.equal(valid.bindingHash.length, 32);
    assert.equal(Object.isFrozen(valid), true);
    assert.deepEqual(Object.keys(valid).sort(), ['account', 'bindingHash']);
    for (const change of [
        { method: 'GET' }, { headers: { 'content-type': 'application/json' } },
        { headers: { origin: 'null', 'content-type': 'application/json' } },
        { headers: { origin: `${origin}.attacker.test`, 'content-type': 'application/json' } },
        { headers: { origin, 'content-type': 'text/plain' } },
        { headers: { origin, 'content-type': 'application/json', authorization: 'Bearer any' } },
        { signedCookies: {} }, { signedCookies: { [PROVIDER_BINDING_COOKIE]: false } },
        { signedCookies: { [PROVIDER_BINDING_COOKIE]: 'malformed' } },
        { cookies: { session: 'unsigned-session' } },
    ]) assert.equal(await read({ ...request(), ...change }), null);
    assert.deepEqual(calls, []);
});

test('valid signed session verifies its UUID and device identifier in storage, not caller-supplied metadata', async () => {
    const { read, calls } = fixture();
    const req = request();
    req.signedCookies.session = session;
    const context = await read({ ...req, ...{ body: { userId: 999, accountId: otherAccountId } } });
    assert.ok(context);
    assert.deepEqual(context.account, { userId: row.userId, accountId });
    assert.equal(Object.isFrozen(context.account), true);
    assert.deepEqual(calls[0][1], [row.userId, accountId, createHash('sha256').update(issued.sessionId).digest()]);
    assert.equal((calls[0][0] as { timeout: number }).timeout, 10_000);
});

test('malformed, expired or wrong-secret sessions cannot downgrade to anonymous', async () => {
    const { read, calls } = fixture();
    for (const token of [false, '', 'a'.repeat(8193), 'not-a-token',
        jwt.sign({ user_id: 7, user_name: row.userName }, 'different-secret'),
        jwt.sign({ user_id: 7, user_name: row.userName }, secret, { expiresIn: -1 }),
    ]) {
        const req = request();
        req.signedCookies.session = token;
        assert.equal(await read(req), null);
    }
    assert.deepEqual(calls, []);
});

test('unknown/renamed accounts fail authentication; corrupt metadata and storage errors fail closed', async () => {
    const req = request();
    req.signedCookies.session = session;
    for (const rows of [[], [{ ...row, userName: 'renamed' }]]) {
        assert.equal(await fixture(rows).read(req), null);
    }
    for (const rows of [null, [row, row], [{ userName: 999 }], [{ userName: '' }]]) {
        await assert.rejects(fixture(rows).read(req), { message: 'The provider account operation could not be confirmed.' });
    }
    await assert.rejects(fixture([row], true).read(req), { message: 'The provider account operation could not be confirmed.' });
});

test('binding changes with the current origin, cookie, session or immutable account identity', async () => {
    const { read } = fixture();
    const anonymous = await read(request());
    assert.ok(anonymous);
    assert.deepEqual((await read(request()))?.bindingHash, anonymous.bindingHash);
    const otherOrigin = request();
    otherOrigin.headers.origin = 'capacitor://localhost';
    const otherCookie = request();
    otherCookie.signedCookies[PROVIDER_BINDING_COOKIE] = 'b'.repeat(43);
    const authenticated = request();
    authenticated.signedCookies.session = session;
    for (const req of [otherOrigin, otherCookie, authenticated]) {
        assert.notDeepEqual((await read(req))?.bindingHash, anonymous.bindingHash);
    }
    const anotherDevice = request();
    anotherDevice.signedCookies.session = issueSessionToken(row, secret).token;
    assert.notDeepEqual((await read(authenticated))?.bindingHash, (await read(anotherDevice))?.bindingHash);
    assert.equal(await fixture([]).read(authenticated), null, 'revoked or UUID-mismatched session fails closed');
});

test('missing signing configuration is rejected before reading any requests', () => {
    assert.throws(() => createProviderAuthContextReader({ database: {} as Pool,
        sessionSecret: '', allowedOrigins: [origin] }), /session configuration/);
});
