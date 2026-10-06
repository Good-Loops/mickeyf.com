import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createViteTestServer } from '../../frontend/ts/testSupport/createViteTestServer.mjs';

const { chromium } = createRequire(import.meta.url)('playwright-core');
const root = fileURLToPath(new URL('../../frontend/', import.meta.url));
const policy = { enabled: true, policyVersion: 'synthetic', parentRegistrationAvailable: false,
    countries: [{ country: 'ZZ', parentRequiredBelow: 15, adultFrom: 18 }] };
let server, browser, origin;

before(async () => {
    server = await createViteTestServer({ root, configFile: false,
        resolve: { alias: { '@': `${root}/ts` } }, esbuild: { jsx: 'automatic' },
        define: { 'import.meta.env.VITE_USE_PUBLIC_API': '"0"', 'import.meta.env.VITE_DEV_API_URL': '""' },
        logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } }, { browser: true });
    await server.listen();
    origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    // A new, ephemeral headless profile; never connects to the user's open Chrome.
    browser = await chromium.launch({ channel: 'chrome', headless: true });
});
after(async () => { await browser?.close(); await server?.close(); });

async function fixture(t, { config = policy, begin } = {}) {
    const context = await browser.newContext();
    t.after(() => context.close());
    const page = await context.newPage();
    page.on('pageerror', error => t.diagnostic(error.message));
    page.setDefaultTimeout(10_000);
    const calls = [];
    await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        // No provider, production API, telemetry or remote assets in these tests.
        if (url.origin !== origin) return route.abort();
        if (url.pathname.startsWith('/auth/') || url.pathname.startsWith('/api/')) {
            const body = route.request().postDataJSON();
            calls.push({ path: url.pathname, body });
            let result = { status: 200, body: {} };
            if (url.pathname === '/auth/registration/config') result.body = config;
            else if (url.pathname === '/auth/registration/begin') result = begin ? await begin(body) : {
                status: 200, body: { authorized: true, expiresInSeconds: 300, scoreVisibility: body.ageBand === 'minor' ? 'private' : 'public' },
            };
            else if (url.pathname === '/auth/registration/cancel') result.body = { cancelled: true };
            else if (url.pathname === '/auth/providers/config') result.body = { clients: [] };
            else if (url.pathname === '/auth/verify-token' || url.pathname === '/auth/renew') result.body = { loggedIn: false };
            else result = { status: 503, body: { error: 'UNAVAILABLE' } };
            return route.fulfill({ status: result.status, contentType: 'application/json', body: JSON.stringify(result.body) });
        }
        return route.continue();
    });
    await page.goto(`${origin}/signup`);
    return { page, calls };
}
const noCredentials = async page => assert.equal(await page.locator('#signup-email, #signup-password').count(), 0);
async function select(page, band = 'minor') {
    await page.locator('#registration-country').selectOption('ZZ');
    await page.locator('#registration-age').selectOption(band);
}

test('closed registration collects no credentials while existing login remains reachable', async t => {
    const { page } = await fixture(t, { config: { enabled: false } });
    await page.getByText('New registrations are currently paused.').waitFor();
    await noCredentials(page);
    await page.getByRole('link', { name: 'Already have an account? Log in' }).click();
    await page.locator('input[type=password]').waitFor();
});

test('unsupported country and both parent-led entry paths never request authorization or child credentials', async t => {
    const { page, calls } = await fixture(t);
    await page.locator('#registration-country').selectOption('unavailable');
    await page.getByText('Registration is not available for that country yet.', { exact: false }).waitFor();
    await noCredentials(page);
    await select(page, 'parent-required');
    await page.getByRole('button', { name: 'Continue to parent-led registration' }).click();
    await page.getByRole('link', { name: 'Continue to parent-led registration' }).waitFor();
    await noCredentials(page);
    await page.getByRole('button', { name: 'Back to registration' }).click();
    await page.locator('#registration-for').selectOption('child');
    await select(page, 'minor');
    await page.getByRole('button', { name: 'Continue to parent-led registration' }).click();
    await page.getByRole('heading', { name: 'A parent or guardian needs to lead this step' }).waitFor();
    assert.equal(calls.filter(call => call.path.endsWith('/begin')).length, 0);
    await noCredentials(page);
});

test('minor preflight precedes credentials; duplicate clicks, back and reload cannot reuse UI authorization', async t => {
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    const { page, calls } = await fixture(t, { begin: async () => {
        await pending; return { status: 200, body: { authorized: true, expiresInSeconds: 300, scoreVisibility: 'private' } };
    } });
    await select(page);
    await page.getByRole('button', { name: 'Continue', exact: true }).evaluate(button => { button.click(); button.click(); });
    await page.getByRole('button', { name: 'Checking…', exact: true }).waitFor();
    await noCredentials(page);
    release();
    await page.locator('#signup-email').waitFor();
    assert.equal(calls.filter(call => call.path.endsWith('/begin')).length, 1);
    await page.getByText('Your scores will stay off public leaderboards.').waitFor();
    await page.locator('#signup-email').fill('synthetic@example.test');
    await page.getByRole('button', { name: 'Back to country and age range' }).click();
    await page.locator('#registration-country').waitFor();
    await noCredentials(page);
    await select(page, 'adult');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.locator('#signup-email').waitFor();
    assert.equal(await page.locator('#signup-email').inputValue(), '');
    await page.reload();
    await page.locator('#registration-country').waitFor();
    await noCredentials(page);
    assert.ok(calls.some(call => call.path.endsWith('/cancel')));
});

test('server rejection and expiry return to eligibility without claiming an account was created', async t => {
    let tries = 0;
    const { page } = await fixture(t, { begin: async () => ++tries === 1
        ? { status: 503, body: { error: 'UNAVAILABLE' } }
        : { status: 200, body: { authorized: true, expiresInSeconds: 1, scoreVisibility: 'public' } } });
    await select(page, 'adult');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'We could not confirm' }).waitFor();
    await noCredentials(page);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.locator('#signup-email').waitFor();
    await page.getByText('This registration step expired.', { exact: false }).waitFor();
    await noCredentials(page);
});

test('leaving while preflight is pending queues cancellation and ignores its late approval', async t => {
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    const { page, calls } = await fixture(t, { begin: async () => {
        await pending; return { status: 200, body: { authorized: true, expiresInSeconds: 300, scoreVisibility: 'private' } };
    } });
    await select(page);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('button', { name: 'Checking…', exact: true }).waitFor();
    await page.getByRole('link', { name: 'Already have an account? Log in' }).click();
    await page.locator('input[type=password]').waitFor();
    release();
    await page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/cancel'));
    assert.ok(page.url().endsWith('/login'));
    assert.equal(calls.filter(call => call.path.endsWith('/begin')).length, 1);
    assert.equal(calls.filter(call => call.path === '/api/users').length, 0);
});
