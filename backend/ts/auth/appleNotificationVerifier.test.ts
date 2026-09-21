import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import test from 'node:test';
import jwt from 'jsonwebtoken';
import {
    APPLE_NOTIFICATION_MAX_LENGTH, createAppleNotificationVerifier,
    type VerifiedAppleNotification,
} from './appleNotificationVerifier';

const nowSeconds = 1_800_000_000;
const audience = 'com.example.native';
const otherAudience = 'com.example.web';
const keyPair = generateKeyPairSync('rsa', { modulusLength: 2_048 });
const otherKey = generateKeyPairSync('rsa', { modulusLength: 2_048 });
const invalid = { verified: false, reason: 'INVALID_APPLE_NOTIFICATION' };
const unavailable = { verified: false, reason: 'APPLE_KEYS_UNAVAILABLE' };
const header = { alg: 'RS256', kid: 'apple-key', typ: 'JWT' };
const event = { type: 'consent-revoked', sub: 'Opaque.Apple.Subject', event_time: nowSeconds - 4 };

function claims(): Record<string, unknown> {
    return { iss: 'https://appleid.apple.com', aud: audience, iat: nowSeconds - 2,
        jti: 'Opaque.Notification.Identifier', events: { ...event } };
}

function signedToken(
    payload: unknown = claims(), tokenHeader: unknown = header, key: KeyObject = keyPair.privateKey
): string {
    const input = [tokenHeader, payload]
        .map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
    return `${input}.${sign('RSA-SHA256', Buffer.from(input), key).toString('base64url')}`;
}

function keysResponse() {
    return new Response(JSON.stringify({ keys: [{ ...keyPair.publicKey.export({ format: 'jwk' }),
        kid: header.kid, alg: 'RS256', use: 'sig' }] }), {
        headers: { 'cache-control': 'max-age=30' },
    });
}

function fixture(options: {
    audiences?: string[];
    response?: () => Response | Promise<Response>;
    nowMs?: number;
} = {}) {
    let nowMs = options.nowMs ?? nowSeconds * 1_000;
    const calls: { url: unknown; init?: RequestInit }[] = [];
    const verifier = createAppleNotificationVerifier({ audiences: options.audiences ?? [audience, otherAudience] }, {
        now: () => nowMs,
        fetch: async (url, init) => {
            calls.push({ url, init });
            return options.response ? options.response() : keysResponse();
        },
    });
    return { verifier, calls, advance: (milliseconds: number) => { nowMs += milliseconds; } };
}

test('raw notification claims cannot cross the branded verified boundary', () => {
    const plain = { audience, subject: event.sub, eventType: 'consent-revoked' as const,
        issuedAt: nowSeconds - 2, eventTime: event.event_time };
    // @ts-expect-error Only the verifier constructs this signature-verified brand.
    const verified: VerifiedAppleNotification = plain;
    assert.equal(verified, plain);
});

test('all four signed Apple events are immutable and discard email, raw token and notification identifiers', async () => {
    const { verifier, calls } = fixture();
    for (const eventType of ['consent-revoked', 'account-deleted', 'email-enabled', 'email-disabled']) {
        const result = await verifier.verify(signedToken({ ...claims(), events: {
            ...event, type: eventType, email: 'private@privaterelay.appleid.com', is_private_email: true,
        } }));
        assert.deepEqual(result, { verified: true, notification: { audience, subject: event.sub,
            eventType, issuedAt: nowSeconds - 2, eventTime: event.event_time } });
        if (result.verified) assert.ok(Object.isFrozen(result.notification));
    }
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://appleid.apple.com/auth/keys');
    assert.equal(calls[0].init?.redirect, 'error');
    assert.equal(calls[0].init?.signal instanceof AbortSignal, true);
});

