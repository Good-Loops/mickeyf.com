import assert from 'node:assert/strict';
import notice from '../../../shared/privacyNotice.json' with { type: 'json' };
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { createParentRegistrationApi } from './parentRegistrationApi.ts';
const response = (value, status = 200) => new Response(JSON.stringify(value), { status });
const config = { enabled: true, creationEnabled: true, policyVersion: 'test-policy', consentVersion: 'test-consent', consentText: 'Synthetic consent.', privacyNoticeUrl: 'https://notice.example.test/privacy', countries: ['ZZ'] };
const random = () => randomBytes(32).toString('base64url');
const challenge = { state: random(), nonce: random(), expiresInSeconds: 300 };
const consent = { country: 'ZZ', adultAttestation: true, guardianAttestation: true, consent: true };

test('parent consent request contains only reviewed coarse fields, never child credentials or claimed parent identity', async () => {
    const api = createParentRegistrationApi('https://api.example.test', async (url, options) => {
        assert.equal(url, 'https://api.example.test/auth/parent-registration/begin');
        assert.equal(options.credentials, 'include'); assert.equal(options.method, 'POST');
        assert.deepEqual(JSON.parse(options.body), { purpose: 'create-child', policyVersion: config.policyVersion,
            consentVersion: config.consentVersion, privacyNoticeUrl: config.privacyNoticeUrl, clientKey: 'google-web', ...consent });
        return response(challenge);
    });
    assert.deepEqual(await api.begin(config, 'google-web', { ...consent, parentAccountId: randomUUID(), email: 'child@example.test', password: 'never-send' }), challenge);
});

test('parent configuration rejects undeclared fields, duplicate countries and empty consent', async () => {
    assert.deepEqual(await createParentRegistrationApi('', async () => response(config)).config(), config);
    assert.deepEqual(await createParentRegistrationApi('', async () => response({ enabled: false })).config(), { enabled: false });
    for (const value of [{ ...config, countries: ['ZZ', 'ZZ'] }, { ...config, countries: [] }, { ...config, consentText: '' },
        { ...config, legalAssurance: 'global' }, { ...config, policyVersion: '' }]) {
        await assert.rejects(createParentRegistrationApi('', async () => response(value)).config(), { code: 'UNAVAILABLE' });
    }
});

test('a missing or unsafe server notice prevents parent consent configuration from being accepted', async () => {
    for (const privacyNoticeUrl of [undefined, '', '/privacy', 'javascript:alert(1)', 'http://notice.example.test/privacy',
        'https://u:p@notice.example.test/privacy', 'https://notice.example.test/privacy?child=123']) {
        await assert.rejects(createParentRegistrationApi('', async () => response({ ...config, privacyNoticeUrl })).config(), { code: 'UNAVAILABLE' });
    }
});

test('malformed challenges cannot open provider collection or child credentials', async () => {
    for (const value of [{ ...challenge, nonce: 'bad' }, { ...challenge, expiresInSeconds: 0 }, { ...challenge, expiresInSeconds: 301 },
        { ...challenge, state: 'bad' }, { ...challenge, extra: true }]) {
        await assert.rejects(createParentRegistrationApi('', async () => response(value)).begin(config, 'google-web', consent), { code: 'UNAVAILABLE' });
    }
});

test('proof submission sends no unsigned provider profile or authorization code; server response must declare purpose', async () => {
    const proof = { grant: random(), purpose: 'create-child', expiresInSeconds: 250 };
    const api = createParentRegistrationApi('', async (_url, options) => {
        assert.deepEqual(JSON.parse(options.body), { state: challenge.state, idToken: 'signed-token' }); return response(proof);
    });
    assert.deepEqual(await api.complete(challenge.state, 'signed-token'), proof);
    for (const value of [{ ...proof, purpose: 'login' }, { ...proof, grant: '' }, { ...proof, expiresInSeconds: 301 }]) {
        await assert.rejects(createParentRegistrationApi('', async () => response(value)).complete(challenge.state, 'token'), { code: 'UNAVAILABLE' });
    }
});

test('a public or malformed child response never reports successful private creation', async () => {
    const child = { accountId: randomUUID(), userName: 'nickname', scoreVisibility: 'private' };
    const api = createParentRegistrationApi('', async (_url, options) => {
        assert.deepEqual(Object.keys(JSON.parse(options.body)).sort(), ['grant', 'password', 'userName']);
        return response({ created: true, child });
    });
    assert.deepEqual(await api.createChild(random(), 'nickname', 'synthetic-password'), child);
    for (const value of [{ ...child, scoreVisibility: 'public' }, { ...child, accountId: '-'.repeat(36) }, { ...child, email: 'unexpected' }]) {
        await assert.rejects(createParentRegistrationApi('', async () => response({ created: true, child: value })).createChild(random(), 'nickname', 'synthetic-password'), { code: 'UNAVAILABLE' });
    }
});

