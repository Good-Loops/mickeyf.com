import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, KeyObject } from 'node:crypto';
import test from 'node:test';
import jwt from 'jsonwebtoken';
import type { IdentityProvider, VerifiedProviderIdentity } from './providerIdentity';
import {
    createProviderTokenVerifier,
    PROVIDER_JWKS_TIMEOUT_MS,
    PROVIDER_TOKEN_MAX_LENGTH,
} from './providerTokenVerifier';

const nowSeconds = 1_800_000_000;
const nonce = 'server-issued-attempt-nonce-with-32-bytes-or-more';
const googleAudience = 'server-selected-web-client.apps.googleusercontent.com';
const appleAudience = 'com.example.web-sign-in';
const firstKey = generateKeyPairSync('rsa', { modulusLength: 2_048 });
const rotatedKey = generateKeyPairSync('rsa', { modulusLength: 2_048 });
const invalidToken = { verified: false, reason: 'INVALID_PROVIDER_TOKEN' };
const unavailable = { verified: false, reason: 'PROVIDER_UNAVAILABLE' };

function publicJwk(publicKey = firstKey.publicKey, kid = 'provider-key-1') {
    return { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };
}

function claims(provider: IdentityProvider = 'google'): Record<string, unknown> {
    return {
        iss: provider === 'google' ? 'https://accounts.google.com' : 'https://appleid.apple.com',
        aud: provider === 'google' ? googleAudience : appleAudience,
        sub: 'Opaque.Mixed-CASE-provider-subject', nonce,
        iat: nowSeconds - 10, exp: nowSeconds + 3_600,
    };
}

function signedToken(
    payload: unknown = claims(),
    header: unknown = { alg: 'RS256', kid: 'provider-key-1', typ: 'JWT' },
    privateKey: KeyObject = firstKey.privateKey
): string {
    const input = [header, payload].map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
    return `${input}.${sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`;
}

function jwksResponse(keys: unknown[] = [publicJwk()], cacheControl = 'public, max-age=3600'): Response {
    return new Response(JSON.stringify({ keys }), {
        headers: { 'cache-control': cacheControl, 'content-type': 'application/json' },
    });
}

function fixture(options: {
    response?: () => Response | Promise<Response>;
    configuration?: Parameters<typeof createProviderTokenVerifier>[0];
} = {}) {
    let currentTime = nowSeconds * 1_000;
    const calls: { url: unknown; options: RequestInit | undefined }[] = [];
    const verifier = createProviderTokenVerifier(options.configuration ?? { googleAudience, appleAudience }, {
        now: () => currentTime,
        fetch: async (url, requestOptions) => {
            calls.push({ url, options: requestOptions });
            return options.response ? options.response() : jwksResponse();
        },
    });
    return { verifier, calls, advance: (milliseconds: number) => { currentTime += milliseconds; } };
}

test('plain decoded claims cannot be passed as a verified identity', () => {
    const plainIdentity = { provider: 'google' as const, subject: 'not-verified' };
    // @ts-expect-error Only the verifier may construct the private identity brand.
    const verifiedIdentity: VerifiedProviderIdentity = plainIdentity;
    assert.equal(verifiedIdentity, plainIdentity);
});

test('only authoritative Google-signed verified email is exposed, normalized and bounded for signup', async () => {
    const { verifier } = fixture();
    for (const [extra, expected] of [
        [{ email: ' Player@GMAIL.COM ', email_verified: true }, 'player@gmail.com'],
        [{ email: ' Player@Example.COM ', email_verified: true, hd: 'example.com' }, 'player@example.com'],
        [{ email: 'player@gmail.com', email_verified: false }, undefined],
        [{ email: 'player@gmail.com', email_verified: 'true' }, undefined],
        [{ email: 'player@gmail.com' }, undefined],
        [{ email: 'player@example.com', email_verified: true }, undefined],
        [{ email: 'player@example.com', email_verified: true, hd: 'https://example.com' }, undefined],
        [{ email: 'player@example.com', email_verified: true, hd: '-bad.example' }, undefined],
        [{ email: 'player@example.com', email_verified: true, hd: 'a'.repeat(64) + '.com' }, undefined],
        [{ email: 'player@example.com', email_verified: true, hd: '127.0.0.1' }, undefined],
        [{ email: 'player@gmail.com.attacker.example', email_verified: true }, undefined],
        [{ email: 'player\u0000@gmail.com', email_verified: true }, undefined],
        [{ email: 'a'.repeat(245) + '@gmail.com', email_verified: true }, undefined],
        [{ email: 'not-an-email', email_verified: true, hd: 'example.com' }, undefined],
    ] as const) {
        const result = await verifier.verify('google', signedToken({ ...claims(), ...extra }), nonce);
        assert.equal(result.verified, true, 'bad contact metadata does not reject existing linked logins');
        if (result.verified) assert.deepEqual(result.identity, { provider: 'google', subject: claims().sub,
            ...(expected === undefined ? {} : { email: expected }) });
    }
});