test('documented seconds and historical serialized millisecond events normalize to the same cutoff second', async () => {
    const { verifier } = fixture();
    for (const events of [{ ...event }, JSON.stringify(event),
        { ...event, event_time: event.event_time * 1_000 + 750 },
        JSON.stringify({ ...event, event_time: event.event_time * 1_000 + 750 })]) {
        const result = await verifier.verify(signedToken({ ...claims(), events }));
        assert.ok(result.verified);
        assert.equal(result.notification.eventTime, event.event_time);
    }
});

test('delayed notifications need no nonce or expiration and retain the event time, not receipt time', async () => {
    const { verifier } = fixture();
    const issuedAt = nowSeconds - 90 * 24 * 60 * 60;
    const result = await verifier.verify(signedToken({ ...claims(), iat: issuedAt,
        events: { ...event, event_time: issuedAt - 1 } }));
    assert.ok(result.verified);
    assert.equal(result.notification.issuedAt, issuedAt);
    assert.equal(result.notification.eventTime, issuedAt - 1);
});

test('optional expiration and not-before claims remain enforced', async () => {
    const { verifier } = fixture();
    assert.ok((await verifier.verify(signedToken({ ...claims(), exp: nowSeconds + 10,
        nbf: nowSeconds - 1 }))).verified);
    for (const mutation of [{ exp: nowSeconds }, { exp: nowSeconds - 3 }, { exp: '9999999999' },
        { exp: nowSeconds + 0.5 }, { exp: Number.MAX_SAFE_INTEGER + 1 }, { nbf: nowSeconds + 1 },
        { nbf: '1' }, { nbf: -1 }, { nbf: nowSeconds - 0.5 }]) {
        assert.deepEqual(await verifier.verify(signedToken({ ...claims(), ...mutation })), invalid);
    }
});

test('issuer, exact single configured audience, jti and issuance types fail closed', async () => {
    const { verifier } = fixture();
    for (const mutation of [{ iss: undefined }, { iss: 'https://appleid.apple.com.attacker.invalid' },
        { iss: 'https://accounts.google.com' }, { aud: undefined }, { aud: 'com.attacker.app' },
        { aud: [audience] }, { aud: [audience, otherAudience] }, { jti: undefined }, { jti: '' },
        { jti: 5 }, { jti: 'has a space' }, { jti: 'control\ncharacter' }, { jti: 'é' },
        { jti: 'a'.repeat(256) }, { iat: undefined }, { iat: '1800000000' }, { iat: 0 },
        { iat: nowSeconds - 0.5 }, { iat: nowSeconds + 31 }, { iat: Number.MAX_SAFE_INTEGER + 1 }]) {
        assert.deepEqual(await verifier.verify(signedToken({ ...claims(), ...mutation })), invalid);
    }
    assert.ok((await verifier.verify(signedToken({ ...claims(), aud: otherAudience }))).verified);
    assert.ok((await verifier.verify(signedToken({ ...claims(), iat: nowSeconds + 30 }))).verified);
});

test('event shape, subject, supported type and timestamp fail closed', async () => {
    const { verifier } = fixture();
    const badEvents: unknown[] = [undefined, null, [], [event], 'not JSON', JSON.stringify([event]),
        JSON.stringify('nested string'), ' '.repeat(4_097),
        { ...event, type: 'account-delete' }, { ...event, type: 1 }, { ...event, type: undefined },
        { ...event, sub: undefined }, { ...event, sub: '' }, { ...event, sub: 'a'.repeat(256) },
        { ...event, sub: 'space subject' }, { ...event, sub: 'subject\n' }, { ...event, sub: 'é' },
        { ...event, event_time: undefined }, { ...event, event_time: 0 }, { ...event, event_time: -1 },
        { ...event, event_time: '1800000000' }, { ...event, event_time: nowSeconds - 0.5 },
        { ...event, event_time: nowSeconds + 31 }, { ...event, event_time: nowSeconds * 1_000 + 30_001 },
        { ...event, event_time: Number.MAX_SAFE_INTEGER + 1 }];
    for (const events of badEvents) {
        assert.deepEqual(await verifier.verify(signedToken({ ...claims(), events })), invalid);
    }
    assert.deepEqual(await verifier.verify(signedToken({ ...claims(), iat: nowSeconds - 31,
        events: { ...event, event_time: nowSeconds } })), invalid, 'event cannot follow issuance without a bound');
});

