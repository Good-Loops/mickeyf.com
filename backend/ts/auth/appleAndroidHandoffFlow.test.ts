import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import test from 'node:test';
import jwt from 'jsonwebtoken';
import { createAppleAndroidHandoffFlow } from './appleAndroidHandoffFlow';
import { createProviderTokenVerifier } from './providerTokenVerifier';
import type { createAppleAndroidHandoffRepository } from './appleAndroidHandoffRepository';
import type { AppleAndroidHandoffBinding } from './appleAndroidHandoffCrypto';
import { APPLE_ANDROID_RETURN_URI } from '../config/appleAndroidConfig';
import type { Pool } from 'mysql2/promise';
import { createProviderAuthContextReader } from './providerAuthContext';
import { issueSessionToken } from '../security/sessionPolicy';
import type { VerifiedProviderIdentity } from './providerIdentity';

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const audience = 'com.example.web';
const now = Date.now();
const proof = createHash('sha256').update('synthetic-random-envelope-fixture').digest('base64url');

test('callback verifies real Apple signature/audience/nonce/expiry before the pending-to-ready transition', async () => {
    for (const failure of ['none', 'signature', 'audience', 'nonce', 'expiry', 'issuer']) {
        const state = randomBytes(32).toString('base64url');
        const binding: AppleAndroidHandoffBinding = { stateHash: createHash('sha256').update(state).digest(),
            bindingHash: randomBytes(32), nonce: randomBytes(32).toString('base64url'), clientKey: 'apple-android',
            action: 'login', accountId: null, userId: null, expiresAt: now + 240_000 };
        const events: string[] = [];
        const verifier = createProviderTokenVerifier({ appleAudience: audience }, { now: () => now,
            fetch: async url => { assert.equal(url, 'https://appleid.apple.com/auth/keys'); events.push('apple-keys');
                return new Response(JSON.stringify({ keys: [{ ...rsa.publicKey.export({ format: 'jwk' }),
                    kid: 'synthetic-key', use: 'sig', alg: 'RS256' }] })); } });
        const store = {
            async readPending(hash: Buffer) { assert.deepEqual(hash, binding.stateHash); return binding; },
            async completeCallback(actual: AppleAndroidHandoffBinding) { assert.equal(actual, binding); events.push('store-ready'); return proof; },
            async cancelPending() { events.push('cancel'); return true; },
        } as unknown as ReturnType<typeof createAppleAndroidHandoffRepository>;
        const wrongKey = failure === 'signature' ? generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey : rsa.privateKey;
        const token = jwt.sign({ iss: failure === 'issuer' ? 'https://attacker.test' : 'https://appleid.apple.com',
            aud: failure === 'audience' ? 'com.other.web' : audience, sub: 'synthetic-apple-subject',
            nonce: failure === 'nonce' ? randomBytes(32).toString('base64url') : binding.nonce,
            iat: Math.floor(now / 1000) - 10, exp: Math.floor(now / 1000) + (failure === 'expiry' ? -1 : 120),
        }, wrongKey, { algorithm: 'RS256', keyid: 'synthetic-key' });
        const result = await createAppleAndroidHandoffFlow(store, verifier).callback({ state, id_token: token, code: 'synthetic-code' });
        assert.equal(result, `${APPLE_ANDROID_RETURN_URI}#state=${state}&result=${failure === 'none' ? `ready&proof=${proof}` : 'cancelled'}`);
        assert.equal(events.includes('store-ready'), failure === 'none');
        assert.equal(events.includes('cancel'), failure !== 'none');
    }
});

test('authenticated preparation keeps the original SQL deadline and unavailable issuance still permits fresh deletion', async () => {
    const account = { userId: 1, accountId: '123e4567-e89b-42d3-a456-426614174000', userName: 'synthetic-player' };
    const database = { async query() { return [[account], []]; } } as unknown as Pick<Pool, 'query'>;
    const context = await createProviderAuthContextReader({ database, sessionSecret: 'synthetic-secret',
        allowedOrigins: ['capacitor://localhost'] })({ method: 'POST', headers: {
        origin: 'capacitor://localhost', 'content-type': 'application/json' }, cookies: {},
        signedCookies: { session: issueSessionToken(account, 'synthetic-secret').token } });
    assert(context); assert.equal(context.bindingExpiresAt, null);
    const state = randomBytes(32).toString('base64url');
    const binding: AppleAndroidHandoffBinding = { stateHash: createHash('sha256').update(state).digest(),
        bindingHash: context.bindingHash, nonce: randomBytes(32).toString('base64url'), clientKey: 'apple-android',
        action: 'delete', accountId: account.accountId, userId: account.userId, expiresAt: now + 123_456 };
    let prepared: AppleAndroidHandoffBinding | undefined;
    const events: string[] = [];
    const store = { async readAttempt() { return binding; },
        async create(value: AppleAndroidHandoffBinding) { prepared = value; return 'created'; },
        async readPending() { return binding; }, async readReady() { return binding; },
        async completeCallback() { events.push('ready'); return proof; },
        async redeem() { events.push('redeem'); return { idToken: 'synthetic.id.token', authorizationCode: 'synthetic-code' }; },
    } as unknown as ReturnType<typeof createAppleAndroidHandoffRepository>;
    const flow = createAppleAndroidHandoffFlow(store, { async verify() { return { verified: true,
        identity: { provider: 'apple', subject: 'synthetic-apple-subject' } as VerifiedProviderIdentity }; } }, () => now);
    assert.equal(await flow.prepare(context, { state, nonce: binding.nonce, expiresInSeconds: 300 }, 'delete'), true);
    assert.equal(prepared?.expiresAt, binding.expiresAt, 'no new 300-second deadline after the original attempt INSERT');
    assert.equal(await flow.callback({ state, id_token: 'synthetic.id.token', code: 'synthetic-code' }, false),
        `${APPLE_ANDROID_RETURN_URI}#state=${state}&result=ready&proof=${proof}`);
    assert.deepEqual(await flow.redeem(context, { state, proof }, false), { idToken: 'synthetic.id.token', authorizationCode: 'synthetic-code' });
    assert.deepEqual(events, ['ready', 'redeem']);
});
