import assert from 'node:assert/strict';
import test from 'node:test';
import { createAuthApi } from './authApi.ts';

const apiBase = 'https://api.example.test';
const challenge = { state: Buffer.alloc(32, 3).toString('base64url'),
    nonce: Buffer.alloc(32, 4).toString('base64url'), expiresInSeconds: 300 };
const idToken = 'synthetic.header.signature';
const signup = { action: 'signup', clientKey: 'google-web', userName: 'New Player' };
const deletion = { action: 'delete', clientKey: 'google-web', confirmation: 'DELETE' };
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

function fixture({ completion = { success: true, user_name: 'New Player' },
    session = { loggedIn: true, user_name: 'New Player' }, status = 200 } = {}) {
    const calls = [];
    const api = createAuthApi(apiBase, async (url, init) => {
        calls.push({ url, init, body: init.body === undefined ? undefined : JSON.parse(init.body) });
        assert.equal(init.credentials, 'include');
        if (url.endsWith('/begin')) return Response.json(challenge);
        if (url.endsWith('/complete')) return Response.json(completion, { status });
        if (url.endsWith('/verify-token')) return Response.json(session);
        assert.fail('Unexpected provider signup/deletion request');
    });
    return { api, calls };
}

for (const clientKey of ['google-web', 'apple-ios']) {
test(`prepared ${clientKey} signup binds its action and challenge before choosing a username and stay-signed-in option`, async () => {
    for (const [rememberMe, expected] of [[undefined, false], [false, false], [true, true]]) {
        const { api, calls } = fixture();
        const prepared = await api.prepareProviderLogin(clientKey, {}, 'signup');
        assert.deepEqual(calls[0].body, { action: 'signup', clientKey });
        assert.equal(Object.isFrozen(prepared.handle), true);
        assert.deepEqual(Object.keys(prepared.handle), []);
        prepared.challenge = { ...challenge, state: 'caller-state', nonce: 'caller-nonce' };
        const options = { userName: '  New Player  ', rememberMe };
        const completion = api.completeProviderLogin(prepared.handle, idToken, options);
        options.userName = 'Changed after submit'; options.rememberMe = !expected;
        assert.deepEqual(await completion, { success: true, user_name: 'New Player' });
        assert.deepEqual(calls[1].body, { action: 'signup', clientKey,
            state: challenge.state, idToken, userName: 'New Player', rememberMe: expected });
        assert.equal(calls[1].init.method, 'POST');
        assert.deepEqual(calls[1].init.headers, { 'Content-Type': 'application/json' });
        assert.equal(calls[2].url, `${apiBase}/auth/verify-token`);
        assert.equal(calls[2].init.method, 'GET');
        assert.equal(calls[2].body, undefined);
    }
});
}

test('signup validates username and rejects caller-provided email, password, account proof or an unsupported client before I/O', async () => {
    const api = createAuthApi(apiBase, async () => assert.fail('invalid signup must not send a request'));
    const acquire = async () => assert.fail('invalid signup must not open a provider');
    const invalid = [
        ...[undefined, null, '', '   ', 'x'.repeat(65), 'bad\u0000name', 'bad\nname', 4].map(userName => ({ ...signup, userName })),
        ...['apple-web', 'google-native', 'unknown'].map(clientKey => ({ ...signup, clientKey })),
        { ...signup, email: 'caller@example.test' }, { ...signup, password: 'fake-password' },
        { ...signup, accountId: 'caller-account' }, { ...signup, userId: 42 },
        { ...signup, nonce: challenge.nonce }, { ...signup, state: challenge.state },
        { ...signup, confirmation: 'DELETE' }, { ...signup, rememberMe: 'true' },
    ];
    for (const input of invalid) {
        assert.deepEqual(await api.runProviderAuthentication(input, acquire), { error: 'INVALID_REQUEST' });
    }
    for (const clientKey of ['apple-web', 'google-native']) {
        assert.deepEqual(await api.prepareProviderLogin(clientKey, {}, 'signup'), { error: 'INVALID_REQUEST' });
    }
    for (const action of ['delete', 'link', 'SIGNUP', null]) {
        assert.deepEqual(await api.prepareProviderLogin('google-web', {}, action), { error: 'INVALID_REQUEST' });
    }
});