test('forgeries and unsupported header/algorithm inputs never establish a notification', async () => {
    const { verifier, calls } = fixture();
    const malformed: unknown[] = [undefined, null, {}, '', 'not-a-jwt', 'a.b.c.d',
        'a'.repeat(APPLE_NOTIFICATION_MAX_LENGTH + 1), signedToken('not an object'),
        signedToken(claims(), { ...header, alg: 'none' }), signedToken(claims(), { ...header, alg: 'HS256' }),
        signedToken(claims(), { ...header, alg: 'ES256' }), signedToken(claims(), { ...header, kid: '../key' }),
        signedToken(claims(), { ...header, crit: ['custom'] }),
        signedToken(claims(), { ...header, jku: 'https://attacker.invalid/keys' }),
        signedToken(claims(), { ...header, jwk: otherKey.publicKey.export({ format: 'jwk' }) }),
        jwt.sign(claims(), keyPair.publicKey.export({ type: 'spki', format: 'pem' }), { algorithm: 'HS256' })];
    for (const token of malformed) assert.deepEqual(await verifier.verify(token), invalid);
    assert.equal(calls.length, 0);
    assert.deepEqual(await verifier.verify(signedToken(claims(), header, otherKey.privateKey)), invalid);
    assert.equal(calls.length, 1);
});

test('JWKS errors stay sanitized and expired keys never silently authenticate delayed events', async () => {
    let available = true;
    const { verifier, calls, advance } = fixture({ response: () => {
        if (!available) throw new Error('Upstream sensitive failure detail');
        return keysResponse();
    } });
    assert.ok((await verifier.verify(signedToken())).verified);
    available = false;
    advance(30_000);
    assert.deepEqual(await verifier.verify(signedToken()), unavailable);
    assert.deepEqual(await verifier.verify(signedToken()), unavailable);
    assert.equal(calls.length, 2);
});

test('concurrent notifications share one fetch and unknown kids cannot force a refetch flood', async () => {
    const { verifier, calls } = fixture();
    const results = await Promise.all(Array.from({ length: 10 }, () => verifier.verify(signedToken())));
    assert.ok(results.every(result => result.verified));
    for (let index = 0; index < 10; index++) {
        assert.deepEqual(await verifier.verify(signedToken(claims(), { ...header, kid: `unknown-${index}` })), invalid);
    }
    assert.equal(calls.length, 1);
});

test('configuration is bounded and snapshotted; disabled verification performs no network call', async () => {
    const disabled = fixture({ audiences: [] });
    assert.deepEqual(await disabled.verifier.verify(signedToken()),
        { verified: false, reason: 'APPLE_NOT_CONFIGURED' });
    assert.equal(disabled.calls.length, 0);
    const configuredAudiences = [audience];
    const { verifier } = fixture({ audiences: configuredAudiences });
    configuredAudiences[0] = 'com.attacker.app';
    assert.ok((await verifier.verify(signedToken())).verified);
    for (const audiences of [[''], ['contains spaces'], ['a'.repeat(256)], [audience, audience],
        Array.from({ length: 9 }, (_, index) => `com.example.app${index}`)]) {
        assert.throws(() => createAppleNotificationVerifier({ audiences }),
            { message: 'Invalid Apple notification configuration.' });
    }
});

test('an invalid clock never authenticates an event', async () => {
    for (const nowMs of [NaN, Infinity, 0, -1, 1_000.5, Number.MAX_SAFE_INTEGER + 1]) {
        assert.deepEqual(await fixture({ nowMs }).verifier.verify(signedToken()), invalid);
    }
});
