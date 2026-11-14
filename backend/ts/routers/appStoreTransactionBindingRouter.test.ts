import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { ProviderAuthContext, createProviderAuthContextReader } from '../auth/providerAuthContext';
import type { AppStoreTransactionResult } from '../auth/appStoreTransaction';
import { createAppStoreTransactionBindingRouter } from './appStoreTransactionBindingRouter';

test('transaction binding requires an authenticated context and verified Apple payload', async () => {
    const context = { bindingHash: Buffer.alloc(32, 1), account: { userId: 1, accountId: '11111111-1111-4111-8111-111111111111' },
        session: { accountId: '11111111-1111-4111-8111-111111111111', sessionId: 'fictional-session' } } as unknown as ProviderAuthContext;
    let current: ProviderAuthContext | null = null;
    let result: AppStoreTransactionResult = { kind: 'verified', appTransactionId: 'fictional-transaction' };
    let verified = 0, failBind = false, restricted = false;
    let eligible: 'child' | 'adult' | 'unknown' | 'invalid-session' = 'child';
    const bound: string[] = [];
    const read = (async () => current) as ReturnType<typeof createProviderAuthContextReader>;
    const app = express();
    app.use('/bind', createAppStoreTransactionBindingRouter(read, async () => { verified++; return result; }, async (_context, id) => {
        if (failBind) throw new Error('fictional storage error');
        bound.push(id);
        return restricted ? 'restricted' : 'linked';
    }, async () => eligible, 'fictional-session-secret'));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/bind`;
    const send = (value: unknown, path = '') => fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(value) });
    try {
        assert.equal((await send({}, '/prepare')).status, 403);
        assert.equal(verified, 0, 'anonymous requests do not reach signature verification');
        current = { ...context, session: { ...context.session!, accountId: '22222222-2222-4222-8222-222222222222' } };
        assert.equal((await send({}, '/prepare')).status, 403);
        assert.equal(verified, 0, 'a mismatched session does not reach signature verification');
        current = context;
        eligible = 'adult';
        assert.equal((await send({}, '/prepare')).status, 204, 'adults do not expose an Apple transaction');
        eligible = 'unknown';
        assert.equal((await send({}, '/prepare')).status, 409, 'unknown age is not assumed to be adult');
        eligible = 'invalid-session';
        assert.equal((await send({}, '/prepare')).status, 403, 'an expired session is not treated as an adult');
        eligible = 'child';
        const prepared = await send({}, '/prepare');
        assert.equal(prepared.status, 200);
        const { bindingProof } = await prepared.json() as { bindingProof: string };
        const body = { signedTransaction: 'fictional', bindingProof };
        assert.equal((await send({ ...body, accountId: 'other' })).status, 400);
        assert.equal((await send({ ...body, signedTransaction: 'x'.repeat(65_537) })).status, 400);
        current = { ...context, bindingHash: Buffer.alloc(32, 2) };
        assert.equal((await send(body)).status, 403, 'a newer session cannot use an earlier session proof');
        assert.equal(verified, 0, 'a stale session cannot reach Apple verification');
        current = context;
        result = { kind: 'invalid' };
        assert.equal((await send(body)).status, 400);
        result = { kind: 'unavailable' };
        assert.equal((await send(body)).status, 503);
        result = { kind: 'verified', appTransactionId: 'fictional-transaction' };
        failBind = true;
        assert.equal((await send(body)).status, 503);
        failBind = false;
        const response = await send(body);
        assert.equal(response.status, 204);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.equal(await response.text(), '');
        assert.deepEqual(bound, ['fictional-transaction']);
        restricted = true;
        assert.equal((await send(body)).status, 403);
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
