import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import jwt from 'jsonwebtoken';
import { loadProviderAuthConfig, prepareRuntimeProviderAuth } from './providerAuthConfig';
import type { AppleTokenLifecycle } from './appleTokenConfig';

const googleWebId = '1234567890-syntheticWebClient.apps.googleusercontent.com';
const appleIosId = 'com.Example.Synthetic-App';
const enabledEnvironment = { PROVIDER_AUTH_ENABLED: 'true', GOOGLE_WEB_CLIENT_ID: googleWebId,
    APPLE_IOS_BUNDLE_ID: appleIosId };
const nowMs = Date.UTC(2026, 8, 14);
const nonce = 'n'.repeat(43);
const key = generateKeyPairSync('rsa', { modulusLength: 2048 });

function verifierFixture() {
    const calls: string[] = [];
    const config = loadProviderAuthConfig(enabledEnvironment, {
        now: () => nowMs,
        fetch: async url => {
            calls.push(String(url));
            return new Response(JSON.stringify({ keys: [{ ...key.publicKey.export({ format: 'jwk' }),
                kid: 'synthetic-config-key', use: 'sig', alg: 'RS256' }] }), {
                headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600' },
            });
        },
    });
    function token(provider: 'google' | 'apple', overrides: Record<string, unknown> = {}) {
        return jwt.sign({
            iss: provider === 'google' ? 'https://accounts.google.com' : 'https://appleid.apple.com',
            aud: provider === 'google' ? googleWebId : appleIosId,
            sub: 'synthetic-config-subject', nonce, iat: nowMs / 1000 - 10, exp: nowMs / 1000 + 300,
            ...overrides,
        }, key.privateKey, { algorithm: 'RS256', keyid: 'synthetic-config-key' });
    }
    return { config, calls, token };
}

test('provider configuration requires exact opt-in and ignores unused identifiers while disabled', () => {
    for (const value of [undefined, '', 'false', 'TRUE', '1', 'yes', ' true ']) {
        const config = loadProviderAuthConfig({ PROVIDER_AUTH_ENABLED: value,
            GOOGLE_WEB_CLIENT_ID: 'malformed unused value', APPLE_IOS_BUNDLE_ID: '', GOOGLE_IOS_CLIENT_ID: 'unused' });
        assert.deepEqual(config, { enabled: false, signupEnabled: false, clients: {}, publicClients: [] });
        assert.equal(Object.isFrozen(config), true);
        assert.equal(Object.isFrozen(config.clients), true);
        assert.equal(Object.isFrozen(config.publicClients), true);
    }
});

test('enabled configuration requires a supported client and rejects premature native Google or Apple web setup', () => {
    assert.throws(() => loadProviderAuthConfig({ PROVIDER_AUTH_ENABLED: 'true' }), /requires GOOGLE_WEB_CLIENT_ID or APPLE_IOS_BUNDLE_ID/);
    for (const extra of [{ GOOGLE_IOS_CLIENT_ID: googleWebId }, { APPLE_WEB_CLIENT_ID: 'com.example.web' },
        { APPLE_WEB_SERVICES_ID: 'com.example.web' }]) {
        assert.throws(() => loadProviderAuthConfig({ ...enabledEnvironment, ...extra }), /unsupported/);
    }
    const googleOnly = loadProviderAuthConfig({ PROVIDER_AUTH_ENABLED: 'true', GOOGLE_WEB_CLIENT_ID: googleWebId });
    assert.deepEqual(Object.keys(googleOnly.clients), ['google-web']);
    const appleOnly = loadProviderAuthConfig({ PROVIDER_AUTH_ENABLED: 'true', APPLE_IOS_BUNDLE_ID: appleIosId });
    assert.deepEqual(Object.keys(appleOnly.clients), ['apple-ios']);
});

test('Google signup requires its own exact opt-in and is advertised only for configured web Google', () => {
    const enabled = loadProviderAuthConfig({ ...enabledEnvironment, PROVIDER_GOOGLE_SIGNUP_ENABLED: 'true' });
    assert.equal(enabled.signupEnabled, true);
    assert.ok('signup' in enabled.publicClients[0] && enabled.publicClients[0].signup === true);
    assert.equal('signup' in enabled.publicClients[1], false);
    assert.equal(enabled.clients['apple-ios'].signupEnabled, false);
    assert.equal(enabled.clients['apple-ios'].deletionEnabled, false);
    for (const value of [undefined, 'false', 'TRUE', '1']) {
        const config = loadProviderAuthConfig({ ...enabledEnvironment, PROVIDER_GOOGLE_SIGNUP_ENABLED: value });
        assert.equal(config.signupEnabled, false);
        assert.equal('signup' in config.publicClients[0], false);
    }
    assert.throws(() => loadProviderAuthConfig({ PROVIDER_AUTH_ENABLED: 'true', APPLE_IOS_BUNDLE_ID: appleIosId,
        PROVIDER_GOOGLE_SIGNUP_ENABLED: 'true' }), /requires GOOGLE_WEB_CLIENT_ID/);
});

