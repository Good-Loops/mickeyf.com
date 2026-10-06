import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { PUBLIC_API_PREFIX, publicApiMiddleware, publicApiPlugin } from '../../dev/publicApi.ts';

const publicOrigin = 'https://mickeyf-org-j7yuum4tiq-uc.a.run.app';
const localOrigin = 'http://localhost:5173';
const readRoutes = ['/auth/verify-token', '/api/leaderboards', '/api/leaderboards/p4-vega', '/api/leaderboards/three-bosses'];
const writeRoutes = ['/api/users', '/auth/logout', '/api/leaderboards/three-bosses/run-tickets', '/api/leaderboards/three-bosses/runs'];

async function invoke(middleware, options = {}) {
    const body = options.body ?? '';
    const request = Readable.from(options.chunks ?? (body ? [Buffer.from(body)] : []));
    request.method = options.method ?? 'GET';
    request.url = options.url ?? '/auth/verify-token';
    request.headers = { host: 'localhost:5173', ...options.headers };
    request.socket = { remoteAddress: options.remoteAddress ?? '::1' };
    const response = {
        statusCode: 200, headers: {},
        setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
        end(body) { this.body = body; },
    };
    await middleware(request, response, () => assert.fail('Reserved routes must not fall through'));
    return response;
}

const mutation = (url = '/api/users', body = { type: 'login', user_name: 'example', user_password: 'not-a-real-password' }) => ({
    method: 'POST', url, body: JSON.stringify(body),
    headers: { origin: localOrigin, 'content-type': 'application/json' },
});

test('gateway mounts only its reserved prefix and forwards fixed route/method pairs', async () => {
    const calls = [];
    const middleware = publicApiMiddleware(async (url, init) => {
        calls.push({ url, init });
        return Response.json({ success: true });
    });
    for (const url of readRoutes) assert.equal((await invoke(middleware, { url })).statusCode, 200);
    for (const url of writeRoutes) assert.equal((await invoke(middleware, mutation(url))).statusCode, url === '/auth/logout' ? 400 : 200);
    assert.equal((await invoke(middleware, mutation('/auth/logout', {}))).statusCode, 200);
    for (const { url, init } of calls) {
        assert.equal(new URL(url).origin, publicOrigin);
        assert.equal(init.redirect, 'error');
        assert.equal(init.credentials, 'omit');
        assert.ok(init.signal instanceof AbortSignal);
    }
    let mounted;
    const plugin = publicApiPlugin();
    plugin.configureServer({ middlewares: { use(prefix) { mounted = prefix; } } });
    assert.equal(plugin.apply, 'serve');
    assert.equal(mounted, PUBLIC_API_PREFIX);
});

test('local authentication headers never reach production; only the dedicated public cookie does', async () => {
    const calls = [];
    const middleware = publicApiMiddleware(async (_url, init) => {
        calls.push(init);
        return Response.json({ success: true });
    });
    await invoke(middleware, { headers: { cookie: 'session=local-old; __session=local-new', authorization: 'Bearer local-secret', 'x-forwarded-for': 'attacker' } });
    assert.deepEqual(calls[0].headers, { Accept: 'application/json' });
    const request = mutation();
    request.headers = { ...request.headers, cookie: 'session=local; ludolume_public_session=s%3Apublic.signature; __session=local-new', authorization: 'Bearer local-secret' };
    await invoke(middleware, request);
    assert.deepEqual(calls[1].headers, {
        Accept: 'application/json', Origin: localOrigin, Cookie: 'session=s%3Apublic.signature', 'Content-Type': 'application/json',
    });
});

test('public cookies retain expiry and clearing order in their isolated localhost namespace', async () => {
    const headers = new Headers({ 'Content-Type': 'application/json', 'X-Upstream-Only': 'private' });
    headers.append('Set-Cookie', 'session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; HttpOnly; SameSite=None');
    headers.append('Set-Cookie', 'session=s%3Apublic.signature; Max-Age=14400; Domain=example.com; Path=/; Expires=Fri, 18 Sep 2026 12:00:00 GMT; HttpOnly; Secure; SameSite=None');
    headers.append('Set-Cookie', '__session=unrelated; Path=/');
    const middleware = publicApiMiddleware(async () => new Response('{"success":true}', { headers }));
    const response = await invoke(middleware, mutation());
    assert.deepEqual(response.headers['set-cookie'], [
        `ludolume_public_session=; Path=${PUBLIC_API_PREFIX}; HttpOnly; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT`,
        `ludolume_public_session=s%3Apublic.signature; Path=${PUBLIC_API_PREFIX}; HttpOnly; SameSite=Lax; Max-Age=14400; Expires=Fri, 18 Sep 2026 12:00:00 GMT`,
    ]);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['x-upstream-only'], undefined);
    assert.equal(response.headers['access-control-allow-origin'], undefined);
});