test('Apple exposes only its signed verified shared or relay email; missing contact data preserves subject login', async () => {
    const { verifier } = fixture();
    for (const [extra, expected] of [
        [{ email: ' Player@Example.COM ', email_verified: true }, 'player@example.com'],
        [{ email: ' Hidden@privaterelay.appleid.com ', email_verified: 'true', is_private_email: 'true' }, 'hidden@privaterelay.appleid.com'],
        [{}, undefined],
        [{ email: '', email_verified: true }, undefined],
        [{ email: 'player@example.com', email_verified: false }, undefined],
        [{ email: 'player@example.com', email_verified: 'false' }, undefined],
        [{ email: 'player@example.com', email_verified: 'TRUE' }, undefined],
        [{ email: 'player@example.com', email_verified: 1 }, undefined],
        [{ email: 'player@example.com' }, undefined],
        [{ email: 'not-an-email', email_verified: true }, undefined],
        [{ email: 'bad\u0000@example.com', email_verified: true }, undefined],
        [{ email: 'a'.repeat(255) + '@example.com', email_verified: true }, undefined],
    ] as const) {
        const result = await verifier.verify('apple', signedToken({ ...claims('apple'), ...extra }), nonce);
        assert.ok(result.verified);
        assert.deepEqual(result.identity, { provider: 'apple', subject: claims('apple').sub,
            appleIssuedAt: claims('apple').iat, appleClientId: appleAudience,
            ...(expected === undefined ? {} : { email: expected }) });
    }
});

test('only original Apple ID-token issuance populates the revocation-check time', async () => {
    const { verifier } = fixture();
    const apple = await verifier.verify('apple', signedToken({ ...claims('apple'),
        appleIssuedAt: nowSeconds + 1_000, appleClientId: 'request-selected-audience' }), nonce);
    assert.ok(apple.verified);
    assert.equal(apple.identity.appleIssuedAt, nowSeconds - 10);
    assert.equal(apple.identity.appleClientId, appleAudience);
    const google = await verifier.verify('google', signedToken({ ...claims(),
        appleIssuedAt: nowSeconds + 1_000, appleClientId: appleAudience }), nonce);
    assert.ok(google.verified);
    assert.equal(google.identity.appleIssuedAt, undefined);
    assert.equal(google.identity.appleClientId, undefined);
});

