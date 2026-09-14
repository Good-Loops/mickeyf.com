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

test('signup, deletion, login and logout share one ordered mutation queue', async () => {
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
        calls.push('logout');
        return Response.json({ loggedOut: true });
    });

    await Promise.all([
        api.signupRequest(registration),
        api.deleteAccountRequest('test-only'),
        api.loginRequest(credentials),
        api.logoutRequest(),
    ]);
    assert.deepEqual(calls, ['signup', 'delete', 'login', 'verify', 'logout']);
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
