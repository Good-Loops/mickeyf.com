import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { AppStoreConsentResult } from '../auth/appStoreConsentNotification';
import { createAppStoreConsentRouter } from './appStoreConsentRouter';

const withdrawal: AppStoreConsentResult = { kind: 'consent-withdrawn',
    notificationId: '6a45449e-988e-4a66-9968-211e92b3331c', signedAt: 1_800_000_000_000,
    appTransactionId: 'fictional-install-id' };

test('acknowledges only verified notifications that the durable handler applied', async () => {
    let result: AppStoreConsentResult = withdrawal;
    let failApply = false;
    const applied: AppStoreConsentResult[] = [];
    const app = express();
    app.use('/notification', createAppStoreConsentRouter(async () => result, async value => {
        if (failApply) throw Error('fictional storage outage');
        applied.push(value);
    }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/notification`;
    const send = (body: unknown) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body) });
    try {
        let response = await send({ signedPayload: 'fictional-signed-notification' });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.deepEqual(applied, [withdrawal]);
        failApply = true;
        response = await send({ signedPayload: 'fictional-signed-notification' });
        assert.equal(response.status, 503);
        for (const [candidate, status] of [[{ kind: 'test' }, 200], [{ kind: 'invalid' }, 400],
            [{ kind: 'unavailable' }, 503], [{ kind: 'unsupported' }, 503]] as const) {
            result = candidate;
            assert.equal((await send({ signedPayload: 'fictional-signed-notification' })).status, status);
        }
        assert.equal((await send({ payload: 'wrong-envelope' })).status, 400);
        assert.equal((await send({ signedPayload: 'x', extra: true })).status, 400);
        assert.deepEqual(applied, [withdrawal]);
    } finally {
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
});
