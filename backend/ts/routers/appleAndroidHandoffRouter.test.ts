import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';
import cookieParser from 'cookie-parser';
import type { Pool } from 'mysql2/promise';
import { createProviderAuthContextReader } from '../auth/providerAuthContext';
import { createProviderAuthFlow, type ProviderAuthClient } from '../auth/providerAuthFlow';
import type { ProviderAttempt } from '../auth/providerAttemptRepository';
import type { VerifiedProviderIdentity } from '../auth/providerIdentity';
import { createAppleAndroidHandoffFlow } from '../auth/appleAndroidHandoffFlow';
import type { AppleAndroidHandoffBinding, AppleAndroidHandoffCredential } from '../auth/appleAndroidHandoffCrypto';
import type { createAppleAndroidHandoffRepository } from '../auth/appleAndroidHandoffRepository';
import { createProviderAuthRouter } from './providerAuthRouter';
import { APPLE_ANDROID_RETURN_URI } from '../config/appleAndroidConfig';
import { createAuthRouter } from './authRouter';

const native = 'capacitor://localhost';
const web = 'https://mickeyf.com';
const accepted = { idToken: 'synthetic.id.token', authorizationCode: 'synthetic-authorization-code' };
const returnProof = createHash('sha256').update('synthetic-random-envelope-fixture').digest('base64url');
const identity = { provider: 'apple', subject: 'synthetic-subject',
    appleClientId: 'com.example.web', appleIssuedAt: Math.floor(Date.now() / 1000) } as VerifiedProviderIdentity;

