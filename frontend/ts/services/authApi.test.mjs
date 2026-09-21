import assert from 'node:assert/strict';
import test from 'node:test';
import { createAuthApi } from './authApi.ts';

const apiBase = 'https://api.example.test';
const credentials = { user_name: ' Player ', user_password: ' pass phrase ' };
const registration = { ...credentials, email: ' Player@example.test ' };
const jsonMethods = [
    ['loginRequest', credentials],
    ['signupRequest', registration],
    ['verifyRequest', undefined],
    ['renewRequest', undefined],
];

for (const [method, type, payload, result] of [
    ['loginRequest', 'login', credentials, { success: true, user_name: 'Player' }],
    ['signupRequest', 'signup', registration, { success: true }],
]) {
    test(`${method} posts only its selected fields and includes session credentials`, async () => {
        let observed;
        const api = createAuthApi(apiBase, async (url, init) => {
            if (url.endsWith('/auth/verify-token')) {
                assert.equal(init.credentials, 'include');
                assert.equal(init.method, 'GET');
                assert.equal(init.body, undefined);
                return Response.json({ loggedIn: true, user_name: 'Player' });
            }
            observed = { url, init };
            return Response.json(result);
        });

        assert.deepEqual(await api[method]({ ...payload, type: 'other', ignored: true }), result);
        assert.equal(observed.url, `${apiBase}/api/users`);
        assert.equal(observed.init.method, 'POST');
        assert.equal(observed.init.credentials, 'include');
        assert.deepEqual(observed.init.headers, { 'Content-Type': 'application/json' });
        assert.deepEqual(JSON.parse(observed.init.body), {
            type,
            ...payload,
            ...(type === 'login' ? { remember_me: false } : {}),
        });
    });
}

test('login sends the explicit stay-signed-in choice without extending omitted or malformed choices', async () => {
    for (const [rememberMe, expected] of [[undefined, false], [false, false], [true, true], ['true', false]]) {
        let sentBody;
        const api = createAuthApi(apiBase, async (url, init) => {
            if (url.endsWith('/auth/verify-token')) {
                return Response.json({ loggedIn: true, user_name: 'Player' });
            }
            sentBody = JSON.parse(init.body);
            return Response.json({ success: true, user_name: 'Player' });
        });

        await api.loginRequest({ ...credentials, remember_me: rememberMe });
        assert.deepEqual(sentBody, { type: 'login', ...credentials, remember_me: expected });
    }
});

test('signup never forwards a stay-signed-in choice to account creation', async () => {
    const api = createAuthApi(apiBase, async (_url, init) => {
        assert.deepEqual(JSON.parse(init.body), { type: 'signup', ...registration });
        return Response.json({ success: true });
    });

    await api.signupRequest({ ...registration, remember_me: true });
});

for (const result of [{ loggedIn: false }, { loggedIn: true, user_name: 'Player' }]) {
    test(`verifyRequest preserves the ${result.loggedIn ? 'authenticated' : 'anonymous'} session result`, async () => {
        const api = createAuthApi(apiBase, async (url, init) => {
            assert.equal(url, `${apiBase}/auth/verify-token`);
            assert.equal(init.method, 'GET');
            assert.equal(init.credentials, 'include');
            assert.equal(init.body, undefined);
            return Response.json(result);
        });

        assert.deepEqual(await api.verifyRequest(), result);
    });
}

test('HTTP 200 application errors pass through, including the legacy duplicate status in JSON', async () => {
    const cases = [
        ['loginRequest', credentials, { error: 'AUTH_FAILED' }],
        ...['INVALID_EMAIL', 'INVALID_PASSWORD', 'INVALID_USERNAME', 'EMPTY_FIELDS'].map(
            (error) => ['signupRequest', registration, { error }]
        ),
        ['signupRequest', registration, { error: 'DUPLICATE_USER', status: 409 }],
        ['signupRequest', registration, { error: 'OTHER_ERROR', message: 'Try again.' }],
    ];

    for (const [method, payload, result] of cases) {
        const api = createAuthApi(apiBase, async () => ({ ok: true, json: async () => result }));
        assert.equal(await api[method](payload), result);
    }
});

for (const result of [{ loggedIn: false }, { loggedIn: true, user_name: 'Player' }]) {
    test(`renewRequest confirms the ${result.loggedIn ? 'authenticated' : 'anonymous'} session without JS credentials`, async () => {
        const api = createAuthApi(apiBase, async (url, init) => {
            assert.equal(url, `${apiBase}/auth/renew`);
            assert.equal(init.method, 'POST');
            assert.equal(init.credentials, 'include');
            assert.deepEqual(init.headers, { 'Content-Type': 'application/json' });
            assert.deepEqual(JSON.parse(init.body), {});
            return Response.json(result);
        });
        assert.deepEqual(await api.renewRequest(), result);
    });
}

test('renewal never converts an unexpected response into authentication or sign-out', async () => {
    for (const result of [null, {}, [], { loggedIn: true }, { loggedIn: true, user_name: '' },
        { loggedIn: false, error: 'UNAVAILABLE' }, { loggedIn: true, user_name: 'Player', token: 'not-allowed' }]) {
        const api = createAuthApi(apiBase, async () => Response.json(result));
        await assert.rejects(api.renewRequest(), { message: 'Could not confirm the renewed session.' });
    }
});

test('login cannot report success when the next request has no matching session', async () => {
    for (const session of [{ loggedIn: false }, { loggedIn: true, user_name: 'Other' }]) {
        const calls = [];
        const api = createAuthApi(apiBase, async (url) => {
            calls.push(url);
            return Response.json(url.endsWith('/api/users')
                ? { success: true, user_name: 'Player' }
                : session);
        });
        const result = await api.loginRequest(credentials);
        assert.equal(result.error, 'SESSION_NOT_ESTABLISHED');
        assert.match(result.message, /session could not be saved/);
        assert.deepEqual(calls, [`${apiBase}/api/users`, `${apiBase}/auth/verify-token`]);
    }
});

test('a rejected password never triggers session verification', async () => {
    let calls = 0;
    const api = createAuthApi(apiBase, async () => {
        calls++;
        return Response.json({ error: 'AUTH_FAILED' });
    });
    assert.deepEqual(await api.loginRequest(credentials), { error: 'AUTH_FAILED' });
    assert.equal(calls, 1);
});

test('a failed follow-up verification rejects instead of reporting login success', async () => {
    const api = createAuthApi(apiBase, async (url) => {
        if (url.endsWith('/auth/verify-token')) throw new TypeError('Network unavailable');
        return Response.json({ success: true, user_name: 'Player' });
    });
    await assert.rejects(api.loginRequest(credentials), /Network unavailable/);
});

test('non-success HTTP responses reject before reading JSON and preserve existing error messages', async () => {
    for (const [method, payload] of jsonMethods) {
        for (const status of [429, 500]) {
            let bodyRead = false;
            const api = createAuthApi(apiBase, async () => ({
                ok: false,
                status,
                json: async () => {
                    bodyRead = true;
                    return { error: 'PRIVATE_RESPONSE_DETAIL' };
                },
            }));
            const separator = method === 'signupRequest' ? ': ' : ' ';

            await assert.rejects(api[method](payload), {
                message: `HTTP error${separator}${status}`,
            });
            assert.equal(bodyRead, false);
        }
    }
});

