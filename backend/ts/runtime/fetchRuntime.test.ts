import './fetchRuntime';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fetch as maintainedFetch, Headers as MaintainedHeaders,
    Request as MaintainedRequest, Response as MaintainedResponse, FormData as MaintainedFormData } from 'undici';
import { createProviderKeyResolver, ProviderKeysUnavailable } from '../auth/providerTokenVerifier';

test('runtime fetch and web API constructors use the same maintained implementation', () => {
    assert.equal(globalThis.fetch, maintainedFetch);
    assert.equal(globalThis.Headers, MaintainedHeaders);
    assert.equal(globalThis.Request, MaintainedRequest);
    assert.equal(globalThis.Response, MaintainedResponse);
    assert.equal(globalThis.FormData, MaintainedFormData);
});

test('every compiled entrypoint bootstraps fetch before importing application clients', () => {
    const entrypoints = [
        'app.ts',
        'leaderboards/runSubmissionReceiptCleanup.ts',
        'accounts/runDeletionAudit.ts',
        'accounts/appleTokenRevocationMain.ts',
        'accounts/runAppleTokenRevocation.ts',
    ];
    for (const entrypoint of entrypoints) {
        const source = readFileSync(path.resolve(__dirname, '..', entrypoint), 'utf8');
        assert.match(source, /^import ['"]\.{1,2}\/runtime\/fetchRuntime['"];\r?\n/u, entrypoint);
    }
});

test('bootstrap preserves provider fetch mocking and explicit dependency injection', async context => {
    const mock = context.mock.method(globalThis, 'fetch', async () =>
        Response.json({ keys: [] }));
    await assert.rejects(createProviderKeyResolver(globalThis.fetch, Date.now)('google', 'mock-key'),
        ProviderKeysUnavailable);
    assert.equal(mock.mock.callCount(), 1);

    let injectedCalls = 0;
    const injectedFetch: typeof fetch = async () => {
        injectedCalls += 1;
        return Response.json({ keys: [] });
    };
    await assert.rejects(createProviderKeyResolver(injectedFetch, Date.now)('google', 'explicit-key'),
        ProviderKeysUnavailable);
    assert.equal(injectedCalls, 1);
    assert.equal(mock.mock.callCount(), 1);
});

test('excessive content encodings and an early close reject without terminating the process',
    { timeout: 15_000 }, () => {
        const regression = String.raw`
            const assert = require('node:assert/strict');
            require(process.argv[1]);
            const { createServer } = require('node:http');
            const { getGlobalDispatcher } = require('undici');
            const server = createServer((_request, response) => {
                response.writeHead(200, {
                    'content-encoding': 'gzip, gzip, gzip, gzip, gzip, gzip',
                    'content-length': '1',
                });
                response.flushHeaders();
                setImmediate(() => response.destroy());
            });
            server.listen(0, '127.0.0.1', async () => {
                try {
                    const endpoint = 'http://127.0.0.1:' + server.address().port;
                    await assert.rejects(fetch(endpoint, { signal: AbortSignal.timeout(2_000) }));
                    await new Promise(resolve => setTimeout(resolve, 100));
                    process.stdout.write('fetch-rejection-handled\n');
                } catch {
                    process.exitCode = 1;
                } finally {
                    server.closeAllConnections();
                    server.close();
                    await getGlobalDispatcher().close();
                }
            });
        `;
        const result = spawnSync(process.execPath,
            ['-r', require.resolve('ts-node/register'), '-e', regression, require.resolve('./fetchRuntime')],
            { cwd: path.resolve(__dirname, '../..'), encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024 });
        assert.equal(result.error, undefined);
        assert.equal(result.signal, null);
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /^fetch-rejection-handled\r?\n$/u);
    });
