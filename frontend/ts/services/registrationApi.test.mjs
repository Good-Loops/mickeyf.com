import assert from 'node:assert/strict';
import test from 'node:test';
import { createRegistrationApi, readRegistrationConfig } from './registrationApi.ts';
import { createAuthApi } from './authApi.ts';

const config = { enabled: true, policyVersion: 'synthetic', parentRegistrationAvailable: false,
    countries: [{ country: 'ZZ', parentRequiredBelow: 15, adultFrom: 18 }] };
const input = { country: 'ZZ', ageBand: 'minor', policyVersion: 'synthetic' };
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });
const approved = { authorized: true, expiresInSeconds: 300, scoreVisibility: 'private' };
const general = { enabled: true, mode: 'general-audience', policyVersion: 'synthetic-general',
    optionalDetails: false, parentRegistrationAvailable: false };

test('general-audience configuration is explicit and does not accept implied eligibility or optional details', () => {
    assert.deepEqual(readRegistrationConfig(general), general);
    for (const invalid of [{ ...general, mode: 'general' }, { ...general, optionalDetails: true },
        { ...general, parentRegistrationAvailable: true }, { ...general, countries: config.countries },
        { ...general, ageBand: 'adult' }, { ...general, policyVersion: '' }]) assert.equal(readRegistrationConfig(invalid), null);
});

test('general-audience begin sends only the reviewed policy version, never fabricated country or age', async () => {
    const api = createRegistrationApi('', async (_url, options) => {
        assert.deepEqual(JSON.parse(options.body), { policyVersion: general.policyVersion });
        assert.equal(options.credentials, 'include');
        return response(approved);
    });
    assert.deepEqual(await api.begin({ policyVersion: general.policyVersion, email: 'must-not-send@example.test' }), approved);
});

test('configuration fails closed for absent/unreviewed policy and unsupported parent capability', () => {
    assert.deepEqual(readRegistrationConfig({ enabled: false }), { enabled: false });
    assert.deepEqual(readRegistrationConfig(config), config);
    for (const invalid of [null, {}, { ...config, parentRegistrationAvailable: true },
        { ...config, countries: [...config.countries, ...config.countries] },
        { ...config, countries: [{ ...config.countries[0], parentRequiredBelow: 19 }] },
        { ...config, countries: [{ ...config.countries[0], adultFrom: 17 }] },
        { ...config, secret: 'must-not-be-disclosed' }]) assert.equal(readRegistrationConfig(invalid), null);
});

test('preflight sends only coarse eligibility data with cookie credentials', async () => {
    const api = createRegistrationApi('https://api.example.test', async (url, options) => {
        assert.equal(url, 'https://api.example.test/auth/registration/begin');
        assert.equal(options.method, 'POST');
        assert.equal(options.credentials, 'include');
        assert.deepEqual(JSON.parse(options.body), input);
        return response(approved);
    });
    assert.deepEqual(await api.begin({ ...input, email: 'must-not-send@example.test' }), approved);
});

test('malformed success and uncertain transport cannot authorize credential collection', async () => {
    for (const body of [null, {}, { ...approved, expiresInSeconds: 301 }, { ...approved, expiresInSeconds: 0 },
        { ...approved, scoreVisibility: 'unknown' }, { ...approved, extra: true }]) {
        assert.deepEqual(await createRegistrationApi('', async () => response(body)).begin(input), { error: 'UNAVAILABLE' });
    }
    assert.deepEqual(await createRegistrationApi('', async () => { throw new Error('private transport details'); }).begin(input),
        { error: 'UNAVAILABLE' });
    assert.deepEqual(await createRegistrationApi('', async () => response({ error: 'PARENT_REQUIRED' }, 403)).begin(input),
        { error: 'PARENT_REQUIRED' });
    assert.deepEqual(await createRegistrationApi('', async () => response({ error: 'PARENT_REQUIRED' }, 200)).begin(input),
        { error: 'UNAVAILABLE' });
});

test('cancel waits for pending preflight, then retries can issue a fresh authorization', async () => {
    const calls = [];
    let finish;
    const first = new Promise(resolve => { finish = resolve; });
    const api = createAuthApi('', async (url, options) => {
        calls.push(url);
        if (calls.length === 1) return first;
        if (url.endsWith('/cancel')) { assert.equal(options.body, '{}'); return response({ cancelled: true }); }
        return response(approved);
    });
    const begun = api.beginRegistration(input);
    const cancelled = api.cancelRegistration();
    const retry = api.beginRegistration(input);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, ['/auth/registration/begin']);
    finish(response(approved));
    assert.deepEqual(await begun, approved);
    assert.equal(await cancelled, true);
    assert.deepEqual(await retry, approved);
    assert.deepEqual(calls, ['/auth/registration/begin', '/auth/registration/cancel', '/auth/registration/begin']);
});

