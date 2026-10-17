import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createViteTestServer } from '../../frontend/ts/testSupport/createViteTestServer.mjs';

const { chromium } = createRequire(import.meta.url)('playwright-core');
const root = fileURLToPath(new URL('../../frontend/', import.meta.url));
const state = Buffer.alloc(32, 1).toString('base64url');
const nonce = Buffer.alloc(32, 2).toString('base64url');
const policy = { enabled: true, mode: 'general-audience', policyVersion: 'synthetic-layout',
    optionalDetails: false, parentRegistrationAvailable: false };
let server, browser, origin;

before(async () => {
    server = await createViteTestServer({ root, configFile: false,
        resolve: { alias: { '@': `${root}/ts` } }, esbuild: { jsx: 'automatic' },
        define: { 'import.meta.env.VITE_USE_PUBLIC_API': '"0"', 'import.meta.env.VITE_DEV_API_URL': '""' },
        logLevel: 'error', server: { host: '127.0.0.1', port: 0 } }, { browser: true });
    await server.listen(); origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    // Disposable browser, synthetic SDK and transport only; never attach to owner Chrome.
    browser = await chromium.launch({ channel: 'chrome', headless: true });
});
after(async () => { await browser?.close(); await server?.close(); });

async function fixture(t, width, { pendingBegin = false, pendingApple = false, height = 900 } = {}) {
    let releaseBegin, releaseApple;
    const beginReady = new Promise(resolve => { releaseBegin = resolve; });
    const appleReady = new Promise(resolve => { releaseApple = resolve; });
    const context = await browser.newContext({ viewport: { width, height } });
    t.after(() => context.close());
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const calls = [];
    await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.href === 'https://accounts.google.com/gsi/client?hl=en') return route.fulfill({ contentType: 'application/javascript', body: `
            window.google = { accounts: { id: {
                initialize(options) { window.__googleLayoutOptions = options; },
                renderButton(host, options) {
                    const control = document.createElement('button');
                    control.textContent = 'Google SDK test control';
                    control.dataset.testid = 'synthetic-google-sdk';
                    control.style.cssText = 'height:40px;border:1px solid #747775;border-radius:999px;background:white;color:#1f1f1f;font:14px Arial';
                    control.style.width = options.width + 'px';
                    control.onclick = () => window.__googleLayoutOptions.callback({ state: options.state, credential: 'synthetic.identity.signature' });
                    host.appendChild(control);
                }
            } } };` });
        if (url.href === 'https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js') {
            if (pendingApple) await appleReady;
            return route.fulfill({ contentType: 'application/javascript', body: 'window.AppleID = {auth:{init(){},signIn(){throw new Error("Not used by layout tests")}}};' });
        }
        // No real providers, API, telemetry or external artwork can be reached.
        if (url.origin !== origin) return route.abort();
        if (url.pathname.startsWith('/auth/') || url.pathname.startsWith('/api/')) {
            calls.push({ path: url.pathname, body: route.request().postDataJSON() });
            let status = 200, result = {};
            if (url.pathname === '/auth/providers/config') result = { clients: [
                { clientKey: 'google-web', provider: 'google', platform: 'web', clientId: 'synthetic.apps.googleusercontent.com', signup: true },
                { clientKey: 'apple-web', provider: 'apple', platform: 'web', clientId: 'com.example.synthetic', redirectUri: 'https://example.test/return', signup: true },
            ] };
            else if (url.pathname === '/auth/registration/config') result = policy;
            else if (url.pathname === '/auth/registration/begin') {
                assert.deepEqual(route.request().postDataJSON(), { policyVersion: policy.policyVersion });
                result = { authorized: true, expiresInSeconds: 300, scoreVisibility: 'private' };
            }
            else if (url.pathname === '/auth/providers/begin') {
                if (pendingBegin) await beginReady;
                result = { state, nonce, expiresInSeconds: 300 };
            }
            else if (url.pathname === '/auth/providers/complete') { status = 403; result = { error: 'REGISTRATION_REQUIRED' }; }
            else if (url.pathname === '/auth/verify-token' || url.pathname === '/auth/renew') result = { loggedIn: false };
            else { status = 503; result = { error: 'UNAVAILABLE' }; }
            return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(result) });
        }
        return route.continue();
    });
    return { page, calls, releaseBegin, releaseApple };
}

