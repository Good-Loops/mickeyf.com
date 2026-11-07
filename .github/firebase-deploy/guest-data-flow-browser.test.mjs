import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createViteTestServer } from '../../frontend/ts/testSupport/createViteTestServer.mjs';

const { chromium } = createRequire(import.meta.url)('playwright-core');
const root = fileURLToPath(new URL('../../frontend/', import.meta.url));
let server, browser, origin;

before(async () => {
    server = await createViteTestServer({ root, configFile: false,
        resolve: { alias: { '@': `${root}/ts` } }, esbuild: { jsx: 'automatic' },
        define: { 'import.meta.env.VITE_USE_PUBLIC_API': '"0"', 'import.meta.env.VITE_DEV_API_URL': '""',
            'import.meta.env.VITE_ENABLE_CHILD_ONLINE_ACTIVITY': '"0"', 'import.meta.env.VITE_ENABLE_CHILD_INACTIVITY_WARNING': '"0"' },
        plugins: [{ name: 'guest-shell-fixture', enforce: 'pre', load(id) {
            if (id.replaceAll('\\', '/').split('?')[0].endsWith('/games/p4-Vega/p4-Vega.ts')) return `
                export async function p4Vega(container, options) {
                    const canvas = document.createElement('canvas'); container.append(canvas);
                    options.onStateChange('running');
                    return {dispose(){canvas.remove()}, pause(){}, resume(){}, restart(){}, retrySubmission(){}};
                }`;
        } }], logLevel: 'error', server: { host: '127.0.0.1', port: 0 } }, { browser: true });
    await server.listen(); origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ channel: 'chrome', headless: true });
});
after(async () => { await browser?.close(); await server?.close(); });

async function openGuest(t, path, selector) {
    const context = await browser.newContext();
    t.after(() => context.close());
    const firstParty = [], external = [];
    await context.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        // No external provider or live service is contacted by this synthetic test.
        if (url.origin !== origin) { external.push(url.origin); return route.abort(); }
        if (url.pathname.startsWith('/auth/') || url.pathname.startsWith('/api/')) {
            firstParty.push({ method: request.method(), path: url.pathname, body: request.postData() });
            const body = url.pathname === '/auth/renew' || url.pathname === '/auth/verify-token'
                ? { loggedIn: false } : url.pathname === '/auth/providers/config' ? { clients: [] }
                : url.pathname === '/auth/registration/config' ? { enabled: true, audience: 'children-included',
                    creationEnabled: true, parentRegistrationAvailable: false, policyVersion: 'synthetic',
                    countries: [{ country: 'US', parentRequiredBelow: 13, adultFrom: 18 }] }
                : { error: 'UNAVAILABLE' };
            return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
        }
        return route.continue();
    });
    const page = await context.newPage();
    await page.goto(`${origin}${path}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.locator(selector).waitFor();
    await page.waitForLoadState('networkidle');
    return { page, firstParty, external };
}

for (const [path, selector] of [['/', '.home'], ['/login', '#login-username'], ['/games/p4-Vega', '.p4-vega__canvas-wrapper']]) {
    test(`signed-out ${path} shell avoids provider and score requests`, async t => {
        const { firstParty, external } = await openGuest(t, path, selector);
        assert.deepEqual(external, []);
        assert.equal(firstParty.some(request => /\/auth\/providers\/(begin|complete)/.test(request.path)), false);
        assert.equal(firstParty.some(request => request.method !== 'GET' && /leaderboard|score|\/api\/users/.test(request.path)), false);
        for (const request of firstParty.filter(item => item.path === '/auth/renew')) {
            assert.ok(request.body === null || request.body === '{}' || request.body === '', 'Guest renewal contains no account fields');
        }
    });
}
