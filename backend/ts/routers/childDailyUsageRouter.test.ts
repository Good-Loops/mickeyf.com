import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import express from 'express';
import type { Pool } from 'mysql2/promise';
import type { createProviderAuthContextReader } from '../auth/providerAuthContext';
import { createChildDailyUsageRouter } from './childDailyUsageRouter';

test('draft usage endpoints reject unauthenticated and client-timed requests', async () => {
    const app = express();
    const readContext = (async () => null) as unknown as ReturnType<typeof createProviderAuthContextReader>;
    app.use(createChildDailyUsageRouter({} as Pool, readContext));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    try {
        const address = server.address(); assert.ok(address && typeof address !== 'string');
        const post = (path: string, body: object) => fetch(`http://127.0.0.1:${address.port}${path}`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        });
        const valid = { childAccountId: randomUUID(), timeZone: 'America/Sao_Paulo', dailyLimitMs: 60_000 };
        assert.equal((await post('/heartbeat', {})).status, 403);
        assert.equal((await post('/heartbeat', { timestamp: 0 })).status, 400);
        assert.equal((await post('/get', { childAccountId: valid.childAccountId })).status, 403);
        assert.equal((await post('/set', valid)).status, 403);
        assert.equal((await post('/set', { ...valid, dailyLimitMs: 0 })).status, 400);
        assert.equal((await post('/set', { ...valid, timeZone: 'not/a-zone' })).status, 400);
        assert.equal((await post('/set', { ...valid, usedMs: 0 })).status, 400);
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
