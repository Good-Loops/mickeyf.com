import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import jwt from 'jsonwebtoken';
import { loadAppleNotificationConfig } from './appleNotificationConfig';
import { loadProviderAuthConfig } from './providerAuthConfig';

const bundleId = 'com.example.app';

test('notification handling is default-off and ignores credentials until exact opt-in', () => {
    for (const flag of [undefined, 'false', 'TRUE', '1', 'true\n']) {
        const config = loadAppleNotificationConfig({ APPLE_NOTIFICATIONS_ENABLED: flag,
            APPLE_IOS_BUNDLE_ID: ' invalid client ' }, { fetch: async () => assert.fail('No provider network calls') });
        assert.equal(config, undefined);
    }
});

test('notification activation requires exactly one bounded bundle identifier', () => {
    for (const value of [undefined, '', 'com.example.app ', ' com.example.app', 'com.example.\napp',
        'no-dots', 'com..app', 'com.example.app,com.other.app', 'com.example.*', 'a'.repeat(256)]) {
        assert.throws(() => loadAppleNotificationConfig({ APPLE_NOTIFICATIONS_ENABLED: 'true', APPLE_IOS_BUNDLE_ID: value }),
            { message: 'Apple notifications require one exact APPLE_IOS_BUNDLE_ID.' });
    }
});

test('receiving revocations can remain enabled while new provider sign-in is disabled', () => {
    const config = loadProviderAuthConfig({ APPLE_NOTIFICATIONS_ENABLED: 'true', APPLE_IOS_BUNDLE_ID: bundleId,
        PROVIDER_AUTH_ENABLED: 'false' }, { fetch: async () => assert.fail('Construction must not fetch keys') });
    assert.equal(config.enabled, false);
    assert.equal(config.signupEnabled, false);
    assert.deepEqual(config.clients, {});
    assert.deepEqual(config.publicClients, []);
    assert.ok(config.appleNotifications);
    assert.equal(config.appleTokenLifecycle, undefined);
    assert.equal(Object.isFrozen(config), true);
});

test('enabled configuration binds verification to the captured native bundle, not another or mutated client', async () => {
    const keys = generateKeyPairSync('rsa', { modulusLength: 2_048 });
    const now = 1_800_000_000;
    let fetches = 0;
    const environment = { APPLE_NOTIFICATIONS_ENABLED: 'true', APPLE_IOS_BUNDLE_ID: bundleId };
    const verifier = loadAppleNotificationConfig(environment, { now: () => now * 1_000,
        fetch: async url => {
            fetches++;
            assert.equal(url, 'https://appleid.apple.com/auth/keys');
            return new Response(JSON.stringify({ keys: [{ ...keys.publicKey.export({ format: 'jwk' }),
                kid: 'synthetic-key', alg: 'RS256', use: 'sig' }] }));
        } })!;
    assert.equal(fetches, 0);
    environment.APPLE_IOS_BUNDLE_ID = 'com.other.app';
    for (const aud of [bundleId, 'com.other.app']) {
        const token = jwt.sign({ iss: 'https://appleid.apple.com', aud, iat: now - 1, jti: 'notification-id',
            events: { type: 'consent-revoked', sub: 'synthetic-subject', event_time: now - 2 } },
        keys.privateKey, { algorithm: 'RS256', keyid: 'synthetic-key' });
        assert.equal((await verifier.verify(token)).verified, aud === bundleId);
    }
    assert.equal(fetches, 1);
});
