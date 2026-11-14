import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { loadConfigFromFile } from 'vite';
import { parsePublicAuthProtocol } from './publicAuthProtocol.ts';

test('public auth defaults to legacy and accepts only exact explicit protocol names', () => {
    assert.equal(parsePublicAuthProtocol(undefined), 'legacy');
    assert.equal(parsePublicAuthProtocol('legacy'), 'legacy');
    assert.equal(parsePublicAuthProtocol('renewable'), 'renewable');
    for (const value of ['', null, true, 1, 'automatic', 'RENEWABLE', ' renewable ']) {
        assert.throws(() => parsePublicAuthProtocol(value), /VITE_PUBLIC_AUTH_PROTOCOL must be legacy or renewable/);
    }
});

test('Vite wires the selected public protocol into the gateway without negotiating or changing account source', async () => {
    const previousPreview = process.env.VITE_USE_PUBLIC_API;
    const previousProtocol = process.env.VITE_PUBLIC_AUTH_PROTOCOL;
    const configFile = fileURLToPath(new URL('../../vite.config.ts', import.meta.url));
    try {
        process.env.VITE_USE_PUBLIC_API = '1';
        for (const protocol of ['legacy', 'renewable']) {
            process.env.VITE_PUBLIC_AUTH_PROTOCOL = protocol;
            const loaded = await loadConfigFromFile({ command: 'serve', mode: 'development' }, configFile, undefined, 'silent');
            const plugin = loaded.config.plugins.find(candidate => candidate.name === 'public-api-preview');
            assert.ok(plugin);
            let middleware;
            const request = Readable.from([]);
            request.method = 'GET';
            request.url = '/auth/providers/config';
            request.headers = { host: 'localhost:5173' };
            request.socket = { remoteAddress: '::1' };
            const response = { statusCode: 200, setHeader() {}, end(body) { this.body = body; } };
            const originalFetch = globalThis.fetch;
            let forwarded = false;
            globalThis.fetch = async url => {
                forwarded = true;
                assert.equal(url, 'https://mickeyf-org-j7yuum4tiq-uc.a.run.app/auth/providers/config');
                return Response.json({ clients: [] });
            };
            try {
                plugin.configureServer({ middlewares: { use(prefix, handler) {
                    assert.equal(prefix, '/__public-api');
                    middleware = handler;
                } } });
                await middleware(request, response, () => assert.fail('Reserved gateway request fell through'));
            } finally { globalThis.fetch = originalFetch; }
            assert.equal(forwarded, protocol === 'renewable');
            assert.equal(response.statusCode, protocol === 'renewable' ? 200 : 404);
        }
        process.env.VITE_PUBLIC_AUTH_PROTOCOL = 'automatic';
        await assert.rejects(loadConfigFromFile({ command: 'serve', mode: 'development' }, configFile, undefined, 'silent'),
            /VITE_PUBLIC_AUTH_PROTOCOL must be legacy or renewable/);
    } finally {
        if (previousPreview === undefined) delete process.env.VITE_USE_PUBLIC_API;
        else process.env.VITE_USE_PUBLIC_API = previousPreview;
        if (previousProtocol === undefined) delete process.env.VITE_PUBLIC_AUTH_PROTOCOL;
        else process.env.VITE_PUBLIC_AUTH_PROTOCOL = previousProtocol;
    }
});
