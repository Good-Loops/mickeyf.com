import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import cookieParser from 'cookie-parser';
import type { Pool } from 'mysql2/promise';
import { createRegistrationRouter } from './registrationRouter';
import { createProviderAuthContextReader } from '../auth/providerAuthContext';
import { createRegistrationAuthorization } from '../accounts/registrationAuthorization';
import { loadRegistrationPolicy } from '../config/registrationPolicy';
import { createMainController } from '../controllers/mainController';
import { asyncHandler } from '../middleware/errorHandling';

const secret = 'synthetic-registration-http-session-secret';
const origin = 'https://mickeyf.com';
async function fixture(run: (url: string, queries: string[]) => Promise<void>, enabled = true, generalAudience = false,
    childAudience = false, creationEnabled = true) {
    const queries: string[] = [];
    const records = new Map<string, { policy: Buffer; country: string; ageBand: string }>();
    const runQuery = async ({ sql }: { sql: string }, values: unknown[] = []) => {
        queries.push(sql);
        if (childAudience) {
            const key = (value: unknown) => (value as Buffer).toString('hex');
            if (sql.startsWith('INSERT IGNORE INTO registration_authorizations')) {
                const id = key(values[0]);
                if (!records.has(id)) records.set(id, { policy: values[1] as Buffer, country: 'ZZ',
                    ageBand: sql.includes("'adult'") ? 'adult' : 'minor' });
                return [{ affectedRows: 1 }];
            }
            if (sql.startsWith('INSERT INTO registration_authorizations')) {
                records.set(key(values[0]), { policy: values[1] as Buffer, country: values[2] as string, ageBand: values[3] as string });
                return [{ affectedRows: 1 }];
            }
            if (sql.startsWith('DELETE FROM registration_authorizations')) {
                if (values.length) records.delete(key(values[0]));
                return [{ affectedRows: values.length ? 1 : 0 }];
            }
            if (sql.startsWith('SELECT policy_digest, country_code')) return [[]];
            if (sql.startsWith('SELECT binding_hash, policy_digest')) return [[...values.flatMap(value => {
                const record = records.get(key(value));
                return record ? [{ binding_hash: value, policy_digest: record.policy, country_code: record.country,
                    age_band: record.ageBand, consumed_at: null, valid_expiry: 1 }] : [];
            })]];
            if (sql.startsWith('SELECT binding_hash FROM registration_authorizations')) return [records.has(key(values[0])) ? [{ binding_hash: values[0] }] : []];
            if (sql.startsWith('SELECT country_code AS country')) {
                const row = records.get(key(values[0])); return [row ? [{ country: row.country, ageBand: row.ageBand }] : []];
            }
        }
        if (sql.includes('GET_LOCK')) return [[{ acquired: 1 }]];
        if (sql.includes('RELEASE_LOCK')) return [[{ released: 1 }]];
        if (sql.startsWith('SELECT COUNT(*)')) return [[{ pendingCount: 0 }]];
        assert(!/\b(?:users|account_registration_profiles|account_score_permissions)\b/u.test(sql));
        return [{ affectedRows: 1 }];
    };
    const database = { query: runQuery, async getConnection() {
        assert(generalAudience || childAudience, 'legacy HTTP preflight must not borrow an account connection');
        return { query: runQuery, async beginTransaction() {}, async commit() {}, async rollback() {}, release() {}, destroy() {} };
    } } as unknown as Pool;
    const policy = enabled ? loadRegistrationPolicy({ REGISTRATION_ENABLED: 'true', REGISTRATION_POLICY_REVIEWED: 'true',
        REGISTRATION_POLICY_VERSION: 'synthetic', REGISTRATION_COUNTRY_RULES: '{"ZZ":{"parentRequiredBelow":15}}',
        ...(childAudience ? { REGISTRATION_AUDIENCE: 'children-included' } : {}),
        ...(generalAudience ? { REGISTRATION_GENERAL_AUDIENCE_ENABLED: 'true',
            REGISTRATION_GENERAL_AUDIENCE_POLICY_REVIEWED: 'true',
            REGISTRATION_GENERAL_AUDIENCE_POLICY_VERSION: 'synthetic-general' } : {}) }) : undefined;
    const registration = createRegistrationAuthorization(database, policy, policy?.audience, creationEnabled);
    const app = express();
    app.use(cookieParser(secret));
    app.use('/auth/registration', createRegistrationRouter(registration,
        createProviderAuthContextReader({ database, sessionSecret: secret, allowedOrigins: [origin] }), true, childAudience && creationEnabled));
    app.post('/api/users', express.json(), asyncHandler(createMainController({ database, sessionSecret: secret,
        isProduction: true, p4VegaScoreSubmissionsEnabled: false, allowedMutationOrigins: [origin], registration })));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, queries); }
    finally { server.close(); server.closeAllConnections(); await once(server, 'close'); }
}
function begin(url: string, body: unknown, requestOrigin = origin) {
    return fetch(`${url}/auth/registration/begin`, { method: 'POST', headers: { origin: requestOrigin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

test('strict parent-required response binds a signed24h restriction across adult retry, cancellation and credential signup', async () => fixture(async (url, queries) => {
    const bootstrap = await fetch(`${url}/auth/registration/bootstrap`, { method: 'POST',
        headers: { origin, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(bootstrap.status, 200); assert.deepEqual(await bootstrap.json(), { ready: true });
    const header = bootstrap.headers.get('set-cookie')!;
    assert.match(header, /Max-Age=86400/u); assert.match(header, /HttpOnly; Secure/u);
    const cookie = header.split(';')[0];
    const post = (route: string, body: unknown) => fetch(`${url}${route}`, { method: 'POST',
        headers: { origin, cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const initial = await post('/auth/registration/begin', { country: 'ZZ', ageBand: 'parent-required', policyVersion: 'synthetic' });
    assert.equal(initial.status, 403); assert.deepEqual(await initial.json(), { error: 'PARENT_REQUIRED' });
    for (let retry = 0; retry < 2; retry++) {
        const result = await post('/auth/registration/begin', { country: 'ZZ', ageBand: 'adult', policyVersion: 'synthetic' });
        assert.equal(result.status, 403); assert.deepEqual(await result.json(), { error: 'PARENT_REQUIRED' });
        assert.equal(result.headers.get('set-cookie'), null, 'retry cannot replace the screening binding');
        const cancelled = await post('/auth/registration/cancel', {});
        assert.deepEqual(await cancelled.json(), { cancelled: true }); assert.equal(cancelled.headers.get('set-cookie'), null);
    }
    const signup = await post('/api/users', { type: 'signup', user_name: 'premature', email: 'invalid', user_password: 'short' });
    assert.equal(signup.status, 403); assert.deepEqual(await signup.json(), { error: 'REGISTRATION_REQUIRED' });
    assert(queries.every(sql => !/\b(?:users|account_registration_profiles|account_score_permissions)\b/u.test(sql)));
}, true, false, true));
test('HTTP policy is closed by default and cannot touch SQL', async () => fixture(async (url, queries) => {
    const config = await fetch(`${url}/auth/registration/config`);
    assert.deepEqual(await config.json(), { enabled: false });
    const result = await begin(url, {});
    assert.equal(result.status, 503);
    assert.deepEqual(await result.json(), { error: 'REGISTRATION_CLOSED' });
    assert.deepEqual(queries, []);
}, false));

test('strict child contract advertises staged parent availability and rejects credential bodies before validation', async () => fixture(async (url, queries) => {
    const config = await (await fetch(`${url}/auth/registration/config`)).json() as { audience: string; mode?: string; parentRegistrationAvailable: boolean };
    assert.equal(config.audience, 'children-included'); assert.equal(config.mode, undefined); assert.equal(config.parentRegistrationAvailable, true);
    const result = await fetch(`${url}/api/users`, { method: 'POST', headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'signup', user_name: 'premature', email: 'invalid', user_password: 'short' }) });
    assert.equal(result.status, 403); assert.deepEqual(await result.json(), { error: 'REGISTRATION_REQUIRED' });
    assert.deepEqual(queries, [], 'a missing staged cookie must stop before identifier lookup or password processing');
}, true, false, true));

test('strict creation-closed config keeps login eligibility and rejects password signup before credential validation', async () => fixture(async (url, queries) => {
    const config = await (await fetch(`${url}/auth/registration/config`)).json() as Record<string, unknown>;
    assert.equal(config.enabled, true); assert.equal(config.audience, 'children-included');
    assert.equal(config.creationEnabled, false); assert.equal(config.parentRegistrationAvailable, false);
    const bootstrap = await fetch(`${url}/auth/registration/bootstrap`, { method: 'POST',
        headers: { origin, 'content-type': 'application/json' }, body: '{}' });
    const cookie = bootstrap.headers.get('set-cookie')!.split(';')[0];
    const authorized = await fetch(`${url}/auth/registration/begin`, { method: 'POST',
        headers: { origin, cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ country: 'ZZ', ageBand: 'adult', policyVersion: 'synthetic' }) });
    assert.equal(authorized.status, 200);
    queries.length = 0;
    const response = await fetch(`${url}/api/users`, { method: 'POST', headers: { origin, cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'signup', user_name: 'premature', email: 'invalid', user_password: 'short' }) });
    assert.equal(response.status, 403); assert.deepEqual(await response.json(), { error: 'REGISTRATION_REQUIRED' });
    assert.deepEqual(queries, []);
}, true, false, true, false));
test('parent-required, unconfigured country and untrusted origin stop before SQL or a signup cookie', async () => fixture(async (url, queries) => {
    for (const [body, requestOrigin, reason] of [
        [{ country: 'ZZ', ageBand: 'parent-required', policyVersion: 'synthetic' }, origin, 'PARENT_REQUIRED'],
        [{ country: 'US', ageBand: 'adult', policyVersion: 'synthetic' }, origin, 'INVALID_REGISTRATION'],
        [{ country: 'ZZ', ageBand: 'adult', policyVersion: 'synthetic' }, 'https://attacker.example', 'INVALID_CONTEXT'],
    ] as const) {
        const response = await begin(url, body, requestOrigin);
        assert.deepEqual(await response.json(), { error: reason });
        assert.equal(response.headers.get('set-cookie'), null);
    }
    assert.deepEqual(queries, []);
}));
for (const ageBand of ['minor', 'adult'] as const) {
test(`authorized ${ageBand} preflight uses the canonical signed HttpOnly cookie and declares private scores`, async () => fixture(async (url, queries) => {
    const response = await begin(url, { country: 'ZZ', ageBand, policyVersion: 'synthetic' });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { authorized: true, expiresInSeconds: 300, scoreVisibility: 'private' });
    assert.match(response.headers.get('set-cookie')!, /^__session=/u);
    assert.match(response.headers.get('set-cookie')!, /HttpOnly; Secure/u);
    assert.equal(queries.length, 2);
}));
}
test('password signup cannot bypass missing preflight with an age claim in its credential body', async () => fixture(async (url, queries) => {
    const response = await fetch(`${url}/api/users`, { method: 'POST', headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'signup', user_name: 'synthetic', email: 'synthetic@example.test', user_password: 'synthetic-long-password',
            country: 'ZZ', ageBand: 'adult', parentApproved: true }) });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'REGISTRATION_REQUIRED' });
    assert.deepEqual(queries, []);
}));


test('HTTP cancellation is origin-bound, idempotent and cannot create or clear an authenticated session', async () => fixture(async (url, queries) => {
    const authorized = await begin(url, { country: 'ZZ', ageBand: 'adult', policyVersion: 'synthetic' });
    const cookie = authorized.headers.get('set-cookie')!.split(';')[0];
    const cancel = (requestOrigin: string, body: unknown = {}) => fetch(`${url}/auth/registration/cancel`, {
        method: 'POST', headers: { origin: requestOrigin, cookie, 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    queries.length = 0;
    assert.equal((await cancel('https://attacker.example')).status, 403);
    assert.equal((await cancel(origin, { approved: true })).status, 400);
    assert.deepEqual(queries, []);
    for (let repeat = 0; repeat < 2; repeat++) {
        const result = await cancel(origin);
        assert.deepEqual(await result.json(), { cancelled: true });
        assert.equal(result.headers.get('set-cookie'), null);
    }
    assert.equal(queries.length, 2);
    for (const sql of queries) assert.match(sql, /binding_hash = \? AND consumed_at IS NULL/u);
}));

test('general config and begin require no country or age and preserve the existing provider binding on refresh', async () => fixture(async (url, queries) => {
    const config = await fetch(`${url}/auth/registration/config`);
    assert.deepEqual(await config.json(), { enabled: true, mode: 'general-audience', policyVersion: 'synthetic-general',
        optionalDetails: false, parentRegistrationAvailable: false });
    assert.equal(config.headers.get('cache-control'), 'no-store');
    const first = await begin(url, { policyVersion: 'synthetic-general' });
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { authorized: true, expiresInSeconds: 300, scoreVisibility: 'private' });
    const cookie = first.headers.get('set-cookie')!.split(';')[0];
    assert.match(cookie, /^__session=/u);
    assert.match(first.headers.get('set-cookie')!, /HttpOnly; Secure/u);
    queries.length = 0;
    const refreshed = await fetch(`${url}/auth/registration/begin`, { method: 'POST',
        headers: { origin, cookie, 'content-type': 'application/json' }, body: JSON.stringify({ policyVersion: 'synthetic-general' }) });
    assert.equal(refreshed.status, 200);
    const result = await refreshed.json() as { authorized: boolean; expiresInSeconds: number; scoreVisibility: string };
    assert.equal(result.authorized, true); assert.equal(result.scoreVisibility, 'private');
    assert(result.expiresInSeconds >= 295 && result.expiresInSeconds <= 300);
    assert.equal(refreshed.headers.get('set-cookie'), null, 'refresh must preserve an already prepared Google nonce binding');
    assert(queries.some(sql => sql.startsWith('INSERT INTO provider_auth_attempts')));
    assert(queries.every(sql => !/registration_profiles|registration_authorizations/u.test(sql)));
}, true, true));

test('general begin rejects invented age/country, stale policy and untrusted origin without SQL or cookie changes', async () => fixture(async (url, queries) => {
    for (const [body, requestOrigin, error] of [
        [{ policyVersion: 'synthetic-general', ageBand: 'adult' }, origin, 'INVALID_REGISTRATION'],
        [{ policyVersion: 'synthetic-general', country: 'ZZ' }, origin, 'INVALID_REGISTRATION'],
        [{ policyVersion: 'synthetic' }, origin, 'INVALID_REGISTRATION'],
        [{ policyVersion: 'synthetic-general' }, 'https://attacker.example', 'INVALID_CONTEXT'],
    ] as const) {
        const response = await begin(url, body, requestOrigin);
        assert.deepEqual(await response.json(), { error });
        assert.equal(response.headers.get('set-cookie'), null);
    }
    assert.deepEqual(queries, []);
}, true, true));

test('screening bootstrap is stable and observe-only invalidates prior authorization without replacing the cookie', async () => fixture(async (url) => {
    const post = (path: string, body: unknown, cookie?: string) => fetch(`${url}${path}`, { method: 'POST',
        headers: { origin, ...(cookie ? { cookie } : {}), 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const first = await post('/auth/registration/bootstrap', {});
    const cookie = first.headers.get('set-cookie')!.split(';')[0];
    const again = await post('/auth/registration/bootstrap', {}, cookie);
    assert.deepEqual(await again.json(), { ready: true });
    assert.equal(again.headers.get('set-cookie'), null);
    const adult = await post('/auth/registration/begin', { country: 'ZZ', ageBand: 'adult', policyVersion: 'synthetic' }, cookie);
    assert.equal(adult.status, 200); assert.equal(adult.headers.get('set-cookie'), null);
    const observed = await post('/auth/registration/observe', { country: 'ZZ', ageBand: 'parent-required', policyVersion: 'synthetic' }, cookie);
    assert.deepEqual(await observed.json(), { observed: true }); assert.equal(observed.headers.get('set-cookie'), null);
    const retried = await post('/auth/registration/begin', { country: 'ZZ', ageBand: 'adult', policyVersion: 'synthetic' }, cookie);
    assert.equal(retried.status, 403); assert.deepEqual(await retried.json(), { error: 'PARENT_REQUIRED' });
    const invalid = await post('/auth/registration/observe', { country: 'ZZ', ageBand: 'adult', policyVersion: 'synthetic' }, cookie);
    assert.equal(invalid.status, 400);
}, true, false, true));