for (const provider of ['google', 'apple'] as const) {
    test(`${provider}: locally signed RSA token returns only a frozen opaque identity`, async () => {
        const { verifier, calls } = fixture();
        const result = await verifier.verify(provider, signedToken({
            ...claims(provider), email: 'private@example.invalid', name: 'Never returned',
            email_verified: false,
        }), nonce);
        assert.deepEqual(result, {
            verified: true,
            identity: { provider, subject: 'Opaque.Mixed-CASE-provider-subject',
                ...(provider === 'apple' ? { appleIssuedAt: nowSeconds - 10, appleClientId: appleAudience } : {}) },
        });
        if (result.verified) assert.equal(Object.isFrozen(result.identity), true);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].url, provider === 'google'
            ? 'https://www.googleapis.com/oauth2/v3/certs' : 'https://appleid.apple.com/auth/keys');
        assert.equal(calls[0].options?.redirect, 'error');
        assert.equal(calls[0].options?.method, 'GET');
        assert.equal(calls[0].options?.signal instanceof AbortSignal, true);
    });

    test(`${provider}: invalid signature and same-email different subject cannot forge identity`, async () => {
        const { verifier } = fixture();
        assert.deepEqual(await verifier.verify(provider,
            signedToken(claims(provider), undefined, rotatedKey.privateKey), nonce), invalidToken);
        const first = await verifier.verify(provider, signedToken({ ...claims(provider),
            email: 'same@example.invalid', sub: 'first-subject' }), nonce);
        const second = await verifier.verify(provider, signedToken({ ...claims(provider),
            email: 'same@example.invalid', sub: 'second-subject' }), nonce);
        assert.equal(first.verified && first.identity.subject, 'first-subject');
        assert.equal(second.verified && second.identity.subject, 'second-subject');
    });

    test(`${provider}: issuer, exact single audience, nonce and required claim types fail closed`, async () => {
        const { verifier } = fixture();
        const valid = claims(provider);
        const invalidClaims: [string, Record<string, unknown>][] = [
            ['missing issuer', { iss: undefined }],
            ['different issuer', { iss: 'https://attacker.example' }],
            ['issuer prefix', { iss: `${valid.iss}.attacker.example` }],
            ['other provider issuer', { iss: provider === 'google'
                ? 'https://appleid.apple.com' : 'https://accounts.google.com' }],
            ['missing audience', { aud: undefined }],
            ['different audience', { aud: 'request-selected-audience' }],
            ['singleton audience array', { aud: [valid.aud] }],
            ['multiple audiences', { aud: [valid.aud, 'another-client'] }],
            ['missing nonce', { nonce: undefined }],
            ['different nonce', { nonce: 'different-server-issued-attempt-nonce-value' }],
            ['wrong nonce type', { nonce: 123 }],
            ['nonce unicode', { nonce: 'é'.repeat(nonce.length) }],
            ['missing subject', { sub: undefined }],
            ['empty subject', { sub: '' }],
            ['numeric subject', { sub: 123 }],
            ['subject length', { sub: 'a'.repeat(256) }],
            ['subject unicode', { sub: 'subject-é' }],
            ['subject control', { sub: 'subject\nvalue' }],
            ['missing expiration', { exp: undefined }],
            ['expiration string', { exp: String(nowSeconds + 3_600) }],
            ['fractional expiration', { exp: nowSeconds + 0.5 }],
            ['unsafe expiration', { exp: Number.MAX_SAFE_INTEGER + 1 }],
            ['expired', { exp: nowSeconds }],
            ['expiration before issuance', { iat: nowSeconds + 10, exp: nowSeconds + 5 }],
            ['missing issuance', { iat: undefined }],
            ['issuance string', { iat: String(nowSeconds) }],
            ['fractional issuance', { iat: nowSeconds - 0.5 }],
            ['future issuance', { iat: nowSeconds + 31 }],
            ['stale issuance', { iat: nowSeconds - 300 }],
            ['future not-before', { nbf: nowSeconds + 1 }],
            ['fractional not-before', { nbf: nowSeconds - 0.5 }],
        ];
        for (const [description, mutation] of invalidClaims) {
            assert.deepEqual(await verifier.verify(provider, signedToken({ ...valid, ...mutation }), nonce),
                invalidToken, description);
        }
        assert.equal((await verifier.verify(provider, signedToken({ ...valid, iat: nowSeconds + 30 }), nonce)).verified, true);
    });
}

test('Google legacy issuer and only the explicitly configured authorized presenter are accepted', async () => {
    const { verifier } = fixture();
    assert.equal((await verifier.verify('google', signedToken({ ...claims(), iss: 'accounts.google.com' }), nonce)).verified, true);
    assert.equal((await verifier.verify('google', signedToken({ ...claims(), azp: googleAudience }), nonce)).verified, true);
    for (const azp of ['unknown-presenter', '', 123, [googleAudience]]) {
        assert.deepEqual(await verifier.verify('google', signedToken({ ...claims(), azp }), nonce), invalidToken);
    }
    const nativeClient = 'server-selected-ios-client.apps.googleusercontent.com';
    const hybrid = fixture({ configuration: { googleAudience, googleAuthorizedParty: nativeClient } }).verifier;
    assert.equal((await hybrid.verify('google', signedToken({ ...claims(), azp: nativeClient }), nonce)).verified, true);
    assert.deepEqual(await hybrid.verify('google', signedToken(claims()), nonce), invalidToken);
    assert.deepEqual(await hybrid.verify('google', signedToken({ ...claims(), azp: googleAudience }), nonce), invalidToken);
});