test('empty logout POST still requires the real Origin and relays upstream cookie deletion', async () => {
    const middleware = publicApiMiddleware(async (_url, init) => {
        assert.equal(init.body, undefined);
        assert.equal(init.headers.Origin, localOrigin);
        return Response.json({ loggedOut: true }, { headers: { 'Set-Cookie': 'session=; Max-Age=0; Path=/; HttpOnly; Secure' } });
    });
    const result = await invoke(middleware, { method: 'POST', url: '/auth/logout', headers: { origin: localOrigin } });
    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.headers['set-cookie'], [`ludolume_public_session=; Path=${PUBLIC_API_PREFIX}; HttpOnly; SameSite=Lax; Max-Age=0`]);
});

test('spoofed hosts/origins and remote clients never make upstream requests', async () => {
    const middleware = publicApiMiddleware(async () => assert.fail('Forbidden request reached production'));
    const cases = [
        { headers: { host: 'attacker.example:5173' } },
        { headers: { host: '127.0.0.1:5173' } },
        { headers: { host: 'localhost:5176' } },
        { headers: { origin: 'https://attacker.example' } },
        { remoteAddress: '192.168.0.2' },
        { remoteAddress: '::ffff:192.168.0.2' },
        { ...mutation(), headers: { 'content-type': 'application/json' } },
        { ...mutation(), headers: { origin: 'https://mickeyf.com', 'content-type': 'application/json' } },
        { ...mutation(), headers: { origin: 'null', 'content-type': 'application/json' } },
    ];
    for (const request of cases) assert.equal((await invoke(middleware, request)).statusCode, 403);
});

test('unknown methods, provider/admin operations, queries and traversal never reach production', async () => {
    const middleware = publicApiMiddleware(async () => assert.fail('Unlisted route reached production'));
    const cases = [
        { url: '/api/leaderboards?limit=1000' }, { url: '/api/leaderboards/' },
        { url: '/api/leaderboards/../users' }, { url: '/api/leaderboards/%2e%2e/users' },
        { url: '//attacker.example/api/leaderboards' }, { url: 'https://attacker.example' },
        { url: '/auth/providers/config' }, { url: '/auth/providers/account' },
        { method: 'PUT', url: '/api/users' }, { method: 'GET', url: '/api/users' },
        mutation('/auth/renew'), mutation('/auth/account'),
        mutation('/api/users', { type: 'get_leaderboard' }),
        mutation('/api/users', { type: 'delete_account' }),
    ];
    for (const request of cases) assert.equal((await invoke(middleware, request)).statusCode, 404);
});

test('only the three deployed user mutation operations are allowed', async () => {
    const middleware = publicApiMiddleware(async (_url, init) => {
        assert.ok(['login', 'signup', 'submit_score'].includes(JSON.parse(init.body).type));
        return Response.json({ success: true });
    });
    for (const type of ['login', 'signup', 'submit_score']) {
        assert.equal((await invoke(middleware, mutation('/api/users', { type }))).statusCode, 200);
    }
});

test('JSON requirements and body size limits apply before any production request', async () => {
    const middleware = publicApiMiddleware(async () => assert.fail('Invalid body reached production'));
    const cases = [
        [{ ...mutation(), body: 'not json' }, 400],
        [{ ...mutation(), body: '[]' }, 400],
        [{ ...mutation(), body: 'null' }, 400],
        [{ ...mutation(), headers: { origin: localOrigin, 'content-type': 'text/plain' } }, 415],
        [{ ...mutation(), headers: { origin: localOrigin, 'content-type': 'application/json', 'content-encoding': 'gzip' } }, 415],
        [{ ...mutation(), body: 'x'.repeat(32 * 1024 + 1) }, 413],
        [{ ...mutation(), chunks: [Buffer.alloc(20_000), Buffer.alloc(20_000)] }, 413],
        [{ ...mutation(), headers: { origin: localOrigin, 'content-length': '40000' } }, 413],
        [{ headers: { 'content-length': '1' }, body: 'x' }, 400],
    ];
    for (const [request, status] of cases) assert.equal((await invoke(middleware, request)).statusCode, status);
});

