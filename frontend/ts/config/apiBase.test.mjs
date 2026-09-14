import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { selectApiBase } from './apiBase.ts';

const urls = {
    developmentUrl: 'http://127.0.0.1:8080',
    productionUrl: 'https://api.example.test',
};

test('built browser pages always use same-origin API requests', () => {
    for (const mode of ['production', 'staging']) {
        assert.equal(selectApiBase({ ...urls, mode, isNative: false }), '');
    }
});

test('native builds preserve the configured production API origin', () => {
    for (const mode of ['production', 'staging']) {
        assert.equal(selectApiBase({ ...urls, mode, isNative: true }), urls.productionUrl);
    }
});

test('development preserves the existing configured endpoint on browser and native', () => {
    for (const isNative of [false, true]) {
        assert.equal(selectApiBase({ ...urls, mode: 'development', isNative }), urls.developmentUrl);
    }
});

test('both API trees reach the existing Cloud Run service before the SPA fallback', async () => {
    const { hosting } = JSON.parse(await readFile(new URL('../../../firebase.json', import.meta.url), 'utf8'));
    const spaIndex = hosting.rewrites.findIndex((rewrite) => rewrite.source === '**');
    assert.ok(spaIndex >= 0);
    for (const source of ['/api/**', '/auth/**']) {
        const matches = hosting.rewrites.filter((rewrite) => rewrite.source === source);
        assert.equal(matches.length, 1);
        assert.deepEqual(matches[0].run, { serviceId: 'mickeyf-org', region: 'us-central1' });
        assert.ok(hosting.rewrites.indexOf(matches[0]) < spaIndex);
    }
    assert.equal(hosting.rewrites[spaIndex].destination, '/index.html');
});

test('API no-store headers override the global cache policy without changing asset headers', async () => {
    const { hosting } = JSON.parse(await readFile(new URL('../../../firebase.json', import.meta.url), 'utf8'));
    const globalIndex = hosting.headers.findIndex((rule) => rule.regex === '.*');
    assert.ok(globalIndex >= 0);
    for (const source of ['/api/**', '/auth/**']) {
        const matches = hosting.headers.filter((rule) => rule.source === source);
        assert.equal(matches.length, 1);
        assert.ok(hosting.headers.indexOf(matches[0]) > globalIndex);
        assert.deepEqual(matches[0].headers, [{ key: 'Cache-Control', value: 'private, no-store' }]);
    }
    const globalHeaders = hosting.headers[globalIndex].headers;
    assert.ok(globalHeaders.some((header) => header.key === 'Content-Security-Policy'));
    assert.ok(globalHeaders.some((header) => header.key === 'Cache-Control' && header.value === 'no-cache, max-age=0, must-revalidate'));
    assert.ok(hosting.headers.some((rule) => rule.regex?.includes('assets')
        && rule.headers.some((header) => header.value === 'public, max-age=31536000, immutable')));
});
