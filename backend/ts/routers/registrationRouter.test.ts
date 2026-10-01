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
async function fixture(run: (url: string, queries: string[]) => Promise<void>, enabled = true) {
    const queries: string[] = [];
    const database = { async query({ sql }: { sql: string }) { queries.push(sql); return [{ affectedRows: 1 }]; },
        async getConnection() { assert.fail('HTTP preflight must not create an account'); } } as unknown as Pool;
    const policy = enabled ? loadRegistrationPolicy({ REGISTRATION_ENABLED: 'true', REGISTRATION_POLICY_REVIEWED: 'true',
        REGISTRATION_POLICY_VERSION: 'synthetic', REGISTRATION_COUNTRY_RULES: '{"ZZ":{"parentRequiredBelow":15}}' }) : undefined;
    const registration = createRegistrationAuthorization(database, policy);
    const app = express();
    app.use(cookieParser(secret));
    app.use('/auth/registration', createRegistrationRouter(registration,
        createProviderAuthContextReader({ database, sessionSecret: secret, allowedOrigins: [origin] }), true));
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
test('HTTP policy is closed by default and cannot touch SQL', async () => fixture(async (url, queries) => {
    const config = await fetch(`${url}/auth/registration/config`);
    assert.deepEqual(await config.json(), { enabled: false });
    const result = await begin(url, {});
    assert.equal(result.status, 503);
    assert.deepEqual(await result.json(), { error: 'REGISTRATION_CLOSED' });
    assert.deepEqual(queries, []);
}, false));
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
test('authorized minor preflight uses the canonical signed HttpOnly cookie and declares private scores', async () => fixture(async (url, queries) => {
    const response = await begin(url, { country: 'ZZ', ageBand: 'minor', policyVersion: 'synthetic' });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { authorized: true, expiresInSeconds: 300, scoreVisibility: 'private' });
    assert.match(response.headers.get('set-cookie')!, /^__session=/u);
    assert.match(response.headers.get('set-cookie')!, /HttpOnly; Secure/u);
    assert.equal(queries.length, 2);
}));
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
