import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, realpathSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';

function npmCli() {
    if (process.env.npm_execpath && existsSync(process.env.npm_execpath)) return process.env.npm_execpath;
    for (const directory of (process.env.PATH ?? '').split(delimiter)) {
        const path = process.platform === 'win32' ? join(directory, 'node_modules/npm/bin/npm-cli.js') : join(directory, 'npm');
        if (existsSync(path)) return realpathSync(path);
    }
    throw new Error('npm CLI was not found');
}

test('npm audit sends vendored minimatch and TypeDoc versions and reports their advisories', { timeout: 70000 }, async t => {
    let body, mockError;
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
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const url = `http://127.0.0.1:${server.address().port}/`;
    const child = spawn(process.execPath, [npmCli(), 'audit', '--json', `--registry=${url}`,
        '--fetch-retries=0', '--fetch-timeout=15000'], {
        env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timeout = setTimeout(() => child.kill(), 60000);
    t.after(() => { clearTimeout(timeout); if (child.exitCode === null) child.kill(); });
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
