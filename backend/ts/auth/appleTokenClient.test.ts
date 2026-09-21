import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import jwt from 'jsonwebtoken';
import { APPLE_OPAQUE_TOKEN_MAX_LENGTH, APPLE_TOKEN_REQUEST_TIMEOUT_MS, AppleTokenClientError,
    createAppleTokenClient, type AppleTokenClientConfiguration } from './appleTokenClient';

const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const configuration: AppleTokenClientConfiguration = {
    clientId: 'com.example.synthetic', teamId: 'TEAM123456', keyId: 'KEY1234567',
    privateKey: key.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
};
const nowSeconds = 1_800_000_000;
const identityToken = 'synthetic.identity.signature';
const refreshToken = 'synthetic-refresh+token/=&%';
const authorizationCode = 'synthetic-code+value/=&%';

function tokenResponse(extra: Record<string, unknown> = {}): Response {
    return Response.json({ id_token: identityToken, refresh_token: refreshToken,
        access_token: 'discard-this-access-token', token_type: 'Bearer', expires_in: 3600, ...extra });
}

function fixture(response: () => Response | Promise<Response> = tokenResponse) {
    const calls: { url: string; options: RequestInit }[] = [];
    let now = nowSeconds * 1_000;
    const client = createAppleTokenClient(configuration, {
        now: () => now,
        fetchRequest: async (url, options) => {
            calls.push({ url: String(url), options: options! });
            return response();
        },
    });
    return { client, calls, advance: (milliseconds: number) => { now += milliseconds; } };
}

function safeError(code: AppleTokenClientError['code']) {
    return (error: unknown) => {
        assert.ok(error instanceof AppleTokenClientError);
        assert.equal(error.code, code);
        assert.equal(error.message, 'Apple authorization could not be completed.');
        assert.equal('cause' in error, false);
        assert.deepEqual(Object.keys(error).sort(), ['code', 'name']);
        for (const secret of [configuration.privateKey, identityToken, refreshToken, authorizationCode, 'private details']) {
            assert.ok(!`${error.stack}\n${JSON.stringify(error)}`.includes(secret));
        }
        return true;
    };
}

test('native code exchange uses a fixed form endpoint and returns only the two required tokens', async () => {
    const f = fixture();
    const result = await f.client.exchangeCode(authorizationCode);
    assert.deepEqual(result, { idToken: identityToken, refreshToken });
    assert.ok(Object.isFrozen(result));
    assert.equal(f.calls.length, 1);
    const { url, options } = f.calls[0];
    assert.equal(url, 'https://appleid.apple.com/auth/token');
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.cache, 'no-store');
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.signal.aborted, false);
    assert.deepEqual(options.headers, { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' });
    const form = new URLSearchParams(options.body as string);
    assert.deepEqual([...form.keys()].sort(), ['client_id', 'client_secret', 'code', 'grant_type']);
    assert.equal(form.get('client_id'), configuration.clientId);
    assert.equal(form.get('grant_type'), 'authorization_code');
    assert.equal(form.get('code'), authorizationCode);
    assert.equal(form.has('redirect_uri'), false, 'native authorization supplied no redirect URI');
});

test('each request signs an ES256 client secret with exact audience, issuer, subject and five-minute expiry', async () => {
    const f = fixture();
    for (const offset of [0, 1_000]) {
        f.advance(offset);
        await f.client.exchangeCode(authorizationCode);
        const secret = new URLSearchParams(f.calls.at(-1)!.options.body as string).get('client_secret')!;
        const decoded = jwt.decode(secret, { complete: true })!;
        assert.deepEqual(decoded.header, { alg: 'ES256', typ: 'JWT', kid: configuration.keyId });
        const claims = jwt.verify(secret, key.publicKey, { algorithms: ['ES256'],
            issuer: configuration.teamId, audience: 'https://appleid.apple.com', subject: configuration.clientId,
            clockTimestamp: nowSeconds + offset / 1_000 });
        assert.deepEqual(claims, { iss: configuration.teamId, sub: configuration.clientId,
            aud: 'https://appleid.apple.com', iat: nowSeconds + offset / 1_000, exp: nowSeconds + offset / 1_000 + 300 });
    }
});