async function fixture(enabled = true) {
    const events: string[] = [];
    const attempts = new Map<string, ProviderAttempt>();
    const handoffs = new Map<string, { binding: AppleAndroidHandoffBinding; credential?: AppleAndroidHandoffCredential }>();
    const database = { async query() { throw new Error('No authenticated account or SQL is used by this fixture'); },
        async getConnection() { throw new Error('No external SQL is allowed'); } } as unknown as Pick<Pool, 'query' | 'getConnection'>;
    const verifier: ProviderAuthClient['verifier'] = { async verify(provider, token, nonce) {
        events.push('verify');
        assert.equal(provider, 'apple');
        assert.equal(nonce.length, 43);
        return token === accepted.idToken ? { verified: true, identity } : { verified: false, reason: 'INVALID_PROVIDER_TOKEN' };
    } };
    const store = {
        async readAttempt(hash: Buffer, binding: Buffer) { const value = attempts.get(hash.toString('hex'));
            return value && value.bindingHash.equals(binding) ? { ...value, expiresAt: Date.now() + 299_000 } : null; },
        async create(binding: AppleAndroidHandoffBinding) { events.push('handoff-create');
            handoffs.set(binding.stateHash.toString('hex'), { binding }); return 'created'; },
        async readPending(hash: Buffer) { const value = handoffs.get(hash.toString('hex'));
            return value && !value.credential ? value.binding : null; },
        async cancelPending(binding: AppleAndroidHandoffBinding) { events.push('cancel');
            const key = binding.stateHash.toString('hex'); const row = handoffs.get(key);
            if (!row || row.credential) return false; return handoffs.delete(key); },
        async completeCallback(binding: AppleAndroidHandoffBinding, credential: AppleAndroidHandoffCredential) {
            events.push('callback-ready'); const row = handoffs.get(binding.stateHash.toString('hex'));
            if (!row || row.credential) return null; row.credential = credential; return returnProof; },
        async readReady(hash: Buffer, binding: Buffer) { const value = handoffs.get(hash.toString('hex'));
            return value?.credential && value.binding.bindingHash.equals(binding) ? value.binding : null; },
        async redeem(binding: AppleAndroidHandoffBinding, proof: string) { events.push('redeem'); const key = binding.stateHash.toString('hex');
            const row = handoffs.get(key); const attempt = attempts.get(key);
            if (!row?.credential || !attempt || !attempt.bindingHash.equals(binding.bindingHash) || proof !== returnProof) return null;
            handoffs.delete(key); return row.credential; },
    } as ReturnType<typeof createAppleAndroidHandoffRepository>;
    const handoff = createAppleAndroidHandoffFlow(store, verifier);
    const client: ProviderAuthClient = { provider: 'apple', verifier, signupEnabled: true, deletionEnabled: true,
        appleTokens: { async exchangeCode(code) { events.push('exchange'); assert.equal(code, accepted.authorizationCode);
            return { idToken: accepted.idToken, refreshToken: 'synthetic-refresh' }; }, async revoke() {} } };
    const clients = { 'apple-android': client };
    const flow = createProviderAuthFlow({ enabled: true, clients, attempts: {
        async create(value) { events.push('attempt-create');
            for (const [key, previous] of attempts) if (previous.bindingHash.equals(value.bindingHash)) attempts.delete(key);
            attempts.set(value.stateHash.toString('hex'), value); return 'created'; },
        async consume(hash, binding, clientKey, action) { events.push('attempt-consume');
            const key = hash.toString('hex'); const row = attempts.get(key);
            if (!row || !row.bindingHash.equals(binding) || row.clientKey !== clientKey || row.action !== action) return null;
            attempts.delete(key); return row; },
    }, accounts: { async find() { events.push('account-find'); return { userId: 1,
        accountId: '123e4567-e89b-42d3-a456-426614174000', userName: 'synthetic-player' }; },
        async link() { throw new Error('Unused'); }, async saveAppleToken() { events.push('save-refresh'); } } });
    const readContext = createProviderAuthContextReader({ database, sessionSecret: 'synthetic-test-secret', allowedOrigins: [native, web] });
    const app = express();
    app.use(cookieParser('synthetic-test-secret'));
    app.use('/auth/providers', createProviderAuthRouter({ database, sessionSecret: 'synthetic-test-secret', isProduction: true,
        allowedOrigins: [native, web], clients, enabled, ...(enabled ? { appleAndroidHandoff: handoff } : {}),
        services: { flow, readContext, async establishSession() { events.push('session'); return true; },
            async readAccountMethods() { return null; } } }));
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/auth/providers`;
    const request = (path: string, body: unknown, cookie?: string, origin = native) => fetch(base + path, {
        method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/json', Origin: origin,
            ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body),
    });
    const callback = (body: Record<string, string>) => fetch(base + '/apple-android/callback', { method: 'POST',
        redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
    async function begin() {
        const response = await request('/begin', { clientKey: 'apple-android', action: 'login' });
        assert.equal(response.status, 200);
        return { challenge: await response.json() as { state: string; nonce: string }, cookie: response.headers.get('set-cookie')!.split(';', 1)[0] };
    }
    return { events, attempts, handoffs, base, request, callback, begin,
        async close() { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}

test('Android return exposes no provider credentials or session cookie; original native binding plus return proof redeems once', async () => {
    const f = await fixture();
    try {
        const { challenge, cookie } = await f.begin();
        const callback = await f.callback({ state: challenge.state, id_token: accepted.idToken, code: accepted.authorizationCode });
        assert.equal(callback.status, 303);
        assert.equal(callback.headers.get('location'), `${APPLE_ANDROID_RETURN_URI}#state=${challenge.state}&result=ready&proof=${returnProof}`);
        assert.equal(callback.headers.get('set-cookie'), null);
        assert.equal(callback.headers.get('cache-control'), 'no-store');
        assert.equal(callback.headers.get('referrer-policy'), 'no-referrer');
        assert.doesNotMatch(await callback.text(), /synthetic\.id\.token|authorization-code/u);
        assert.equal((await f.request('/apple-android/credential', { state: challenge.state, proof: returnProof }, cookie, web)).status, 403);
        assert.equal((await f.request('/apple-android/credential', { state: challenge.state, proof: returnProof })).status, 400);
        assert.equal((await f.request('/apple-android/credential', { state: challenge.state }, cookie)).status, 400,
            'knowing the initiating cookie and state cannot bypass verified HTTPS return capture');
        assert.equal((await f.request('/apple-android/credential', { state: challenge.state, proof: 'A'.repeat(43) }, cookie)).status, 400);
        const other = await f.begin();
        assert.equal((await f.request('/apple-android/credential', { state: challenge.state, proof: returnProof }, other.cookie)).status, 400);
        const credential = await f.request('/apple-android/credential', { state: challenge.state, proof: returnProof }, cookie);
        assert.equal(credential.status, 200); assert.deepEqual(await credential.json(), accepted);
        assert.equal((await f.request('/apple-android/credential', { state: challenge.state, proof: returnProof }, cookie)).status, 400);
        assert.equal((await f.callback({ state: challenge.state, id_token: accepted.idToken, code: accepted.authorizationCode })).status, 400);
        f.events.length = 0;
        const complete = await f.request('/complete', { clientKey: 'apple-android', action: 'login', state: challenge.state, ...accepted }, cookie);
        assert.equal(complete.status, 200);
        assert.deepEqual(f.events, ['attempt-consume', 'verify', 'account-find', 'exchange', 'verify', 'save-refresh', 'session']);
        assert.equal((await f.request('/complete', { clientKey: 'apple-android', action: 'login', state: challenge.state, ...accepted }, cookie)).status, 400);
    } finally { await f.close(); }
});

