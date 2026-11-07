import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createViteTestServer } from '../../testSupport/createViteTestServer.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const server = await createViteTestServer({
    root, configFile: `${root}/vite.config.ts`, logLevel: 'silent',
    appType: 'custom', server: { middlewareMode: true },
    ssr: { noExternal: [/^pixi\.js/] },
    plugins: [{
        name: 'fractal-host-app-fixture', enforce: 'pre',
        resolveId(source) {
            if (source === 'pixi.js' || source === 'pixi.js/unsafe-eval') return `\0host-test:${source}`;
        },
        load(id) {
            if (id === '\0host-test:pixi.js/unsafe-eval') return 'export {};';
            if (id === '\0host-test:pixi.js') return `
                export class Application { constructor() { return globalThis.__fractalHostTestApp; } }
                export class Ticker {}`;
        },
    }],
});
after(() => server.close());
const { createFractalHost } = await server.ssrLoadModule('/ts/animations/dancing fractals/createFractalHost.ts');

async function fixture(t) {
    const ticks = new Set();
    const app = {
        async init() {}, destroy() {},
        screen: { width: 800, height: 450 },
        renderer: { events: {}, background: {} },
        canvas: { classList: { add() {} }, style: {}, setAttribute() {}, remove() {} },
        ticker: { add: tick => ticks.add(tick), remove: tick => ticks.delete(tick) },
    };
    for (const [key, value] of Object.entries({
        window: { location: { pathname: '/animations/dancing-fractals' } },
        __fractalHostTestApp: app, __PIXI_APP__: undefined,
    })) {
        const original = Object.getOwnPropertyDescriptor(globalThis, key);
        Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
        t.after(() => {
            if (original) Object.defineProperty(globalThis, key, original);
            else delete globalThis[key];
        });
    }
    const instances = [];
    // A controllable animation timer exercises the real host, without a GPU.
    class Fractal {
        static backgroundColor = '#000';
        remaining = null;
        fading = false;
        disposed = false;
        constructor() { instances.push(this); }
        init() {}
        updateConfig() {}
        scheduleDisposal(seconds) { this.remaining = seconds; this.fading = false; }
        cancelScheduledDisposal() { this.remaining = null; }
        step(seconds) {
            if (this.remaining === null) return;
            this.remaining -= seconds;
            if (this.remaining <= 0) { this.remaining = null; this.fading = true; }
        }
        dispose() { this.disposed = true; }
    }
    const host = await createFractalHost({ append() {} });
    t.after(() => host.dispose());
    let nowMs = 0;
    const tick = seconds => {
        nowMs += seconds * 1000;
        for (const callback of ticks) callback({ deltaMS: seconds * 1000, lastTime: nowMs });
    };
    return { host, Fractal, instances, tick };
}

test('disabling auto-dispose cancels the active animation timer, not just its displayed countdown', async t => {
    const { host, Fractal, instances, tick } = await fixture(t);
    host.setFractal(Fractal, {});
    host.setLifetime(3);
    tick(1);
    assert.equal(host.getStats().remainingLifetime, 2);
    host.setLifetime(null);
    host.setLifetime(null);
    tick(10);
    assert.equal(host.getStats().remainingLifetime, null);
    assert.equal(instances[0].fading, false);
    assert.equal(instances[0].disposed, false);
});

test('re-enabling auto-dispose starts a fresh full countdown and still triggers the fade', async t => {
    const { host, Fractal, instances, tick } = await fixture(t);
    host.setFractal(Fractal, {});
    host.setLifetime(3);
    tick(2);
    host.setLifetime(null);
    host.setLifetime(4);
    tick(3);
    assert.equal(host.getStats().remainingLifetime, 1);
    assert.equal(instances[0].fading, false);
    tick(1);
    assert.equal(host.getStats().remainingLifetime, 0);
    assert.equal(instances[0].fading, true);
    host.setLifetime(null);
    assert.equal(instances[0].fading, true, 'cancellation does not reverse a fade already started');
});

test('lifetime configured before mounting is reapplied on restart and stays disabled after a swap', async t => {
    const { host, Fractal, instances, tick } = await fixture(t);
    host.setLifetime(3);
    assert.equal(host.getStats().remainingLifetime, 3);
    host.setFractal(Fractal, {});
    tick(2);
    host.restart();
    assert.equal(instances[0].disposed, true);
    assert.equal(instances[1].remaining, 3);
    assert.equal(host.getStats().remainingLifetime, 3);
    host.setLifetime(null);
    host.setFractal(Fractal, {});
    tick(10);
    assert.equal(instances[1].disposed, true);
    assert.equal(instances[2].fading, false);
    assert.equal(host.getStats().remainingLifetime, null);
});
