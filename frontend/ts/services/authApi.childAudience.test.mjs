import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import { createAuthApi } from './authApi.ts';
import { createRegistrationApi, readRegistrationConfig } from './registrationApi.ts';
import { selectProviderDeletionClient } from './providerClient.ts';

const policy = { enabled: true, audience: 'children-included', creationEnabled: true, policyVersion: 'synthetic-children',
    parentRegistrationAvailable: true, countries: [{ country: 'US', parentRequiredBelow: 13, adultFrom: 18 },
        { country: 'BR', parentRequiredBelow: 18, adultFrom: 18 }] };
const input = { country: 'US', ageBand: 'adult', policyVersion: policy.policyVersion };
const approved = { authorized: true, expiresInSeconds: 300, scoreVisibility: 'private' };
const challenge = { state: Buffer.alloc(32, 1).toString('base64url'), nonce: Buffer.alloc(32, 2).toString('base64url'), expiresInSeconds: 300 };
const credentials = { user_name: 'Synthetic player', user_password: 'synthetic password', email: 'synthetic@example.test' };
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(change = () => undefined) {
    const calls = [];
    const api = createAuthApi('', async (url, options = {}) => {
        const call = { url, body: options.body ? JSON.parse(options.body) : undefined };
        calls.push(call);
        const replacement = await change(call);
        if (replacement) return replacement;
        if (url.endsWith('/registration/config')) return Response.json(policy);
        if (url.endsWith('/registration/begin')) return Response.json(approved);
        if (url.endsWith('/registration/cancel')) return Response.json({ cancelled: true });
        if (url.endsWith('/providers/begin')) return Response.json(challenge);
        if (url.endsWith('/providers/complete')) return Response.json({ success: true, user_name: credentials.user_name });
        if (url.endsWith('/verify-token')) return Response.json({ loggedIn: true, user_name: credentials.user_name });
        if (url === '/api/users') return Response.json({ success: true });
        throw new Error('Unexpected synthetic request');
    }, undefined, { requireChildAudience: true, prepareGeneralRegistration: true });
    return { api, calls };
}

test('children-included policy is explicit; legacy contracts remain parseable only for explicit legacy consumers', async () => {
    assert.deepEqual(readRegistrationConfig(policy), policy);
    assert.deepEqual(readRegistrationConfig({ ...policy, creationEnabled: false }), { ...policy, creationEnabled: false });
    const legacy = { enabled: true, mode: 'general-audience', policyVersion: 'synthetic-general', optionalDetails: false, parentRegistrationAvailable: false };
    assert.deepEqual(readRegistrationConfig(legacy), legacy);
    for (const body of [legacy, { ...policy, audience: undefined }, { ...policy, mode: 'general-audience' },
        { ...policy, creationEnabled: undefined }, { ...policy, creationEnabled: 'false' },
        { ...policy, parentRegistrationAvailable: 'true' }, { ...policy, extra: true }]) {
        const api = createRegistrationApi('', async () => Response.json(body), { requireChildAudience: true });
        assert.equal(await api.config(), null);
    }
});

test('entry HTML and SPA shell cannot load obsolete provider bootstrap code before eligibility', () => {
    const index=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
    const app=readFileSync(new URL('../App.tsx',import.meta.url),'utf8');
    assert.doesNotMatch(index,/provider-signin-preload|accounts\.google\.com|appleid\.cdn-apple\.com/u);
    assert.doesNotMatch(app,/preloadGoogleSignInForRoute/u);
    assert.equal(existsSync(new URL('../../public/provider-signin-preload.js',import.meta.url)),false);
});

test('a server-managed child account cannot select an external deletion identity', async () => {
    const methods={hasPassword:true,googleLinked:false,googleDeletionEnabled:false,appleLinked:false,
        appleDeletionEnabled:false,providerCollectionAllowed:false};
    const {api}=fixture(call=>call.url.endsWith('/providers/account')?Response.json(methods):undefined);
    assert.deepEqual(await api.providerAccountMethodsRequest(),methods);
    assert.equal(selectProviderDeletionClient([{clientKey:'google-web',provider:'google'}],methods),undefined);
});

