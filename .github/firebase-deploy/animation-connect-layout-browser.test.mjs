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
        define: { 'import.meta.env.VITE_USE_PUBLIC_API': '"0"', 'import.meta.env.VITE_DEV_API_URL': '""' },
        plugins: [{ name: 'animation-layout-canvas-fixture', enforce: 'pre',
            resolveId(source) {
                const name = source.replaceAll('\\', '/').split('/').at(-1).replace(/\.ts$/, '');
                if (['runDancingCircles', 'createFractalHost'].includes(name)) return `\0animation-layout:${name}`;
            },
            load(id) {
                if (!id.startsWith('\0animation-layout:')) return;
                // Real page/components/styles; renderer initialization is replaced
                // only with the same intrinsic canvas geometry, without a GPU.
                const canvas = `const canvas = document.createElement('canvas');
                    canvas.width = 1920; canvas.height = 1080; canvas.className = name;
                    container.append(canvas); return () => canvas.remove();`;
                if (id.endsWith('runDancingCircles')) return `export const DEFAULT_DANCING_CIRCLES_CUSTOM_COLOR = '#46515b';
                    export async function runDancingCircles({container}) { const name = 'dancing-circles__canvas'; ${canvas} }`;
                return `export async function createFractalHost(container) { const name = 'dancing-fractals__canvas';
                    const dispose = (() => { ${canvas} })();
                    return {dispose,setFractal(){},updateConfig(){},setLifetime(){},restart(){},getStats(){return {fps:0,remainingLifetime:null}}}; }`;
            },
        }], logLevel: 'error', server: { host: '127.0.0.1', port: 0 } }, { browser: true });
    await server.listen(); origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ channel: 'chrome', headless: true });
});
after(async () => { await browser?.close(); await server?.close(); });

async function fixture(t, width, height, native = true) {
    const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce' });
    t.after(() => context.close());
    if (native) await context.addInitScript(() => {
        document.addEventListener('DOMContentLoaded', () => { document.documentElement.dataset.nativeApp = 'ios'; }, { once: true });
    });
    const page = await context.newPage();
    page.nativeLayoutFixture = native;
    page.setDefaultTimeout(10_000); page.setDefaultNavigationTimeout(30_000);
    await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) return route.abort();
        if (url.pathname.startsWith('/auth/') || url.pathname.startsWith('/api/')) {
            return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ loggedIn: false, clients: [] }) });
        }
        return route.continue();
    });
    return page;
}

async function open(page, route, selector) {
    await page.goto(`${origin}${route}`);
    await page.locator(selector).waitFor();
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.locator('html').getAttribute('data-native-app'), page.nativeLayoutFixture ? 'ios' : null);
}
const bounds = locator => locator.boundingBox();
function contained(inner, outer, label) {
    assert.ok(inner && outer && inner.width > 0 && inner.height > 0, `${label} has size`);
    assert.ok(inner.x >= outer.x - 1 && inner.y >= outer.y - 1
        && inner.x + inner.width <= outer.x + outer.width + 1
        && inner.y + inner.height <= outer.y + outer.height + 1,
    `${label} fits: ${JSON.stringify({ inner, outer })}`);
}
async function noHorizontalOverflow(page) {
    const overflow = await page.evaluate(() => ({ page: document.documentElement.scrollWidth - innerWidth,
        main: document.querySelector('.main').scrollWidth - document.querySelector('.main').clientWidth }));
    assert.ok(overflow.page <= 1 && overflow.main <= 1, JSON.stringify(overflow));
}

test('Circles portrait uses available width and provides 44px music and background targets', async t => {
    const page = await fixture(t, 393, 852);
    await open(page, '/animations/dancing-circles', '.dancing-circles__canvas');
    const canvas = await bounds(page.locator('.dancing-circles__canvas'));
    assert.ok(canvas.width >= 340, `Canvas width ${canvas.width}`);
    assert.ok(Math.abs(canvas.width / canvas.height - 16 / 9) < .01);
    for (const selector of ['.music-controls__btn', '.dancing-circles__background-mode', '.dancing-circles__upload-btn']) {
        for (const target of await page.locator(selector).all()) assert.ok((await bounds(target)).height >= 43.9, selector);
    }
    contained(await bounds(page.locator('.dancing-circles__transport')), await bounds(page.locator('.main')), 'Portrait transport');
    await noHorizontalOverflow(page);
});

for (const [width, height] of [[852, 393], [667, 375]]) {
    for (const native of [true, false]) {
        test(`Circles ${width}x${height} ${native ? 'native' : 'web'} keeps stage and controls in the available main area`, async t => {
            const page = await fixture(t, width, height, native);
            await open(page, '/animations/dancing-circles', '.dancing-circles__canvas');
            const main = await bounds(page.locator('.main'));
            const canvas = await bounds(page.locator('.dancing-circles__canvas'));
            const transport = await bounds(page.locator('.dancing-circles__transport'));
            contained(canvas, main, 'Landscape canvas'); contained(transport, main, 'Landscape transport');
            assert.ok(canvas.x + canvas.width <= transport.x + 1, 'Canvas and transport use separate columns');
            assert.ok(Math.abs(canvas.width / canvas.height - 16 / 9) < .01);
            assert.ok(await page.locator('.main').evaluate(node => node.scrollHeight <= node.clientHeight + 1));
            await noHorizontalOverflow(page);
        });
    }
}

