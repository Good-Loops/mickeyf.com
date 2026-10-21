import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { OAuth2Client } from 'google-auth-library';
import jwt from 'jsonwebtoken';
import { APPLE_MAINTENANCE_AUDIENCE, APPLE_MAINTENANCE_CALLER_EMAIL,
    type AppleMaintenanceConfig } from '../config/appleMaintenanceConfig';
import { createAppleMaintenanceIdentityVerifier } from './appleMaintenanceIdentity';

const config: AppleMaintenanceConfig = { audience: APPLE_MAINTENANCE_AUDIENCE,
    callerEmail: APPLE_MAINTENANCE_CALLER_EMAIL, callerSubject: '123456789012345678901',
    expectedServerUuid: '12345678-1234-1234-1234-123456789abc' };
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const keyId = 'synthetic-test-key';

function token(overrides: Record<string, unknown> = {}, privateKey = pair.privateKey): string {
    const now = Math.floor(Date.now() / 1_000);
    return jwt.sign({ iss: 'https://accounts.google.com', aud: config.audience, sub: config.callerSubject,
        email: config.callerEmail, email_verified: true, iat: now - 10, exp: now + 3_500, ...overrides },
    privateKey, { algorithm: 'RS256', keyid: keyId });
}

function verifier(fetcher?: typeof fetch, timeoutMs?: number) {
    const calls: Array<{ url: string; options: RequestInit | undefined }> = [];
    return { calls, verifier: createAppleMaintenanceIdentityVerifier(config, { timeoutMs, createClient: () =>
        new OAuth2Client({ transporterOptions: { fetchImplementation: fetcher ?? (async (url, options) => {
            calls.push({ url: String(url), options });
            return new Response(JSON.stringify({ [keyId]: publicKey }), {
                headers: { 'content-type': 'application/json', 'cache-control': 'public,max-age=3600' },
            });
        }) } }),
    }) };
}

test('real Google verifier validates synthetic RSA signature and exact service identity without network', async () => {
    const subject = verifier();
    assert.equal(await subject.verifier.verify(token()), true);
    assert.equal(subject.calls.length, 1);
    assert.equal(subject.calls[0].url, 'https://www.googleapis.com/oauth2/v1/certs');
    assert.equal(subject.calls[0].options?.redirect, 'error');
    assert.ok(subject.calls[0].options?.signal);
    assert.equal(await subject.verifier.verify(token({ iss: 'accounts.google.com' })), true);
});

test('signed but wrong identity, audience, issuer and strict time claims fail closed', async () => {
    const now = Math.floor(Date.now() / 1_000);
    for (const overrides of [
        { aud: `${config.audience}/internal/maintenance/apple` }, { sub: '999999999999999999999' },
        { email: 'someone@example.com' }, { email_verified: false }, { email_verified: 'true' },
        { iss: 'https://issuer.invalid' }, { exp: now - 1 }, { iat: now + 60 },
        { iat: now - 10_000 }, { exp: now + 5_000 },
    ]) assert.equal(await verifier().verifier.verify(token(overrides)), false, JSON.stringify(overrides));
});

test('tampered signatures and unsigned or oversized envelopes never authenticate', async () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    assert.equal(await verifier().verifier.verify(token({}, other.privateKey)), false);
    const subject = verifier();
    for (const malformed of ['bad', 'a.b.c', 'a'.repeat(16_385),
        `${Buffer.from('{"alg":"none","kid":"synthetic-test-key"}').toString('base64url')}.e30.e30`]) {
        assert.equal(await subject.verifier.verify(malformed), false);
    }
    assert.equal(subject.calls.length, 0);
});

test('certificate fetch is not retried and failures reveal no token', async () => {
    let calls = 0;
    const subject = verifier(async () => { calls++; return new Response('private service failure', { status: 503 }); });
    assert.equal(await subject.verifier.verify(token()), false);
    assert.equal(calls, 1);
});

test('deadline aborts stalled verification; late keys cannot turn rejection into acceptance', async () => {
    let release!: (response: Response) => void;
    let signal: AbortSignal | null | undefined;
    const subject = verifier(async (_url, options) => {
        signal = options?.signal;
        return new Promise<Response>(resolve => { release = resolve; });
    }, 10);
    assert.equal(await subject.verifier.verify(token()), false);
    assert.equal(signal?.aborted, true);
    release(new Response(JSON.stringify({ [keyId]: publicKey }), { headers: { 'content-type': 'application/json' } }));
    await new Promise(resolve => setImmediate(resolve));
});
