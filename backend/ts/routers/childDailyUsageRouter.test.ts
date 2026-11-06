import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import type { Pool } from 'mysql2/promise';
import type { createProviderAuthContextReader } from '../auth/providerAuthContext';
import type { ProviderAuthContext } from '../auth/providerAuthContext';
import { createChildDailyUsageHeartbeatRouter, createChildDailyUsageRouter } from './childDailyUsageRouter';

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

test('heartbeat limits verified sessions independently on the same network', async () => {
    const app = express();
    const readContext = (async (req: { headers: Record<string, unknown> }) => {
        const sessionId = req.headers['x-synthetic-session'];
        if (typeof sessionId !== 'string') return null;
        const accountId = '00000000-0000-4000-8000-000000000001';
        return { account: { accountId, userId: 1 }, session: { accountId, sessionId },
            bindingHash: Buffer.alloc(32), bindingExpiresAt: null, anonymousCookie: null } as ProviderAuthContext;
    }) as unknown as ReturnType<typeof createProviderAuthContextReader>;
    app.use(createChildDailyUsageRouter({} as Pool, readContext));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    try {
        const address = server.address(); assert.ok(address && typeof address !== 'string');
        const post = (session: string) => fetch(`http://127.0.0.1:${address.port}/heartbeat`, {
            method: 'POST', headers: { 'content-type': 'application/json', 'x-synthetic-session': session }, body: '{}',
        });
        // Storage is intentionally unavailable; requests still exercise authentication and rate limiting.
        for (let i = 0; i < 120; i++) assert.equal((await post('synthetic-session-a')).status, 503);
        assert.equal((await post('synthetic-session-a')).status, 429);
        assert.equal((await post('synthetic-session-b')).status, 503);
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test('separate heartbeat mounting preserves the general authentication limit', async () => {
    const app = express();
    const readContext = (async () => null) as unknown as ReturnType<typeof createProviderAuthContextReader>;
    app.use('/auth/child-daily-usage/heartbeat', createChildDailyUsageHeartbeatRouter({} as Pool, readContext));
    app.use('/auth', rateLimit({ windowMs: 60_000, limit: 2, legacyHeaders: false }));
    app.post('/auth/login', (_req, res) => res.status(204).end());
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    try {
        const address = server.address(); assert.ok(address && typeof address !== 'string');
        const base = `http://127.0.0.1:${address.port}`;
        for (let i = 0; i < 3; i++) assert.equal((await fetch(`${base}/auth/child-daily-usage/heartbeat`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
        })).status, 403);
        assert.equal((await fetch(`${base}/auth/login`, { method: 'POST' })).status, 204);
        assert.equal((await fetch(`${base}/auth/login`, { method: 'POST' })).status, 204);
        assert.equal((await fetch(`${base}/auth/login`, { method: 'POST' })).status, 429);
        assert.equal((await fetch(`${base}/auth/child-daily-usage/heartbeat`, { method: 'GET' })).status, 429);
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
