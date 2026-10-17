import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createRequire } from 'node:module';
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

async function fixture(t, width, { pendingBegin = false, pendingApple = false, pendingRenew = false,
    pendingConfig = false, height = 900, closedSignup = false } = {}) {
    let releaseBegin, releaseApple, releaseRenew, releaseConfig;
    const beginReady = new Promise(resolve => { releaseBegin = resolve; });
    const appleReady = new Promise(resolve => { releaseApple = resolve; });
    const renewReady = new Promise(resolve => { releaseRenew = resolve; });
    const configReady = new Promise(resolve => { releaseConfig = resolve; });
    const context = await browser.newContext({ viewport: { width, height } });
    t.after(() => context.close());
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    // A cold Vite transform can overlap the full unit suite on CI; UI waits remain bounded separately.
    page.setDefaultNavigationTimeout(30_000);
    const calls = [];
    await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.href === 'https://accounts.google.com/gsi/style') return route.fulfill({ contentType: 'text/css', body: '' });
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
            if (url.pathname === '/auth/providers/config') {
                if (pendingConfig) await configReady;
                result = { clients: [
                { clientKey: 'google-web', provider: 'google', platform: 'web', clientId: 'synthetic.apps.googleusercontent.com', ...(closedSignup ? {} : { signup: true }) },
                { clientKey: 'apple-web', provider: 'apple', platform: 'web', clientId: 'com.example.synthetic', redirectUri: 'https://example.test/return', ...(closedSignup ? {} : { signup: true }) },
                ] };
            }
            else if (url.pathname === '/auth/registration/config') result = closedSignup ? { enabled: false } : policy;
            else if (url.pathname === '/auth/registration/begin') {
                assert.deepEqual(route.request().postDataJSON(), { policyVersion: policy.policyVersion });
                result = { authorized: true, expiresInSeconds: 300, scoreVisibility: 'private' };
            }
            else if (url.pathname === '/auth/providers/begin') {
                if (pendingBegin) await beginReady;
                result = { state, nonce, expiresInSeconds: 300 };
            }
            else if (url.pathname === '/auth/providers/complete') { status = 403; result = { error: 'REGISTRATION_REQUIRED' }; }
            else if (url.pathname === '/auth/verify-token' || url.pathname === '/auth/renew') {
                if (pendingRenew) await renewReady;
                result = { loggedIn: false };
            }
            else { status = 503; result = { error: 'UNAVAILABLE' }; }
            return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(result) });
        }
        return route.continue();
    });
    return { page, calls, releaseBegin, releaseApple, releaseRenew, releaseConfig };
}

test('Google preparation keeps a disabled named pill at the final control height without visible loading copy', async t => {
    const { page, releaseBegin } = await fixture(t, 390, { pendingBegin: true });
    await page.goto(`${origin}/login`);
    await page.locator('.provider-sign-in__google').waitFor();
    const placeholder = page.getByRole('button', { name: 'Continue with Google', exact: true });
    await placeholder.waitFor();
    assert.equal(await placeholder.isDisabled(), true);
    assert.equal(await placeholder.evaluate(button => getComputedStyle(button).backgroundColor), 'rgb(255, 255, 255)');
    assert.equal(await placeholder.locator('img').getAttribute('src'), '/images/google-sign-in-logo.svg');
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

test('auth-route Google resources warm during renewal and config discovery without racing their cookie barrier', async t => {
    const { page, calls, releaseRenew, releaseConfig } = await fixture(t, 390, { pendingRenew: true, pendingConfig: true });
    const styleRequested = page.waitForRequest('https://accounts.google.com/gsi/style');
    await page.goto(`${origin}/login`);
    await page.waitForFunction(() => Boolean(window.google?.accounts?.id));
    await styleRequested;
    assert.equal(calls.filter(call => call.path === '/auth/providers/begin').length, 0);
    const pending = page.getByRole('button', { name: 'Continue with Google', exact: true });
    await pending.waitFor(); assert.equal(await pending.isDisabled(), true);
    assert.equal(await pending.evaluate(button => getComputedStyle(button).opacity), '1');
    assert.equal(await pending.evaluate(button => getComputedStyle(button).backgroundColor), 'rgb(255, 255, 255)');
    releaseConfig();
    await page.locator('.provider-sign-in__google').waitFor();
    assert.equal(calls.filter(call => call.path === '/auth/providers/begin').length, 0, 'unknown session must not be replaced');
    releaseRenew();
    await page.getByTestId('synthetic-google-sdk').waitFor();
    assert.equal(calls.filter(call => call.path === '/auth/providers/begin').length, 1);
    assert.equal(calls.filter(call => call.path === '/auth/providers/complete').length, 0);
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

test('closed registration retains both signup choices and explains a click without any auth mutation', async t => {
    const { page, calls } = await fixture(t, 390, { closedSignup: true });
    await page.goto(`${origin}/signup`);
    const google = page.getByRole('button', { name: 'Continue with Google', exact: true });
    const apple = page.getByRole('button', { name: 'Continue with Apple', exact: true });
    await google.waitFor(); await apple.filter({ has: page.locator('img') }).waitFor();
    const geometry = await page.evaluate(() => {
        const google = document.querySelector('.provider-sign-in__button--availability');
        const apple = document.querySelector('.provider-sign-in__button--apple');
        const rect = element => { const value = element.getBoundingClientRect(); return { x: value.x, y: value.y, width: value.width, height: value.height }; };
        const text = button => { const range = document.createRange(); range.selectNodeContents(button.querySelector('span:last-child'));
            const box = range.getBoundingClientRect(); const buttonBox = button.getBoundingClientRect();
            return { centerX: box.x + box.width / 2, relativeCenterY: box.y + box.height / 2 - buttonBox.y }; };
        return { google: rect(google), apple: rect(apple), slot: rect(google.querySelector('.provider-sign-in__google-mark')),
            logo: rect(google.querySelector('img')), googleText: text(google), appleText: text(apple) };
    });
    assert.equal(geometry.slot.width, 20); assert.equal(geometry.slot.height, 20);
    assert.equal(geometry.logo.width, 18); assert.equal(geometry.logo.height, 18);
    assert.ok(Math.abs(geometry.logo.x + 9 - geometry.google.x - 22) < .1);
    assert.ok(Math.abs(geometry.logo.y + 9 - geometry.google.y - 20) < .1);
    assert.equal(geometry.google.width, geometry.apple.width); assert.equal(geometry.google.height, geometry.apple.height);
    assert.ok(Math.abs(geometry.googleText.centerX - geometry.appleText.centerX) < .1);
    assert.ok(Math.abs(geometry.googleText.relativeCenterY - geometry.appleText.relativeCenterY) < .1);
    assert.equal(await page.getByTestId('synthetic-google-sdk').count(), 0);
    await google.click();
    await page.getByRole('alert').filter({ hasText: 'Account creation with Google is temporarily unavailable.' }).waitFor();
    await apple.click();
    await page.getByRole('alert').filter({ hasText: 'Account creation with Apple is temporarily unavailable.' }).waitFor();
    assert.equal(calls.filter(call => ['/auth/registration/begin', '/auth/providers/begin', '/auth/providers/complete', '/api/users'].includes(call.path)).length, 0);
    assert.equal(await page.locator('select').count(), 0);
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
        await retry.click();
        await page.getByTestId('synthetic-google-sdk').waitFor();
        assert.equal(calls.filter(call => call.path === '/auth/providers/begin').length, 2);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    });
}
