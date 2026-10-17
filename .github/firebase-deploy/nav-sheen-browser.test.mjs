import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createViteTestServer } from '../../frontend/ts/testSupport/createViteTestServer.mjs';

const { chromium } = createRequire(import.meta.url)('playwright-core');
const root = fileURLToPath(new URL('../../frontend/', import.meta.url));
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

async function fixture(t, reducedMotion = 'no-preference', width = 1440) {
    const context = await browser.newContext({ reducedMotion, viewport: { width, height: 900 } });
    t.after(() => context.close());
    await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) return route.abort();
        if (url.pathname.startsWith('/auth/')) return route.fulfill({ contentType: 'application/json',
            body: JSON.stringify(url.pathname === '/auth/providers/config' ? { clients: [] } : { loggedIn: false }) });
        return route.continue();
    });
    const page = await context.newPage();
    await page.goto(`${origin}/login`);
    await page.locator('.nav__list').waitFor();
    return page;
}

async function positionSheens(page, milliseconds) {
    return page.evaluate(time => {
        const navigation = document.querySelector('.nav__list');
        const animations = document.getAnimations().filter(animation => animation.animationName === 'nav-sheen-orbit');
        animations.forEach(animation => { animation.pause(); animation.currentTime = time; });
        const styles = ['::before', '::after'].map(pseudo => {
            const style = getComputedStyle(navigation, pseudo);
            return { angle: parseFloat(style.getPropertyValue('--nav-sheen-angle')), background: style.backgroundImage,
                inset: [style.top, style.right, style.bottom, style.left], pointerEvents: style.pointerEvents,
                maskComposite: style.maskComposite, duration: style.animationDuration, timing: style.animationTimingFunction };
        });
        const bounds = navigation.getBoundingClientRect();
        return { animations: animations.length, styles, bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } };
    }, milliseconds);
}

async function capture(page, name) {
    const directory = process.env.LUDOLUME_NAV_SCREENSHOT_DIR;
    if (!directory) return;
    await mkdir(directory, { recursive: true });
    await page.locator('.nav__list').screenshot({ path: path.join(directory, `nav-sheen-${name}.png`) });
}

test('opposing border sheens complete a continuous full orbit without moving or covering navigation', async t => {
    const page = await fixture(t);
    const start = await positionSheens(page, 0);
    assert.equal(start.animations, 2);
    assert.deepEqual(start.styles.map(style => style.angle), [0, 180]);
    await capture(page, '0');
    for (const style of start.styles) {
        assert.deepEqual(style.inset, ['0px', '0px', '0px', '0px']);
        assert.equal(style.pointerEvents, 'none');
        assert.equal(style.maskComposite, 'exclude, exclude');
        assert.equal(style.duration, '9s');
        assert.equal(style.timing, 'linear');
    }
    for (const [time, angle] of [[2250, 90], [4500, 180], [6750, 270], [9000, 0]]) {
        const current = await positionSheens(page, time);
        assert.equal(current.styles[0].angle, angle);
        assert.equal(current.styles[1].angle, (angle + 180) % 360);
        assert.deepEqual(current.bounds, start.bounds);
        if (time < 9000) await capture(page, String(angle));
    }
    const beforeWrap = await positionSheens(page, 8999);
    const afterWrap = await positionSheens(page, 9001);
    assert.ok((afterWrap.styles[0].angle - beforeWrap.styles[0].angle + 360) % 360 < .1);
    const home = page.getByRole('link', { name: 'Home', exact: true });
    assert.equal(await home.evaluate(link => {
        const rect = link.getBoundingClientRect();
        return link.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
    }), true);
});

test('border masks leave dropdowns visible and the inset selection slider usable at mobile width', async t => {
    const page = await fixture(t, 'no-preference', 390);
    await page.getByRole('button', { name: 'Entertainment', exact: true }).click();
    const animations = page.getByRole('link', { name: 'Animations', exact: true });
    await animations.waitFor();
    assert.equal(await animations.evaluate(link => {
        const rect = link.getBoundingClientRect();
        return link.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
    }), true);
    const before = await page.locator('.nav__indicator').boundingBox();
    await page.getByRole('link', { name: 'Home', exact: true }).hover();
    await page.waitForFunction(() => {
        const track = document.querySelector('.nav__indicator-track').getBoundingClientRect();
        const slider = document.querySelector('.nav__indicator').getBoundingClientRect();
        return slider.x >= track.x && slider.y >= track.y && slider.right <= track.right + .1 && slider.bottom <= track.bottom + .1;
    });
    assert.ok(before.width > 0 && before.height > 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
});

test('reduced motion keeps the border traces static and disables slider motion', async t => {
    const page = await fixture(t, 'reduce');
    const current = await positionSheens(page, 2250);
    assert.equal(current.animations, 0);
    assert.deepEqual(current.styles.map(style => style.angle), [0, 180]);
    await capture(page, 'reduced-motion');
    assert.equal(await page.locator('.nav__indicator').evaluate(slider => getComputedStyle(slider).transitionDuration), '0s');
});