test('Google client configuration rejects empty, whitespace, multiple, URL and malformed audiences without echoing input', () => {
    for (const value of ['', ' ', ` ${googleWebId}`, `${googleWebId}\n`, `${googleWebId},other.apps.googleusercontent.com`,
        `https://${googleWebId}`, '*.apps.googleusercontent.com', 'synthetic.apps.googleusercontent.com.attacker.test',
        'synthetic.apps.GOOGLEUSERCONTENT.com', 'synthetic.com', 'x'.repeat(256), 'é.apps.googleusercontent.com']) {
        assert.throws(() => loadProviderAuthConfig({ ...enabledEnvironment, GOOGLE_WEB_CLIENT_ID: value }),
            error => error instanceof Error && error.message.startsWith('GOOGLE_WEB_CLIENT_ID must be one exact, nonempty'));
    }
});

test('Apple native configuration requires one bounded explicit bundle identifier', () => {
    for (const value of ['', ' ', ` ${appleIosId}`, `${appleIosId}\n`, 'com.example.*', 'com.example.under_score',
        'com..example', '.com.example', 'com.example.', 'https://com.example.app', 'com.example.app,com.example.other',
        'app', 'é.example.app', `com.${'x'.repeat(256)}`]) {
        assert.throws(() => loadProviderAuthConfig({ ...enabledEnvironment, APPLE_IOS_BUNDLE_ID: value }), /APPLE_IOS_BUNDLE_ID/);
    }
});

test('public discovery metadata contains fixed client keys and exact IDs without verifier or unrelated configuration', () => {
    const environment = { ...enabledEnvironment, SESSION_SECRET: 'never-public', GOOGLE_WEB_CLIENT_SECRET: 'never-public' };
    const config = loadProviderAuthConfig(environment);
    assert.deepEqual(Object.keys(config.clients), ['google-web', 'apple-ios']);
    assert.deepEqual(config.publicClients, [
        { clientKey: 'google-web', provider: 'google', platform: 'web', clientId: googleWebId },
        { clientKey: 'apple-ios', provider: 'apple', platform: 'ios', clientId: appleIosId },
    ]);
    assert.equal(JSON.stringify(config.publicClients).includes('never-public'), false);
    assert.equal(Object.isFrozen(config), true);
    assert.equal(Object.isFrozen(config.clients), true);
    assert.equal(Object.isFrozen(config.publicClients), true);
    for (const client of config.publicClients) assert.equal(Object.isFrozen(client), true);
    environment.GOOGLE_WEB_CLIENT_ID = 'later.apps.googleusercontent.com';
    assert.equal(config.publicClients[0].clientId, googleWebId);
});

test('startup constructs independent pinned verifiers without contacting providers', async () => {
    const { config, calls, token } = verifierFixture();
    assert.deepEqual(calls, []);
    const google = config.clients['google-web'].verifier;
    const apple = config.clients['apple-ios'].verifier;
    assert.deepEqual(await google.verify('apple', token('apple'), nonce), { verified: false, reason: 'PROVIDER_NOT_CONFIGURED' });
    assert.deepEqual(await apple.verify('google', token('google'), nonce), { verified: false, reason: 'PROVIDER_NOT_CONFIGURED' });
    assert.deepEqual(calls, []);
    assert.equal((await google.verify('google', token('google'), nonce)).verified, true);
    assert.equal((await apple.verify('apple', token('apple'), nonce)).verified, true);
    assert.deepEqual(calls, ['https://www.googleapis.com/oauth2/v3/certs', 'https://appleid.apple.com/auth/keys']);
});

