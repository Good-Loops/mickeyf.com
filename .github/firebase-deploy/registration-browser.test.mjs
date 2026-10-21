import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createViteTestServer } from '../../frontend/ts/testSupport/createViteTestServer.mjs';

const { chromium } = createRequire(import.meta.url)('playwright-core');
const root = fileURLToPath(new URL('../../frontend/', import.meta.url));
const policy = { enabled: true, audience: 'children-included', creationEnabled: true, policyVersion: 'synthetic-reviewed',
    parentRegistrationAvailable: true, countries: [
        { country: 'US', parentRequiredBelow: 13, adultFrom: 18 },
        { country: 'BR', parentRequiredBelow: 18, adultFrom: 18 },
    ] };
let server, browser, origin;
before(async () => {
    server = await createViteTestServer({ root, configFile: false,
        resolve: { alias: { '@': `${root}/ts` } }, esbuild: { jsx: 'automatic' },
        define: { 'import.meta.env.VITE_USE_PUBLIC_API': '"0"', 'import.meta.env.VITE_DEV_API_URL': '""' },
        logLevel: 'error', server: { host: '127.0.0.1', port: 0 } }, { browser: true });
    await server.listen(); origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ channel: 'chrome', headless: true });
});
after(async () => { await browser?.close(); await server?.close(); });

async function fixture(t, signup = async () => ({ error: 'REGISTRATION_REQUIRED' }), { eligible = true, config = policy } = {}) {
    const context = await browser.newContext(); t.after(() => context.close());
    const page = await context.newPage(); page.setDefaultTimeout(10_000);
    const calls = [];
    await context.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        // Every API/provider response is synthetic; no account or production state can change.
        if (url.origin !== origin) return route.abort();
        if (url.pathname.startsWith('/auth/') || url.pathname.startsWith('/api/')) {
            const body = request.postDataJSON(); calls.push({ path: url.pathname, body });
            let result = { status: 200, body: {} };
            if (url.pathname === '/auth/providers/config') result.body = { clients: [] };
            else if (url.pathname === '/auth/registration/config') result.body = config;
            else if (url.pathname === '/auth/registration/begin') {
                assert.deepEqual(body, { country: 'US', ageBand: 'adult', policyVersion: policy.policyVersion });
                result.body = { authorized: true, expiresInSeconds: 300, scoreVisibility: 'private' };
            }
            else if (url.pathname === '/auth/verify-token' || url.pathname === '/auth/renew') result.body = { loggedIn: false };
            else if (url.pathname === '/api/users' && body?.type === 'signup') result.body = await signup(body);
            else result = { status: 503, body: { error: 'UNAVAILABLE' } };
            return route.fulfill({ status: result.status, contentType: 'application/json', body: JSON.stringify(result.body) });
        }
        return route.continue();
    });
    // A fresh isolated Vite cache compiles the module graph before DOMContentLoaded.
    await page.goto(`${origin}/signup`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    if (eligible) await approveAdult(page);
    return { page, calls };
}
async function fillSynthetic(page) {
    await page.locator('#signup-username').fill('Synthetic Layout Player');
    await page.locator('#signup-email').fill('synthetic@example.test');
    await page.locator('#signup-password').fill('Synthetic test password 123!');
}

async function approveAdult(page) {
    await page.locator('#registration-country').selectOption('US');
    await page.locator('#registration-age').selectOption('adult');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.locator('#signup-password').waitFor();
}

test('signup collects country and coarse age before mounting account credentials', async t => {
    const { page, calls } = await fixture(t, undefined, { eligible: false });
    await page.locator('#registration-country').waitFor();
    assert.equal(await page.locator('#signup-username, #signup-email, #signup-password').count(), 0);
    assert.equal(calls.filter(call => call.path === '/auth/registration/begin').length, 0);
    await approveAdult(page);
    assert.equal(await page.locator('#signup-username, #signup-email, #signup-password').count(), 3);
    assert.deepEqual(calls.find(call => call.path === '/auth/registration/begin').body,
        { country: 'US', ageBand: 'adult', policyVersion: policy.policyVersion });
    assert.equal(calls.filter(call => call.path === '/api/users').length, 0);
    await page.getByRole('link', { name: 'Log in', exact: true }).click();
    await page.locator('#login-password').waitFor();
});