test('Google preparation keeps a disabled named pill at the final control height without visible loading copy', async t => {
    const { page, releaseBegin } = await fixture(t, 390, { pendingBegin: true });
    await page.goto(`${origin}/login`);
    await page.locator('.provider-sign-in__google').waitFor();
    const placeholder = page.getByRole('button', { name: 'Continue with Google', exact: true });
    await placeholder.waitFor();
    assert.equal(await placeholder.isDisabled(), true);
    assert.equal(await placeholder.evaluate(button => getComputedStyle(button).backgroundColor), 'rgba(0, 0, 0, 0)');
    assert.equal(await page.getByText('Loading Google sign-in…', { exact: true }).count(), 0);
    assert.equal(await page.getByTestId('synthetic-google-sdk').count(), 0);
    const before = await placeholder.boundingBox();
    releaseBegin();
    const actual = page.getByTestId('synthetic-google-sdk');
    await actual.waitFor();
    const after = await actual.boundingBox();
    assert.ok(Math.abs(before.width - after.width) < 2);
    assert.ok(Math.abs(before.height - after.height) < 2);
    assert.ok(Math.abs(before.y - after.y) < 2);
});

test('Google SDK loads alongside its challenge and becomes usable before the independent Apple SDK finishes', async t => {
    const { page, releaseBegin, releaseApple } = await fixture(t, 390, { pendingBegin: true, pendingApple: true });
    await page.goto(`${origin}/login`);
    await page.locator('.provider-sign-in__google').waitFor();
    await page.waitForFunction(() => Boolean(window.google?.accounts?.id));
    assert.equal(await page.evaluate(() => Boolean(window.AppleID)), false);
    assert.equal(await page.getByTestId('synthetic-google-sdk').count(), 0, 'SDK loading cannot fabricate a prepared challenge');
    releaseBegin();
    await page.getByTestId('synthetic-google-sdk').waitFor();
    assert.equal(await page.evaluate(() => Boolean(window.AppleID)), false);
    assert.equal(await page.getByRole('button', { name: 'Continue with Apple', exact: true }).isDisabled(), true);
    releaseApple();
    await page.waitForFunction(() => Boolean(window.AppleID));
    await page.waitForFunction(() => ![...document.querySelectorAll('button')]
        .find(button => button.textContent === 'Continue with Apple')?.disabled);
});

test('the viewport contains the shell while short screens can scroll to every account control inside main', async t => {
    const measurements = [];
    for (const [width, height] of [[1440, 900], [390, 844], [844, 390], [390, 360]]) {
        const { page } = await fixture(t, width, { height });
        for (const route of ['/', '/login', '/signup']) {
            await page.goto(`${origin}${route}`);
            await page.locator('.main > *').waitFor();
            if (route !== '/') await page.getByTestId('synthetic-google-sdk').waitFor();
            const result = await page.evaluate(() => {
                const main = document.querySelector('.main');
                return { width: innerWidth, height: innerHeight, route: location.pathname,
                    documentWidth: document.documentElement.scrollWidth, documentHeight: document.documentElement.scrollHeight,
                    bodyHeight: document.body.scrollHeight, headerHeight: document.querySelector('.header').getBoundingClientRect().height,
                    mainHeight: main.clientHeight, mainContentHeight: main.scrollHeight,
                    footerHeight: document.querySelector('.footer').getBoundingClientRect().height };
            });
            measurements.push(result);
            if (route !== '/') {
                const main = page.locator('.main');
                const first = page.locator('main input').first();
                await first.scrollIntoViewIfNeeded();
                const firstBox = await first.boundingBox(), mainBox = await main.boundingBox();
                assert.ok(firstBox.y >= mainBox.y && firstBox.y + firstBox.height <= mainBox.y + mainBox.height + 1);
                const last = page.locator('main button, main a').last();
                await last.scrollIntoViewIfNeeded();
                const lastBox = await last.boundingBox();
                assert.ok(lastBox.y >= mainBox.y && lastBox.y + lastBox.height <= mainBox.y + mainBox.height + 1);
            }
        }
        await page.context().close();
    }
    t.diagnostic(JSON.stringify(measurements));
    assert.deepEqual(measurements.filter(item => item.documentWidth > item.width || item.documentHeight > item.height), []);
});

