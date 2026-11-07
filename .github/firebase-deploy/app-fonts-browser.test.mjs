import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createViteTestServer } from '../../frontend/ts/testSupport/createViteTestServer.mjs';

const { chromium } = createRequire(import.meta.url)('playwright-core');
const root = fileURLToPath(new URL('../../frontend/', import.meta.url));
const sources = JSON.parse(await readFile(new URL('../../frontend/public/fonts/sources.json', import.meta.url), 'utf8'));
const faces = [...new Map(sources.faceRules.map(face => [`${face.family}:${face.weight}`, face])).values()]
    .map(({ family, weight }) => ({ family, weight }));
let server, browser, origin;

before(async () => {
    server = await createViteTestServer({ root, configFile: false,
        resolve: { alias: { '@': `${root}/ts` } }, esbuild: { jsx: 'automatic' },
        define: { 'import.meta.env.VITE_USE_PUBLIC_API': '"0"', 'import.meta.env.VITE_DEV_API_URL': '""' },
        logLevel: 'error', server: { host: '127.0.0.1', port: 0 } }, { browser: true });
    await server.listen();
    origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ channel: 'chrome', headless: true });
});

after(async () => { await browser?.close(); await server?.close(); });

for (const pathname of ['/', '/login', '/signup']) {
    test(`fresh guest ${pathname} loads app fonts locally without a Google Fonts request`, async t => {
        const context = await browser.newContext();
        t.after(() => context.close());
        const page = await context.newPage();
        page.setDefaultTimeout(10_000);
        page.setDefaultNavigationTimeout(30_000);
        const requests = [], responses = [];
        page.on('request', request => requests.push(request.url()));
        page.on('response', response => responses.push({ url: response.url(), status: response.status() }));
        // Fresh anonymous state and synthetic API only; never contact accounts or providers.
        await context.route('**/*', route => {
            const url = new URL(route.request().url());
            if (url.origin !== origin) return route.abort();
            if (url.pathname.startsWith('/auth/') || url.pathname.startsWith('/api/')) {
                return route.fulfill({ contentType: 'application/json',
                    status: url.pathname.endsWith('/verify-token') ? 200 : 503,
                    body: JSON.stringify(url.pathname.endsWith('/verify-token') ? { loggedIn: false } : { error: 'UNAVAILABLE' }) });
            }
            return route.continue();
        });
        await page.goto(`${origin}${pathname}`);
        await page.locator('main').waitFor();
        await page.waitForFunction(() => [...document.styleSheets].some(sheet => sheet.href?.endsWith('/fonts/app-fonts.css')));
        const loaded = await page.evaluate(async requiredFaces => {
            const result = [];
            for (const { family, weight } of requiredFaces) {
                const loadedFaces = await document.fonts.load(`${weight} 24px "${family}"`, 'Welcome! Ação Çãõ áéíóú');
                result.push({ family, weight, count: loadedFaces.length,
                    statuses: loadedFaces.map(face => face.status), weights: loadedFaces.map(face => face.weight),
                    families: loadedFaces.map(face => face.family.replaceAll('"', '')) });
            }
            await document.fonts.ready;
            return result;
        }, faces);
        assert.equal(loaded.length, faces.length);
        for (const face of loaded) {
            assert.ok(face.count > 0, `${face.family} ${face.weight} must use a loaded FontFace, not a fallback`);
            assert.ok(face.statuses.every(status => status === 'loaded'));
            assert.ok(face.weights.every(weight => weight === String(face.weight)));
            assert.ok(face.families.every(family => family === face.family));
        }
        assert.equal(await page.locator('#app-fonts').getAttribute('href'), '/fonts/app-fonts.css');
        assert.deepEqual(requests.filter(url => /https?:\/\/fonts\.(?:googleapis|gstatic)\.com\//u.test(url)), []);
        const fontResponses = responses.filter(response => new URL(response.url).pathname.endsWith('.woff2'));
        assert.ok(fontResponses.length >= 5);
        assert.ok(fontResponses.every(response => response.status === 200
            && new URL(response.url).origin === origin && new URL(response.url).pathname.startsWith('/fonts/')));
    });
}
