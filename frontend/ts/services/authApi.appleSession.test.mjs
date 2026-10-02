import assert from 'node:assert/strict';
import test from 'node:test';
import { createAuthApi } from './authApi.ts';

const apiBase = 'https://api.example.test';
const loggedIn = { loggedIn: true, user_name: 'New Player' };
const credentials = { user_name: 'New Player', user_password: 'synthetic password' };
const challenge = { state: Buffer.alloc(32, 3).toString('base64url'),
    nonce: Buffer.alloc(32, 4).toString('base64url'), expiresInSeconds: 300 };
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
    let resolve;
    const promise = new Promise(complete => { resolve = complete; });
    return { promise, resolve };
}

for (const method of ['verifyRequest', 'renewRequest']) {
    test(`${method} sends only the current-device logout after confirmed Apple revocation`, async () => {
        const calls = [];
        const api = createAuthApi(apiBase, async (url, init) => {
            calls.push({ url, init });
            return Response.json({ loggedOut: true });
        }, async () => 'revoked');
        assert.deepEqual(await api[method](), { loggedIn: false });
        assert.deepEqual(calls, [{ url: `${apiBase}/auth/logout`, init: { method: 'POST', credentials: 'include' } }]);
    });

    test(`${method} does not issue requests for a missing native session or an unavailable credential check`, async () => {
        const noRequests = async () => assert.fail('session check must stop the request');
        assert.deepEqual(await createAuthApi(apiBase, noRequests, async () => 'signedOut')[method](), { loggedIn: false });
        const failure = new Error('Could not check Apple authorization.');
        await assert.rejects(createAuthApi(apiBase, noRequests, async () => { throw failure; })[method](), failure);
    });
}

test('unconfirmed revocation keeps UI signed out and retries only logout despite a subsequent native-query outage', async () => {
    const calls = [];
    let checks = 0;
    const api = createAuthApi(apiBase, async (url, init) => {
        calls.push({ url, init });
        assert.equal(url, `${apiBase}/auth/logout`);
        return calls.length === 1 ? new Response(null, { status: 503 }) : Response.json({ loggedOut: true });
    }, async () => {
        if (++checks > 1) throw new Error('native query offline');
        return 'revoked';
    });
    assert.deepEqual(await api.verifyRequest(), { loggedIn: false, revocationPending: true });
    assert.deepEqual(await api.renewRequest(), { loggedIn: false });
    assert.equal(checks, 1, 'known revocation is not reinterpreted as an unknown native state');
    assert.equal(calls.length, 2);
    await assert.rejects(api.verifyRequest(), { message: 'native query offline' });
    assert.equal(calls.length, 2, 'successful logout clears the pending retry');
});

test('network and malformed logout responses never claim confirmed server revocation', async () => {
    for (const response of [
        async () => { throw new Error('offline'); },
        async () => Response.json({ loggedOut: false }),
        async () => Response.json({ loggedOut: true, unexpected: true }),
        async () => new Response('not-json'),
    ]) {
        const api = createAuthApi(apiBase, response, async () => 'revoked');
        assert.deepEqual(await api.renewRequest(), { loggedIn: false, revocationPending: true });
    }
});

for (const replacement of ['password', 'google']) {
    test(`${replacement} session replacement does not inherit another session's pending Apple logout`, async () => {
        const calls = [];
        let cookie = 'old-apple';
        const api = createAuthApi(apiBase, async (url, init) => {
            const path = new URL(url).pathname;
            calls.push(path);
            assert.equal(init.credentials, 'include');
            if (path === '/auth/logout') return new Response(null, { status: 503 });
            if (path === '/auth/providers/begin') return Response.json(challenge);
            if (path === '/api/users' || path === '/auth/providers/complete') {
                cookie = replacement;
                return Response.json({ success: true, user_name: loggedIn.user_name });
            }
            assert.ok(['/auth/verify-token', '/auth/renew'].includes(path));
            return Response.json(loggedIn);
        }, async () => cookie === 'old-apple' ? 'revoked' : 'unchanged');
        assert.deepEqual(await api.verifyRequest(), { loggedIn: false, revocationPending: true });
        const result = replacement === 'password' ? await api.loginRequest(credentials)
            : await api.runProviderAuthentication({ action: 'login', clientKey: 'google-web' }, async () => 'synthetic.header.signature');
        assert.deepEqual(result, { success: true, user_name: loggedIn.user_name });
        assert.deepEqual(await api.renewRequest(), loggedIn);
        assert.equal(calls.filter(path => path === '/auth/logout').length, 1);
    });
}

