import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';
import { APPLE_MAINTENANCE_PATH, loadAppleMaintenanceConfig } from '../config/appleMaintenanceConfig';
import type { AppleMaintenanceIdentityVerifier } from '../security/appleMaintenanceIdentity';
import { createAppleMaintenanceRouter } from './appleMaintenanceRouter';

const config = loadAppleMaintenanceConfig({ NODE_ENV: 'production', APPLE_MAINTENANCE_HTTP_ENABLED: 'true',
    APPLE_MAINTENANCE_CALLER_SUBJECT: '123456789012345678901',
    APPLE_MAINTENANCE_EXPECTED_SERVER_UUID: '12345678-1234-1234-1234-123456789abc' });
const authorization = 'Bearer synthetic.identity.token';

async function withServer(run: (url: string, state: {
    tokens: string[]; runs: number; authenticated: boolean; exitCode: number;
    runner: (() => Promise<number>) | undefined;
}) => Promise<void>, options: { enabled?: boolean; verifier?: AppleMaintenanceIdentityVerifier } = {}) {
    const state = { tokens: [] as string[], runs: 0, authenticated: true, exitCode: 0,
        runner: undefined as (() => Promise<number>) | undefined };
    const app = express();
    app.use(APPLE_MAINTENANCE_PATH, createAppleMaintenanceRouter(options.enabled === false ? undefined : config,
        async () => { state.runs++; return state.runner ? await state.runner() : state.exitCode; },
        options.verifier ?? { async verify(token) { state.tokens.push(token); return state.authenticated; } }));
    // Receiver is deliberately ahead of normal website parsing.
    app.use(express.json());
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}${APPLE_MAINTENANCE_PATH}`, state); }
    finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

const post = (url: string, headers: Record<string, string> = {}) =>
    fetch(url, { method: 'POST', headers: { authorization, ...headers } });

test('disabled route is absent for every method, without verification or work', async () => {
    await withServer(async (url, state) => {
        for (const method of ['POST', 'GET', 'PUT', 'OPTIONS']) {
            const response = await fetch(url, { method, headers: { authorization } });
            assert.equal(response.status, 404);
            assert.deepEqual(await response.json(), { error: 'NOT_FOUND' });
        }
        assert.equal(state.runs, 0);
        assert.deepEqual(state.tokens, []);
    }, { enabled: false });
});

test('enabled receiver accepts only POST on its exact mounted path', async () => {
    await withServer(async (url, state) => {
        for (const method of ['GET', 'PUT', 'OPTIONS', 'DELETE']) {
            const response = await fetch(url, { method, headers: { authorization } });
            assert.equal(response.status, 405);
            assert.equal(response.headers.get('allow'), 'POST');
        }
        assert.equal((await post(`${url}/extra`)).status, 404);
        assert.equal(state.runs, 0);
        assert.deepEqual(state.tokens, []);
    });
});

test('only one bearer header without website cookie, origin or query reaches identity verification', async () => {
    await withServer(async (url, state) => {
        const invalidHeaders: Record<string, string>[] = [{ authorization: '' }, { authorization: 'Basic password' },
            { authorization: `${authorization}, ${authorization}` }, { cookie: '__session=private' },
            { origin: 'https://mickeyf.com' }];
        for (const headers of invalidHeaders) {
            assert.equal((await post(url, headers)).status, 401);
        }
        assert.equal((await post(`${url}?accountId=123`)).status, 401);
        const duplicateStatus = await new Promise<number>((resolve, reject) => {
            const outgoing = request(url, { method: 'POST', headers: ['Host', new URL(url).host, 'Authorization', authorization,
                'Authorization', authorization, 'Content-Length', '0'] }, response => {
                response.resume(); resolve(response.statusCode!);
            });
            outgoing.on('error', reject); outgoing.end();
        });
        assert.equal(duplicateStatus, 401);
        assert.deepEqual(state.tokens, []);
        assert.equal(state.runs, 0);
    });
});

test('invalid identity prevents all maintenance and returns only generic response', async () => {
    await withServer(async (url, state) => {
        state.authenticated = false;
        const response = await post(url);
        assert.equal(response.status, 401);
        assert.deepEqual(await response.json(), { error: 'UNAUTHORIZED' });
        assert.equal(state.runs, 0);
    });
});

test('enabled receiver rate-limits per IP before certificate verification, while disabled stays404', async () => {
    await withServer(async (url, state) => {
        state.authenticated = false;
        for (let attempt = 0; attempt < 20; attempt++) assert.equal((await post(url)).status, 401);
        const limited = await post(url);
        assert.equal(limited.status, 429);
        assert.deepEqual(await limited.json(), { error: 'RATE_LIMITED' });
        assert.equal(state.tokens.length, 20);
        assert.equal(state.runs, 0);
    });
    await withServer(async (url, state) => {
        for (let attempt = 0; attempt < 21; attempt++) assert.equal((await post(url)).status, 404);
        assert.equal(state.tokens.length, 0);
        assert.equal(state.runs, 0);
    }, { enabled: false });
});

test('authenticated requests must have no body or selected scope', async () => {
    await withServer(async (url, state) => {
        for (const body of ['{}', '{"accountId":123}', ' ', 'a'.repeat(100_000)]) {
            const response = await fetch(url, { method: 'POST', headers: { authorization,
                'content-type': 'application/json' }, body });
            assert.equal(response.status, 400);
            assert.deepEqual(await response.json(), { error: 'INVALID_REQUEST' });
        }
        assert.equal((await post(url, { 'content-encoding': 'gzip' })).status, 400);
        assert.equal(state.runs, 0);
    });
});

test('only complete execution acknowledges success; failures and partial work stay retryable', async () => {
    await withServer(async (url, state) => {
        const success = await post(url);
        assert.equal(success.status, 200);
        assert.deepEqual(await success.json(), { completed: true });
        assert.equal(success.headers.get('cache-control'), 'no-store');
        assert.equal(success.headers.get('set-cookie'), null);
        for (const code of [1, 2, -1]) {
            state.exitCode = code;
            const response = await post(url);
            assert.equal(response.status, 503);
            assert.deepEqual(await response.json(), { error: 'UNAVAILABLE' });
        }
        state.runner = async () => { throw new Error('private SQL and token information'); };
        const error = await post(url);
        assert.equal(error.status, 503);
        assert.deepEqual(await error.json(), { error: 'UNAVAILABLE' });
        state.runner = undefined;
        state.exitCode = 0;
        assert.equal((await post(url)).status, 200);
    });
});

test('process-local concurrent execution is rejected until the active attempt actually finishes', async () => {
    await withServer(async (url, state) => {
        let started!: () => void;
        let finish!: (code: number) => void;
        const active = new Promise<void>(resolve => { started = resolve; });
        state.runner = () => { started(); return new Promise(resolve => { finish = resolve; }); };
        const first = post(url);
        try {
            await active;
            const duplicate = await post(url);
            assert.equal(duplicate.status, 503);
            assert.equal(state.runs, 1);
        } finally { finish(0); }
        assert.equal((await first).status, 200);
        state.runner = undefined;
        assert.equal((await post(url)).status, 200);
    });
});

test('a verifier that throws cannot expose details or invoke work', async () => {
    await withServer(async (url, state) => {
        const response = await post(url);
        assert.equal(response.status, 401);
        assert.deepEqual(await response.json(), { error: 'UNAUTHORIZED' });
        assert.equal(state.runs, 0);
    }, { verifier: { async verify() { throw new Error('private JWT credentials'); } } });
});

test('late verification success after the fixed deadline never starts maintenance', async () => {
    let accept!: (accepted: boolean) => void;
    await withServer(async (url, state) => {
        const response = await post(url);
        assert.equal(response.status, 401);
        accept(true);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(state.runs, 0);
    }, { verifier: { verify: () => new Promise(resolve => { accept = resolve; }) } });
});
