import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import test from 'node:test';

// The upstream regression sends a complete frame, a null byte and 100 KiB of trailing data.
// https://github.com/expressjs/body-parser/commit/f7075ea
const compressionProbe = String.raw`
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');
const express = require('express');
const encoding = process.argv[1];
const expected = { synthetic: 'compressed-parser-regression' };
const json = Buffer.from(JSON.stringify(expected));
const app = express();
app.use(express.json());
app.post('/', (req, res) => {
    const respond = () => res.json(req.body);
    if (req.complete) respond();
    else req.once('end', respond);
});
const server = http.createServer(app);

function post(body, contentEncoding) {
    return new Promise((resolve, reject) => {
        const request = http.request({ host: '127.0.0.1', port: server.address().port,
            method: 'POST', path: '/', agent: false,
            headers: { 'content-type': 'application/json', 'content-encoding': contentEncoding,
                'content-length': body.length } }, response => {
                let text = '';
                response.setEncoding('utf8');
                response.on('data', chunk => { text += chunk; });
                response.on('error', reject);
                response.on('end', () => resolve({ status: response.statusCode, text }));
            });
        request.on('error', reject);
        request.setTimeout(2000, () => request.destroy(new Error('Loopback parser request timed out')));
        request.end(body);
    });
}

server.listen(0, '127.0.0.1', async () => {
    try {
        const frame = encoding === 'gzip' ? zlib.gzipSync(json) : zlib.deflateSync(json);
        const first = await post(Buffer.concat([frame, Buffer.from([0]), Buffer.alloc(100 * 1024, 0x58)]), encoding);
        assert.equal(first.status, 200);
        assert.deepEqual(JSON.parse(first.text), expected);
        // Give the finished decoder time to receive the remaining bytes before checking survival.
        await new Promise(resolve => setTimeout(resolve, 200));
        const second = await post(json, 'identity');
        assert.equal(second.status, 200);
        assert.deepEqual(JSON.parse(second.text), expected);
        process.stdout.write(JSON.stringify({ encoding, first: first.status, second: second.status }));
    } catch (error) {
        process.stderr.write(String(error));
        process.exitCode = 1;
    } finally {
        server.closeAllConnections();
        server.close();
    }
});
`;

for (const encoding of ['gzip', 'deflate']) {
    test(`${encoding}: trailing compressed bytes cannot crash Express before a second request`, { timeout: 10_000 }, () => {
        // Do not pass runtime configuration or credentials to this parser-only process.
        const environment = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP']
            .flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name]!]]));
        const child = spawnSync(process.execPath, ['-e', compressionProbe, encoding], {
            cwd: resolve(__dirname, '../..'), env: environment, encoding: 'utf8',
            windowsHide: true, timeout: 8000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024,
        });
        assert.ifError(child.error);
        assert.equal(child.signal, null, child.stderr);
        assert.equal(child.status, 0, child.stderr);
        assert.deepEqual(JSON.parse(child.stdout), { encoding, first: 200, second: 200 });
    });
}