test('revocation accepts Apple HTTP 200 with no body and sends the refresh-token hint', async () => {
    const f = fixture(() => new Response(null, { status: 200 }));
    assert.equal(await f.client.revoke(refreshToken), undefined);
    const { url, options } = f.calls[0];
    assert.equal(url, 'https://appleid.apple.com/auth/revoke');
    assert.equal(options.redirect, 'error');
    const form = new URLSearchParams(options.body as string);
    assert.deepEqual([...form.keys()].sort(), ['client_id', 'client_secret', 'token', 'token_type_hint']);
    assert.equal(form.get('client_id'), configuration.clientId);
    assert.equal(form.get('token'), refreshToken);
    assert.equal(form.get('token_type_hint'), 'refresh_token');
    assert.equal(await fixture(() => Response.json({})).client.revoke(refreshToken), undefined);
});

test('invalid client identifiers, team-prefixed client IDs and malformed keys fail before any network operation', () => {
    const publicKey = key.publicKey.export({ format: 'pem', type: 'spki' }).toString();
    const wrongCurve = generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).privateKey
        .export({ format: 'pem', type: 'pkcs8' }).toString();
    const wrongType = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
        .export({ format: 'pem', type: 'pkcs8' }).toString();
    for (const override of [
        { clientId: '' }, { clientId: ' com.example.synthetic' }, { clientId: 'com.example.synthetic\n' },
        { clientId: 'https://example.test' }, { clientId: `${configuration.teamId}.com.example.synthetic` },
        { clientId: `com.${'x'.repeat(252)}` }, { teamId: 'TEAM12345' }, { teamId: 'team123456' },
        { teamId: 'TEAM123456\n' },
        { keyId: 'KEY1234567\n' }, { keyId: '' }, { privateKey: '' }, { privateKey: 'private details' },
        { privateKey: 'x'.repeat(16_385) }, { privateKey: publicKey }, { privateKey: wrongCurve }, { privateKey: wrongType },
    ]) {
        assert.throws(() => createAppleTokenClient({ ...configuration, ...override }, {
            fetchRequest: async () => { assert.fail('invalid configuration must not contact Apple'); },
        }), safeError('INVALID_CONFIGURATION'));
    }
});

test('code and refresh-token inputs are bounded opaque printable strings and never normalized', async () => {
    const f = fixture();
    for (const invalid of ['', ' ', '\tcode', 'code\n', 'code\r', 'code\r\n', 'a\0b', 'café', 'x'.repeat(4097), null, 42, {}]) {
        await assert.rejects(f.client.exchangeCode(invalid as string), safeError('INVALID_REQUEST'));
        await assert.rejects(f.client.revoke(invalid as string), safeError('INVALID_REQUEST'));
    }
    assert.equal(f.calls.length, 0);
    await f.client.exchangeCode('x'.repeat(APPLE_OPAQUE_TOKEN_MAX_LENGTH));
    assert.equal(new URLSearchParams(f.calls[0].options.body as string).get('code')!.length, 4096);
});

test('only a complete Apple HTTP 400 invalid_grant is classified as a definite invalid grant', async () => {
    for (const method of ['exchangeCode', 'revoke'] as const) {
        const f = fixture(() => Response.json({ error: 'invalid_grant', error_description: 'private details' }, { status: 400 }));
        await assert.rejects(f.client[method](authorizationCode), safeError('INVALID_GRANT'));
        assert.equal(f.calls.length, 1, 'single-use code requests are never automatically retried');
        for (const [status, error] of [[400, 'invalid_client'], [400, 'invalid_request'], [401, 'invalid_grant'],
            [429, 'invalid_grant'], [500, 'invalid_grant'], [200, 'invalid_grant']]) {
            await assert.rejects(fixture(() => Response.json({ error, error_description: 'private details' },
                { status: status as number })).client[method](authorizationCode), safeError('UNAVAILABLE'));
        }
    }
});

test('redirects, unknown successful statuses and malformed error bodies never become success', async () => {
    const responses = [
        () => new Response(null, { status: 302, headers: { location: 'https://other.example.test' } }),
        () => new Response(null, { status: 204 }),
        () => new Response('private details', { status: 400 }),
        () => Response.json({ error: 'invalid_grant' }, { status: 503 }),
        () => Object.defineProperty(tokenResponse(), 'redirected', { value: true }),
    ];
    for (const response of responses) {
        for (const method of ['exchangeCode', 'revoke'] as const) {
            const f = fixture(response);
            await assert.rejects(f.client[method](authorizationCode), safeError('UNAVAILABLE'));
            assert.equal(f.calls.length, 1);
            assert.equal(f.calls[0].options.signal!.aborted, true);
        }
    }
});

