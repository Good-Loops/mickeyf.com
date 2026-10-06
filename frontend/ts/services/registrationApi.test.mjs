import assert from 'node:assert/strict';
import test from 'node:test';
import { createRegistrationApi, readRegistrationConfig } from './registrationApi.ts';
import { createAuthApi } from './authApi.ts';

const config = { enabled: true, policyVersion: 'synthetic', parentRegistrationAvailable: false,
    countries: [{ country: 'ZZ', parentRequiredBelow: 15, adultFrom: 18 }] };
const input = { country: 'ZZ', ageBand: 'minor', policyVersion: 'synthetic' };
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });
const approved = { authorized: true, expiresInSeconds: 300, scoreVisibility: 'private' };

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