test('unknown/malformed callbacks never verify; known invalid Apple token/cancel returns fixed destination without storing credentials', async () => {
    const f = await fixture();
    try {
        assert.equal((await f.callback({ state: 'x'.repeat(43), id_token: accepted.idToken, code: accepted.authorizationCode })).status, 400);
        assert.equal(f.events.includes('verify'), false);
        const first = await f.begin(); f.events.length = 0;
        const invalid = await f.callback({ state: first.challenge.state, id_token: 'rejected.token.value', code: accepted.authorizationCode });
        assert.equal(invalid.headers.get('location'), `${APPLE_ANDROID_RETURN_URI}#state=${first.challenge.state}&result=cancelled`);
        assert.deepEqual(f.events, ['verify', 'cancel']);
        assert.equal((await f.request('/apple-android/credential', { state: first.challenge.state, proof: returnProof }, first.cookie)).status, 400);
        const second = await f.begin(); f.events.length = 0;
        const cancelled = await f.callback({ state: second.challenge.state, error: 'user_cancelled_authorize', redirect_uri: 'https://attacker.test' });
        assert.equal(cancelled.headers.get('location'), `${APPLE_ANDROID_RETURN_URI}#state=${second.challenge.state}&result=cancelled`);
        assert.deepEqual(f.events, ['cancel']);
        assert.equal(cancelled.headers.get('set-cookie'), null);
    } finally { await f.close(); }
});

test('off and nonnative begin never touch handoffs; replaced attempt and extra redeem fields fail closed', async () => {
    const off = await fixture(false);
    try {
        assert.equal((await off.request('/apple-android/credential', { state: 'x'.repeat(43) })).status, 404);
        assert.equal((await off.callback({ state: 'x'.repeat(43) })).status, 404);
        assert.deepEqual(off.events, []);
    } finally { await off.close(); }
    const f = await fixture();
    try {
        assert.equal((await f.request('/begin', { clientKey: 'apple-android', action: 'login' }, undefined, web)).status, 503);
        assert.deepEqual(f.events, []);
        const { challenge, cookie } = await f.begin();
        await f.callback({ state: challenge.state, id_token: accepted.idToken, code: accepted.authorizationCode });
        assert.equal((await f.request('/apple-android/credential', { state: challenge.state, proof: returnProof, idToken: accepted.idToken }, cookie)).status, 400);
        f.attempts.delete(createHash('sha256').update(challenge.state).digest('hex'));
        assert.equal((await f.request('/apple-android/credential', { state: challenge.state, proof: returnProof }, cookie)).status, 400);
    } finally { await f.close(); }
});

test('verified return fallback contains only fixed text and never processes state, cookies or credentials', async () => {
    let reads = 0;
    const database = { async query() { reads++; throw new Error('No SQL allowed'); },
        async getConnection() { reads++; throw new Error('No SQL allowed'); } } as unknown as Pick<Pool, 'query' | 'getConnection'>;
    const app = express();
    app.use('/auth', createAuthRouter(database, 'synthetic-test-secret', true, [native], { providerAuth: {
        enabled: true, clients: { 'apple-android': { provider: 'apple', verifier: { async verify() { assert.fail('No verification allowed'); } } } },
    } }));
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    try {
        const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/auth/native/apple-return?state=untrusted&result=ready`);
        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-type')!, /^text\/plain/u);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
        assert.equal(response.headers.get('set-cookie'), null);
        assert.doesNotMatch(await response.text(), /untrusted|ready/u);
        assert.equal(reads, 0);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
