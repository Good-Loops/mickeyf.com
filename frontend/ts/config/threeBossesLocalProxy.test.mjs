import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadConfigFromFile } from 'vite';

test('local WebGL proxy keeps upstream transfers open even when the client requests close', async () => {
    const previousLocalBuild = process.env.VITE_ENABLE_THREE_BOSSES_LOCAL;
    const configFile = fileURLToPath(new URL('../../vite.config.ts', import.meta.url));
    let proxy;
    try {
        process.env.VITE_ENABLE_THREE_BOSSES_LOCAL = '1';
        const loaded = await loadConfigFromFile(
            { command: 'serve', mode: 'development' }, configFile, undefined, 'silent',
        );
        proxy = loaded.config.server.proxy['/__local/three-bosses/'];
        assert.equal(proxy.target, 'http://127.0.0.1:4174');
        assert.equal(proxy.agent.options.keepAlive, true);
        // Node normalizes incoming header names before the proxy applies overrides.
        const forwardedHeaders = { connection: 'close', ...proxy.headers };
        assert.equal(forwardedHeaders.connection, 'keep-alive');
    } finally {
        proxy?.agent.destroy();
        if (previousLocalBuild === undefined) delete process.env.VITE_ENABLE_THREE_BOSSES_LOCAL;
        else process.env.VITE_ENABLE_THREE_BOSSES_LOCAL = previousLocalBuild;
    }
});