test('new source never sends credentials, general grants or provider requests without explicit eligibility', async () => {
    const { api, calls } = fixture();
    assert.equal(await api.prepareSignupRegistration(), 'REGISTRATION_REQUIRED');
    assert.deepEqual(await api.signupRequest(credentials), { error: 'REGISTRATION_REQUIRED' });
    for (const action of ['login', 'signup']) {
        assert.deepEqual(await api.prepareProviderLogin('google-web', {}, action), { error: 'REGISTRATION_REQUIRED' });
        let collected = false;
        const result = await api.runProviderAuthentication({ action, clientKey: 'google-web', ...(action === 'signup' ? { userName: credentials.user_name } : {}) },
            async () => { collected = true; return 'synthetic.identity.signature'; });
        assert.deepEqual(result, { error: 'REGISTRATION_REQUIRED' });
        assert.equal(collected, false);
    }
    assert.deepEqual(calls, []);
});

test('old general backend and fabricated/parent-required selections cannot issue a new-source grant', async () => {
    for (const selection of [{ policyVersion: input.policyVersion }, { ...input, ageBand: 'parent-required' },
        { ...input, country: 'ZZ' }, { ...input, policyVersion: 'stale' }, { ...input, country: 'BR', ageBand: 'minor' }]) {
        const { api, calls } = fixture();
        assert.deepEqual(await api.beginRegistration(selection), { error: 'REGISTRATION_REQUIRED' });
        assert.equal(calls.some(call => call.url.endsWith('/begin')), false);
    }
    const { api, calls } = fixture(call => call.url.endsWith('/registration/config') ? Response.json({
        enabled: true, mode: 'general-audience', policyVersion: input.policyVersion, optionalDetails: false, parentRegistrationAvailable: false }) : undefined);
    assert.deepEqual(await api.beginRegistration(input), { error: 'REGISTRATION_REQUIRED' });
    assert.deepEqual(await api.signupRequest(credentials), { error: 'REGISTRATION_REQUIRED' });
    assert.equal(calls.length, 1);
});

test('a staged private grant permits one password signup, then requires a fresh eligibility step', async () => {
    const { api, calls } = fixture();
    assert.deepEqual(await api.beginRegistration(input), approved);
    assert.deepEqual(await api.signupRequest(credentials), { success: true });
    assert.deepEqual(calls.map(call => call.url), ['/auth/registration/config', '/auth/registration/begin', '/api/users']);
    assert.deepEqual(calls[1].body, input);
    assert.deepEqual(calls[2].body, { type: 'signup', ...credentials });
    assert.deepEqual(await api.signupRequest(credentials), { error: 'REGISTRATION_REQUIRED' });
});

test('paused creation preserves staged provider login while blocking password and provider signup before collection', async () => {
    const { api, calls } = fixture(call => call.url.endsWith('/registration/config')
        ? Response.json({ ...policy, creationEnabled: false, parentRegistrationAvailable: false }) : undefined);
    assert.deepEqual(await api.beginRegistration(input), approved);
    const beforeSignup = calls.length;
    assert.deepEqual(await api.signupRequest(credentials), { error: 'REGISTRATION_CLOSED' });
    assert.equal(await api.prepareSignupRegistration(), 'REGISTRATION_CLOSED');
    assert.deepEqual(await api.prepareProviderLogin('google-web', {}, 'signup'), { error: 'REGISTRATION_CLOSED' });
    assert.deepEqual(await api.runProviderAuthentication({ action: 'signup', clientKey: 'google-web', userName: credentials.user_name },
        async () => assert.fail('Paused creation must not collect provider credentials')), { error: 'REGISTRATION_CLOSED' });
    assert.equal(calls.length, beforeSignup);
    const prepared = await api.prepareProviderLogin('google-web');
    assert.ok('challenge' in prepared);
    assert.deepEqual(await api.completeProviderLogin(prepared.handle, 'synthetic.identity.signature'),
        { success: true, user_name: credentials.user_name });
    assert.deepEqual(calls.slice(beforeSignup).map(call => call.url),
        ['/auth/providers/begin', '/auth/providers/complete', '/auth/verify-token']);
    assert.equal(calls.some(call => call.body?.action === 'signup' || call.body?.type === 'signup'), false);
});