for (const country of ['US', 'BR']) test(`${country} parent-required signup collects no child credentials or registration grant`, async t => {
    const { page, calls } = await fixture(t, undefined, { eligible: false });
    await page.locator('#registration-country').selectOption(country);
    await page.locator('#registration-age').selectOption('parent-required');
    await page.getByRole('button', { name: 'Continue with a parent', exact: true }).click();
    await page.getByRole('link', { name: 'Continue to parent-led registration', exact: true }).waitFor();
    assert.equal(await page.locator('#signup-username, #signup-email, #signup-password').count(), 0);
    assert.equal(calls.filter(call => ['/auth/registration/begin', '/auth/providers/begin', '/api/users'].includes(call.path)).length, 0);
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
});

test('a general-audience backend cannot authorize the new child-audience credential form', async t => {
    const { page, calls } = await fixture(t, undefined, { eligible: false, config: {
        enabled: true, mode: 'general-audience', policyVersion: 'synthetic-old', optionalDetails: false, parentRegistrationAvailable: false,
    } });
    await page.getByText('Registration eligibility could not be confirmed. You can keep exploring without an account.', { exact: true }).waitFor();
    assert.equal(await page.locator('input, select').count(), 0);
    assert.equal(calls.filter(call => ['/auth/registration/begin', '/auth/providers/begin', '/api/users'].includes(call.path)).length, 0);
});

test('server registration rejection does not invent authorization, claim success or start login', async t => {
    const { page, calls } = await fixture(t);
    await fillSynthetic(page);
    await page.getByRole('button', { name: 'Sign up', exact: true }).click();
    await page.getByRole('heading', { name: 'Registration unavailable', exact: true }).waitFor();
    assert.equal(calls.filter(call => call.path === '/api/users').length, 1);
    assert.equal(calls.find(call => call.path === '/api/users').body.type, 'signup');
    assert.equal(calls.filter(call => call.path === '/auth/registration/begin').length, 1);
    assert.equal(await page.getByRole('heading', { name: "You're all set!", exact: true }).count(), 0);
    assert.equal(page.url(), `${origin}/signup`);
});

test('duplicate submit events send only one signup while the result is unresolved', async t => {
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    const { page, calls } = await fixture(t, async () => { await pending; return { error: 'DUPLICATE_USER' }; });
    await fillSynthetic(page);
    await page.locator('.signup__form').evaluate(form => {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await page.getByRole('button', { name: 'Signing up…', exact: true }).waitFor();
    assert.equal(calls.filter(call => call.path === '/api/users').length, 1);
    release();
    await page.getByRole('heading', { name: 'Duplicate user', exact: true }).waitFor();
    assert.equal(calls.filter(call => call.path === '/api/users').length, 1);
});

test('leaving an unresolved signup ignores its late result and does not open a stale dialog', async t => {
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    const { page, calls } = await fixture(t, async () => { await pending; return { error: 'REGISTRATION_REQUIRED' }; });
    await fillSynthetic(page);
    await page.getByRole('button', { name: 'Sign up', exact: true }).click();
    await page.getByRole('button', { name: 'Signing up…', exact: true }).waitFor();
    await page.getByRole('link', { name: 'Log in', exact: true }).click();
    await page.locator('#login-password').waitFor();
    const finished = page.waitForResponse(response => new URL(response.url()).pathname === '/api/users');
    release(); await finished;
    assert.equal(calls.filter(call => call.path === '/api/users').length, 1);
    assert.equal(await page.locator('.swal2-popup').count(), 0);
    assert.equal(page.url(), `${origin}/login`);
});

test('parent-led registration remains a separate account-management route', async t => {
    const { page } = await fixture(t);
    await page.goto(`${origin}/parent-accounts`);
    await page.getByRole('heading', { name: 'Parent and child accounts', exact: true }).waitFor();
    assert.equal(await page.locator('#signup-password').count(), 0);
    await page.getByRole('link', { name: 'Manage your own account', exact: true }).waitFor();
});