test('Fractals portrait retains stage above its complete settings panel', async t => {
    const page = await fixture(t, 393, 852);
    await open(page, '/animations/dancing-fractals', '.dancing-fractals__canvas');
    const canvas = await bounds(page.locator('.dancing-fractals__canvas'));
    const panel = await bounds(page.locator('.dancing-fractals__ui'));
    assert.ok(canvas.y + canvas.height < panel.y);
    assert.ok(canvas.width >= 280 && canvas.width <= 310, 'Existing portrait stage width is preserved');
    await noHorizontalOverflow(page);
});

for (const [width, height] of [[852, 393], [667, 375]]) {
    test(`Fractals ${width}x${height} separates stage/settings and removes the nested sidebar scrollbar`, async t => {
        const page = await fixture(t, width, height);
        await open(page, '/animations/dancing-fractals', '.dancing-fractals__canvas');
        const canvas = await bounds(page.locator('.dancing-fractals__canvas'));
        const panel = await bounds(page.locator('.dancing-fractals__ui'));
        assert.ok(canvas.x + canvas.width < panel.x, 'Canvas does not overlap settings');
        assert.ok(Math.abs(canvas.width / canvas.height - 16 / 9) < .01);
        assert.equal(await page.locator('.dancing-fractals__ui').evaluate(node => getComputedStyle(node).overflowY), 'visible');
        contained(canvas, await bounds(page.locator('.main')), 'Landscape fractal canvas');
        contained(await bounds(page.locator('.dancing-fractals__transport')), await bounds(page.locator('.main')), 'Landscape fractal transport');
        await page.locator('.dancing-fractals__ui--dropdown .dropdown__button').click();
        await page.getByRole('button', { name: 'Flower Spiral', exact: true }).click();
        await page.waitForFunction(() => getComputedStyle(document.querySelector('.dancing-fractals__ui .dropdown__menu')).opacity === '0');
        assert.equal(await page.locator('.dancing-fractals__ui--controls__group').count(), 5);
        contained(await bounds(page.locator('.dancing-fractals__ui')), await bounds(page.locator('.main')), 'Complete landscape fractal settings');
        assert.ok(await page.locator('.main').evaluate(node => node.scrollHeight <= node.clientHeight + 1));
        await page.locator('.dancing-fractals__ui--controls__group').last().scrollIntoViewIfNeeded();
        contained(await bounds(page.locator('.dancing-fractals__ui--controls__group').last()), await bounds(page.locator('.main')), 'Final fractal setting remains reachable');
        await noHorizontalOverflow(page);
    });
}

test('Connect portrait preserves stacked profiles and feedback', async t => {
    const page = await fixture(t, 393, 852);
    await open(page, '/connect', '.connect__feedback');
    const grid = await bounds(page.locator('.connect__grid'));
    const feedback = await bounds(page.locator('.connect__feedback'));
    assert.ok(grid.y + grid.height < feedback.y);
    assert.ok((await bounds(page.locator('.connect__link').first())).height >= 150);
    await noHorizontalOverflow(page);
});

for (const [route, prefix] of [['/animations/dancing-circles', 'dancing-circles'], ['/animations/dancing-fractals', 'dancing-fractals']]) {
    test(`${prefix} landscape fallback fullscreen still fills the viewport and exits back into its fitted page`, async t => {
        const page = await fixture(t, 852, 393);
        await open(page, route, `.${prefix}__canvas`);
        const wrapper = page.locator(`.${prefix}__canvas-wrapper`);
        await wrapper.evaluate(node => { node.requestFullscreen = undefined; node.webkitRequestFullscreen = undefined; });
        await page.locator(`.${prefix}__fullscreen-btn`).click();
        await page.locator(`.${prefix}__canvas-wrapper[data-canvas-fullscreen="fallback"]`).waitFor();
        const frame = await bounds(wrapper);
        assert.ok(Math.abs(frame.x) <= 1 && Math.abs(frame.y) <= 1 && Math.abs(frame.width - 852) <= 1 && Math.abs(frame.height - 393) <= 1,
            `Fallback remains viewport anchored: ${JSON.stringify(frame)}`);
        contained(await bounds(page.locator(`.${prefix}__fullscreen-btn`)), frame, 'Fullscreen exit control');
        await page.locator(`.${prefix}__fullscreen-btn`).click();
        await page.waitForFunction(selector => !document.querySelector(selector).hasAttribute('data-canvas-fullscreen'), `.${prefix}__canvas-wrapper`);
        contained(await bounds(page.locator(`.${prefix}__transport`)), await bounds(page.locator('.main')), 'Transport after fullscreen exit');
    });
}

for (const [width, height] of [[852, 393], [667, 375]]) {
    test(`Connect ${width}x${height} keeps all profile links and the email form together without clipping`, async t => {
        const page = await fixture(t, width, height);
        await open(page, '/connect', '.connect__feedback');
        const main = await bounds(page.locator('.main'));
        const grid = await bounds(page.locator('.connect__grid'));
        const feedback = await bounds(page.locator('.connect__feedback'));
        contained(grid, main, 'Profile grid'); contained(feedback, main, 'Feedback form');
        assert.ok(grid.x + grid.width < feedback.x, 'Profiles and feedback use separate columns');
        assert.ok(await page.locator('.main').evaluate(node => node.scrollHeight <= node.clientHeight + 1));
        await noHorizontalOverflow(page);
    });
}
