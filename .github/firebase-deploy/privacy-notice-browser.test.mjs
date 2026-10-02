import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createViteTestServer } from '../../frontend/ts/testSupport/createViteTestServer.mjs';
const { chromium } = createRequire(import.meta.url)('playwright-core');
const root = fileURLToPath(new URL('../../frontend/', import.meta.url));
const notice = 'https://notice.example.test/privacy#children';
const approved = JSON.parse(await readFile(new URL('../../shared/privacyNotice.json', import.meta.url), 'utf8'));
let server, browser, origin;
before(async () => {
    server = await createViteTestServer({ root, configFile: false, resolve: { alias: { '@': `${root}/ts` } },
        esbuild: { jsx: 'automatic' }, logLevel: 'error',
        define: { 'import.meta.env.VITE_PRIVACY_NOTICE_URL': '""',
            'import.meta.env.VITE_USE_PUBLIC_API': '"0"', 'import.meta.env.VITE_DEV_API_URL': '""' },
        plugins: [{ name: 'privacy-notice-browser-fixture',
            resolveId(id) { if (id === '/privacy-fixture.js') return '\0privacy-fixture'; },
            load(id) { if (id === '\0privacy-fixture') return `
                import React from 'react'; import { createRoot } from 'react-dom/client';
                import ParentRegistration from '/ts/components/ParentRegistration.tsx';
                const config = { enabled: true, creationEnabled: true, policyVersion: 'test', consentVersion: 'test',
                    consentText: ${JSON.stringify(approved.consent.parent.text)}, privacyNoticeUrl: ${JSON.stringify(notice)}, countries: ['ZZ'] };
                const api = { config: async () => config, begin: async () => ({state:'synthetic-state',nonce:'nonce',expiresInSeconds:300}),
                    complete: async () => ({grant:'synthetic-grant',purpose:'create-child',expiresInSeconds:300}), cancel: async()=>{} };
                createRoot(document.getElementById('root')).render(React.createElement(ParentRegistration,
                    { api, authenticated: true, accountKey: 'synthetic-parent', clients:[{clientKey:'google-web',provider:'google'}],
                      acquire:async()=> 'synthetic-provider-token' }));`; },
        }], server: { host: '127.0.0.1', port: 0, strictPort: false } }, { browser: true });
    await server.listen(); origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ channel: 'chrome', headless: true });
});
after(async () => { await browser?.close(); await server?.close(); });
async function fixture(t) {
    const context = await browser.newContext(); t.after(() => context.close());
    const noticeRequests = [];
    await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin === new URL(notice).origin) {
            noticeRequests.push(route.request().headers());
            return route.fulfill({ contentType: 'text/html', body: '<h1>Synthetic notice</h1>' });
        }
        if (url.origin !== origin) return route.abort();
        if (url.pathname === '/__privacy-fixture') return route.fulfill({ contentType: 'text/html',
            body: '<div id="root"></div><script type="module" src="/privacy-fixture.js"></script>' });
        if (url.pathname.startsWith('/auth/')) return route.fulfill({ contentType: 'application/json',
            body: JSON.stringify(url.pathname.includes('config') ? { enabled: false } : { loggedIn: false }) });
        return route.continue();
    });
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    return { page, noticeRequests };
}
test('closed account entry links to the approved local notice without configuration or authentication', async t => {
    const { page } = await fixture(t); await page.goto(`${origin}/account`);
    const link = page.getByRole('contentinfo').getByRole('link', { name: 'Privacy notice', exact: true });
    await link.waitFor(); assert.equal(await link.getAttribute('href'), '/privacy');
    assert.equal(await page.locator('input[type=password]').count(), 0);
    await link.click(); await page.getByRole('heading', { name: 'Ludolume privacy notice', exact: true }).waitFor();
    assert.equal(new URL(page.url()).pathname, '/privacy');
});
test('direct notice route renders full approved wording with separate permissions and fits a narrow viewport', async t => {
    const { page } = await fixture(t);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${origin}/privacy`);
    const article = page.getByRole('article'); await article.waitFor();
    for (const section of approved.sections) await article.getByText(section.text, { exact: true }).waitFor();
    await article.getByText(approved.consent.parent.text, { exact: true }).waitFor();
    await article.getByText(approved.consent.publicScores.text, { exact: true }).waitFor();
    assert.equal(await article.getByRole('link', { name: approved.contactEmail, exact: true }).getAttribute('href'), `mailto:${approved.contactEmail}`);
    assert.equal(await article.locator('input, form, button').count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.setViewportSize({ width: 1280, height: 800 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
});
test('keyboard notice navigation isolates the new tab and preserves consent and child credentials', async t => {
    const { page, noticeRequests } = await fixture(t); await page.goto(`${origin}/__privacy-fixture`);
    const link = page.getByRole('link', { name: 'Privacy notice (opens in a new tab)' });
    await link.waitFor(); assert.equal(await page.locator('input[type=password]').count(), 0);
    await page.getByText(approved.consent.parent.text, { exact: true }).waitFor();
    assert.equal(await page.getByRole('checkbox').count(), 3);
    for (const checkbox of await page.getByRole('checkbox').all()) assert.equal(await checkbox.isChecked(), false);
    assert.equal(await page.getByRole('button', { name: 'Confirm with Google' }).isDisabled(), true);
    await page.getByLabel("Child's country").selectOption('ZZ');
    for (const checkbox of await page.getByRole('checkbox').all()) await checkbox.check();
    await link.focus();
    const opened = page.waitForEvent('popup'); await page.keyboard.press('Enter');
    const popup = await opened; await popup.getByRole('heading', { name: 'Synthetic notice' }).waitFor();
    assert.equal(await popup.evaluate(() => window.opener), null);
    assert.equal(noticeRequests.length, 1); assert.equal(noticeRequests[0].referer, undefined);
    await popup.close(); assert.equal(await page.getByRole('checkbox').first().isChecked(), true);
    await page.getByRole('button', { name: 'Confirm with Google' }).click();
    const password = page.getByLabel("Child's password"); await password.fill('synthetic-local-password');
    const reopened = page.waitForEvent('popup'); await link.click(); const childPopup = await reopened;
    await childPopup.getByRole('heading', { name: 'Synthetic notice' }).waitFor(); await childPopup.close();
    assert.equal(await password.inputValue(), 'synthetic-local-password');
    assert.equal(noticeRequests.length, 2); assert.equal(noticeRequests[1].referer, undefined);
});