test('malformed tokens, unsupported headers, algorithms and nonce inputs reject before fetching keys', async () => {
    const { verifier, calls } = fixture();
    const normalHeader = { alg: 'RS256', kid: 'provider-key-1', typ: 'JWT' };
    const valid = signedToken();
    const badTokens: unknown[] = [undefined, null, {}, '', 'not-a-jwt', 'a.b.c.d', `${valid}.`,
        ` ${valid}`, `${valid}=`, 'a'.repeat(PROVIDER_TOKEN_MAX_LENGTH + 1),
        signedToken('not-an-object'), signedToken([]), signedToken(null),
        signedToken(claims(), { ...normalHeader, alg: 'none' }),
        signedToken(claims(), { ...normalHeader, alg: 'HS256' }),
        signedToken(claims(), { ...normalHeader, alg: 'RS384' }),
        signedToken(claims(), { ...normalHeader, alg: 'PS256' }),
        signedToken(claims(), { ...normalHeader, alg: 'ES256' }),
        signedToken(claims(), { ...normalHeader, kid: undefined }),
        signedToken(claims(), { ...normalHeader, kid: '../local-key.pem' }),
        signedToken(claims(), { ...normalHeader, kid: 'a'.repeat(129) }),
        signedToken(claims(), { ...normalHeader, typ: 'at+jwt' }),
        signedToken(claims(), { ...normalHeader, crit: ['unsupported'] }),
        signedToken(claims(), { ...normalHeader, b64: false }),
        signedToken(claims(), { ...normalHeader, jku: 'https://attacker.example/keys' }),
        signedToken(claims(), { ...normalHeader, jwk: publicJwk(rotatedKey.publicKey) }),
        signedToken(claims(), { ...normalHeader, x5u: 'https://attacker.example/cert' }),
        signedToken(claims(), { ...normalHeader, x5c: ['attacker'] }),
        jwt.sign(claims(), firstKey.publicKey.export({ type: 'spki', format: 'pem' }), { algorithm: 'HS256' }),
    ];
    for (const token of badTokens) {
        assert.deepEqual(await verifier.verify('google', token, nonce), invalidToken);
    }
    for (const invalidNonce of ['', 'too-short', 'x'.repeat(257), ' '.repeat(43), undefined, null]) {
        assert.deepEqual(await verifier.verify('google', valid, invalidNonce as string), invalidToken);
    }
    assert.deepEqual(await verifier.verify('unknown' as IdentityProvider, valid, nonce), invalidToken);
    assert.equal(calls.length, 0);
});

test('missing provider configuration fails closed and server configuration is captured once', async () => {
    const configuration = { googleAudience };
    const { verifier, calls } = fixture({ configuration });
    configuration.googleAudience = 'later-mutated-client-id';
    assert.deepEqual(await verifier.verify('apple', signedToken(claims('apple')), nonce),
        { verified: false, reason: 'PROVIDER_NOT_CONFIGURED' });
    assert.equal(calls.length, 0);
    assert.equal((await verifier.verify('google', signedToken(), nonce)).verified, true);
    for (const configuration of [{ googleAudience: '' }, { appleAudience: ' contains spaces ' },
        { googleAudience: 'x'.repeat(256) }, { googleAuthorizedParty: googleAudience }]) {
        assert.throws(() => createProviderTokenVerifier(configuration),
            { message: 'Invalid provider verification configuration.' });
    }
});

test('concurrent requests share a bounded cache fetch, including independent provider caches', async () => {
    const { verifier, calls } = fixture();
    const results = await Promise.all(Array.from({ length: 20 }, () => verifier.verify('google', signedToken(), nonce)));
    assert.equal(results.every(result => result.verified), true);
    assert.equal(calls.length, 1);
    await verifier.verify('apple', signedToken(claims('apple')), nonce);
    assert.equal(calls.length, 2);
    await verifier.verify('google', signedToken(), nonce);
    assert.equal(calls.length, 2);
});

test('unknown key IDs are throttled and rotation replaces the old key set', async () => {
    let rotated = false;
    const { verifier, calls, advance } = fixture({ response: () => rotated
        ? jwksResponse([publicJwk(rotatedKey.publicKey, 'provider-key-2')]) : jwksResponse() });
    assert.equal((await verifier.verify('google', signedToken(), nonce)).verified, true);
    const rotatedToken = signedToken(claims(), { alg: 'RS256', kid: 'provider-key-2' }, rotatedKey.privateKey);
    rotated = true;
    for (let index = 0; index < 20; index += 1) {
        assert.deepEqual(await verifier.verify('google',
            signedToken(claims(), { alg: 'RS256', kid: `unknown-${index}` }), nonce), invalidToken);
    }
    assert.equal(calls.length, 1);
    assert.deepEqual(await verifier.verify('google', rotatedToken, nonce), invalidToken);
    advance(30_000);
    assert.equal((await verifier.verify('google', rotatedToken, nonce)).verified, true);
    assert.equal(calls.length, 2);
    assert.deepEqual(await verifier.verify('google', signedToken(), nonce), invalidToken);
});

