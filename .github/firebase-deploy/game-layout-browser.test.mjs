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
        define: { 'import.meta.env.VITE_ENABLE_THREE_BOSSES_LOCAL': '"1"',
            'import.meta.env.VITE_USE_PUBLIC_API': '"0"', 'import.meta.env.VITE_DEV_API_URL': '""' },
        plugins: [{ name: 'game-layout-renderer-fixtures', enforce: 'pre', load(id) {
            const file = id.replaceAll('\\', '/').split('?')[0];
            // Exercise actual routes, controls, shell and styles without starting a GPU engine.
            if (file.endsWith('/games/p4-Vega/p4-Vega.ts')) return `export async function p4Vega(container, options) {
                const canvas = document.createElement('canvas'); canvas.className = 'p4-vega__canvas';
                canvas.width = 960; canvas.height = 540; container.append(canvas);
                options.onStateChange('running'); return { dispose(){canvas.remove()},
                    pause(){options.onStateChange('paused')}, resume(){options.onStateChange('running')},
                    restart(){}, retrySubmission(){} };
            }`;
            if (file.endsWith('/games/three-bosses/unityWebGl.ts')) return `import {bindUnityPageScroll} from './unityPageScroll';
                export async function startThreeBossesWebGl(options) {
                    const release = bindUnityPageScroll(options.canvas);
                    options.onCanvasOwned?.(); options.onProgress(1);
                    return {async quit(){release()},setSubmissionEnabled(){}};
                }`;
        } }], logLevel: 'error', server: { host: '127.0.0.1', port: 0 } }, { browser: true });
    await server.listen(); origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ channel: 'chrome', headless: true });
});
after(async () => { await browser?.close(); await server?.close(); });

async function fixture(t, width, height, native = true) {
    // Native CSS does not use Safari's browser-only background extension controller.
    // Keep Chromium's actual UA instead of accidentally enabling that unrelated web path.
    const context = await browser.newContext({ viewport: { width, height }, hasTouch: native,
        isMobile: native, reducedMotion: 'reduce' });
    t.after(() => context.close());
    if (native) await context.addInitScript(() => {
        const markNative = () => {
            if (!document.documentElement) return false;
            document.documentElement.dataset.nativeApp = 'ios';
            return true;
        };
        // main.tsx applies this before React mounts; autofocus must see the native shell.
        if (!markNative()) {
            const observer = new MutationObserver(() => { if (markNative()) observer.disconnect(); });
            observer.observe(document, { childList: true });
        }
        document.addEventListener('DOMContentLoaded', markNative, { once: true });
    });
    await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) return route.abort();
        if (url.pathname.startsWith('/auth/') || url.pathname.startsWith('/api/')) {
            const body = /renew|verify-token/.test(url.pathname) ? { loggedIn: false }
                : /leaderboard/.test(url.pathname) ? { games: [] } : { clients: [] };
            return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
        }
        return route.continue();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000); page.setDefaultNavigationTimeout(30_000);
    return page;
}

async function open(page, game, native = true) {
    await page.goto(`${origin}/games/${game}?three-bosses-mobile-preview=1`);
    await page.locator('.score-submission-notice').waitFor();
    // The font stylesheet is added asynchronously; fonts.ready alone can resolve before it arrives.
    await page.waitForFunction(() => [...document.styleSheets].some(sheet => sheet.href?.endsWith('/fonts/app-fonts.css')));
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.locator('html').getAttribute('data-native-app'), native ? 'ios' : null);
}

async function geometry(page, prefix) {
    return page.evaluate(prefix => {
        const bounds = selector => {
            const node = document.querySelector(selector);
            if (!node) return null;
            const rect = node.getBoundingClientRect();
            return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, bottom: rect.bottom };
        };
        const main = document.querySelector('.main');
        return { page: bounds(`.${prefix}`), canvas: bounds(`.${prefix}__canvas-wrapper`),
            notice: bounds('.score-submission-notice'), controls: bounds(`.${prefix}__ui`),
            preference: bounds(`.${prefix}__joystick-preference`), main: bounds('.main'),
            outerOverflow: document.documentElement.scrollWidth - innerWidth,
            mainOverflow: main.scrollWidth - main.clientWidth };
    }, prefix);
}

