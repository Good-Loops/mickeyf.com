import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createViteTestServer } from '../../testSupport/createViteTestServer.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const key = '__p4RunLifecycleTest';
const scope = `globalThis.${key}`;
const mocks = {
    'pixi.js/unsafe-eval': 'export {};',
    'pixi.js': `export const { autoDetectRenderer, Container, AnimatedSprite, Spritesheet, Ticker, Assets } = ${scope};`,
    tone: `export const { Context, Player } = ${scope};`,
    canvasPageGestures: 'export const enableCanvasPageGestures = () => {};',
    apiFetch: 'export const apiFetch = () => { throw Error("Unexpected network request"); };',
    ...Object.fromEntries(['P4', 'Water', 'BlackHole', 'Sky', 'PickupFeedback'].map(name => [name, `export const ${name} = ${scope}.${name};`])),
};
const server = await createViteTestServer({
    root, configFile: `${root}/vite.config.ts`, logLevel: 'silent', appType: 'custom',
    server: { middlewareMode: true }, ssr: { noExternal: ['pixi.js', 'tone'] },
    plugins: [{ name: 'p4-run-lifecycle-fixture', enforce: 'pre',
        resolveId(source) {
            const name = Object.hasOwn(mocks, source) ? source : source.split('/').at(-1).replace(/\.ts$/, '');
            if (Object.hasOwn(mocks, name)) return `\0p4-lifecycle:${name}`;
        },
        load(id) { if (id.startsWith('\0p4-lifecycle:')) return mocks[id.slice('\0p4-lifecycle:'.length)]; },
    }],
});
after(() => server.close());

const target = () => ({
    listeners: new Map(), hidden: false,
    addEventListener(type, listener) { this.listeners.set(type, listener); },
    removeEventListener(type) { this.listeners.delete(type); },
    querySelector() { return null; }, querySelectorAll() { return []; },
});
let current;
const graphics = {
    async autoDetectRenderer() { return current.renderer; },
    Container: class { removeChildren() { return []; } destroy() {} },
    AnimatedSprite: class {
        playing = true;
        stop() { this.playing = false; } play() { this.playing = true; } destroy() {}
    },
    Spritesheet: class {
        animations = { p4: [], water: [], bhBlue: [], bhRed: [], bhYellow: [] };
        async parse() {} destroy() {}
    },
    Ticker: class {
        callbacks = [];
        constructor() { current.ticker = this; }
        add(callback) { this.callbacks.push(callback); }
        start() {} stop() {} destroy() { current.tickerDisposed++; }
    },
    Assets: { load: () => current.load() },
    Context: class {
        destination = {}; rawContext = { async suspend() {} };
        async resume() {} dispose() { current.audioDisposed++; }
    },
    Player: class { loaded = true; toDestination() { return this; } start() {} stop() {} dispose() {} },
    P4: class { totalWater = 20; constructor(_stage, sprite) { this.p4Anim = sprite; } update() {} destroy() {} },
    Water: class { constructor(_stage, sprite) { this.waterAnim = sprite; } update() { return false; } destroy() {} },
    BlackHole: {
        bHAnimArray: [], bHArray: [],
        spawn() { this.bHArray.push({ update: () => false }); return true; },
        destroy() { this.bHArray = []; this.bHAnimArray = []; },
    },
    Sky: class { update() {} }, PickupFeedback: class { update() {} show() {} },
};
globalThis[key] = graphics;
after(() => { delete globalThis[key]; });
const { p4Vega } = await server.ssrLoadModule('/ts/games/p4-Vega/p4-Vega.ts');

async function fixture(t) {
    const keyboard = target(), focus = target(), canvas = { ...target(), remove() {} };
    const f = current = {
        load: async () => ({}), states: [], results: [], errors: [],
        rendererDisposed: 0, tickerDisposed: 0, audioDisposed: 0,
        renderer: { view: { canvas }, events: {}, render() {}, destroy() { f.rendererDisposed++; } },
    };
    const originals = new Map();
    for (const [name, value] of Object.entries({ document: { ...keyboard, baseURI: 'https://fixture.invalid/' }, window: focus })) {
        originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
        Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    }
    t.mock.method(console, 'error', () => {});
    t.after(() => {
        f.controller?.dispose();
        for (const [name, original] of originals) {
            if (original) Object.defineProperty(globalThis, name, original);
            else delete globalThis[name];
        }
    });
    f.controller = await p4Vega({ closest: () => keyboard, appendChild() {} }, {
        onStateChange: state => f.states.push(state), onResultChange: result => f.results.push(result),
        onLoadError: error => f.errors.push(error),
    });
    f.finish = () => f.ticker.callbacks[0]({ elapsedMS: 17 });
    return f;
}

test('failed restart reports the load error and disposes the unusable session once', async t => {
    const f = await fixture(t);
    f.finish();
    const error = Error('controlled asset failure');
    f.load = async () => { throw error; };
    await f.controller.restart();
    assert.deepEqual(f.errors, [error]);
    assert.equal(f.results.at(-1), null);
    assert.equal(f.rendererDisposed, 1);
    assert.equal(f.tickerDisposed, 1);
    assert.equal(f.audioDisposed, 1);
    await f.controller.restart();
    f.controller.dispose();
    assert.equal(f.rendererDisposed, 1);
    assert.deepEqual(f.errors, [error]);
});

test('a restart failure after departure cannot publish an error into the next page', async t => {
    const f = await fixture(t);
    f.finish();
    let reject;
    const pending = new Promise((_resolve, fail) => { reject = fail; });
    f.load = () => pending;
    const restarting = f.controller.restart();
    f.controller.dispose();
    reject(Error('late failure'));
    await restarting;
    assert.deepEqual(f.errors, []);
    assert.equal(f.rendererDisposed, 1);
});

test('successful restart starts a fresh run without reporting a failure', async t => {
    const f = await fixture(t);
    f.finish();
    await f.controller.restart();
    assert.equal(f.states.at(-1), 'running');
    assert.equal(f.rendererDisposed, 0);
    assert.deepEqual(f.errors, []);
});
