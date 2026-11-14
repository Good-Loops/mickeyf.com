import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';
import type { Pool } from 'mysql2/promise';
import { createChildWarningWebhookRouter } from './childWarningWebhookRouter';

test('authenticated callback bursts receive a retryable limit before parsing or database work', async () => {
    const token = randomBytes(32).toString('base64url');
    const parentId = randomUUID(), childId = randomUUID();
    let queries = 0, recorded = 0;
    const database = { async query() { queries++; return [[{ parentId, childId }], []]; } } as unknown as Pick<Pool, 'query'>;
    const workflow = { async recordFailure(parent: string, child: string) {
        assert.equal(parent, parentId); assert.equal(child, childId); recorded++;
    } };
    const app = express();
    app.use('/callback', createChildWarningWebhookRouter(database, workflow, token));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`;
    const event = JSON.stringify({ event: 'hard_bounce', email: 'synthetic@example.test', 'message-id': '<synthetic@example.test>' });
    const post = (body: string, auth = token) => fetch(url, { method: 'POST',
        headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' }, body });
    try {
        assert.equal((await post('{invalid', 'incorrect')).status, 401);
        assert.equal(queries, 0);
        for (let index = 0; index < 120; index++) assert.equal((await post(event)).status, 204);
        assert.equal(queries, 120); assert.equal(recorded, 120);
        for (const body of ['{invalid', event]) {
            const response = await post(body);
            assert.equal(response.status, 429);
            assert.equal(response.headers.get('Retry-After'), '60');
            assert.equal(response.headers.get('Cache-Control'), 'no-store');
        }
        assert.equal((await post(event, 'incorrect')).status, 401);
        assert.equal(queries, 120); assert.equal(recorded, 120);
    } finally {
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
});