test('prepared signup cannot become login/delete, and a validated completion consumes its handle synchronously once', async () => {
    const { api, calls } = fixture();
    const prepared = await api.prepareProviderLogin('google-web', {}, 'signup');
    for (const options of [{}, { userName: '' }, { userName: 'x'.repeat(65) },
        { userName: 'New Player', action: 'login' }, { userName: 'New Player', confirmation: 'DELETE' },
        { userName: 'New Player', clientKey: 'apple-ios' }, { userName: 'New Player', state: challenge.state }]) {
        assert.deepEqual(await api.completeProviderLogin(prepared.handle, idToken, options), { error: 'INVALID_REQUEST' });
    }
    assert.equal(calls.length, 1);
    const first = api.completeProviderLogin(prepared.handle, idToken, { userName: 'New Player' });
    assert.deepEqual(await api.completeProviderLogin(prepared.handle, idToken, { userName: 'Different Player' }),
        { error: 'INVALID_ATTEMPT' });
    assert.deepEqual(await first, { success: true, user_name: 'New Player' });
    assert.equal(calls.filter(({ url }) => url.endsWith('/complete')).length, 1);
    const login = await api.prepareProviderLogin('google-web');
    assert.deepEqual(await api.completeProviderLogin(login.handle, idToken, { userName: 'New Player' }),
        { error: 'INVALID_REQUEST' }, 'login does not silently become signup');
});

for (const clientKey of ['google-web', 'apple-ios']) {
test(`direct ${clientKey} signup sends no password or email and needs exact matching cookie-session proof`, async () => {
    const signup = { action: 'signup', clientKey, userName: 'New Player' };
    const sessions = [null, {}, [], { loggedIn: false }, { loggedIn: true },
        { loggedIn: true, user_name: 'Other Player' },
        { loggedIn: true, user_name: 'New Player', token: 'private-token' },
        { loggedIn: true, user_name: 'New Player', accountId: 'caller-account' }];
    for (const session of sessions) {
        const { api, calls } = fixture({ session });
        assert.deepEqual(await api.runProviderAuthentication({ ...signup, rememberMe: true }, async () => idToken),
            { error: 'SESSION_NOT_ESTABLISHED' });
        assert.deepEqual(calls[0].body, { action: 'signup', clientKey });
        assert.deepEqual(calls[1].body, { ...signup, rememberMe: true, state: challenge.state, idToken });
        assert.equal(calls.length, 3);
    }
    for (const completion of [{ success: true }, { success: true, linked: true },
        { success: true, user_name: 'New Player', token: 'private-token' },
        { success: true, user_name: 'New Player', deleted: true }]) {
        const { api, calls } = fixture({ completion });
        assert.deepEqual(await api.runProviderAuthentication(signup, async () => idToken), { error: 'INVALID_RESPONSE' });
        assert.equal(calls.length, 2, 'a malformed completion never counts as creation/session proof');
    }
});
}

test('signup collision and email-authority failures are accepted only with their exact status and body', async () => {
    for (const [error, status] of [['ALREADY_LINKED', 409], ['DUPLICATE_USER', 409],
        ['INVALID_USERNAME', 400], ['INVALID_EMAIL', 400]]) {
        for (const [body, responseStatus, expected] of [[{ error }, status, error],
            [{ error }, 500, 'UNAVAILABLE'], [{ error, privateDetail: idToken }, status, 'UNAVAILABLE']]) {
            const { api, calls } = fixture({ completion: body, status: responseStatus });
            assert.deepEqual(await api.runProviderAuthentication(signup, async () => idToken), { error: expected });
            assert.equal(calls.length, 2);
        }
    }
});

for (const clientKey of ['google-web', 'apple-ios']) {
test(`${clientKey} deletion posts only its fresh server challenge, token and literal destructive confirmation`, async () => {
    const deletion = { action: 'delete', clientKey, confirmation: 'DELETE' };
    const { api, calls } = fixture({ completion: { success: true, deleted: true } });
    assert.deepEqual(await api.runProviderAuthentication(deletion, async (received, signal) => {
        assert.deepEqual(received, challenge);
        assert.equal(signal.aborted, false);
        return idToken;
    }), { success: true, deleted: true });
    assert.deepEqual(calls.map(({ body }) => body), [
        { action: 'delete', clientKey },
        { ...deletion, state: challenge.state, idToken },
    ]);
    assert.ok(calls.every(({ init }) => init.method === 'POST' && init.credentials === 'include'));
    assert.equal(calls.some(({ url }) => url.endsWith('/verify-token')), false, 'a valid deletion receipt is not a login');
});
}

test('deletion rejects missing confirmation and every login/signup/link or caller identity field before I/O', async () => {
    const api = createAuthApi(apiBase, async () => assert.fail('invalid deletion cannot send a request'));
    const acquire = async () => assert.fail('invalid deletion cannot open Google');
    for (const input of [
        ...[undefined, null, true, 'delete', ' DELETE '].map(confirmation => ({ ...deletion, confirmation })),
        { ...deletion, clientKey: 'apple-web' }, { ...deletion, rememberMe: false },
        { ...deletion, password: 'private' }, { ...deletion, userName: 'New Player' },
        { ...deletion, accountId: 'caller-account' }, { ...deletion, userId: 42 },
        { ...deletion, nonce: challenge.nonce }, { ...deletion, state: challenge.state },
    ]) assert.deepEqual(await api.runProviderAuthentication(input, acquire), { error: 'INVALID_REQUEST' });
});