test('exchange rejects absent, malformed, oversized or inconsistent token responses', async () => {
    for (const response of [
        () => new Response(null), () => Response.json(null), () => Response.json([]), () => Response.json({}),
        () => tokenResponse({ id_token: 'not-a-jwt' }), () => tokenResponse({ id_token: 'a.b.' }),
        () => tokenResponse({ id_token: `${identityToken}\n` }),
        () => tokenResponse({ id_token: `${'a'.repeat(16_383)}.b.c` }),
        () => tokenResponse({ refresh_token: '' }), () => tokenResponse({ refresh_token: 'bad token' }),
        () => tokenResponse({ refresh_token: 'refresh-token\n' }),
        () => tokenResponse({ refresh_token: 'x'.repeat(4097) }), () => tokenResponse({ error: 'invalid_grant' }),
        () => new Response(JSON.stringify({ id_token: identityToken, refresh_token: refreshToken }),
            { headers: { 'content-type': 'text/html' } }),
        () => new Response('{private details', { headers: { 'content-type': 'application/json' } }),
        () => new Response(new Uint8Array([0xff]), { headers: { 'content-type': 'application/json' } }),
    ]) {
        await assert.rejects(fixture(response).client.exchangeCode(authorizationCode), safeError('UNAVAILABLE'));
    }
});

test('the bounded reader rejects excessive and malformed declared lengths before accepting tokens', async () => {
    for (const length of ['65537', '-1', 'Infinity', '1e3', 'private details']) {
        const f = fixture(() => new Response(JSON.stringify({ id_token: identityToken, refresh_token: refreshToken }),
            { headers: { 'content-type': 'application/json', 'content-length': length } }));
        await assert.rejects(f.client.exchangeCode(authorizationCode), safeError('UNAVAILABLE'));
    }
});

test('streamed response bytes are bounded without trusting content-length, and the reader is cancelled', async () => {
    for (const method of ['exchangeCode', 'revoke'] as const) {
        let cancelled = false;
        const f = fixture(() => new Response(new ReadableStream({
            start(controller) { controller.enqueue(new Uint8Array(65_537)); },
            cancel() { cancelled = true; },
        }), { headers: { 'content-type': 'application/json', 'content-length': '1' } }));
        await assert.rejects(f.client[method](authorizationCode), safeError('UNAVAILABLE'));
        assert.equal(cancelled, true);
    }
});

test('transport failures and invalid clocks are sanitized without retries', async () => {
    const f = fixture(() => { throw new Error(`private details ${configuration.privateKey}`); });
    await assert.rejects(f.client.exchangeCode(authorizationCode), safeError('UNAVAILABLE'));
    assert.equal(f.calls.length, 1);
    for (const now of [() => NaN, () => Infinity, () => -1, () => 0, () => 1.5,
        () => { throw new Error('private details'); }]) {
        const client = createAppleTokenClient(configuration, { now,
            fetchRequest: async () => { assert.fail('invalid clock must fail before sending credentials'); } });
        await assert.rejects(client.exchangeCode(authorizationCode), safeError('UNAVAILABLE'));
    }
});

test('the deadline covers stalled fetch even when the transport ignores abort', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture(() => new Promise<Response>(() => undefined));
    const request = f.client.exchangeCode(authorizationCode);
    const rejected = assert.rejects(request, safeError('UNAVAILABLE'));
    assert.equal(f.calls.length, 1);
    t.mock.timers.tick(APPLE_TOKEN_REQUEST_TIMEOUT_MS);
    await rejected;
    assert.equal(f.calls[0].options.signal!.aborted, true);
});

test('the same deadline bounds stalled body reads and cancels the reader', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let readerStarted!: () => void;
    const started = new Promise<void>(resolve => { readerStarted = resolve; });
    let cancelled = false;
    const f = fixture(() => new Response(new ReadableStream({
        pull() { readerStarted(); },
        cancel() { cancelled = true; },
    }), { headers: { 'content-type': 'application/json' } }));
    const rejected = assert.rejects(f.client.exchangeCode(authorizationCode), safeError('UNAVAILABLE'));
    await started;
    t.mock.timers.tick(APPLE_TOKEN_REQUEST_TIMEOUT_MS);
    await rejected;
    assert.equal(f.calls[0].options.signal!.aborted, true);
    assert.equal(cancelled, true);
});
