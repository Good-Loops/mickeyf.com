import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';
import cookieParser from 'cookie-parser';
import type { Pool } from 'mysql2/promise';
import { createParentRegistrationFlow, type ParentRegistrationStore } from '../accounts/parentRegistrationFlow';
import { createProviderAuthContextReader } from '../auth/providerAuthContext';
import { issueSessionToken } from '../security/sessionPolicy';
import { createParentRegistrationRouter } from './parentRegistrationRouter';

const secret = 'parent-http-synthetic-session-secret';
const origin = 'https://example.test';
const account = { userId: 7, userName: 'synthetic-parent', accountId: randomUUID() };
const token = issueSessionToken(account, secret).token;
const signature = createHmac('sha256', secret).update(token).digest('base64').replace(/=+$/u, '');
const cookie = `__session=${encodeURIComponent(`s:${token}.${signature}`)}`;
const input = { purpose: 'create-child', clientKey: 'google-web', policyVersion: 'test', consentVersion: 'test',
    country: 'ZZ', adultAttestation: true, guardianAttestation: true, consent: true };

async function fixture(run: (url: string, calls: string[]) => Promise<void>, enabled = true, liveSession = true) {
    const calls: string[] = [];
    const store: ParentRegistrationStore = { async listChildren() { return []; }, async begin(_attempt, context) { calls.push('begin'); assert.equal(context.account?.accountId, account.accountId); return true; },
        async consumeChallenge() { calls.push('consume'); return null; }, async approve() { assert.fail('unexpected approve'); },
        async isLinkedParent() { assert.fail('unexpected verification'); }, async cancel() { calls.push('cancel'); },
        async createChild() { assert.fail('unexpected create'); }, async withdrawChild() { assert.fail('unexpected delete'); } };
    const database = { async query() { return [liveSession ? [{ userName: account.userName }] : []]; } } as unknown as Pool;
    const flow = createParentRegistrationFlow({ store, clients: { 'google-web': { provider: 'google', verifier: { async verify() { assert.fail('unexpected provider'); } } } },
        policy: enabled ? { version: 'test', consentVersion: 'test', consentText: 'Synthetic reviewed text.', countries: ['ZZ'] } : undefined });
    const app = express(); app.use(cookieParser(secret));
    app.use('/parent', createParentRegistrationRouter(flow,
        createProviderAuthContextReader({ database, sessionSecret: secret, allowedOrigins: [origin] })));
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/parent`, calls); }
    finally { server.close(); server.closeAllConnections(); await once(server, 'close'); }
}
const post = (url: string, body: unknown, extra: Record<string, string> = {}) => fetch(`${url}/begin`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin, cookie, ...extra }, body: JSON.stringify(body),
});

test('HTTP fresh parent challenge binds the existing signed session without setting any login cookie', async () => fixture(async (url, calls) => {
    const result = await post(url, input); assert.equal(result.status, 200);
    assert.match((await result.json() as { state: string }).state, /^[A-Za-z0-9_-]{43}$/u);
    assert.equal(result.headers.get('set-cookie'), null); assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.deepEqual(calls, ['begin']);
}));
test('HTTP rejects untrusted origin, unsigned cookie, bearer substitution and missing parent session before storage', async () => fixture(async (url, calls) => {
    const cases: Record<string, string>[] = [{ origin: 'https://attacker.example' }, { cookie: `__session=${token}` },
        { authorization: `Bearer ${token}` }, { cookie: '' }];
    for (const headers of cases) {
        assert.equal((await post(url, input, headers)).status, 403);
    }
    assert.deepEqual(calls, []);
}));
test('HTTP rejects a revoked live session despite a valid signed token', async () => fixture(async (url, calls) => {
    assert.equal((await post(url, input)).status, 403); assert.deepEqual(calls, []);
}, true, false));
test('HTTP disabled policy exposes no consent or mutation capability', async () => fixture(async (url, calls) => {
    assert.deepEqual(await (await fetch(`${url}/config`)).json(), { enabled: false });
    assert.equal((await post(url, input)).status, 503); assert.deepEqual(calls, []);
}, false));