async function capture(page, name) {
    const directory = process.env.LUDOLUME_AUTH_SCREENSHOT_DIR;
    if (!directory) return;
    await mkdir(directory, { recursive: true });
    await page.screenshot({ path: path.join(directory, `${name}.png`), fullPage: true });
}

for (const width of [1280, 390]) {
    test(`signup opens the ordinary form and provider choices at ${width}px without country or an extra entry screen`, async t => {
        const { page, calls } = await fixture(t, width);
        await page.goto(`${origin}/signup`);
        await page.locator('#signup-password').waitFor();
        await page.getByTestId('synthetic-google-sdk').waitFor();
        await page.getByRole('button', { name: 'Continue with Apple', exact: true }).waitFor();
        assert.equal(await page.locator('#signup-username, #signup-email, #signup-password').count(), 3);
        assert.equal(await page.locator('select').count(), 0);
        assert.equal(await page.getByRole('button', { name: 'Create account', exact: true }).count(), 0);
        assert.equal(await page.getByRole('link', { name: 'Cancel', exact: true }).count(), 0);
        const loginLink = page.getByRole('link', { name: 'Log in', exact: true });
        assert.equal(await loginLink.evaluate(link => getComputedStyle(link).color), 'rgba(234, 234, 251, 0.9)');
        const privacy = page.locator('.footer a');
        assert.equal(await privacy.textContent(), 'Privacy notice');
        assert.equal(await privacy.evaluate(link => getComputedStyle(link).color), 'rgb(234, 234, 251)');
        assert.equal(calls.filter(call => call.path === '/api/users').length, 0);
        assert.equal(calls.some(call => call.body && ('country' in call.body || 'ageBand' in call.body)), false);
        await capture(page, `auth-signup-form-synthetic-google-${width}`);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    });

    test(`unlinked Google feedback has an explicit signup action and no empty widget gap at ${width}px`, async t => {
        const { page, calls } = await fixture(t, width);
        await page.goto(`${origin}/login`);
        await page.getByTestId('synthetic-google-sdk').waitFor();
        const apple = page.getByRole('button', { name: 'Continue with Apple', exact: true });
        await apple.waitFor();
        const googleBox = await page.getByTestId('synthetic-google-sdk').boundingBox();
        const appleBox = await apple.boundingBox();
        assert.ok(Math.abs(googleBox.width - appleBox.width) < 2);
        assert.ok(Math.abs(googleBox.height - appleBox.height) < 2);
        assert.ok(appleBox.y - googleBox.y - googleBox.height >= 8);
        await capture(page, `auth-login-ready-synthetic-google-${width}`);
        await page.getByTestId('synthetic-google-sdk').click();
        await page.getByRole('alert').filter({ hasText: 'This Google account isn’t linked yet.' }).waitFor();
        assert.equal(await page.locator('.provider-sign-in__google-host').count(), 0);
        const retry = page.getByRole('button', { name: 'Retry Google sign-in', exact: true });
        const action = page.locator('.provider-sign-in__account-action');
        assert.equal(await action.getAttribute('href'), '/signup');
        assert.equal(await action.textContent(), 'Create account');
        assert.equal(await action.evaluate(link => getComputedStyle(link).color), 'rgb(234, 234, 251)');
        const retryBox = await retry.boundingBox();
        const recoveredAppleBox = await apple.boundingBox();
        assert.ok(Math.abs(retryBox.width - recoveredAppleBox.width) < 2);
        assert.ok(recoveredAppleBox.y - retryBox.y - retryBox.height >= 8);
        assert.ok((await page.locator('.provider-sign-in__google').boundingBox()).height < 160);
        assert.equal(calls.filter(call => call.path === '/auth/providers/complete').length, 1);
        assert.equal(calls.filter(call => call.path.includes('/registration/')).length, 0);
        await capture(page, `auth-login-unlinked-${width}`);
        await retry.click();
        await page.getByTestId('synthetic-google-sdk').waitFor();
        assert.equal(calls.filter(call => call.path === '/auth/providers/begin').length, 2);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    });
}