test('network failures propagate unchanged for every auth operation', async () => {
    const failure = new TypeError('Network unavailable');
    const api = createAuthApi(apiBase, async () => { throw failure; });

    for (const [method, payload] of [...jsonMethods, ['logoutRequest', undefined]]) {
        await assert.rejects(api[method](payload), (error) => error === failure);
    }
});

test('JSON parsing failures propagate unchanged for operations that read a response', async () => {
    const failure = new SyntaxError('Invalid JSON');
    const api = createAuthApi(apiBase, async () => ({
        ok: true,
        json: async () => { throw failure; },
    }));

    for (const [method, payload] of jsonMethods) {
        await assert.rejects(api[method](payload), (error) => error === failure);
    }
});

test('logout posts with credentials and requires a confirmed sign-out response', async () => {
    const api = createAuthApi(apiBase, async (url, init) => {
        assert.equal(url, `${apiBase}/auth/logout`);
        assert.equal(init.method, 'POST');
        assert.equal(init.credentials, 'include');
        assert.equal(init.body, undefined);
        return Response.json({ loggedOut: true });
    });

    assert.equal(await api.logoutRequest(), undefined);
});

test('logout rejects HTTP failures before reading their bodies', async () => {
    for (const status of [401, 429, 500, 503]) {
        let bodyRead = false;
        const api = createAuthApi(apiBase, async () => {
            return {
                ok: false,
                status,
                json: async () => { bodyRead = true; },
            };
        });

        await assert.rejects(api.logoutRequest(), { message: 'Could not confirm sign-out.' });
        assert.equal(bodyRead, false);
    }
});

test('logout never confirms an empty, malformed or contradictory response', async () => {
    for (const body of [{}, null, [], { loggedOut: false }, { loggedOut: 1 }, { loggedOut: true, error: 'FAILED' }]) {
        const api = createAuthApi(apiBase, async () => Response.json(body));
        await assert.rejects(api.logoutRequest(), { message: 'Could not confirm sign-out.' });
    }
    for (const response of [new Response(null, { status: 204 }), new Response('not JSON')]) {
        const api = createAuthApi(apiBase, async () => response);
        await assert.rejects(api.logoutRequest(), SyntaxError);
    }
});

test('logout waits for delayed login and its complete verification before revoking the resulting session', async () => {
    let releaseLogin;
    let releaseVerification;
    const loginResponse = new Promise((resolve) => { releaseLogin = resolve; });
    const verificationResponse = new Promise((resolve) => { releaseVerification = resolve; });
    const calls = [];
    let session = false;
    const api = createAuthApi(apiBase, async (url) => {
        if (url.endsWith('/api/users')) {
            calls.push('login');
            await loginResponse;
            session = true;
            return Response.json({ success: true, user_name: 'Player' });
        }
        if (url.endsWith('/auth/verify-token')) {
            calls.push('verify');
            await verificationResponse;
            return Response.json({ loggedIn: session, user_name: 'Player' });
        }
        calls.push('logout');
        assert.equal(session, true, 'logout receives the session established by the earlier login');
        session = false;
        return Response.json({ loggedOut: true });
    });

    const login = api.loginRequest(credentials);
    const logout = api.logoutRequest();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, ['login']);
    releaseLogin();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, ['login', 'verify']);
    releaseVerification();
    assert.deepEqual(await login, { success: true, user_name: 'Player' });
    await logout;
    assert.deepEqual(calls, ['login', 'verify', 'logout']);
    assert.equal(session, false);
});

test('signup, deletion, login, renewal and logout share one ordered mutation queue', async () => {
    const calls = [];
    let activeRequests = 0;
    const api = createAuthApi(apiBase, async (url, init) => {
        assert.equal(++activeRequests, 1, 'auth mutation transports cannot overlap');
        await Promise.resolve();
        activeRequests--;
        if (url.endsWith('/api/users')) {
            const { type } = JSON.parse(init.body);
            calls.push(type);
            return Response.json(type === 'signup' ? { success: true } : { success: true, user_name: 'Player' });
        }
        if (url.endsWith('/auth/delete-account')) {
            calls.push('delete');
            return Response.json({ deleted: true });
        }
        if (url.endsWith('/auth/verify-token')) {
            calls.push('verify');
            return Response.json({ loggedIn: true, user_name: 'Player' });
        }
        if (url.endsWith('/auth/renew')) {
            calls.push('renew');
            return Response.json({ loggedIn: true, user_name: 'Player' });
        }
        calls.push('logout');
        return Response.json({ loggedOut: true });
    });

    await Promise.all([
        api.signupRequest(registration),
        api.deleteAccountRequest('test-only'),
        api.loginRequest(credentials),
        api.renewRequest(),
        api.logoutRequest(),
    ]);
    assert.deepEqual(calls, ['signup', 'delete', 'login', 'verify', 'renew', 'logout']);
});

test('logout waits for an in-flight cookie rotation and a later renewal cannot recreate the session', async () => {
    let releaseRenewal;
    const blockedRenewal = new Promise((resolve) => { releaseRenewal = resolve; });
    const calls = [];
    let signedIn = true;
    const api = createAuthApi(apiBase, async (url) => {
        if (url.endsWith('/auth/renew')) {
            calls.push('renew');
            await blockedRenewal;
            return Response.json(signedIn ? { loggedIn: true, user_name: 'Player' } : { loggedIn: false });
        }
        calls.push('logout');
        signedIn = false;
        return Response.json({ loggedOut: true });
    });
    const renewal = api.renewRequest();
    const logout = api.logoutRequest();
    const laterRenewal = api.renewRequest();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, ['renew']);
    releaseRenewal();
    assert.deepEqual(await renewal, { loggedIn: true, user_name: 'Player' });
    await logout;
    assert.deepEqual(await laterRenewal, { loggedIn: false });
    assert.deepEqual(calls, ['renew', 'logout', 'renew']);
});

test('a failed mutation does not poison the queue or retry its network operation', async () => {
    const failure = new TypeError('Network unavailable');
    const calls = [];
    const api = createAuthApi(apiBase, async (url) => {
        calls.push(url);
        if (url.endsWith('/api/users')) throw failure;
        return Response.json({ loggedOut: true });
    });
    const login = api.loginRequest(credentials);
    const logout = api.logoutRequest();
    await assert.rejects(login, (error) => error === failure);
    await logout;
    assert.deepEqual(calls, [`${apiBase}/api/users`, `${apiBase}/auth/logout`]);
});

test('a pending read-only startup verification does not block an auth mutation', async () => {
    let releaseVerification;
    const response = new Promise((resolve) => { releaseVerification = resolve; });
    const api = createAuthApi(apiBase, async (url) => {
        if (url.endsWith('/auth/verify-token')) return response;
        return Response.json({ loggedOut: true });
    });
    const verification = api.verifyRequest();
    await api.logoutRequest();
    releaseVerification(Response.json({ loggedIn: false }));
    assert.deepEqual(await verification, { loggedIn: false });
});