test('cancellation never treats a malformed response as proof', async () => {
    for (const body of [{}, { cancelled: false }, { cancelled: true, extra: true }]) {
        assert.equal(await createRegistrationApi('', async () => response(body)).cancel(), false);
    }
});

Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true, writable: true });

test('child screening fails closed without a shared browser lock and on a rejected bootstrap', async t => {
    const calls = [];
    const fetcher = async url => { calls.push(url); return response({ ready: true }); };
    navigator.locks = undefined;
    assert.deepEqual(await createRegistrationApi('', fetcher, { requireChildAudience: true }).begin(input), { error: 'UNAVAILABLE' });
    assert.deepEqual(calls, []);
    navigator.locks = { request: async (_name, _options, work) => work() };
    assert.deepEqual(await createRegistrationApi('', async () => response({ ready: false }), { requireChildAudience: true }).begin(input),
        { error: 'UNAVAILABLE' });
});

test('concurrent screens hold the browser lock through bootstrap and age observation', async t => {
    let tail = Promise.resolve();
    navigator.locks = { request(_name, _options, work) {
        const current = tail.then(work);
        tail = current.catch(() => {});
        return current;
    } };
    t.after(() => { navigator.locks = undefined; });
    const calls = []; let release;
    const waiting = new Promise(resolve => { release = resolve; });
    const fetcher = async (url, options) => {
        const band = options.body === '{}' ? 'bootstrap' : JSON.parse(options.body).ageBand;
        calls.push(band);
        if (band === 'parent-required') { await waiting; return response({ error: 'PARENT_REQUIRED' }, 403); }
        return response(band === 'bootstrap' ? { ready: true } : approved);
    };
    const apiA = createRegistrationApi('', fetcher, { requireChildAudience: true });
    const apiB = createRegistrationApi('', fetcher, { requireChildAudience: true });
    const younger = apiA.begin({ ...input, ageBand: 'parent-required' });
    const adult = apiB.begin({ ...input, ageBand: 'adult' });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, ['bootstrap', 'parent-required']);
    release();
    await younger; await adult;
    assert.deepEqual(calls, ['bootstrap', 'parent-required', 'bootstrap', 'adult']);
});

test('screening bootstrap waits for a concurrent login in another auth instance', async t => {
    let tail = Promise.resolve();
    navigator.locks = { request(_name, _options, work) {
        const current = tail.then(work); tail = current.catch(() => {}); return current;
    } };
    t.after(() => { navigator.locks = undefined; });
    let finishLogin;
    const delayedLogin = new Promise(resolve => { finishLogin = resolve; });
    const calls = [];
    const fetcher = async (url, options = {}) => {
        calls.push(url);
        if (url === '/api/users') return delayedLogin;
        if (url.endsWith('/verify-token')) return response({ loggedIn: true, user_name: 'test-user' });
        if (url.endsWith('/registration/config')) return response({ enabled: true, audience: 'children-included', creationEnabled: true,
            policyVersion: input.policyVersion, parentRegistrationAvailable: true,
            countries: [{ country: 'ZZ', parentRequiredBelow: 15, adultFrom: 18 }] });
        if (url.endsWith('/registration/bootstrap')) return response({ error: 'INVALID_CONTEXT' }, 403);
        if (url.endsWith('/registration/begin')) return response(approved);
        throw new Error('unexpected synthetic endpoint');
    };
    const loginApi = createAuthApi('', fetcher, undefined, { requireChildAudience: true });
    const signupApi = createAuthApi('', fetcher, undefined, { requireChildAudience: true });
    const login = loginApi.loginRequest({ user_name: 'test-user', user_password: 'synthetic' });
    const screening = signupApi.beginRegistration(input);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, ['/api/users']);
    finishLogin(response({ success: true, user_name: 'test-user' }));
    assert.deepEqual(await login, { success: true, user_name: 'test-user' });
    assert.deepEqual(await screening, { error: 'UNAVAILABLE' });
    assert.deepEqual(calls, ['/api/users', '/auth/verify-token', '/auth/registration/config',
        '/auth/registration/bootstrap']);
});

test('stalled screening transport is aborted and cannot hold the shared lock indefinitely', async t => {
    let tail = Promise.resolve();
    navigator.locks = { request(_name, _options, work) { const current = tail.then(work); tail = current.catch(() => {}); return current; } };
    t.after(() => { navigator.locks = undefined; });
    let stalledSignal;
    const stalled = createRegistrationApi('', async (_url, init) => {
        stalledSignal = init.signal;
        return new Promise(() => {});
    }, { requireChildAudience: true, timeoutMs: 20 });
    const waiting = stalled.observe({ ...input, ageBand: 'minor' });
    const available = createRegistrationApi('', async url => response(url.endsWith('/bootstrap') ? { ready: true } : approved),
        { requireChildAudience: true, timeoutMs: 200 });
    const next = available.begin(input);
    assert.equal(await waiting, false);
    assert.equal(stalledSignal.aborted, true);
    assert.deepEqual(await next, approved);
});
