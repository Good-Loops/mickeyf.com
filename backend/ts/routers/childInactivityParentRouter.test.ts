import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';
import { createChildInactivityParentRouter } from './childInactivityParentRouter';
import type { ChildInactivityParentService } from '../accounts/childInactivityParentService';
import type { createProviderAuthContextReader } from '../auth/providerAuthContext';

test('routine pending checks cannot consume the acknowledgment rate limit', async () => {
    const service = { async pending() { return { pending: true }; }, async read() { return { warning: null }; },
        async acknowledge() { return { acknowledged: true }; } } as unknown as ChildInactivityParentService;
    const readContext = (async () => null) as unknown as ReturnType<typeof createProviderAuthContextReader>;
    const app = express(); app.use('/auth/child-inactivity', createChildInactivityParentRouter(service, readContext));
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/auth/child-inactivity`;
    const post = (path: string) => fetch(`${base}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    try {
        for (let i = 0; i < 31; i++) assert.equal((await post('pending')).status, 200);
        const result = await post('acknowledge'); assert.equal(result.status, 200);
        assert.deepEqual(await result.json(), { acknowledged: true });
    } finally { server.close(); await once(server, 'close'); }
});
