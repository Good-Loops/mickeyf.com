'use strict';

// Runs inside the final image without network, credentials, database or writes.
const assert = require('node:assert/strict');
const { existsSync } = require('node:fs');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const httpClient = require('undici');

async function main() {
    assert.equal(process.versions.node, '26.12.0');
    assert.match(process.versions.openssl, /^3\.5\.(?:9|[1-9][0-9]+)$/u);
    assert.equal(process.getuid(), 1000);
    assert.equal(process.env.NODE_ENV, 'production');
    assert.equal(require('undici/package.json').version, '7.30.1');
    assert.equal(existsSync('.env'), false);
    for (const entry of ['server', 'apple-token-revocation', 'submission-receipt-cleanup', 'account-deletion-audit']) {
        assert.ok(existsSync(`dist/${entry}.min.js`), `Missing runtime entry: ${entry}`);
    }

    const message = Buffer.from('ludolume-container-compatibility');
    const elliptic = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const ellipticToken = jwt.sign({ purpose: 'runtime-smoke' }, elliptic.privateKey, { algorithm: 'ES256' });
    assert.equal(jwt.verify(ellipticToken, elliptic.publicKey, { algorithms: ['ES256'] }).purpose, 'runtime-smoke');
    const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    assert.ok(crypto.verify('sha256', message, rsa.publicKey, crypto.sign('sha256', message, rsa.privateKey)));

    const key = crypto.randomBytes(32);
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
    const encrypted = Buffer.concat([cipher.update(message), cipher.final()]);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(cipher.getAuthTag());
    assert.deepEqual(Buffer.concat([decipher.update(encrypted), decipher.final()]), message);
    const password = crypto.randomBytes(24).toString('hex');
    assert.ok(bcrypt.compareSync(password, bcrypt.hashSync(password, 10)));

    httpClient.install();
    assert.equal(globalThis.fetch, httpClient.fetch);
    assert.equal(await (await fetch('data:text/plain,ludolume-runtime-ready')).text(), 'ludolume-runtime-ready');
    console.log(JSON.stringify({ status: 'passed', node: process.versions.node, openssl: process.versions.openssl,
        undici: require('undici/package.json').version, uid: process.getuid(), cryptoAndFetch: 'passed',
        network: 'none', credentials: 'none', databaseOperations: 0 }));
}

main().catch(() => { console.error('Production container compatibility smoke failed'); process.exitCode = 1; });