test('a failed logout after login can reconcile the still-authenticated session with a read-only check', async () => {
    let signedIn = false;
    const api = createAuthApi(apiBase, async (url) => {
        if (url.endsWith('/api/users')) {
            signedIn = true;
            return Response.json({ success: true, user_name: 'Player' });
        }
        if (url.endsWith('/auth/logout')) return Response.json({ error: 'LOGOUT_UNAVAILABLE' }, { status: 503 });
        return Response.json(signedIn ? { loggedIn: true, user_name: 'Player' } : { loggedIn: false });
    });
    const login = api.loginRequest(credentials);
    const logout = api.logoutRequest();
    assert.equal((await login).success, true);
    await assert.rejects(logout, { message: 'Could not confirm sign-out.' });
    assert.deepEqual(await api.verifyRequest(), { loggedIn: true, user_name: 'Player' });
});

test('account deletion sends the current password and explicit confirmation through the session transport', async () => {
    const calls = [];
    const api = createAuthApi(apiBase, async (url, init) => {
        calls.push({ url, init });
        return Response.json({ deleted: true });
    });

    assert.deepEqual(await api.deleteAccountRequest(' current password '), { deleted: true });
    assert.equal(calls.length, 1, 'no login/logout or automatic destructive retry');
    assert.equal(calls[0].url, `${apiBase}/auth/delete-account`);
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.credentials, 'include');
    assert.deepEqual(calls[0].init.headers, { 'Content-Type': 'application/json' });
    assert.deepEqual(JSON.parse(calls[0].init.body), { password: ' current password ', confirmation: 'DELETE' });
});

test('account deletion distinguishes rejected password, invalid request, expired session and temporary failure', async () => {
    for (const [status, error] of [
        [400, 'INVALID_REQUEST'],
        [403, 'INVALID_PASSWORD'],
        [401, 'UNAUTHENTICATED'],
        [503, 'ACCOUNT_DELETION_UNAVAILABLE'],
        [503, 'ACCOUNT_DELETION_PENDING'],
        [429, 'RATE_LIMITED'],
    ]) {
        const api = createAuthApi(apiBase, async () => Response.json({ error, message: 'Ignored private detail' }, { status }));
        assert.deepEqual(await api.deleteAccountRequest('test-only'), { error });
    }
});

test('account deletion never treats an unexpected or incomplete response as durable success', async () => {
    for (const [status, body] of [
        [200, {}], [200, { deleted: false }], [200, { deleted: 1 }],
        [200, { deleted: true, error: 'INVALID_PASSWORD' }],
        [200, null], [403, { deleted: true }], [503, { deleted: true }],
        [400, { error: 'UNAUTHENTICATED' }], [500, { error: 'PRIVATE_DETAIL' }],
    ]) {
        const api = createAuthApi(apiBase, async () => Response.json(body, { status }));
        await assert.rejects(api.deleteAccountRequest('test-only'), { message: 'Could not confirm account deletion.' });
    }
    for (const response of [new Response(null, { status: 204 }), new Response('not JSON', { status: 200 })]) {
        const api = createAuthApi(apiBase, async () => response);
        await assert.rejects(api.deleteAccountRequest('test-only'), SyntaxError);
    }
});

test('account deletion propagates uncertain network failure without retrying', async () => {
    let calls = 0;
    const failure = new TypeError('Network unavailable');
    const api = createAuthApi(apiBase, async () => { calls++; throw failure; });
    await assert.rejects(api.deleteAccountRequest('test-only'), (error) => error === failure);
    assert.equal(calls, 1);
});

const providerInput = { action: 'login', clientKey: 'google-web', rememberMe: true };
const providerChallenge = { state: Buffer.alloc(32, 1).toString('base64url'),
    nonce: Buffer.alloc(32, 2).toString('base64url'), expiresInSeconds: 300 };
const providerToken = 'synthetic.header.signature';
const appleCredential = { idToken: providerToken, authorizationCode: 'synthetic-one-time-code' };
const credentialFor = clientKey => clientKey === 'apple-ios' ? appleCredential : providerToken;
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

for (const clientKey of ['google-web', 'apple-ios']) {
test(`${clientKey} login owns begin, credential acquisition, complete and saved-cookie verification`, async () => {
    const calls = [];
    const input = { ...providerInput, clientKey };
    const api = createAuthApi(apiBase, async (url, init) => {
        calls.push(url);
        assert.equal(init.credentials, 'include');
        assert.equal(init.signal, undefined, 'an already-sent cookie mutation must finish before releasing the queue');
        if (url.endsWith('/auth/verify-token')) {
            assert.equal(init.method, 'GET');
            return Response.json({ loggedIn: true, user_name: 'Player' });
        }
        assert.equal(init.method, 'POST');
        assert.deepEqual(init.headers, { 'Content-Type': 'application/json' });
        if (url.endsWith('/begin')) {
            assert.deepEqual(JSON.parse(init.body), { action: 'login', clientKey });
            return Response.json(providerChallenge);
        }
        assert.deepEqual(JSON.parse(init.body), { ...input, state: providerChallenge.state,
            ...(clientKey === 'apple-ios' ? appleCredential : { idToken: providerToken }) });
        return Response.json({ success: true, user_name: 'Player' });
    });
    assert.deepEqual(await api.runProviderAuthentication(input, async (challenge, signal) => {
        calls.push('acquire');
        assert.deepEqual(challenge, providerChallenge);
        assert.equal(Object.isFrozen(challenge), true);
        assert.equal(signal.aborted, false);
        return credentialFor(clientKey);
    }), { success: true, user_name: 'Player' });
    assert.deepEqual(calls, [`${apiBase}/auth/providers/begin`, 'acquire',
        `${apiBase}/auth/providers/complete`, `${apiBase}/auth/verify-token`]);
});
}

test('provider completions reject missing Apple codes, malformed proofs and cross-provider credentials without sending them', async () => {
    const invalidApple = [providerToken, null, [], {}, { idToken: providerToken },
        { ...appleCredential, identityToken: providerToken }, { ...appleCredential, email: 'private@example.test' },
        { ...appleCredential, idToken: 'invalid' },
        ...[undefined, null, '', 1, ' ', 'code with space', 'code\n', '\u0000', '\u007f', 'é', 'x'.repeat(4097)]
            .map(authorizationCode => ({ idToken: providerToken, authorizationCode }))];
    for (const [clientKey, values] of [['google-web', [appleCredential, { idToken: providerToken }]], ['apple-ios', invalidApple]]) {
        for (const credential of values) {
            const calls = [];
            const api = createAuthApi(apiBase, async (url, init) => {
                calls.push(JSON.parse(init.body));
                assert.ok(url.endsWith('/begin'), 'invalid proof cannot reach completion');
                return Response.json(providerChallenge);
            });
            const prepared = await api.prepareProviderLogin(clientKey);
            assert.deepEqual(await api.completeProviderLogin(prepared.handle, credential), { error: 'INVALID_PROVIDER_TOKEN' });
            assert.deepEqual(await api.completeProviderLogin(prepared.handle, credentialFor(clientKey)), { error: 'INVALID_ATTEMPT' });
            assert.deepEqual(await api.runProviderAuthentication({ action: 'login', clientKey }, async () => credential),
                { error: 'INVALID_PROVIDER_TOKEN' });
            assert.equal(calls.length, 2);
            assert.ok(calls.every(body => !('idToken' in body) && !('authorizationCode' in body)));
        }
    }
});

