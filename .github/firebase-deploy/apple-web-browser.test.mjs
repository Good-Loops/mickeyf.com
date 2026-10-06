import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createViteTestServer } from '../../frontend/ts/testSupport/createViteTestServer.mjs';

const { chromium } = createRequire(import.meta.url)('playwright-core');
const root = fileURLToPath(new URL('../../frontend/', import.meta.url));
const sdkUrl = 'https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js';
const state = Buffer.alloc(32, 1).toString('base64url');
const nonce = Buffer.alloc(32, 2).toString('base64url');
let server, browser, origin;
before(async () => {
    const hosting = JSON.parse(await readFile(new URL('../../firebase.json', import.meta.url), 'utf8')).hosting;
    const csp = hosting.headers.find(entry => entry.regex === '.*').headers.find(header => header.key === 'Content-Security-Policy').value;
    server = await createViteTestServer({ root, configFile: false,
        resolve: { alias: { '@': `${root}/ts` } }, esbuild: { jsx: 'automatic' },
        define: { 'import.meta.env.VITE_USE_PUBLIC_API': '"0"', 'import.meta.env.VITE_DEV_API_URL': '""' },
        logLevel: 'error', server: { host: '127.0.0.1', port: 0, headers: { 'Content-Security-Policy': csp } } }, { browser: true });
    await server.listen(); origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ channel: 'chrome', headless: true });
});
after(async () => { await browser?.close(); await server?.close(); });

async function fixture(t, mode = 'success') {
    const context = await browser.newContext(); t.after(() => context.close());
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    const calls = [];
    let loggedIn = false;
    await context.route('**/*', async route => {
        const request = route.request(); const url = new URL(request.url());
        if (request.url() === sdkUrl) return route.fulfill({ contentType: 'application/javascript', body: `
            window.__appleMode = ${JSON.stringify(mode)};
            window.AppleID = { auth: { init(input) { window.__appleInit = input; }, signIn() {
                window.__appleClickTrusted = !!window.event?.isTrusted;
                window.__appleClickActive = navigator.userActivation.isActive;
                const result = { authorization: { state: window.__appleMode === 'wrong-state' ? 'wrong' : window.__appleInit.state,
                    id_token: 'synthetic.identity.signature', code: 'synthetic-code' }, user: { email: 'ignored@example.test' } };
                if (window.__appleMode === 'blocked') return Promise.reject({ error: 'popup_blocked_by_browser' });
                if (window.__appleMode === 'pending') return new Promise(resolve => { window.__finishApple = () => resolve(result); });
                return Promise.resolve(result);
            } } };` });
        if (url.origin !== origin) return route.abort();
        if (url.pathname.startsWith('/auth/')) {
            const body = request.postDataJSON(); calls.push({ path: url.pathname, body });
            let response = {};
            if (url.pathname === '/auth/providers/config') response = { clients: [{ clientKey: 'apple-web', provider: 'apple',
                platform: 'web', clientId: 'com.example.web', redirectUri: 'https://example.test/login' }] };
            else if (url.pathname.endsWith('/providers/begin')) response = { state, nonce, expiresInSeconds: 300 };
            else if (url.pathname.endsWith('/providers/complete')) { loggedIn = true; response = { success: true, user_name: 'Player' }; }
            else if (url.pathname === '/auth/verify-token' || url.pathname === '/auth/renew') response = loggedIn
                ? { loggedIn: true, user_name: 'Player' } : { loggedIn: false };
            return route.fulfill({ contentType: 'application/json', body: JSON.stringify(response) });
        }
        return route.continue();
    });
    await page.goto(`${origin}/login`);
    return { page, calls };
}
async function openApple(page) {
    await page.getByRole('button', { name: 'Continue with Apple', exact: true }).click();
    await page.locator('.swal2-popup').getByRole('button', { name: 'Continue with Apple', exact: true }).waitFor();
}

test('real browser click reaches the popup adapter then completes through the serialized auth transport', async t => {
    const { page, calls } = await fixture(t);
    await openApple(page);
    assert.equal(calls.filter(call => call.path.endsWith('/complete')).length, 0);
    await page.locator('.swal2-popup').getByRole('button', { name: 'Continue with Apple', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.swal2-popup'));
    await page.waitForFunction(() => document.body.textContent.includes('Player'));
    assert.equal(await page.evaluate(() => window.__appleClickActive), true);
    assert.equal(await page.evaluate(() => window.__appleClickTrusted), true);
    assert.deepEqual(await page.evaluate(() => window.__appleInit), { clientId: 'com.example.web',
        redirectURI: 'https://example.test/login', scope: 'email', state, nonce, usePopup: true });
    const completed = calls.filter(call => call.path.endsWith('/complete'));
    assert.equal(completed.length, 1);
    assert.deepEqual(completed[0].body, { action: 'login', clientKey: 'apple-web', state,
        idToken: 'synthetic.identity.signature', authorizationCode: 'synthetic-code', rememberMe: false });
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
    assert.doesNotMatch(page.url(), /synthetic-code|identity.signature/);
});

for (const mode of ['blocked', 'wrong-state']) test(`browser ${mode} sends no credential completion and restores the login controls`, async t => {
    const { page, calls } = await fixture(t, mode);
    await openApple(page);
    await page.locator('.swal2-popup').getByRole('button', { name: 'Continue with Apple', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'We could not confirm sign-in.' }).waitFor();
    assert.equal(calls.filter(call => call.path.endsWith('/complete')).length, 0);
    assert.equal(await page.locator('input[type=password]').count(), 1);
});

test('browser cancellation ignores a delayed SDK success without storing or submitting its credentials', async t => {
    const { page, calls } = await fixture(t, 'pending');
    await openApple(page);
    await page.locator('.swal2-popup').getByRole('button', { name: 'Continue with Apple', exact: true }).click();
    await page.locator('.swal2-popup').getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.evaluate(() => window.__finishApple());
    await page.getByRole('button', { name: 'Continue with Apple', exact: true }).waitFor();
    assert.equal(calls.filter(call => call.path.endsWith('/complete')).length, 0);
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
});

test('Hosting CSP permits only the exact Apple SDK and preserves popup isolation and other restrictions', async () => {
    const config = JSON.parse(await readFile(new URL('../../firebase.json', import.meta.url), 'utf8'));
    const headers = config.hosting.headers.find(entry => entry.regex === '.*').headers;
    const csp = headers.find(header => header.key === 'Content-Security-Policy').value;
    const directives = new Map(csp.split(';').map(value => { const [name, ...sources] = value.trim().split(/\s+/); return [name, sources]; }));
    assert.deepEqual(directives.get('script-src'), ["'self'", "'wasm-unsafe-eval'", 'https://accounts.google.com/gsi/client', sdkUrl]);
    assert.deepEqual(directives.get('script-src-attr'), ["'none'"]);
    assert.deepEqual(directives.get('form-action'), ["'self'"]);
    assert.deepEqual(directives.get('frame-ancestors'), ["'none'"]);
    assert.equal(headers.find(header => header.key === 'Cross-Origin-Opener-Policy').value, 'same-origin-allow-popups');
});