for (const rejectedLogin of ['password', 'google']) {
    test(`definitely rejected ${rejectedLogin} login retains the previous session's pending revocation`, async () => {
        let checks = 0, logouts = 0;
        const api = createAuthApi(apiBase, async url => {
            const path = new URL(url).pathname;
            if (path === '/auth/logout') return ++logouts === 1
                ? new Response(null, { status: 503 }) : Response.json({ loggedOut: true });
            if (path === '/auth/providers/begin') return Response.json(challenge);
            if (path === '/auth/providers/complete') return Response.json({ error: 'INVALID_PROVIDER_TOKEN' }, { status: 401 });
            assert.equal(path, '/api/users');
            return Response.json({ error: 'AUTH_FAILED' });
        }, async () => {
            if (++checks > 1) throw new Error('native state is unavailable now');
            return 'revoked';
        });
        assert.deepEqual(await api.verifyRequest(), { loggedIn: false, revocationPending: true });
        const result = rejectedLogin === 'password' ? await api.loginRequest(credentials)
            : await api.runProviderAuthentication({ action: 'login', clientKey: 'google-web' }, async () => 'synthetic.header.signature');
        assert.deepEqual(result, { error: rejectedLogin === 'password' ? 'AUTH_FAILED' : 'INVALID_PROVIDER_TOKEN' });
        assert.deepEqual(await api.renewRequest(), { loggedIn: false });
        assert.equal(checks, 1);
        assert.equal(logouts, 2);
    });
}

test('a revocation check holds the auth queue through logout before a newer password session is issued', async () => {
    const check = deferred(), logout = deferred();
    const events = [];
    let cookie = 'old-apple';
    const api = createAuthApi(apiBase, async url => {
        const path = new URL(url).pathname;
        events.push(path);
        if (path === '/auth/logout') {
            assert.equal(cookie, 'old-apple');
            await logout.promise;
            cookie = null;
            return Response.json({ loggedOut: true });
        }
        if (path === '/api/users') {
            cookie = 'new-password';
            return Response.json({ success: true, user_name: loggedIn.user_name });
        }
        assert.equal(path, '/auth/verify-token');
        assert.equal(cookie, 'new-password');
        return Response.json(loggedIn);
    }, async () => {
        events.push(`check:${cookie}`);
        return cookie === 'old-apple' ? check.promise : 'unchanged';
    });
    const verification = api.verifyRequest();
    await nextTurn();
    const login = api.loginRequest(credentials);
    await nextTurn();
    assert.deepEqual(events, ['check:old-apple']);
    check.resolve('revoked');
    await nextTurn();
    assert.deepEqual(events, ['check:old-apple', '/auth/logout']);
    logout.resolve();
    assert.deepEqual(await verification, { loggedIn: false });
    assert.deepEqual(await login, { success: true, user_name: loggedIn.user_name });
    assert.equal(cookie, 'new-password');
    assert.deepEqual(events, ['check:old-apple', '/auth/logout', '/api/users', 'check:new-password', '/auth/verify-token']);
});

test('renewal and explicit logout cannot overlap a guarded verification', async () => {
    const check = deferred();
    const events = [];
    let checks = 0;
    const api = createAuthApi(apiBase, async url => {
        const path = new URL(url).pathname;
        events.push(path);
        return Response.json(path === '/auth/logout' ? { loggedOut: true } : loggedIn);
    }, async () => ++checks === 1 ? check.promise : 'unchanged');
    const verification = api.verifyRequest();
    const renewal = api.renewRequest();
    const logout = api.logoutRequest();
    await nextTurn();
    assert.deepEqual(events, []);
    check.resolve('unchanged');
    assert.deepEqual(await verification, loggedIn);
    assert.deepEqual(await renewal, loggedIn);
    await logout;
    assert.deepEqual(events, ['/auth/verify-token', '/auth/renew', '/auth/logout']);
});
