import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { loadAppleTokenConfig } from './appleTokenConfig';
import { loadProviderAuthConfig, prepareRuntimeProviderAuth } from './providerAuthConfig';
import { APPLE_ANDROID_CALLBACK_URI } from './appleAndroidConfig';

const privateKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
const env = {
    PROVIDER_AUTH_ENABLED: 'true', APPLE_NOTIFICATIONS_ENABLED: 'true', APPLE_TOKEN_LIFECYCLE_ENABLED: 'true',
    APPLE_TOKEN_RUNTIME_SECRETS_ENABLED: 'true', APPLE_MAINTENANCE_HTTP_ENABLED: 'true', ACCOUNT_DELETION_ENABLED: 'true',
    APPLE_IOS_BUNDLE_ID: 'com.example.app', APPLE_WEB_AUTH_ENABLED: 'true', APPLE_WEB_SERVICES_ID: 'com.example.web',
    APPLE_WEB_REDIRECT_URI: 'https://example.test/login', APPLE_SIGN_IN_TEAM_ID: 'ABCDEFGHIJ', APPLE_SIGN_IN_KEY_ID: '0123456789',
    APPLE_SIGN_IN_PRIVATE_KEY: privateKey, APPLE_TOKEN_ACTIVE_KEY_ID: 'synthetic',
    APPLE_TOKEN_ENCRYPTION_KEYS: JSON.stringify({ synthetic: Buffer.alloc(32, 4).toString('base64') }),
    PROVIDER_APPLE_SIGNUP_ENABLED: 'true', PROVIDER_APPLE_DELETION_ENABLED: 'true',
};

test('absent or inexact Android opt-in keeps current lifecycle and public metadata unchanged', () => {
    const baselineLifecycle = loadAppleTokenConfig(env)!;
    const baseline = loadProviderAuthConfig(env, {}, baselineLifecycle);
    for (const flag of [undefined, 'false', 'TRUE', '1', 'true\n']) {
        const lifecycle = loadAppleTokenConfig({ ...env, APPLE_ANDROID_AUTH_ENABLED: flag })!;
        assert.equal(lifecycle.android, undefined);
        const config = loadProviderAuthConfig({ ...env, APPLE_ANDROID_AUTH_ENABLED: flag }, {}, lifecycle);
        assert.equal(config.appleAndroidEnabled, undefined);
        assert.equal(config.clients['apple-android'], undefined);
        assert.deepEqual(config.publicClients, baseline.publicClients);
    }
});

test('Android uses existing Services ID repository/keyring and a distinct exact callback token client', async () => {
    const requests: URLSearchParams[] = [];
    const original = globalThis.fetch;
    let lifecycle;
    try {
        globalThis.fetch = async (_input, init) => {
            requests.push(new URLSearchParams(String(init?.body)));
            return new Response(JSON.stringify({ id_token: 'synthetic.id.token', refresh_token: 'synthetic-refresh' }),
                { headers: { 'content-type': 'application/json' } });
        };
        lifecycle = loadAppleTokenConfig({ ...env, APPLE_ANDROID_AUTH_ENABLED: 'true' })!;
    } finally { globalThis.fetch = original; }
    assert.equal(lifecycle.android!.repository, lifecycle.web!.repository);
    assert.notEqual(lifecycle.android!.client, lifecycle.web!.client);
    assert.equal(lifecycle.android!.redirectUri, APPLE_ANDROID_CALLBACK_URI);
    await lifecycle.android!.client.exchangeCode('synthetic-code');
    await lifecycle.web!.client.exchangeCode('synthetic-code');
    await lifecycle.client.exchangeCode('synthetic-code');
    assert.deepEqual(requests.map(form => form.get('redirect_uri')), [APPLE_ANDROID_CALLBACK_URI, env.APPLE_WEB_REDIRECT_URI, null]);
    assert.deepEqual(requests.map(form => form.get('client_id')), ['com.example.web', 'com.example.web', 'com.example.app']);
    const configured = loadProviderAuthConfig({ ...env, APPLE_ANDROID_AUTH_ENABLED: 'true' }, {}, lifecycle);
    assert.equal(configured.appleAndroidEnabled, true);
    assert.deepEqual(configured.publicClients.at(-1), { clientKey: 'apple-android', provider: 'apple', platform: 'android',
        clientId: 'com.example.web', redirectUri: APPLE_ANDROID_CALLBACK_URI, signup: true });
    assert.equal(configured.clients['apple-android'].appleTokens, lifecycle.android!.client);
    assert.doesNotMatch(JSON.stringify(configured.publicClients), /PRIVATE KEY|handoffCrypto|encryptionKeys/u);
});

test('Android prerequisites and lifecycle mismatch fail closed; credential outage hides Android issuance', async () => {
    const enabled = { ...env, APPLE_ANDROID_AUTH_ENABLED: 'true' };
    for (const change of [{ APPLE_WEB_AUTH_ENABLED: 'false' }, { APPLE_WEB_SERVICES_ID: undefined },
        { APPLE_NOTIFICATIONS_ENABLED: 'false' }, { ACCOUNT_DELETION_ENABLED: 'false' }]) {
        assert.throws(() => loadProviderAuthConfig({ ...enabled, ...change }));
    }
    const existing = loadAppleTokenConfig(env)!;
    assert.throws(() => loadProviderAuthConfig(enabled, {}, existing), /Android lifecycle/u);
    const config = loadProviderAuthConfig(enabled);
    assert.equal(config.publicClients.some(client => client.clientKey === 'apple-android'), false);
    assert.equal(config.clients['apple-android'].appleTokens, undefined);
    let reports = 0;
    assert.equal(await prepareRuntimeProviderAuth(config, enabled, { async loadLifecycle() { throw new Error('synthetic-private'); },
        reportUnavailable() { reports++; } }), config);
    assert.equal(reports, 1);
});