test('ambiguous or malformed public cookies are rejected rather than mixing sessions', async () => {
    const middleware = publicApiMiddleware(async () => assert.fail('Invalid cookie reached production'));
    for (const cookie of [
        'ludolume_public_session=one; ludolume_public_session=two',
        'ludolume_public_session=bad value',
        'ludolume_public_session="quoted"',
        `ludolume_public_session=${'x'.repeat(8_193)}`,
    ]) assert.equal((await invoke(middleware, { headers: { cookie } })).statusCode, 400);
});

test('upstream errors retain their status without private headers, while transport errors stay generic', async () => {
    const denied = publicApiMiddleware(async () => Response.json({ error: 'AUTH_FAILED' }, { status: 401, headers: { 'X-Internal': 'private' } }));
    const result = await invoke(denied);
    assert.equal(result.statusCode, 401);
    assert.equal(result.body, '{"error":"AUTH_FAILED"}');
    assert.equal(result.headers['x-internal'], undefined);
    const unavailable = publicApiMiddleware(async () => { throw new Error('private request details'); });
    const failure = await invoke(unavailable);
    assert.equal(failure.statusCode, 502);
    assert.equal(failure.body, '{"error":"PUBLIC_API_UNAVAILABLE"}');
    const html = publicApiMiddleware(async () => new Response('<html>not API</html>'));
    assert.equal((await invoke(html)).statusCode, 502);
});

test('renewable public transport explicitly allows provider entry and renewal without opening admin routes', async () => {
    const calls = [];
    const middleware = publicApiMiddleware(async (url, init) => {
        calls.push({ url, init });
        return Response.json({ success: true });
    }, 'renewable');
    for (const url of ['/auth/providers/config', '/auth/providers/account']) {
        assert.equal((await invoke(middleware, { url })).statusCode, 200);
    }
    for (const url of ['/auth/providers/begin', '/auth/providers/complete']) {
        for (const action of ['login', 'signup', 'link']) {
            assert.equal((await invoke(middleware, mutation(url, { action, clientKey: 'google-web' }))).statusCode, 200);
        }
    }
    assert.equal((await invoke(middleware, mutation('/auth/renew', {}))).statusCode, 200);
    assert.equal(calls.length, 9);
    for (const request of [
        mutation('/auth/providers/complete', { action: 'delete' }),
        mutation('/auth/providers/begin', { action: 'unknown' }),
        mutation('/auth/account'), { url: '/auth/providers/config?enable=true' },
        { url: '/auth/providers/complete' }, mutation('/auth/renew', { session: 'injected' }),
    ]) assert.ok((await invoke(middleware, request)).statusCode >= 400);
    assert.equal(calls.length, 9, 'Rejected operations never reach the public backend');
    for (const { url, init } of calls) {
        assert.equal(new URL(url).origin, publicOrigin);
        if (init.method === 'POST') assert.equal(init.headers.Origin, localOrigin);
    }
});

test('renewable transport keeps anonymous Google binding and signed session in a separate public namespace', async () => {
    const calls = [];
    const middleware = publicApiMiddleware(async (_url, init) => {
        calls.push(init);
        const headers = new Headers({ 'Content-Type': 'application/json' });
        // Both anonymous challenge binding and authenticated sessions use the canonical web cookie.
        headers.append('Set-Cookie', '__session=s%3Abinding.signature; Max-Age=300; Path=/; Secure; HttpOnly');
        headers.append('Set-Cookie', 'session=do-not-map-native; Path=/');
        return new Response('{"state":"synthetic-state"}', { headers });
    }, 'renewable');
    const begin = mutation('/auth/providers/begin', { action: 'login', clientKey: 'google-web' });
    begin.headers.cookie = 'session=local; __session=local-web; ludolume_public_session=old-public';
    const response = await invoke(middleware, begin);
    assert.equal(calls[0].headers.Cookie, undefined, 'Neither local credentials nor old public sessions are reused');
    assert.deepEqual(response.headers['set-cookie'], [
        `ludolume_public_web_session=s%3Abinding.signature; Path=${PUBLIC_API_PREFIX}; HttpOnly; SameSite=Lax; Max-Age=300`,
    ]);
    const complete = mutation('/auth/providers/complete', { action: 'login', clientKey: 'google-web', state: 'synthetic-state', idToken: 'synthetic-token' });
    complete.headers.cookie = `${begin.headers.cookie}; ludolume_public_web_session=s%3Abinding.signature`;
    complete.headers.authorization = 'Bearer do-not-forward';
    await invoke(middleware, complete);
    assert.equal(calls[1].headers.Cookie, '__session=s%3Abinding.signature');
    assert.equal(calls[1].headers.Authorization, undefined);
    assert.equal(calls[1].headers.Origin, localOrigin);
    assert.equal(calls[1].body, complete.body);
});

