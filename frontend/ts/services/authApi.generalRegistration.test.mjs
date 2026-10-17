import assert from 'node:assert/strict';
import test from 'node:test';
import { createAuthApi } from './authApi.ts';

const policy = { enabled: true, mode: 'general-audience', policyVersion: 'synthetic-general',
    optionalDetails: false, parentRegistrationAvailable: false };
const grant = { authorized: true, expiresInSeconds: 300, scoreVisibility: 'private' };
const challenge = { state: Buffer.alloc(32, 1).toString('base64url'),
    nonce: Buffer.alloc(32, 2).toString('base64url'), expiresInSeconds: 300 };
const credentials = { user_name: 'Synthetic Player', user_password: 'synthetic password', email: 'synthetic@example.test' };
const token = 'synthetic.identity.signature';
const turn = () => new Promise(resolve => setImmediate(resolve));

function fixture(override = async () => undefined) {
    const calls = [];
    const api = createAuthApi('', async (url, init = {}) => {
        const call = { url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined };
        calls.push(call);
        const changed = await override(call);
        if (changed !== undefined) return changed;
        if (url.endsWith('/registration/config')) return Response.json(policy);
        if (url.endsWith('/registration/begin')) return Response.json(grant);
        if (url.endsWith('/providers/begin')) return Response.json(challenge);
        if (url.endsWith('/providers/complete')) return Response.json({ success: true, user_name: credentials.user_name });
        if (url.endsWith('/verify-token')) return Response.json({ loggedIn: true, user_name: credentials.user_name });
        if (url === '/api/users') return Response.json({ success: true });
        throw new Error('Unexpected synthetic request');
    }, undefined, { prepareGeneralRegistration: true });
    return { api, calls };
}

test('background preparation and password signup share one private anonymous grant, then refresh after consumption', async () => {
    const { api, calls } = fixture();
    assert.equal(await api.prepareSignupRegistration(), null);
    assert.deepEqual(calls, [
        { url: '/auth/registration/config', method: 'GET', body: undefined },
        { url: '/auth/registration/begin', method: 'POST', body: { policyVersion: policy.policyVersion } },
    ]);
    assert.deepEqual(await api.signupRequest(credentials), { success: true });
    assert.equal(calls.filter(call => call.url.endsWith('/registration/begin')).length, 1);
    assert.deepEqual(calls.at(-1).body, { type: 'signup', ...credentials });
    await api.signupRequest(credentials);
    assert.equal(calls.filter(call => call.url.endsWith('/registration/begin')).length, 2);
    assert.equal(calls.some(call => call.body && ('country' in call.body || 'ageBand' in call.body)), false);
});

test('provider signup receives a grant before its challenge and still uses the explicit signup completion', async () => {
    const { api, calls } = fixture();
    const prepared = await api.prepareProviderLogin('google-web', {}, 'signup');
    assert.deepEqual(calls.map(call => call.url), ['/auth/registration/config', '/auth/registration/begin', '/auth/providers/begin']);
    assert.equal('challenge' in prepared, true);
    assert.deepEqual(await api.completeProviderLogin(prepared.handle, token, { userName: credentials.user_name }),
        { success: true, user_name: credentials.user_name });
    assert.deepEqual(calls.find(call => call.url.endsWith('/providers/complete')).body,
        { action: 'signup', clientKey: 'google-web', state: challenge.state, idToken: token,
            rememberMe: false, userName: credentials.user_name });
});

test('missing, closed or malformed general authorization cannot send credentials or begin provider signup', async () => {
    for (const [path, body] of [
        ['/registration/config', { enabled: false }],
        ['/registration/config', { ...policy, optionalDetails: true }],
        ['/registration/begin', { ...grant, scoreVisibility: 'public' }],
        ['/registration/begin', { ...grant, expiresInSeconds: 0 }],
    ]) {
        const { api, calls } = fixture(async call => call.url.endsWith(path) ? Response.json(body) : undefined);
        assert.ok('error' in await api.signupRequest(credentials));
        assert.ok('error' in await api.prepareProviderLogin('google-web', {}, 'signup'));
        assert.equal(calls.some(call => call.url === '/api/users' || call.url.endsWith('/providers/begin')), false);
    }
});

test('an unresolved grant cookie mutation finishes before any queued provider challenge', async () => {
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    const { api, calls } = fixture(async call => call.url.endsWith('/registration/begin') ? pending : undefined);
    const preparation = api.prepareSignupRegistration();
    const provider = api.prepareProviderLogin('google-web', {}, 'signup');
    await turn();
    assert.deepEqual(calls.map(call => call.url), ['/auth/registration/config', '/auth/registration/begin']);
    release(Response.json(grant));
    assert.equal(await preparation, null);
    assert.equal('challenge' in await provider, true);
    assert.equal(calls.at(-1).url, '/auth/providers/begin');
});

test('refreshing a general grant does not invalidate a previously prepared signup nonce', async t => {
    let now = 100_000;
    t.mock.method(Date, 'now', () => now);
    const { api, calls } = fixture(async call => call.url.endsWith('/registration/begin')
        ? Response.json({ ...grant, expiresInSeconds: 20 }) : undefined);
    const prepared = await api.prepareProviderLogin('google-web', {}, 'signup');
    now += 15_000;
    assert.equal(await api.prepareSignupRegistration(), null);
    assert.equal(calls.filter(call => call.url.endsWith('/registration/begin')).length, 2);
    assert.deepEqual(await api.completeProviderLogin(prepared.handle, token, { userName: credentials.user_name }),
        { success: true, user_name: credentials.user_name });
});

test('ordinary login never creates a general registration grant', async () => {
    const { api, calls } = fixture();
    assert.equal('challenge' in await api.prepareProviderLogin('google-web', {}, 'login'), true);
    assert.deepEqual(calls.map(call => call.url), ['/auth/providers/begin']);
});