for (const [width, height] of [[393, 852], [852, 393], [390, 844], [390, 667], [844, 390], [667, 375], [1024, 768]]) {
    for (const game of ['p4-Vega', 'three-bosses']) {
        test(`${game} ${width}x${height} keeps the native composition compact and touch scroll contained`, async t => {
            const page = await fixture(t, width, height);
            await open(page, game);
            const prefix = game === 'p4-Vega' ? 'p4-vega' : game;
            await page.locator(`.${prefix}__canvas-wrapper`).waitFor();
            const data = await geometry(page, prefix);
            assert.ok(data.outerOverflow <= 1 && data.mainOverflow <= 1, JSON.stringify(data));
            const centered = game === 'p4-Vega' && width > height ? data.page : data.canvas;
            assert.ok(Math.abs(centered.x + centered.width / 2 - width / 2) < 2, 'Composition is centered');
            if (game === 'p4-Vega') {
                assert.ok(data.canvas.y - data.notice.bottom <= (width < height ? 7 : 14), `Notice stays near the scene: ${JSON.stringify(data)}`);
                if (width < height) assert.ok(data.controls.y - data.canvas.bottom <= 7, 'Portrait controls stay near the scene');
                assert.ok(Math.abs(data.preference.x + data.preference.width / 2 - width / 2) < 2, 'Joystick preference is centered');
                assert.ok(data.notice.y >= data.main.y - 1 && data.preference.bottom <= data.main.bottom + 1,
                    'The complete native group stays inside the finite main region');
            } else {
                assert.equal(await page.locator('.three-bosses__controls').isVisible(), false);
                if (width > height) assert.ok(data.canvas.height <= Math.max(120, height - 170) + 12, 'Embedded landscape leaves room for the page');
                const exitCorner = await page.evaluate(() => {
                    const canvas = document.querySelector('.three-bosses__canvas').getBoundingClientRect();
                    const button = document.querySelector('.three-bosses__fullscreen-btn').getBoundingClientRect();
                    const scale = canvas.width / 1280;
                    return { left: (canvas.right - button.left) / scale, top: (canvas.bottom - button.top) / scale };
                });
                assert.ok(exitCorner.left <= 160 && exitCorner.top <= 160,
                    `HTML fullscreen toggle fits Unity's reserved corner: ${JSON.stringify(exitCorner)}`);
                const scroll = await page.evaluate(() => {
                    const section = document.querySelector('.three-bosses');
                    const main = document.querySelector('.main');
                    const wrapper = document.querySelector('.three-bosses__canvas-wrapper');
                    const extra = document.createElement('div'); extra.style.height = '800px'; section.append(extra);
                    main.scrollTop = 0;
                    window.MickeyfThreeBossesScrollPage(.25);
                    const moved = main.scrollTop;
                    wrapper.dataset.canvasFullscreen = 'fallback';
                    window.MickeyfThreeBossesScrollPage(.25);
                    const fullscreen = main.scrollTop;
                    delete wrapper.dataset.canvasFullscreen; extra.remove(); main.scrollTop = 0;
                    return { moved, fullscreen, documentScroll: document.documentElement.scrollTop };
                });
                assert.ok(scroll.moved > 0, 'Unity drag scrolls the actual native main region');
                assert.equal(scroll.fullscreen, scroll.moved, 'Fullscreen keeps the scroll chain stationary');
                assert.equal(scroll.documentScroll, 0, 'The native document remains locked');
            }
        });
    }
}

test('a wide mouse-and-keyboard browser retains the ThreeBosses keyboard guide', async t => {
    const page = await fixture(t, 1440, 900, false);
    await open(page, 'three-bosses', false);
    assert.equal(await page.locator('.three-bosses__controls').isVisible(), true);
});