test('deletion needs an exact success receipt and preserves unavailable/pending outcomes without claiming deletion', async () => {
    for (const completion of [null, {}, [], { deleted: true }, { success: true }, { success: true, deleted: false },
        { success: true, deleted: true, user_name: 'New Player' }, { success: true, deleted: true, error: 'FAILED' },
        { success: true, linked: true }, { success: true, user_name: 'New Player' }]) {
        const { api, calls } = fixture({ completion });
        assert.deepEqual(await api.runProviderAuthentication(deletion, async () => idToken), { error: 'INVALID_RESPONSE' });
        assert.equal(calls.length, 2);
    }
    for (const error of ['ACCOUNT_DELETION_UNAVAILABLE', 'ACCOUNT_DELETION_PENDING']) {
        const { api } = fixture({ completion: { error }, status: 503 });
        assert.deepEqual(await api.runProviderAuthentication(deletion, async () => idToken), { error });
        const wrongStatus = fixture({ completion: { error }, status: 409 });
        assert.deepEqual(await wrongStatus.api.runProviderAuthentication(deletion, async () => idToken), { error: 'UNAVAILABLE' });
    }
});

test('a sent Google deletion finishes before a later logout, even if its UI cancels after submission', async () => {
    const calls = [];
    let complete;
    const receipt = new Promise(resolve => { complete = resolve; });
    const api = createAuthApi(apiBase, async url => {
        calls.push(url);
        if (url.endsWith('/begin')) return Response.json(challenge);
        if (url.endsWith('/complete')) { await receipt; return Response.json({ success: true, deleted: true }); }
        if (url.endsWith('/logout')) return Response.json({ loggedOut: true });
        assert.fail('Deletion does not create or verify a login session');
    });
    const controller = new AbortController();
    const pending = api.runProviderAuthentication(deletion, async () => idToken, { signal: controller.signal });
    await nextTurn();
    assert.equal(calls.at(-1), `${apiBase}/auth/providers/complete`);
    controller.abort();
    const logout = api.logoutRequest();
    await nextTurn();
    assert.equal(calls.length, 2, 'later auth mutation waits for the submitted deletion');
    complete();
    assert.deepEqual(await pending, { success: true, deleted: true });
    await logout;
    assert.equal(calls.at(-1), `${apiBase}/auth/logout`);
});

test('account method discovery accepts exact current or legacy capability shapes without exposing unknown fields', async () => {
    const methods = { hasPassword: false, googleLinked: true, googleDeletionEnabled: true };
    for (const body of [methods, { ...methods, hasPassword: true, googleDeletionEnabled: false },
        { ...methods, appleLinked: true, appleDeletionEnabled: false },
        { ...methods, appleLinked: true, appleDeletionEnabled: true }]) {
        const api = createAuthApi(apiBase, async (url, init) => {
            assert.equal(url, `${apiBase}/auth/providers/account`);
            assert.deepEqual(init, { method: 'GET', credentials: 'include' });
            return Response.json(body);
        });
        assert.deepEqual(await api.providerAccountMethodsRequest(), { appleLinked: false, appleDeletionEnabled: false, ...body });
    }
    for (const body of [null, {}, [], { hasPassword: false, googleLinked: true },
        { ...methods, hasPassword: 'false' }, { ...methods, googleLinked: 1 },
        { ...methods, googleDeletionEnabled: 'true' }, { ...methods, accountId: 'private-account' },
        { ...methods, appleLinked: true }, { ...methods, appleDeletionEnabled: false },
        { ...methods, appleLinked: 'true', appleDeletionEnabled: false },
        { ...methods, appleLinked: true, appleDeletionEnabled: 1 },
        { ...methods, appleLinked: true, appleDeletionEnabled: true, accountId: 'private-account' }]) {
        const api = createAuthApi(apiBase, async () => Response.json(body));
        assert.equal(await api.providerAccountMethodsRequest(), null);
    }
    for (const status of [401, 403, 503]) {
        assert.equal(await createAuthApi(apiBase, async () => Response.json(methods, { status })).providerAccountMethodsRequest(), null);
    }
    assert.equal(await createAuthApi(apiBase, async () => { throw new Error(idToken); }).providerAccountMethodsRequest(), null);
});
