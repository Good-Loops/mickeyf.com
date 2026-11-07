import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import type { Pool } from 'mysql2/promise';
import { createManagedChildActivityRouter } from './managedChildActivityRouter';
import type { createProviderAuthContextReader } from '../auth/providerAuthContext';

test('interaction and parent keep requests have independent per-IP rate limits', async () => {
    const app = express();
    const readContext = (async () => null) as unknown as ReturnType<typeof createProviderAuthContextReader>;
    app.use(createManagedChildActivityRouter({} as Pool, readContext, {
        async initialize() {}, async recordInteraction() { return true; },
    }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    try {
        const address = server.address(); assert.ok(address && typeof address !== 'string');
        const post = (path: string) => fetch(`http://127.0.0.1:${address.port}${path}`,
            { method: 'POST', headers: { 'content-type': 'application/json' }, body: path === '/interaction' ? '{}' : '{"childAccountId":"x"}' });
        for (let i = 0; i < 30; i++) assert.equal((await post('/keep')).status, 403);
        assert.equal((await post('/keep')).status, 429);
        for (let i = 0; i < 31; i++) assert.equal((await post('/interaction')).status, 403);
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