test('paused creation also permits the one-shot provider login only after a fresh staged approval', async () => {
    const { api } = fixture(call => call.url.endsWith('/registration/config')
        ? Response.json({ ...policy, creationEnabled: false, parentRegistrationAvailable: false }) : undefined);
    const login = () => api.runProviderAuthentication({ action: 'login', clientKey: 'google-web' },
        async () => 'synthetic.identity.signature');
    assert.deepEqual(await login(), { error: 'REGISTRATION_REQUIRED' });
    assert.deepEqual(await api.beginRegistration(input), approved);
    assert.deepEqual(await login(), { success: true, user_name: credentials.user_name });
    assert.deepEqual(await login(), { error: 'REGISTRATION_REQUIRED' });
});

for (const action of ['login', 'signup']) test(`provider ${action} requires staged approval before its challenge`, async () => {
    const { api } = fixture();
    await api.beginRegistration(input);
    const prepared = await api.prepareProviderLogin('google-web', {}, action);
    assert.ok('challenge' in prepared);
    assert.deepEqual(await api.completeProviderLogin(prepared.handle, 'synthetic.identity.signature',
        action === 'signup' ? { userName: credentials.user_name } : {}), { success: true, user_name: credentials.user_name });
});

test('provider login never silently turns into account creation in the child-audience source', async () => {
    const { api, calls } = fixture(call => call.url.endsWith('/providers/complete')
        ? Response.json({ signupRequired: true, challenge: { ...challenge, state: Buffer.alloc(32, 3).toString('base64url') } }) : undefined);
    await api.beginRegistration(input);
    const prepared = await api.prepareProviderLogin('google-web');
    assert.deepEqual(await api.completeProviderLogin(prepared.handle, 'synthetic.identity.signature'), { error: 'REGISTRATION_REQUIRED' });
    assert.equal(calls.filter(call => call.url.endsWith('/providers/complete')).length, 1);
    assert.equal(calls.some(call => call.body?.action === 'signup'), false);
});

test('late approval cannot resurrect a cancelled eligibility step', async () => {
    let resolve;
    const response = new Promise(done => { resolve = done; });
    const { api } = fixture(call => call.url.endsWith('/registration/begin') ? response : undefined);
    const begun = api.beginRegistration(input);
    await tick();
    const cancelled = api.cancelRegistration();
    resolve(Response.json(approved));
    await begun; await cancelled;
    assert.deepEqual(await api.signupRequest(credentials), { error: 'REGISTRATION_REQUIRED' });
});

test('public visibility and expired approvals never authorize credential collection', async t => {
    const publicGrant = fixture(call => call.url.endsWith('/registration/begin') ? Response.json({ ...approved, scoreVisibility: 'public' }) : undefined);
    assert.deepEqual(await publicGrant.api.beginRegistration(input), { error: 'UNAVAILABLE' });
    assert.deepEqual(await publicGrant.api.signupRequest(credentials), { error: 'REGISTRATION_REQUIRED' });
    let now = 1000;
    t.mock.method(Date, 'now', () => now);
    const { api } = fixture(); await api.beginRegistration(input); now += 300_001;
    assert.deepEqual(await api.signupRequest(credentials), { error: 'REGISTRATION_REQUIRED' });
});