test('prepared Apple completion snapshots both proof fields before queued work and accepts bounded opaque codes', async () => {
    for (const authorizationCode of ['!', 'opaque+/=._-~', 'x'.repeat(4096)]) {
        const calls = [];
        const api = createAuthApi(apiBase, async (url, init) => {
            if (url.endsWith('/begin')) return Response.json(providerChallenge);
            if (url.endsWith('/verify-token')) return Response.json({ loggedIn: true, user_name: 'Player' });
            calls.push(JSON.parse(init.body));
            return Response.json({ success: true, user_name: 'Player' });
        });
        const prepared = await api.prepareProviderLogin('apple-ios');
        const credential = { idToken: providerToken, authorizationCode };
        const completion = api.completeProviderLogin(prepared.handle, credential);
        credential.idToken = 'changed'; credential.authorizationCode = 'changed';
        assert.deepEqual(await completion, { success: true, user_name: 'Player' });
        assert.deepEqual(calls, [{ action: 'login', clientKey: 'apple-ios', state: providerChallenge.state,
            idToken: providerToken, authorizationCode, rememberMe: false }]);
    }
});

test('provider linking sends the unchanged password only on complete and never requests a new login session', async () => {
    const password = ' correct horse é ';
    const calls = [];
    const api = createAuthApi(apiBase, async (url, init) => {
        calls.push(url);
        if (url.endsWith('/begin')) {
            assert.deepEqual(JSON.parse(init.body), { action: 'link', clientKey: 'apple-ios' });
            return Response.json(providerChallenge);
        }
        assert.equal(url, `${apiBase}/auth/providers/complete`);
        assert.deepEqual(JSON.parse(init.body), { action: 'link', clientKey: 'apple-ios',
            password, state: providerChallenge.state, ...appleCredential });
        return Response.json({ success: true, linked: true });
    });
    assert.deepEqual(await api.runProviderAuthentication({ action: 'link', clientKey: 'apple-ios', password },
        async () => appleCredential), { success: true, linked: true });
    assert.equal(calls.length, 2);
});

test('provider transport rejects malformed input, extra account proof and unsafe password bounds before any request', async () => {
    const invalidInputs = [null, [], {}, { action: 'signup', clientKey: 'google-web' },
        { ...providerInput, clientKey: '' }, { ...providerInput, clientKey: 'A'.repeat(65) },
        { ...providerInput, clientKey: '../google' }, { ...providerInput, rememberMe: 'true' },
        { ...providerInput, password: 'unexpected' }, { ...providerInput, accountId: 'caller-account' },
        { ...providerInput, nonce: providerChallenge.nonce }, { ...providerInput, state: providerChallenge.state },
        { action: 'link', clientKey: 'google-web' }, { action: 'link', clientKey: 'google-web', password: '' },
        { action: 'link', clientKey: 'google-web', password: 'é'.repeat(37) },
        { action: 'link', clientKey: 'google-web', password: 'a\u0000b' },
        { action: 'link', clientKey: 'google-web', password: 'secret', rememberMe: false }];
    const api = createAuthApi(apiBase, async () => { assert.fail('invalid input must not call fetch'); });
    const acquire = async () => { assert.fail('invalid input must not open the provider'); };
    for (const input of invalidInputs) {
        assert.deepEqual(await api.runProviderAuthentication(input, acquire), { error: 'INVALID_REQUEST' });
    }
    assert.deepEqual(await api.runProviderAuthentication(providerInput, null), { error: 'INVALID_REQUEST' });
    for (const options of [null, [], { signal: false }, { signal: {} }, { accountId: 'unexpected' }]) {
        assert.deepEqual(await api.runProviderAuthentication(providerInput, acquire, options), { error: 'INVALID_REQUEST' });
    }
});

test('provider begin rejects malformed challenge shape, entropy encoding and lifetime before acquiring a credential', async () => {
    for (const challenge of [null, [], {}, { ...providerChallenge, token: 'private' },
        { ...providerChallenge, state: 'a'.repeat(43) }, { ...providerChallenge, nonce: 'a'.repeat(44) },
        ...[0, -1, 301, 1.5, '300', null].map(expiresInSeconds => ({ ...providerChallenge, expiresInSeconds }))]) {
        const calls = [];
        const api = createAuthApi(apiBase, async url => { calls.push(url); return Response.json(challenge); });
        assert.deepEqual(await api.runProviderAuthentication(providerInput, async () => {
            assert.fail('an invalid challenge must not reach the provider');
        }), { error: 'INVALID_RESPONSE' });
        assert.deepEqual(calls, [`${apiBase}/auth/providers/begin`]);
    }
});

test('provider transport returns only recognized HTTP failures and never exposes provider response details', async () => {
    for (const path of ['begin', 'complete']) {
        for (const [status, body, expected] of [
            [400, { error: 'INVALID_ATTEMPT' }, 'INVALID_ATTEMPT'],
            [401, { error: 'INVALID_PROVIDER_TOKEN' }, 'INVALID_PROVIDER_TOKEN'],
            [403, { error: 'NOT_LINKED' }, 'NOT_LINKED'],
            [409, { error: 'LINK_CONFLICT' }, 'LINK_CONFLICT'],
            [429, { error: 'RATE_LIMITED' }, 'RATE_LIMITED'],
            [503, { error: 'UNAVAILABLE' }, 'UNAVAILABLE'],
            [500, { error: 'private credential' }, 'UNAVAILABLE'],
            [403, { error: 'INVALID_PASSWORD', detail: 'private credential' }, 'UNAVAILABLE'],
            [500, { error: 'NOT_LINKED' }, 'UNAVAILABLE'],
            [503, { success: true, user_name: 'Player' }, 'UNAVAILABLE'],
        ]) {
            let acquisitions = 0;
            const api = createAuthApi(apiBase, async url => url.endsWith('/' + path)
                ? Response.json(body, { status }) : Response.json(providerChallenge));
            assert.deepEqual(await api.runProviderAuthentication(providerInput, async () => {
                acquisitions++;
                return providerToken;
            }), { error: expected });
            assert.equal(acquisitions, path === 'begin' ? 0 : 1);
        }
    }
});

test('provider credential rejection, cancellation and invalid token values skip completion and leave the queue usable', async () => {
    for (const [acquire, expected] of [
        [async () => { throw new DOMException('private provider details', 'AbortError'); }, 'CANCELLED'],
        [async () => { throw { code: 'CANCELLED', message: 'private provider details' }; }, 'CANCELLED'],
        [async () => { throw new Error('private token and credentials'); }, 'UNAVAILABLE'],
        ...[null, '', 123, 'not a jwt', 'a.b.', 'a.b.Ü', 'a.b.' + 'c'.repeat(16_384)]
            .map(value => [async () => value, 'INVALID_PROVIDER_TOKEN']),
    ]) {
        const calls = [];
        const api = createAuthApi(apiBase, async url => {
            calls.push(url);
            return Response.json(url.endsWith('/begin') ? providerChallenge : { loggedOut: true });
        });
        assert.deepEqual(await api.runProviderAuthentication(providerInput, acquire), { error: expected });
        await api.logoutRequest();
        assert.deepEqual(calls, [`${apiBase}/auth/providers/begin`, `${apiBase}/auth/logout`]);
    }
});