test('configured Google web audience and presenter cannot be replaced by a request-selected or native client', async () => {
    const { config, token } = verifierFixture();
    const verifier = config.clients['google-web'].verifier;
    assert.equal((await verifier.verify('google', token('google', { azp: googleWebId }), nonce)).verified, true);
    for (const claims of [{ aud: 'different.apps.googleusercontent.com' }, { aud: [googleWebId] },
        { aud: googleWebId.toLowerCase() }, { azp: 'native.apps.googleusercontent.com' }]) {
        assert.deepEqual(await verifier.verify('google', token('google', claims), nonce),
            { verified: false, reason: 'INVALID_PROVIDER_TOKEN' });
    }
});

test('configured Apple native audience stays byte-exact and excludes web or other app tokens', async () => {
    const { config, token } = verifierFixture();
    const verifier = config.clients['apple-ios'].verifier;
    for (const aud of ['com.example.web-service', appleIosId.toLowerCase(), [appleIosId]]) {
        assert.deepEqual(await verifier.verify('apple', token('apple', { aud }), nonce),
            { verified: false, reason: 'INVALID_PROVIDER_TOKEN' });
    }
});

const runtimeEnvironment = { ...enabledEnvironment, APPLE_TOKEN_RUNTIME_SECRETS_ENABLED: 'true',
    APPLE_TOKEN_LIFECYCLE_ENABLED: 'true', APPLE_NOTIFICATIONS_ENABLED: 'true' };

test('runtime Apple secrets are deferred and unavailable Apple is absent from public discovery', async () => {
    const config = loadProviderAuthConfig(runtimeEnvironment);
    assert.equal(config.appleTokenLifecycle, undefined);
    assert.equal(config.clients['apple-ios'].appleTokens, undefined);
    assert.ok(config.appleNotifications);
    assert.deepEqual(config.publicClients.map(client => client.provider), ['google']);
    let reports = 0;
    const prepared = await prepareRuntimeProviderAuth(config, runtimeEnvironment, {
        loadLifecycle: async () => { throw new Error('synthetic secret must not be reported'); },
        reportUnavailable: () => { reports++; },
    });
    assert.equal(prepared, config);
    assert.equal(reports, 1);
    assert.equal(prepared.clients['google-web'], config.clients['google-web']);
});

test('successfully loaded lifecycle advertises Apple without enabling signup or deletion', async () => {
    const config = loadProviderAuthConfig(runtimeEnvironment);
    // These handles are never invoked: the test checks wiring, not encryption or network clients.
    const lifecycle = { clientId: appleIosId, client: {}, repository: {} } as AppleTokenLifecycle;
    const prepared = await prepareRuntimeProviderAuth(config, runtimeEnvironment, { loadLifecycle: async () => lifecycle });
    assert.equal(prepared.appleTokenLifecycle, lifecycle);
    assert.equal(prepared.clients['apple-ios'].appleTokens, lifecycle.client);
    assert.equal(prepared.clients['apple-ios'].signupEnabled, false);
    assert.equal(prepared.clients['apple-ios'].deletionEnabled, false);
    assert.deepEqual(prepared.publicClients.map(client => client.provider), ['google', 'apple']);
    assert.equal(config.appleTokenLifecycle, undefined);
});

test('runtime hydration rejects wrong audiences or missing notifications without losing Google', async () => {
    for (const env of [runtimeEnvironment, { ...runtimeEnvironment, APPLE_NOTIFICATIONS_ENABLED: 'false' }]) {
        const config = loadProviderAuthConfig(env);
        const lifecycle = { clientId: env.APPLE_NOTIFICATIONS_ENABLED === 'true' ? 'com.other.app' : appleIosId,
            client: {}, repository: {} } as AppleTokenLifecycle;
        let reports = 0;
        assert.equal(await prepareRuntimeProviderAuth(config, env, {
            loadLifecycle: async () => lifecycle, reportUnavailable: () => { reports++; },
        }), config);
        assert.equal(reports, 1);
    }
});

test('ordinary or disabled provider startup performs no runtime secret fetch', async () => {
    for (const env of [enabledEnvironment, { ...runtimeEnvironment, PROVIDER_AUTH_ENABLED: 'false' },
        { ...runtimeEnvironment, APPLE_TOKEN_LIFECYCLE_ENABLED: 'false' },
        { ...runtimeEnvironment, APPLE_IOS_BUNDLE_ID: undefined, APPLE_NOTIFICATIONS_ENABLED: 'false' }]) {
        const config = loadProviderAuthConfig(env);
        assert.equal(await prepareRuntimeProviderAuth(config, env, {
            loadLifecycle: async () => { assert.fail('Unexpected secret access'); },
        }), config);
    }
});