test('uncertain transport is sanitized and cannot be mistaken for confirmed creation or cancellation', async () => {
    const api = createParentRegistrationApi('', async () => { throw new Error('sensitive transport details'); });
    await assert.rejects(api.createChild(random(), 'nickname', 'synthetic-password'), error => error.code === 'UNAVAILABLE' && !error.message.includes('sensitive'));
    await assert.rejects(api.cancel(challenge.state), { code: 'UNAVAILABLE' });
    await assert.rejects(createParentRegistrationApi('', async () => response({ error: 'VERIFIED_CONTACT_REQUIRED' }, 200))
        .complete(challenge.state, 'token'), { code: 'UNAVAILABLE' });
    await assert.rejects(createParentRegistrationApi('', async () => response({ error: 'VERIFIED_CONTACT_REQUIRED' }, 403))
        .complete(challenge.state, 'token'), { code: 'VERIFIED_CONTACT_REQUIRED' });
});

test('cancellation is scoped by challenge; failed cancellation remains unconfirmed', async () => {
    const api = createParentRegistrationApi('', async (_url, options) => {
        assert.deepEqual(JSON.parse(options.body), { state: challenge.state }); return response({ cancelled: true });
    });
    await api.cancel(challenge.state);
    await assert.rejects(createParentRegistrationApi('', async () => response({ cancelled: false })).cancel(challenge.state), { code: 'UNAVAILABLE' });
});

test('child listing requires authenticated POST and rejects public, oversized or identifying response fields', async () => {
    const child = { accountId: randomUUID(), userName: 'nickname', scoreVisibility: 'private' };
    const api = createParentRegistrationApi('', async (url, options) => {
        assert.equal(url, '/auth/parent-registration/children/list');
        assert.equal(options.method, 'POST'); assert.equal(options.credentials, 'include'); assert.equal(options.body, '{}');
        return response({ children: [child] });
    });
    assert.deepEqual(await api.listChildren(), [{ accountId: child.accountId, userName: child.userName }]);
    for (const children of [[{ ...child, email: 'unexpected' }], [{ ...child, scoreVisibility: 'public' }], Array(51).fill(child)]) {
        await assert.rejects(createParentRegistrationApi('', async () => response({ children })).listChildren(), { code: 'UNAVAILABLE' });
    }
});

test('withdrawal binds the exact child and explicit destructive confirmation without sending creation consent', async () => {
    const childAccountId = randomUUID(); const grant = random(); const requests = [];
    const api = createParentRegistrationApi('', async (url, options) => {
        requests.push({ url, body: JSON.parse(options.body) });
        return response(url.endsWith('/begin') ? challenge : { deleted: true });
    });
    await api.beginWithdrawal(config, 'google-web', childAccountId); await api.withdraw(grant);
    assert.deepEqual(requests, [
        { url: '/auth/parent-registration/begin', body: { purpose: 'withdraw-child', policyVersion: config.policyVersion,
            clientKey: 'google-web', childAccountId, confirmation: 'WITHDRAW AND DELETE' } },
        { url: '/auth/parent-registration/withdraw', body: { grant, confirmation: 'WITHDRAW AND DELETE' } },
    ]);
    await assert.rejects(createParentRegistrationApi('', async () => response({ deleted: false })).withdraw(grant), { code: 'UNAVAILABLE' });
});

test('signed form configuration must match the bundled notice and only accepts exact private request metadata', async () => {
    const signedConfig = { ...config, countries: ['US'], signedFormCountries: ['US'], signedFormVersion: notice.signedParentForm.version };
    assert.deepEqual(await createParentRegistrationApi('', async () => response(signedConfig)).config(), signedConfig);
    for (const patch of [{ signedFormVersion: 'old' }, { signedFormCountries: ['US', 'ZZ'] }, { signedFormVersion: undefined }]) {
        await assert.rejects(createParentRegistrationApi('', async () => response({ ...signedConfig, ...patch })).config(), { code: 'UNAVAILABLE' });
    }
    const form = { reference: randomUUID(), parentAccountId: randomUUID(), country: 'US', userName: 'synthetic-child', verifiedContact: 'parent@example.test',
        policyVersion: 'policy-test', consentVersion: 'consent-test', status: 'pending', expiresAt: new Date(Date.now()+86400000).toISOString(),
        publicPolicyDigest: null, publicConsentText: null, publicConsentVersion: null };
    const requests = [];
    const api = createParentRegistrationApi('', async (url, options) => {
        requests.push(JSON.parse(options.body)); return response({ form });
    });
    const state = random(); assert.deepEqual(await api.requestSignedForm(state, 'synthetic-proof', form.userName), form);
    assert.deepEqual(requests, [{ state, idToken: 'synthetic-proof', userName: form.userName }]);
    for (const patch of [{ childPassword: 'unexpected' }, { status: 'used' }, { reference: 'foreign' }, { expiresAt: 'never' }, { country: 'ZZ' }, { publicConsentText: 'unbound' }]) {
        await assert.rejects(createParentRegistrationApi('', async () => response({ form: { ...form, ...patch } })).requestSignedForm(state, 'proof', form.userName), { code: 'UNAVAILABLE' });
    }
});