test('provider completion requires the exact success shape for the requested action', async () => {
    for (const action of ['login', 'link']) {
        const input = action === 'login' ? providerInput : { action, clientKey: 'apple-web', password: 'existing-password' };
        for (const body of [null, [], {}, { success: false }, { success: 1, user_name: 'Player' },
            { success: true }, { success: true, user_name: '' }, { success: true, user_name: 'a'.repeat(256) },
            { success: true, user_name: 'Player\n' }, { success: true, linked: true, user_name: 'Player' },
            { success: true, user_name: 'Player', idToken: 'private' }, { success: true, linked: true, error: 'FAILED' },
            action === 'login' ? { success: true, linked: true } : { success: true, user_name: 'Player' }]) {
            let calls = 0;
            const api = createAuthApi(apiBase, async url => {
                calls++;
                return Response.json(url.endsWith('/begin') ? providerChallenge : body);
            });
            assert.deepEqual(await api.runProviderAuthentication(input, async () => providerToken), { error: 'INVALID_RESPONSE' });
            assert.equal(calls, 2);
        }
    }
});

test('provider login never succeeds without an exact matching saved-cookie verification', async () => {
    for (const session of [null, {}, [], { loggedIn: false }, { loggedIn: true, user_name: 'Other' },
        { loggedIn: true, user_name: 'Player', token: 'private' }]) {
        const api = createAuthApi(apiBase, async url => Response.json(url.endsWith('/begin') ? providerChallenge
            : url.endsWith('/complete') ? { success: true, user_name: 'Player' } : session));
        assert.deepEqual(await api.runProviderAuthentication(providerInput, async () => providerToken),
            { error: 'SESSION_NOT_ESTABLISHED' });
    }
    for (const failureAt of ['/begin', '/complete', '/auth/verify-token']) {
        for (const malformedJson of [false, true]) {
            const api = createAuthApi(apiBase, async url => {
                if (url.endsWith(failureAt)) {
                    if (malformedJson) return new Response('private malformed token details');
                    throw new Error('private connection and token details');
                }
                return Response.json(url.endsWith('/begin') ? providerChallenge : { success: true, user_name: 'Player' });
            });
            assert.deepEqual(await api.runProviderAuthentication(providerInput, async () => providerToken), { error: 'UNAVAILABLE' });
        }
    }
});

test('provider dialog and cookie verification block later mutations while ordinary verification remains available', async () => {
    let releaseProvider;
    let releaseVerification;
    const provider = new Promise(resolve => { releaseProvider = resolve; });
    const verification = new Promise(resolve => { releaseVerification = resolve; });
    const calls = [];
    let completed = false;
    const api = createAuthApi(apiBase, async (url, init) => {
        if (url.endsWith('/begin')) { calls.push('begin'); return Response.json(providerChallenge); }
        if (url.endsWith('/complete')) {
            calls.push('complete'); completed = true;
            return Response.json({ success: true, user_name: 'Player' });
        }
        if (url.endsWith('/auth/verify-token')) {
            calls.push('verify');
            if (!completed) return Response.json({ loggedIn: false });
            await verification;
            return Response.json({ loggedIn: true, user_name: 'Player' });
        }
        if (url.endsWith('/auth/renew')) { calls.push('renew'); return Response.json({ loggedIn: true, user_name: 'Player' }); }
        if (url.endsWith('/api/users')) { calls.push(JSON.parse(init.body).type); return Response.json({ success: true, user_name: 'Player' }); }
        calls.push('logout'); return Response.json({ loggedOut: true });
    });
    const login = api.runProviderAuthentication(providerInput, async () => { calls.push('acquire'); return provider; });
    const renewal = api.renewRequest();
    const passwordLogin = api.loginRequest(credentials);
    const logout = api.logoutRequest();
    await nextTurn();
    assert.deepEqual(calls, ['begin', 'acquire']);
    assert.deepEqual(await api.verifyRequest(), { loggedIn: false });
    releaseProvider(providerToken);
    await nextTurn();
    assert.deepEqual(calls, ['begin', 'acquire', 'verify', 'complete', 'verify']);
    releaseVerification();
    assert.deepEqual(await login, { success: true, user_name: 'Player' });
    await Promise.all([renewal, passwordLogin, logout]);
    assert.deepEqual(calls, ['begin', 'acquire', 'verify', 'complete', 'verify', 'renew', 'login', 'verify', 'logout']);
});

test('aborting provider acquisition cleans up its signal, skips late credentials and unblocks logout', async () => {
    const controller = new AbortController();
    let releaseProvider;
    let providerSignal;
    const provider = new Promise(resolve => { releaseProvider = resolve; });
    const calls = [];
    const api = createAuthApi(apiBase, async url => {
        calls.push(url);
        return Response.json(url.endsWith('/begin') ? providerChallenge : { loggedOut: true });
    });
    const login = api.runProviderAuthentication(providerInput, async (_challenge, signal) => {
        providerSignal = signal;
        return provider;
    }, { signal: controller.signal });
    const logout = api.logoutRequest();
    await nextTurn();
    controller.abort('private caller reason');
    assert.deepEqual(await login, { error: 'CANCELLED' });
    assert.equal(providerSignal.aborted, true);
    await logout;
    releaseProvider(providerToken);
    await nextTurn();
    assert.deepEqual(calls, [`${apiBase}/auth/providers/begin`, `${apiBase}/auth/logout`]);
});

test('an expired provider dialog aborts acquisition and releases the queue without accepting a late credential', async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
    let releaseProvider;
    let providerSignal;
    const provider = new Promise(resolve => { releaseProvider = resolve; });
    const calls = [];
    const api = createAuthApi(apiBase, async url => {
        calls.push(url);
        return Response.json(url.endsWith('/begin') ? { ...providerChallenge, expiresInSeconds: 1 } : { loggedOut: true });
    });
    const login = api.runProviderAuthentication(providerInput, async (_challenge, signal) => {
        providerSignal = signal;
        return provider;
    });
    const logout = api.logoutRequest();
    await nextTurn();
    t.mock.timers.tick(1000);
    assert.deepEqual(await login, { error: 'INVALID_ATTEMPT' });
    assert.equal(providerSignal.aborted, true);
    await logout;
    releaseProvider(providerToken);
    await nextTurn();
    assert.deepEqual(calls, [`${apiBase}/auth/providers/begin`, `${apiBase}/auth/logout`]);
});

