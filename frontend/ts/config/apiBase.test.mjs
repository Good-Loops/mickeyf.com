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

test('public preview is explicit and restricted to the development browser', () => {
    assert.equal(selectApiBase({ ...urls, mode: 'development', isNative: false, publicPreview: true }), '/__public-api');
    assert.equal(selectApiBase({ ...urls, mode: 'development', isNative: true, publicPreview: true }), urls.developmentUrl);
    assert.equal(selectApiBase({ ...urls, mode: 'production', isNative: false, publicPreview: true }), '');
    assert.equal(selectApiBase({ ...urls, mode: 'production', isNative: true, publicPreview: true }), urls.productionUrl);
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

test('one global document policy permits only the required Google GIS resources across SPA navigation', async () => {
    const { hosting } = JSON.parse(await readFile(new URL('../../../firebase.json', import.meta.url), 'utf8'));
    const policyRules = hosting.headers.filter(rule => rule.headers.some(header =>
        ['Content-Security-Policy', 'Cross-Origin-Opener-Policy'].includes(header.key)));
    // Home -> Login keeps the original document and its response headers.
    // A Login-only exception would therefore leave the provider button blocked.
    assert.equal(policyRules.length, 1);
    assert.equal(policyRules[0].regex, '.*');
    const policies = policyRules[0].headers.filter(header => header.key === 'Content-Security-Policy');
    assert.equal(policies.length, 1);
    const entries = policies[0].value.split(';').map(directive => directive.trim().split(/\s+/));
    assert.equal(new Set(entries.map(([name]) => name)).size, entries.length, 'directives must not be duplicated');
    // Google's setup guide requires the GIS parent path for evolving connect/frame endpoints,
    // while scripts and styles remain restricted to the exact documented resources.
    assert.deepEqual(Object.fromEntries(entries.map(([name, ...sources]) => [name, sources])), {
        'default-src': ["'self'"],
        'base-uri': ["'self'"],
        'connect-src': ["'self'", 'data:', 'https://mickeyf-org-j7yuum4tiq-uc.a.run.app', 'https://accounts.google.com/gsi/'],
        'font-src': ["'self'", 'data:', 'https://fonts.gstatic.com'],
        'form-action': ["'self'"],
        'frame-ancestors': ["'none'"],
        'frame-src': ['https://accounts.google.com/gsi/'],
        'img-src': ["'self'", 'data:', 'blob:'],
        'manifest-src': ["'self'"],
        'media-src': ["'self'", 'blob:'],
        'object-src': ["'none'"],
        'script-src': ["'self'", "'wasm-unsafe-eval'", 'https://accounts.google.com/gsi/client'],
        'script-src-attr': ["'none'"],
        'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://accounts.google.com/gsi/style'],
        'worker-src': ["'self'", 'blob:'],
        'upgrade-insecure-requests': [],
    });
});

test('GIS popup compatibility changes only opener isolation and preserves the other global security headers', async () => {
    const { hosting } = JSON.parse(await readFile(new URL('../../../firebase.json', import.meta.url), 'utf8'));
    const headers = hosting.headers.find(rule => rule.regex === '.*').headers;
    assert.equal(new Set(headers.map(header => header.key)).size, headers.length);
    assert.deepEqual(Object.fromEntries(headers.filter(header => header.key !== 'Content-Security-Policy')
        .map(header => [header.key, header.value])), {
        'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
        'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
        'Cross-Origin-Resource-Policy': 'same-origin',
        'Permissions-Policy': 'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(self), payment=(), usb=()',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Cache-Control': 'no-cache, max-age=0, must-revalidate',
    });
});
