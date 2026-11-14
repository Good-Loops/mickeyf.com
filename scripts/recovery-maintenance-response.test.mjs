import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = 'scripts/recovery-maintenance-response.mjs';
const sourceText = readFileSync(source, 'utf8');
for (const [mode, args] of [
    ['file', [source]],
    ['inline', ['--input-type=module', '--eval', sourceText]],
    ['encoded import', [`--import=data:text/javascript;base64,${Buffer.from(sourceText).toString('base64')}`, '--eval', '0']],
]) test(`maintenance ${mode} blocks requests and limits CORS`, async t => {
    const child = spawn(process.execPath, args, {
        env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    t.after(() => child.kill());
    const [ready] = await once(child.stdout, 'data');
    const port = /listening on (\d+)/u.exec(String(ready))?.[1];
    assert.ok(port, 'maintenance server must report a listening port');
    const url = `http://127.0.0.1:${port}/auth/login`;
    for (const method of ['GET', 'POST', 'DELETE']) {
        const response = await fetch(url, { method, headers: { Origin: 'https://mickeyf.com' } });
        assert.equal(response.status, 503);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.equal(response.headers.get('access-control-allow-origin'), 'https://mickeyf.com');
    }
    const preflight = await fetch(url, { method: 'OPTIONS', headers: { Origin: 'capacitor://localhost' } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'capacitor://localhost');
    const untrusted = await fetch(url, { method: 'OPTIONS', headers: { Origin: 'https://mickeyf.com.evil.example' } });
    assert.equal(untrusted.status, 503);
    assert.equal(untrusted.headers.get('access-control-allow-origin'), null);
});