test('pre-cancelled provider input sends nothing and cancellation during begin awaits the already-sent cookie response', async () => {
    const cancelled = new AbortController();
    cancelled.abort();
    const noFetch = createAuthApi(apiBase, async () => { assert.fail('pre-cancelled operation cannot send begin'); });
    assert.deepEqual(await noFetch.runProviderAuthentication(providerInput, async () => providerToken,
        { signal: cancelled.signal }), { error: 'CANCELLED' });
    const controller = new AbortController();
    let releaseBegin;
    const begin = new Promise(resolve => { releaseBegin = resolve; });
    const calls = [];
    const api = createAuthApi(apiBase, async url => {
        calls.push(url);
        if (url.endsWith('/begin')) { await begin; return Response.json(providerChallenge); }
        return Response.json({ loggedOut: true });
    });
    const login = api.runProviderAuthentication(providerInput, async () => { assert.fail('cancelled begin cannot open provider'); },
        { signal: controller.signal });
    const logout = api.logoutRequest();
    await nextTurn();
    controller.abort();
    await nextTurn();
    assert.deepEqual(calls, [`${apiBase}/auth/providers/begin`]);
    releaseBegin();
    assert.deepEqual(await login, { error: 'CANCELLED' });
    await logout;
    assert.deepEqual(calls, [`${apiBase}/auth/providers/begin`, `${apiBase}/auth/logout`]);
});

test('cancellation after complete is sent waits for the real cookie outcome and verification before logout', async () => {
    const controller = new AbortController();
    let releaseComplete;
    const completion = new Promise(resolve => { releaseComplete = resolve; });
    const calls = [];
    let signedIn = false;
    const api = createAuthApi(apiBase, async url => {
        if (url.endsWith('/begin')) { calls.push('begin'); return Response.json(providerChallenge); }
        if (url.endsWith('/complete')) {
            calls.push('complete'); await completion; signedIn = true;
            return Response.json({ success: true, user_name: 'Player' });
        }
        if (url.endsWith('/auth/verify-token')) {
            calls.push('verify');
            assert.equal(signedIn, true);
            return Response.json({ loggedIn: true, user_name: 'Player' });
        }
        calls.push('logout'); signedIn = false; return Response.json({ loggedOut: true });
    });
    const login = api.runProviderAuthentication(providerInput, async () => providerToken, { signal: controller.signal });
    const logout = api.logoutRequest();
    await nextTurn();
    controller.abort();
    await nextTurn();
    assert.deepEqual(calls, ['begin', 'complete']);
    releaseComplete();
    assert.deepEqual(await login, { success: true, user_name: 'Player' });
    await logout;
    assert.deepEqual(calls, ['begin', 'complete', 'verify', 'logout']);
    assert.equal(signedIn, false);
});

test('provider inputs are captured before queueing and omitted rememberMe stays false', async () => {
    let releaseLogout;
    const pendingLogout = new Promise(resolve => { releaseLogout = resolve; });
    const input = { action: 'login', clientKey: 'google-web' };
    const api = createAuthApi(apiBase, async (url, init) => {
        if (url.endsWith('/auth/logout')) { await pendingLogout; return Response.json({ loggedOut: true }); }
        if (url.endsWith('/begin')) {
            assert.deepEqual(JSON.parse(init.body), { action: 'login', clientKey: 'google-web' });
            return Response.json(providerChallenge);
        }
        if (url.endsWith('/complete')) {
            assert.deepEqual(JSON.parse(init.body), { action: 'login', clientKey: 'google-web', rememberMe: false,
                state: providerChallenge.state, idToken: providerToken });
            return Response.json({ success: true, user_name: 'Player' });
        }
        return Response.json({ loggedIn: true, user_name: 'Player' });
    });
    const logout = api.logoutRequest();
    const login = api.runProviderAuthentication(input, async () => providerToken);
    input.action = 'link'; input.clientKey = 'changed'; input.password = 'changed'; input.rememberMe = true;
    releaseLogout();
    await logout;
    assert.deepEqual(await login, { success: true, user_name: 'Player' });
});

test('prepared provider login releases the idle queue and sends only server-owned challenge fields on completion', async () => {
    const calls = [];
    const api = createAuthApi(apiBase, async (url, init) => {
        calls.push(url);
        assert.equal(init.credentials, 'include');
        assert.equal(init.signal, undefined);
        if (url.endsWith('/begin')) {
            assert.deepEqual(JSON.parse(init.body), { action: 'login', clientKey: 'google-web' });
            return Response.json(providerChallenge);
        }
        if (url.endsWith('/auth/renew')) return Response.json({ loggedIn: false });
        if (url.endsWith('/complete')) {
            assert.deepEqual(JSON.parse(init.body), { action: 'login', clientKey: 'google-web',
                state: providerChallenge.state, idToken: providerToken, rememberMe: true });
            return Response.json({ success: true, user_name: 'Player' });
        }
        return Response.json({ loggedIn: true, user_name: 'Player' });
    });
    const prepared = await api.prepareProviderLogin('google-web');
    assert.deepEqual(prepared.challenge, providerChallenge);
    assert.equal(Object.isFrozen(prepared.challenge), true);
    assert.throws(() => { prepared.challenge.state = 'caller-supplied-state'; }, TypeError);
    prepared.challenge = { ...prepared.challenge, state: 'caller-supplied-state' };
    assert.equal(Object.isFrozen(prepared.handle), true);
    assert.deepEqual(Object.keys(prepared.handle), [], 'state, cookie proof and client selection stay private');
    assert.deepEqual(await api.renewRequest(), { loggedIn: false }, 'idle provider cannot block anonymous renewal');
    assert.deepEqual(await api.completeProviderLogin(prepared.handle, providerToken, { rememberMe: true }),
        { success: true, user_name: 'Player' });
    assert.deepEqual(calls, ['/auth/providers/begin', '/auth/renew', '/auth/providers/complete', '/auth/verify-token']
        .map(path => apiBase + path));
});

test('prepared login does not hold up password login, and its late credential cannot follow the newer password intent', async () => {
    const calls = [];
    const api = createAuthApi(apiBase, async url => {
        calls.push(url);
        if (url.endsWith('/begin')) return Response.json(providerChallenge);
        if (url.endsWith('/api/users')) return Response.json({ success: true, user_name: 'Player' });
        if (url.endsWith('/auth/verify-token')) return Response.json({ loggedIn: true, user_name: 'Player' });
        assert.fail('stale provider completion must not be sent');
    });
    const prepared = await api.prepareProviderLogin('google-web');
    const passwordLogin = api.loginRequest(credentials);
    assert.deepEqual(await api.completeProviderLogin(prepared.handle, providerToken), { error: 'CANCELLED' });
    assert.deepEqual(await passwordLogin, { success: true, user_name: 'Player' });
    assert.equal(calls.length, 3);
});

