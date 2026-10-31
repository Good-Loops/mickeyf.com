import assert from 'node:assert/strict';
import test from 'node:test';
import { loadAppleWebConfig } from './appleWebConfig';
import { loadProviderAuthConfig } from './providerAuthConfig';
import type { AppleTokenLifecycle } from './appleTokenConfig';
import { generateKeyPairSync } from 'node:crypto';
import jwt from 'jsonwebtoken';

const web = { APPLE_WEB_SERVICES_ID: 'com.example.web', APPLE_WEB_REDIRECT_URI: 'https://example.test/login' };
const enabled = { ...web, APPLE_IOS_BUNDLE_ID: 'com.example.ios', PROVIDER_AUTH_ENABLED: 'true',
    APPLE_WEB_AUTH_ENABLED: 'true', APPLE_TOKEN_RUNTIME_SECRETS_ENABLED: 'true', APPLE_TOKEN_LIFECYCLE_ENABLED: 'true',
    APPLE_NOTIFICATIONS_ENABLED: 'true', APPLE_MAINTENANCE_HTTP_ENABLED: 'true', ACCOUNT_DELETION_ENABLED: 'true',
    PROVIDER_APPLE_SIGNUP_ENABLED: 'true', PROVIDER_APPLE_DELETION_ENABLED: 'true' };
const lifecycle = { clientId: enabled.APPLE_IOS_BUNDLE_ID, client: {}, repository: {},
    web: { clientId: web.APPLE_WEB_SERVICES_ID, redirectUri: web.APPLE_WEB_REDIRECT_URI, client: {}, repository: {} } } as AppleTokenLifecycle;

test('web setup requires both exact public identifiers, separate from the native audience', () => {
    assert.equal(loadAppleWebConfig({}), undefined);
    assert.deepEqual(loadAppleWebConfig(web), { clientId: web.APPLE_WEB_SERVICES_ID, redirectUri: web.APPLE_WEB_REDIRECT_URI });
    for (const change of [{ APPLE_WEB_SERVICES_ID: undefined }, { APPLE_WEB_REDIRECT_URI: undefined },
        { APPLE_WEB_SERVICES_ID: 'com.example.web ' }, { APPLE_IOS_BUNDLE_ID: web.APPLE_WEB_SERVICES_ID },
        ...['http://example.test/login', 'https://localhost/login', 'https://127.1/login', 'https://[::1]/login',
            'https://example.test/login#state', 'https://example.test/login?code=private', 'https://user@example.test/login',
            'https://example.test:443/login', 'https://example.test:8443/login', 'https://EXAMPLE.test/login',
            'https://example.test/login\n'].map(APPLE_WEB_REDIRECT_URI => ({ APPLE_WEB_REDIRECT_URI }))]) {
        assert.throws(() => loadAppleWebConfig({ ...web, ...change }), /Apple web/);
    }
    assert.throws(() => loadAppleWebConfig({ APPLE_WEB_AUTH_ENABLED: 'true' }), /Apple web/);
});

test('native and web verifiers cannot accept each other\'s audience, altered nonce or a foreign issuer', async () => {
    const key = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const now = 1_800_000_000;
    const config = loadProviderAuthConfig(enabled, { now: () => now * 1000,
        fetch: async () => Response.json({ keys: [{ ...key.publicKey.export({ format: 'jwk' }), kid: 'test', alg: 'RS256', use: 'sig' }] }),
    }, lifecycle);
    for (const [clientKey, audience, other] of [['apple-ios', enabled.APPLE_IOS_BUNDLE_ID, web.APPLE_WEB_SERVICES_ID],
        ['apple-web', web.APPLE_WEB_SERVICES_ID, enabled.APPLE_IOS_BUNDLE_ID]]) {
        const verifier = config.clients[clientKey].verifier;
        for (const change of [{}, { aud: other }, { nonce: 'wrong' }, { iss: 'https://attacker.test' }]) {
            const token = jwt.sign({ iss: 'https://appleid.apple.com', aud: audience, sub: 'same-primary-app-subject',
                nonce: 'n'.repeat(43), iat: now - 1, exp: now + 300, ...change }, key.privateKey, { algorithm: 'RS256', keyid: 'test' });
            assert.equal((await verifier.verify('apple', token, 'n'.repeat(43))).verified, Object.keys(change).length === 0);
        }
    }
});

test('browser issuance needs exact opt-in, all operational prerequisites and a matching loaded lifecycle', () => {
    const config = loadProviderAuthConfig(enabled, {}, lifecycle);
    assert.deepEqual(config.publicClients.find(client => client.clientKey === 'apple-web'), {
        clientKey: 'apple-web', provider: 'apple', platform: 'web', clientId: web.APPLE_WEB_SERVICES_ID,
        redirectUri: web.APPLE_WEB_REDIRECT_URI, signup: true,
    });
    for (const flag of [undefined, 'false', 'TRUE', '1', 'true\n']) {
        const disabled = loadProviderAuthConfig({ ...enabled, APPLE_WEB_AUTH_ENABLED: flag }, {}, lifecycle);
        assert.equal(disabled.clients['apple-web'], undefined);
        assert.equal(disabled.publicClients.some(client => client.clientKey === 'apple-web'), false);
        assert.equal(disabled.appleTokenLifecycle?.web?.clientId, web.APPLE_WEB_SERVICES_ID);
        assert(disabled.appleNotifications, 'revocation receiving remains available when issuance is paused');
    }
    const unavailable = loadProviderAuthConfig(enabled);
    assert.equal(unavailable.publicClients.some(client => client.clientKey === 'apple-web'), false);
    assert.equal(unavailable.clients['apple-web'].appleTokens, undefined);
    for (const name of ['APPLE_TOKEN_RUNTIME_SECRETS_ENABLED', 'APPLE_TOKEN_LIFECYCLE_ENABLED',
        'APPLE_NOTIFICATIONS_ENABLED', 'APPLE_MAINTENANCE_HTTP_ENABLED', 'ACCOUNT_DELETION_ENABLED']) {
        assert.throws(() => loadProviderAuthConfig({ ...enabled, [name]: 'false' }, {}, lifecycle));
    }
    for (const mismatched of [{ ...lifecycle, web: undefined }, { ...lifecycle, web: { ...lifecycle.web!, clientId: 'com.other.web' } },
        { ...lifecycle, web: { ...lifecycle.web!, redirectUri: 'https://other.test/login' } }]) {
        assert.throws(() => loadProviderAuthConfig(enabled, {}, mismatched), /does not match/);
    }
});