test('renewable cookie clearing preserves clear-then-set order without relaying native cookies', async () => {
    const headers = new Headers({ 'Content-Type': 'application/json' });
    headers.append('Set-Cookie', 'session=; Max-Age=0; Path=/');
    headers.append('Set-Cookie', '__session=; Max-Age=0; Path=/');
    headers.append('Set-Cookie', '__session=s%3Arenewed.signature; Max-Age=2592000; Secure; HttpOnly; Path=/');
    const middleware = publicApiMiddleware(async () => new Response('{"loggedIn":true}', { headers }), 'renewable');
    const result = await invoke(middleware, mutation('/auth/renew', {}));
    assert.deepEqual(result.headers['set-cookie'], [
        `ludolume_public_web_session=; Path=${PUBLIC_API_PREFIX}; HttpOnly; SameSite=Lax; Max-Age=0`,
        `ludolume_public_web_session=s%3Arenewed.signature; Path=${PUBLIC_API_PREFIX}; HttpOnly; SameSite=Lax; Max-Age=2592000`,
    ]);
});

test('renewable requests retain exact Origin, loopback and unambiguous cookie requirements', async () => {
    const middleware = publicApiMiddleware(async () => assert.fail('Unsafe provider request reached production'), 'renewable');
    const request = mutation('/auth/providers/begin', { action: 'login', clientKey: 'google-web' });
    for (const headers of [{ host: 'localhost:5176' }, { origin: 'https://mickeyf.com' }, { origin: undefined }]) {
        assert.equal((await invoke(middleware, { ...request, headers: { ...request.headers, ...headers } })).statusCode, 403);
    }
    assert.equal((await invoke(middleware, { ...request, remoteAddress: '192.168.0.2' })).statusCode, 403);
    for (const cookie of ['ludolume_public_web_session=one; ludolume_public_web_session=two',
        'ludolume_public_web_session=bad value']) {
        assert.equal((await invoke(middleware, { ...request, headers: { ...request.headers, cookie } })).statusCode, 400);
    }
    assert.throws(() => publicApiMiddleware(fetch, 'automatic'), /Unknown public authentication protocol/);
});

const deletionRequests = [
    mutation('/auth/delete-account', { password: 'synthetic-password', confirmation: 'DELETE' }),
    mutation('/auth/providers/begin', { action: 'delete', clientKey: 'google-web' }),
    mutation('/auth/providers/complete', { action: 'delete', clientKey: 'google-web',
        state: 'synthetic-state', idToken: 'synthetic-token', confirmation: 'DELETE' }),
];

test('renewable self-deletion forwards unchanged proof and only the selected public session', async () => {
    const calls = [];
    const middleware = publicApiMiddleware(async (url, init) => {
        calls.push({ url, init });
        return Response.json({ accepted: true });
    }, 'renewable');
    for (const request of deletionRequests) {
        const response = await invoke(middleware, { ...request, headers: { ...request.headers,
            cookie: 'session=local; __session=local-web; ludolume_public_session=legacy; ludolume_public_web_session=s%3Apublic.signature',
            authorization: 'Bearer local-token', 'x-account-id': 'another-account',
        } });
        assert.equal(response.statusCode, 200);
        const call = calls.at(-1);
        assert.equal(call.url, `${publicOrigin}${request.url}`);
        assert.equal(call.init.method, 'POST');
        assert.equal(call.init.body, request.body);
        assert.deepEqual(call.init.headers, { Accept: 'application/json', Origin: localOrigin,
            Cookie: '__session=s%3Apublic.signature', 'Content-Type': 'application/json' });
        assert.equal(call.init.redirect, 'error');
    }
    assert.equal(calls.length, deletionRequests.length);
});