test('a prepared handle belongs to one API instance and cannot be forged, copied or completed twice', async () => {
    const calls = [];
    const api = createAuthApi(apiBase, async (url, init) => {
        calls.push(url);
        if (url.endsWith('/begin')) return Response.json(providerChallenge);
        if (url.endsWith('/complete')) {
            assert.equal(JSON.parse(init.body).rememberMe, false);
            return Response.json({ success: true, user_name: 'Player' });
        }
        return Response.json({ loggedIn: true, user_name: 'Player' });
    });
    const otherApi = createAuthApi(apiBase, async () => assert.fail('foreign handle cannot send a request'));
    const prepared = await api.prepareProviderLogin('google-web');
    for (const handle of [null, undefined, '', 1, {}, { ...prepared.handle }, { state: providerChallenge.state }]) {
        assert.deepEqual(await api.completeProviderLogin(handle, providerToken), { error: 'INVALID_ATTEMPT' });
    }
    assert.deepEqual(await otherApi.completeProviderLogin(prepared.handle, providerToken), { error: 'INVALID_ATTEMPT' });
    const first = api.completeProviderLogin(prepared.handle, providerToken);
    assert.deepEqual(await api.completeProviderLogin(prepared.handle, providerToken), { error: 'INVALID_ATTEMPT' });
    assert.deepEqual(await first, { success: true, user_name: 'Player' });
    assert.equal(calls.length, 3);
});

test('split provider methods reject malformed options, caller challenge fields and oversized tokens', async () => {
    const calls = [];
    const api = createAuthApi(apiBase, async url => { calls.push(url); return Response.json(providerChallenge); });
    for (const clientKey of [null, undefined, '', '../google', 'A'.repeat(65)]) {
        assert.deepEqual(await api.prepareProviderLogin(clientKey), { error: 'INVALID_REQUEST' });
    }
    for (const options of [null, [], { signal: {} }, { nonce: providerChallenge.nonce }, { rememberMe: true }]) {
        assert.deepEqual(await api.prepareProviderLogin('google-web', options), { error: 'INVALID_REQUEST' });
    }
    assert.equal(calls.length, 0);
    const prepared = await api.prepareProviderLogin('google-web');
    for (const options of [null, [], { signal: false }, { rememberMe: 'true' }, { password: 'private' },
        { state: providerChallenge.state }, { clientKey: 'apple-ios' }]) {
        assert.deepEqual(await api.completeProviderLogin(prepared.handle, providerToken, options), { error: 'INVALID_REQUEST' });
    }
    for (const token of [null, '', 'not.jwt', 'a.b.' + 'c'.repeat(16_384)]) {
        const attempt = await api.prepareProviderLogin('google-web');
        assert.deepEqual(await api.completeProviderLogin(attempt.handle, token), { error: 'INVALID_PROVIDER_TOKEN' });
        assert.deepEqual(await api.completeProviderLogin(attempt.handle, providerToken), { error: 'INVALID_ATTEMPT' });
    }
    assert.ok(calls.every(url => url.endsWith('/begin')));
});

test('new provider preparation and every explicit auth mutation invalidate earlier prepared handles immediately', async () => {
    for (const mutate of [api => api.prepareProviderLogin('apple-ios'), api => api.signupRequest(registration),
        api => api.logoutRequest(), api => api.deleteAccountRequest('password'),
        api => api.runProviderAuthentication(providerInput, async () => providerToken)]) {
        const api = createAuthApi(apiBase, async url => {
            if (url.endsWith('/begin')) return Response.json(providerChallenge);
            if (url.endsWith('/auth/logout')) return Response.json({ loggedOut: true });
            if (url.endsWith('/auth/delete-account')) return Response.json({ deleted: true });
            if (url.endsWith('/auth/verify-token')) return Response.json({ loggedIn: true, user_name: 'Player' });
            return Response.json({ success: true, user_name: 'Player' });
        });
        const prepared = await api.prepareProviderLogin('google-web');
        const mutation = mutate(api);
        assert.deepEqual(await api.completeProviderLogin(prepared.handle, providerToken), { error: 'CANCELLED' });
        await mutation;
    }
});

test('an authenticated or uncertain renewal invalidates a queued provider completion before its transport starts', async () => {
    for (const response of [{ loggedIn: true, user_name: 'Player' }, { loggedIn: true }, null]) {
        let releaseRenewal;
        const renewalResponse = new Promise(resolve => { releaseRenewal = resolve; });
        const calls = [];
        const api = createAuthApi(apiBase, async url => {
            calls.push(url);
            if (url.endsWith('/begin')) return Response.json(providerChallenge);
            if (url.endsWith('/auth/renew')) {
                await renewalResponse;
                if (response === null) throw new Error('uncertain cookie rotation');
                return Response.json(response);
            }
            assert.fail('completion cannot use a possibly replaced cookie binding');
        });
        const prepared = await api.prepareProviderLogin('google-web');
        const renewal = api.renewRequest().catch(() => undefined);
        const completion = api.completeProviderLogin(prepared.handle, providerToken);
        await nextTurn();
        releaseRenewal();
        await renewal;
        assert.deepEqual(await completion, { error: 'CANCELLED' });
        assert.equal(calls.length, 2);
    }
});

test('prepared challenge lifetime counts begin response latency and is checked again before queued completion', async t => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    for (const expireDuringBegin of [true, false]) {
        let release;
        const blocked = new Promise(resolve => { release = resolve; });
        const api = createAuthApi(apiBase, async url => {
            if (url.endsWith('/begin')) {
                if (expireDuringBegin) await blocked;
                return Response.json({ ...providerChallenge, expiresInSeconds: 1 });
            }
            if (url.endsWith('/auth/renew')) { await blocked; return Response.json({ loggedIn: false }); }
            assert.fail('expired challenge cannot send completion');
        });
        const preparing = api.prepareProviderLogin('google-web');
        if (expireDuringBegin) {
            await nextTurn();
            t.mock.timers.tick(1000);
            release();
            assert.deepEqual(await preparing, { error: 'INVALID_ATTEMPT' });
        } else {
            const prepared = await preparing;
            const renewal = api.renewRequest();
            const completion = api.completeProviderLogin(prepared.handle, providerToken);
            await nextTurn();
            t.mock.timers.tick(1000);
            release();
            await renewal;
            assert.deepEqual(await completion, { error: 'INVALID_ATTEMPT' });
        }
    }
});

test('cancelled preparation sends nothing if queued, but awaits an already-sent cookie mutation before releasing password login', async () => {
    const cancelled = new AbortController();
    cancelled.abort();
    const noFetch = createAuthApi(apiBase, async () => assert.fail('aborted preparation cannot fetch'));
    assert.deepEqual(await noFetch.prepareProviderLogin('google-web', { signal: cancelled.signal }), { error: 'CANCELLED' });
    const controller = new AbortController();
    let releaseBegin;
    const begin = new Promise(resolve => { releaseBegin = resolve; });
    const calls = [];
    const api = createAuthApi(apiBase, async url => {
        calls.push(url);
        if (url.endsWith('/begin')) { await begin; return Response.json(providerChallenge); }
        if (url.endsWith('/api/users')) return Response.json({ success: true, user_name: 'Player' });
        return Response.json({ loggedIn: true, user_name: 'Player' });
    });
    const preparation = api.prepareProviderLogin('google-web', { signal: controller.signal });
    await nextTurn();
    controller.abort();
    const passwordLogin = api.loginRequest(credentials);
    await nextTurn();
    assert.equal(calls.length, 1);
    releaseBegin();
    assert.deepEqual(await preparation, { error: 'CANCELLED' });
    assert.deepEqual(await passwordLogin, { success: true, user_name: 'Player' });
    assert.equal(calls.length, 3);
});

