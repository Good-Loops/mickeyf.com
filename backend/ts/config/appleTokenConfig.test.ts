import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { loadAppleTokenConfig } from './appleTokenConfig';
import { loadProviderAuthConfig } from './providerAuthConfig';

const privateKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey
    .export({ format: 'pem', type: 'pkcs8' }).toString();
const environment = {
    APPLE_NOTIFICATIONS_ENABLED: 'true',
    APPLE_TOKEN_LIFECYCLE_ENABLED: 'true', APPLE_IOS_BUNDLE_ID: 'com.example.test',
    APPLE_SIGN_IN_TEAM_ID: 'ABCDEFGHIJ', APPLE_SIGN_IN_KEY_ID: '0123456789', APPLE_SIGN_IN_PRIVATE_KEY: privateKey,
    APPLE_TOKEN_ACTIVE_KEY_ID: 'v1', APPLE_TOKEN_ENCRYPTION_KEYS: JSON.stringify({ v1: Buffer.alloc(32, 9).toString('base64') }),
};

test('Apple credentials are ignored without an exact lifecycle opt-in', () => {
    for (const flag of [undefined, 'false', 'TRUE', '1', 'true\n']) {
        assert.equal(loadAppleTokenConfig({ APPLE_TOKEN_LIFECYCLE_ENABLED: flag, APPLE_TOKEN_ENCRYPTION_KEYS: 'broken' }), undefined);
    }
});

test('dedicated signing and rotation keyring construct a usable encrypted vault without provider calls', () => {
    const lifecycle = loadAppleTokenConfig(environment)!;
    const token = lifecycle.repository.prepare('synthetic-refresh-token', '12345678-1234-4234-8234-123456789abc');
    assert.equal(lifecycle.repository.decrypt(token), 'synthetic-refresh-token');
    assert.equal(lifecycle.clientId, environment.APPLE_IOS_BUNDLE_ID);
    assert.equal(Object.isFrozen(lifecycle), true);
});

test('web tokens keep their Services ID through encryption and cannot be opened by the native vault', () => {
    const lifecycle = loadAppleTokenConfig({ ...environment, APPLE_WEB_AUTH_ENABLED: 'false',
        APPLE_WEB_SERVICES_ID: 'com.example.web', APPLE_WEB_REDIRECT_URI: 'https://example.test/login' })!;
    const account = '12345678-1234-4234-8234-123456789abc';
    const native = lifecycle.repository.prepare('synthetic-native-refresh', account);
    const web = lifecycle.web!.repository.prepare('synthetic-web-refresh', account);
    assert.equal(web.client_id, 'com.example.web');
    assert.equal(lifecycle.web!.repository.decrypt(web), 'synthetic-web-refresh');
    assert.throws(() => lifecycle.repository.decrypt(web));
    assert.throws(() => lifecycle.web!.repository.decrypt(native));
    assert.throws(() => lifecycle.web!.repository.decrypt({ ...web, client_id: native.client_id }));
    assert.equal(lifecycle.web!.redirectUri, 'https://example.test/login');
});

test('missing or malformed secret material fails closed without leaking input or causes', () => {
    const invalid = [
        { APPLE_TOKEN_ENCRYPTION_KEYS: 'secret-invalid-json' },
        { APPLE_TOKEN_ENCRYPTION_KEYS: '[]' },
        { APPLE_TOKEN_ENCRYPTION_KEYS: '{}' },
        { APPLE_TOKEN_ENCRYPTION_KEYS: JSON.stringify({ v1: Buffer.alloc(31).toString('base64') }) },
        { APPLE_TOKEN_ENCRYPTION_KEYS: JSON.stringify({ v1: `${Buffer.alloc(32).toString('base64')}\n` }) },
        { APPLE_TOKEN_ENCRYPTION_KEYS: JSON.stringify(Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`v${i}`, Buffer.alloc(32).toString('base64')]))) },
        { APPLE_TOKEN_ACTIVE_KEY_ID: 'missing' }, { APPLE_SIGN_IN_PRIVATE_KEY: 'secret-invalid-pem' },
        { APPLE_SIGN_IN_TEAM_ID: undefined }, { APPLE_SIGN_IN_KEY_ID: undefined },
        { APPLE_IOS_BUNDLE_ID: undefined },
    ];
    for (const change of invalid) {
        assert.throws(() => loadAppleTokenConfig({ ...environment, ...change }), (error: unknown) => {
            assert(error instanceof Error);
            assert.equal(error.message, 'Apple token lifecycle requires valid dedicated signing and encryption credentials.');
            assert.equal('cause' in error, false);
            return true;
        });
    }
});

test('prepared lifecycle stays private and does not enable Apple signup or deletion', () => {
    const config = loadProviderAuthConfig({ ...environment, PROVIDER_AUTH_ENABLED: 'true' });
    assert(config.appleTokenLifecycle);
    assert(config.appleNotifications);
    assert(config.clients['apple-ios'].appleTokens);
    assert.equal(config.clients['apple-ios'].signupEnabled, false);
    assert.equal(config.clients['apple-ios'].deletionEnabled, false);
    assert.equal(JSON.stringify(config.publicClients).includes(privateKey), false);
    assert.equal(JSON.stringify(config.publicClients).includes('encryption'), false);
});

test('active Apple sign-in lifecycle cannot be configured without server-side revocation handling', () => {
    for (const flag of [undefined, 'false', 'TRUE', '1']) {
        assert.throws(() => loadProviderAuthConfig({ ...environment, PROVIDER_AUTH_ENABLED: 'true',
            APPLE_NOTIFICATIONS_ENABLED: flag }), { message: 'Apple sign-in requires enabled server notifications.' });
    }
});
