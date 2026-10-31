import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';

function npmCli() {
    // Use only the npm installed with the Node executable running this test.
    // Untrusted PATH/npm_execpath values must not select executable code.
    const nodeDir = dirname(process.execPath);
    const path = process.platform === 'win32' ? join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
        : resolve(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (!existsSync(path)) throw new Error('npm CLI was not found in this Node installation');
    return path;
}

test('npm audit sends vendored minimatch and TypeDoc versions and reports their advisories', { timeout: 70000 }, async t => {
    const cacheBase = await realpath(tmpdir());
    const cache = await mkdtemp(join(cacheBase, 'ludolume-audit-mock-'));
    assert.equal(await realpath(cache), cache);
    assert.equal(dirname(cache), cacheBase);
    let body, mockError, child, timeout;
    const server = createServer((request, response) => {
        response.setHeader('connection', 'close');
        if (request.method !== 'POST' || request.url !== '/-/npm/v1/security/advisories/bulk') {
            response.writeHead(404, { 'content-type': 'application/json' });
            response.end('{}');
            return;
        }
        const chunks = [];
        request.on('data', chunk => chunks.push(chunk));
        request.on('end', () => {
            try {
                const raw = Buffer.concat(chunks);
                body = JSON.parse((request.headers['content-encoding'] === 'gzip' ? gunzipSync(raw) : raw).toString('utf8'));
                const advisory = (name, id, vulnerable_versions) => ({
                    id, name, title: `Synthetic ${name} advisory`, severity: 'moderate',
                    url: `https://example.invalid/${name}`, vulnerable_versions,
                });
                response.writeHead(200, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ typedoc: [advisory('typedoc', 9999001, '<=0.28.20')],
                    minimatch: [advisory('minimatch', 9999002, '<=11.0.3')] }));
            } catch (error) {
                mockError = error;
                response.writeHead(500); response.end();
            }
        });
    });
    t.after(async () => {
        clearTimeout(timeout);
        if (child && child.exitCode === null && child.signalCode === null) {
            const closed = once(child, 'close');
            child.kill();
            await closed;
        }
        if (server.listening) await new Promise(done => { server.closeAllConnections(); server.close(done); });
        // Only delete the unique cache directory created by this test.
        assert.equal(dirname(resolve(cache)), cacheBase);
        assert.ok(basename(cache).startsWith('ludolume-audit-mock-'));
        await rm(cache, { recursive: true, force: true });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const url = `http://127.0.0.1:${server.address().port}/`;
    child = spawn(process.execPath, [npmCli(), 'audit', '--json', `--registry=${url}`,
        '--fetch-retries=0', '--fetch-timeout=15000'], {
        env: { ...process.env, npm_config_cache: cache, NPM_CONFIG_CACHE: cache,
            NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    timeout = setTimeout(() => child.kill(), 60000);
    let stdout = '', stderr = '';
    child.stdout.on('data', value => { stdout += value; });
    child.stderr.on('data', value => { stderr += value; });
    const [exit] = await once(child, 'close');
    assert.ifError(mockError);
    assert.equal(exit, 1, `Expected synthetic advisories to fail audit: ${stderr}`);
    assert.deepEqual(body?.typedoc, ['0.28.20']);
    assert.deepEqual(body?.minimatch, ['11.0.3']);
    const result = JSON.parse(stdout);
    assert.ok(result.vulnerabilities.typedoc, 'TypeDoc synthetic advisory was not reported');
    assert.ok(result.vulnerabilities.minimatch, 'Minimatch synthetic advisory was not reported');
});