test('cancelling an idle or queued prepared completion ignores late credentials without changing cookies', async () => {
    for (const useCompletionSignal of [false, true]) {
        const controller = new AbortController();
        const calls = [];
        const api = createAuthApi(apiBase, async url => {
            calls.push(url);
            return Response.json(url.endsWith('/begin') ? providerChallenge : { loggedIn: false });
        });
        const prepared = await api.prepareProviderLogin('google-web', useCompletionSignal ? {} : { signal: controller.signal });
        const completion = api.completeProviderLogin(prepared.handle, providerToken,
            useCompletionSignal ? { signal: controller.signal } : {});
        controller.abort();
        assert.deepEqual(await completion, { error: 'CANCELLED' });
        assert.equal(calls.length, 1);
    }
});

test('split completion waits for accepted cookie response and verification despite cancellation before queued logout', async () => {
    const controller = new AbortController();
    let releaseComplete;
    let releaseVerification;
    const completed = new Promise(resolve => { releaseComplete = resolve; });
    const verified = new Promise(resolve => { releaseVerification = resolve; });
    const calls = [];
    const api = createAuthApi(apiBase, async url => {
        if (url.endsWith('/begin')) { calls.push('begin'); return Response.json(providerChallenge); }
        if (url.endsWith('/complete')) {
            calls.push('complete'); await completed;
            return Response.json({ success: true, user_name: 'Player' });
        }
        if (url.endsWith('/auth/verify-token')) {
            calls.push('verify'); await verified;
            return Response.json({ loggedIn: true, user_name: 'Player' });
        }
        calls.push('logout'); return Response.json({ loggedOut: true });
    });
    const prepared = await api.prepareProviderLogin('google-web', { signal: controller.signal });
    const completion = api.completeProviderLogin(prepared.handle, providerToken);
    await nextTurn();
    controller.abort();
    const logout = api.logoutRequest();
    await nextTurn();
    assert.deepEqual(calls, ['begin', 'complete']);
    releaseComplete();
    await nextTurn();
    assert.deepEqual(calls, ['begin', 'complete', 'verify']);
    releaseVerification();
    assert.deepEqual(await completion, { success: true, user_name: 'Player' });
    await logout;
    assert.deepEqual(calls, ['begin', 'complete', 'verify', 'logout']);
});

test('split completion requires the same exact saved-cookie verification as the original provider flow', async () => {
    const api = createAuthApi(apiBase, async url => Response.json(url.endsWith('/begin') ? providerChallenge
        : url.endsWith('/complete') ? { success: true, user_name: 'Player' } : { loggedIn: false }));
    const prepared = await api.prepareProviderLogin('google-web');
    assert.deepEqual(await api.completeProviderLogin(prepared.handle, providerToken), { error: 'SESSION_NOT_ESTABLISHED' });
});

for (const clientKey of ['google-web', 'apple-ios']) {
test(`new ${clientKey} entry retains its proof through an opaque username continuation without a second begin`, async () => {
    const calls = [];
    const signupChallenge = { ...providerChallenge, state: Buffer.alloc(32, 3).toString('base64url'), expiresInSeconds: 200 };
    const api = createAuthApi(apiBase, async (url, init) => {
        const body = init?.body ? JSON.parse(init.body) : undefined;
        calls.push({ url, body });
        if (url.endsWith('/begin')) return Response.json(providerChallenge);
        if (url.endsWith('/auth/verify-token')) return Response.json({ loggedIn: true, user_name: 'new-player' });
        return Response.json(body.action === 'login' ? { signupRequired: true, challenge: signupChallenge }
            : { success: true, user_name: 'new-player' });
    });
    const prepared = await api.prepareProviderLogin(clientKey);
    const next = await api.completeProviderLogin(prepared.handle, credentialFor(clientKey), { rememberMe: true });
    assert.equal(next.signupRequired, true);
    assert.deepEqual(Object.keys(next).sort(), ['handle', 'signupRequired']);
    assert.deepEqual(Object.keys(next.handle), []);
    assert.equal(calls.length, 2, 'no session verification or account creation before username consent');
    assert.deepEqual(calls[1].body, { action: 'login', clientKey, state: providerChallenge.state,
        ...(clientKey === 'apple-ios' ? appleCredential : { idToken: providerToken }), rememberMe: true });
    assert.deepEqual(await api.completeProviderLogin(next.handle, credentialFor(clientKey), { rememberMe: true, userName: ' new-player ' }),
        { success: true, user_name: 'new-player' });
    assert.deepEqual(calls[2].body, { clientKey, action: 'signup', state: signupChallenge.state,
        ...(clientKey === 'apple-ios' ? appleCredential : { idToken: providerToken }), rememberMe: true, userName: 'new-player' });
    assert.equal(calls.filter(call => call.url.endsWith('/begin')).length, 1);
    assert.deepEqual(await api.completeProviderLogin(next.handle, credentialFor(clientKey), { userName: 'again' }),
        { error: 'INVALID_ATTEMPT' });
});

test(`${clientKey} signup continuation rejects changed nonce, reused state and extra response fields`, async () => {
    for (const response of [
        { signupRequired: true, challenge: providerChallenge },
        { signupRequired: true, challenge: { ...providerChallenge, state: Buffer.alloc(32, 3).toString('base64url'),
            nonce: Buffer.alloc(32, 4).toString('base64url') } },
        { signupRequired: true, challenge: providerChallenge, email: 'private@example.test' },
    ]) {
        const api = createAuthApi(apiBase, async url => Response.json(url.endsWith('/begin') ? providerChallenge : response));
        const prepared = await api.prepareProviderLogin(clientKey);
        assert.deepEqual(await api.completeProviderLogin(prepared.handle, credentialFor(clientKey)), { error: 'INVALID_RESPONSE' });
    }
});

test(`${clientKey} continuation inherits original expiry and is invalidated by logout or cancellation`, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    for (const invalidation of ['expiry', 'logout', 'abort']) {
        const controller = new AbortController();
        const calls = [];
        const api = createAuthApi(apiBase, async url => {
            calls.push(url);
            return Response.json(url.endsWith('/begin') ? { ...providerChallenge, expiresInSeconds: 2 }
                : url.endsWith('/auth/logout') ? { loggedOut: true }
                : { signupRequired: true, challenge: { ...providerChallenge,
                    state: Buffer.alloc(32, 3).toString('base64url'), expiresInSeconds: 300 } });
        });
        const prepared = await api.prepareProviderLogin(clientKey, { signal: controller.signal });
        const next = await api.completeProviderLogin(prepared.handle, credentialFor(clientKey));
        assert.equal(next.signupRequired, true);
        if (invalidation === 'expiry') t.mock.timers.tick(2000);
        else if (invalidation === 'logout') await api.logoutRequest();
        else controller.abort();
        const before = calls.length;
        assert.deepEqual(await api.completeProviderLogin(next.handle, credentialFor(clientKey), { userName: 'new-player' }),
            { error: invalidation === 'expiry' ? 'INVALID_ATTEMPT' : 'CANCELLED' });
        assert.equal(calls.length, before);
    }
});
}
