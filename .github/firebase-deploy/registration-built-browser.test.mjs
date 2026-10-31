import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';

const { chromium } = createRequire(import.meta.url)('playwright-core');
const dist = fileURLToPath(new URL('../../frontend/dist/', import.meta.url));
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
    '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
    '.webp': 'image/webp', '.woff2': 'font/woff2' };
const policy = { enabled: true, audience: 'children-included', creationEnabled: true,
    policyVersion: 'synthetic-build', parentRegistrationAvailable: true,
    countries: [{ country: 'US', parentRequiredBelow: 13, adultFrom: 18 },
        { country: 'BR', parentRequiredBelow: 18, adultFrom: 18 }] };
let server, browser, origin;

before(async () => {
    // Serve the actual Vite output, not source modules; never contact a live account or API.
    await stat(path.join(dist, 'index.html'));
    server = createServer(async (req, res) => {
        try {
            const pathname = new URL(req.url, 'http://localhost').pathname;
            const relative = pathname === '/signup' || pathname === '/' ? '/index.html' : pathname;
            const target = path.resolve(dist, `.${relative}`);
            if (!target.startsWith(`${path.resolve(dist)}${path.sep}`)) throw new Error('Invalid path');
            const body = await readFile(target);
            res.writeHead(200, { 'content-type': mime[path.extname(target)] ?? 'application/octet-stream' });
            res.end(body);
        } catch {
            res.writeHead(404); res.end();
        }
    });
    await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ channel: 'chrome', headless: true });
});
after(async () => {
    await browser?.close();
    if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

async function fixture(t, initialConfig) {
    let config = initialConfig;
    const calls = [];
    const context = await browser.newContext({ viewport: { width: 390, height: 900 } });
    t.after(() => context.close());
    const page = await context.newPage();
    await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) return route.abort();
        if (!url.pathname.startsWith('/auth/') && !url.pathname.startsWith('/api/')) return route.continue();
        calls.push({ path: url.pathname, method: route.request().method(), body: route.request().postDataJSON() });
        if (url.pathname === '/auth/registration/config') {
            return route.fulfill({ status: config === null ? 503 : 200, contentType: 'application/json',
                body: JSON.stringify(config ?? { error: 'UNAVAILABLE' }) });
        }
        if (url.pathname === '/auth/providers/config') return route.fulfill({ json: { clients: [] } });
        if (url.pathname === '/auth/registration/begin') {
            assert.deepEqual(route.request().postDataJSON(), { country: 'US', ageBand: 'adult', policyVersion: policy.policyVersion });
            return route.fulfill({ json: { authorized: true, expiresInSeconds: 300, scoreVisibility: 'private' } });
        }
        return route.fulfill({ json: { loggedIn: false } });
    });
    await page.goto(`${origin}/signup`);
    return { page, calls, setConfig: value => { config = value; } };
}

function assertNoSignupRequests(calls) {
    assert.deepEqual(calls.filter(call => ['/auth/registration/begin', '/auth/providers/begin',
        '/auth/providers/complete', '/api/users'].includes(call.path)), []);
}

for (const paused of [{ enabled: false }, { ...policy, creationEnabled: false }]) test('built website shows pause, guest and login links, and no signup controls', async t => {
    const { page, calls } = await fixture(t, paused);
    await page.getByRole('status').filter({ hasText: 'New account creation is temporarily paused.' }).waitFor();
    assert.equal(await page.getByRole('link', { name: 'Continue as a guest' }).getAttribute('href'), '/');
    assert.equal(await page.getByRole('link', { name: 'Log in', exact: true }).getAttribute('href'), '/login');
    assert.equal(await page.locator('#signup-username, #signup-email, #signup-password, #registration-country, #registration-age, .provider-sign-in').count(), 0);
    assertNoSignupRequests(calls);
});

test('built website fails closed when configuration is unavailable and can retry', async t => {
    const { page, calls, setConfig } = await fixture(t, null);
    await page.getByRole('alert').filter({ hasText: 'We can’t check sign-up availability right now.' }).waitFor();
    assert.equal(await page.locator('#signup-username, #signup-email, #signup-password, .provider-sign-in').count(), 0);
    setConfig({ enabled: false });
    await page.getByRole('button', { name: 'Check again' }).click();
    await page.getByRole('status').filter({ hasText: 'New account creation is temporarily paused.' }).waitFor();
    assertNoSignupRequests(calls);
});

test('built website requires country and age eligibility before signup when registration is open', async t => {
    const { page, calls } = await fixture(t, policy);
    await page.locator('#registration-country').waitFor();
    assert.equal(await page.locator('#signup-username, #signup-email, #signup-password').count(), 0);
    assertNoSignupRequests(calls);
    await page.locator('#registration-country').selectOption('US');
    await page.locator('#registration-age').selectOption('adult');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.locator('#signup-password').waitFor();
    assert.equal(await page.locator('#signup-username, #signup-email, #signup-password').count(), 3);
    assert.deepEqual(calls.find(call => call.path === '/auth/registration/begin')?.body,
        { country: 'US', ageBand: 'adult', policyVersion: policy.policyVersion });
    // All endpoints are synthetic, and merely displaying the form must not create a user.
    assert.deepEqual(calls.filter(call => ['/auth/providers/complete', '/api/users'].includes(call.path)), []);
});