test('legacy mode still refuses every deletion path before contacting the backend', async () => {
    const middleware = publicApiMiddleware(async () => assert.fail('Legacy mode forwarded deletion'));
    for (const request of deletionRequests) assert.equal((await invoke(middleware, request)).statusCode, 404);
});

test('self-deletion rejects account selectors, missing confirmation/proof and unapproved clients', async () => {
    const middleware = publicApiMiddleware(async () => assert.fail('Invalid deletion reached the backend'), 'renewable');
    for (const request of deletionRequests) {
        const body = JSON.parse(request.body);
        const invalid = [{ ...body, userId: 42 }, { ...body, accountId: 'someone-else' },
            ...Object.keys(body).map(key => Object.fromEntries(Object.entries(body).filter(([field]) => field !== key)))];
        if ('confirmation' in body) invalid.push({ ...body, confirmation: 'delete' });
        if ('password' in body) invalid.push({ ...body, password: '' }, { ...body, password: null });
        if ('clientKey' in body) invalid.push({ ...body, clientKey: 'google-ios' }, { ...body, clientKey: 'apple-web' });
        if ('state' in body) invalid.push({ ...body, state: '' }, { ...body, idToken: null });
        for (const changed of invalid) {
            assert.ok((await invoke(middleware, mutation(request.url, changed))).statusCode >= 400);
        }
    }
});

test('deletion retains exact route, method, loopback, Origin, JSON and body-size restrictions', async () => {
    const middleware = publicApiMiddleware(async () => assert.fail('Unsafe deletion reached the backend'), 'renewable');
    for (const request of deletionRequests) {
        for (const changed of [
            { ...request, method: 'DELETE' }, { ...request, method: 'GET' },
            { ...request, url: `${request.url}?accountId=42` },
            { ...request, headers: { ...request.headers, origin: undefined } },
            { ...request, headers: { ...request.headers, origin: 'https://mickeyf.com' } },
            { ...request, headers: { ...request.headers, host: '127.0.0.1:5173' } },
            { ...request, headers: { ...request.headers, 'content-type': 'text/plain' } },
            { ...request, remoteAddress: '192.168.0.2' },
            { ...request, body: 'x'.repeat(32 * 1024 + 1) },
        ]) assert.ok((await invoke(middleware, changed)).statusCode >= 400);
    }
});

test('confirmed deletion relays the result and clears only the renewable public cookie', async () => {
    for (const request of [deletionRequests[0], deletionRequests[2]]) {
        const result = request.url === '/auth/delete-account' ? { deleted: true } : { success: true, deleted: true };
        const headers = new Headers({ 'Content-Type': 'application/json' });
        headers.append('Set-Cookie', '__session=; Max-Age=0; Path=/; HttpOnly; Secure');
        headers.append('Set-Cookie', 'session=; Max-Age=0; Path=/; HttpOnly; Secure');
        const middleware = publicApiMiddleware(async () => new Response(JSON.stringify(result), { headers }), 'renewable');
        const response = await invoke(middleware, request);
        assert.equal(response.statusCode, 200);
        assert.deepEqual(JSON.parse(response.body), result);
        assert.deepEqual(response.headers['set-cookie'], [
            `ludolume_public_web_session=; Path=${PUBLIC_API_PREFIX}; HttpOnly; SameSite=Lax; Max-Age=0`,
        ]);
    }
});

test('unconfirmed deletion preserves errors without inventing success, clearing cookies or retrying', async () => {
    for (const request of [deletionRequests[0], deletionRequests[2]]) {
        for (const [status, error] of [[401, 'UNAUTHENTICATED'], [403, 'INVALID_PASSWORD'],
            [503, 'ACCOUNT_DELETION_PENDING'], [503, 'ACCOUNT_DELETION_UNAVAILABLE'], [429, 'RATE_LIMITED'],
            [502, 'PUBLIC_API_UNAVAILABLE']]) {
            let calls = 0;
            const middleware = publicApiMiddleware(async () => {
                calls++;
                if (status === 502) throw new Error('private transport details');
                return Response.json({ error }, { status });
            }, 'renewable');
            const response = await invoke(middleware, request);
            assert.equal(calls, 1);
            assert.equal(response.statusCode, status);
            assert.deepEqual(JSON.parse(response.body), { error });
            assert.equal(response.headers['set-cookie'], undefined);
        }
    }
});