test('expired cache never permits stale-key fallback after provider failure', async () => {
    let available = true;
    const { verifier, calls, advance } = fixture({ response: () => {
        if (!available) throw new Error('Sensitive upstream details must not escape');
        return jwksResponse(undefined, 'max-age=30');
    } });
    assert.equal((await verifier.verify('google', signedToken(), nonce)).verified, true);
    available = false;
    advance(30_000);
    assert.deepEqual(await verifier.verify('google', signedToken(), nonce), unavailable);
    assert.deepEqual(await verifier.verify('google', signedToken(), nonce), unavailable);
    assert.equal(calls.length, 2);
});

test('cache lifetime respects age, no-store and the one-hour local ceiling', async () => {
    for (const [cacheControl, age, elapsed] of [
        ['max-age=60', '30', 30_000],
        ['max-age=999999', '0', 3_600_000],
        ['no-store', '0', 30_000],
        ['no-cache', '0', 30_000],
        ['no-cache="set-cookie", max-age=3600', '0', 30_000],
    ] as const) {
        const { verifier, calls, advance } = fixture({ response: () => {
            const response = jwksResponse(undefined, cacheControl);
            response.headers.set('age', age);
            return response;
        } });
        assert.equal((await verifier.verify('google', signedToken(), nonce)).verified, true);
        advance(elapsed);
        const refreshedClaims = { ...claims(), iat: nowSeconds + elapsed / 1_000,
            exp: nowSeconds + elapsed / 1_000 + 3_600 };
        assert.equal((await verifier.verify('google', signedToken(refreshedClaims), nonce)).verified, true);
        assert.equal(calls.length, 2, cacheControl);
    }
});

test('HTTP errors, redirect responses, oversized or malformed key sets return sanitized failures', async () => {
    const invalidSets: unknown[] = [{}, { keys: [] }, { keys: [publicJwk(), publicJwk()] },
        { keys: Array.from({ length: 17 }, (_, index) => publicJwk(undefined, `key-${index}`)) },
        ...[
            { kty: 'oct' }, { alg: 'HS256' }, { use: 'enc' }, { n: 'broken' },
            { e: 'broken exponent' }, { d: 'private-key-material' }, { key_ops: ['sign'] },
            { kid: '../key' }, { kid: '__proto__', n: 'A'.repeat(342) },
        ].map(mutation => ({ keys: [{ ...publicJwk(), ...mutation }] })),
    ];
    const responses: (() => Response)[] = invalidSets.map(document => () => new Response(JSON.stringify(document)));
    responses.push(() => new Response('upstream private details', { status: 500 }),
        () => new Response('redirect', { status: 302, headers: { location: 'https://attacker.example' } }),
        () => new Response('a'.repeat(65_537)),
        () => new Response('{}', { headers: { 'content-length': '65537' } }),
        () => new Response('not-json'));
    for (const response of responses) {
        const { verifier, calls } = fixture({ response });
        assert.deepEqual(await verifier.verify('google', signedToken(), nonce), unavailable);
        assert.deepEqual(await verifier.verify('google', signedToken(), nonce), unavailable);
        assert.equal(calls.length, 1);
    }
});

test('token expiration is checked again after the key fetch completes', async () => {
    const context = fixture({ response: () => {
        context.advance(2_000);
        return jwksResponse();
    } });
    assert.deepEqual(await context.verifier.verify('google',
        signedToken({ ...claims(), exp: nowSeconds + 1 }), nonce), invalidToken);
});

test('key fetch deadline aborts even a transport that never resolves and failure is throttled', async () => {
    let signal: AbortSignal | undefined;
    let calls = 0;
    const verifier = createProviderTokenVerifier({ googleAudience }, {
        now: () => nowSeconds * 1_000,
        fetch: async (_url, options) => {
            calls += 1;
            signal = options?.signal ?? undefined;
            return new Promise<Response>(() => undefined);
        },
    });
    const start = Date.now();
    assert.deepEqual(await verifier.verify('google', signedToken(), nonce), unavailable);
    assert.equal(signal?.aborted, true);
    assert.ok(Date.now() - start < PROVIDER_JWKS_TIMEOUT_MS + 3_000);
    assert.deepEqual(await verifier.verify('google', signedToken(), nonce), unavailable);
    assert.equal(calls, 1);
});
