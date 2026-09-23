import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createViteTestServer } from '../../testSupport/createViteTestServer.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const key = '__fractalSettingsTest';
const scope = `globalThis.${key}`;
const mocks = {
    react: `export const useState = initial => ${scope}.state(initial);
        export const useRef = initial => ${scope}.ref(initial);
        export const useMemo = factory => ${scope}.memo(factory);
        export const useEffect = (callback, deps) => ${scope}.effect(callback, deps);
        export default {};`,
    'jsx-runtime': 'export const jsx = (type, props) => ({type, props}); export const jsxs = jsx;',
    'jsx-dev-runtime': 'export const jsxDEV = (type, props) => ({type, props});',
    createFractalHost: `export const createFractalHost = () => ${scope}.create();`,
    AudioEngine: 'export const audioEngine = { dispose() {}, play() {}, pause() {}, stop() {} };',
    useAudioEngineState: 'export const useAudioEngineState = () => ({ playing: false });',
    ...Object.fromEntries(['Tree', 'FlowerSpiral', 'Mandelbrot'].map(name => [name, `export class ${name} {}`])),
    ...Object.fromEntries(['TreeControls', 'FlowerSpiralControls', 'MandelbrotControls',
        'Dropdown', 'FullscreenButton', 'MusicControls', 'MusicUpload'].map(name => [name, `export default '${name}';`])),
};
const server = await createViteTestServer({
    root, configFile: `${root}/vite.config.ts`, logLevel: 'silent',
    appType: 'custom', server: { middlewareMode: true }, ssr: { noExternal: [/^react$/] },
    plugins: [{ name: 'fractal-settings-fixture', enforce: 'pre',
        resolveId(source) {
            const name = source.replaceAll('\\', '/').split('/').at(-1).replace(/\.tsx?$/, '');
            if (Object.hasOwn(mocks, name)) return `\0fractal-settings:${name}`;
        },
        load(id) { if (id.startsWith('\0fractal-settings:')) return mocks[id.slice('\0fractal-settings:'.length)]; },
    }],
});
after(() => server.close());
const { default: Page } = await server.ssrLoadModule('/ts/pages/animations/DancingFractals.tsx');
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture(t) {
    const slots = [], pending = [], starts = [], failures = [];
    let cursor = 0, view, stateUpdates = 0;
    const hooks = {
        state(initial) {
            const index = cursor++;
            slots[index] ??= { value: typeof initial === 'function' ? initial() : initial };
            return [slots[index].value, next => {
                stateUpdates++;
                const previous = slots[index].value;
                if (typeof next === 'function') next(previous); // Deliberate updater replay.
                slots[index].value = typeof next === 'function' ? next(previous) : next;
            }];
        },
        ref(initial) { return slots[cursor++] ??= { current: initial }; },
        memo(factory) { cursor++; return factory(); },
        effect(callback, deps) {
            const index = cursor++;
            const old = slots[index];
            if (!old || deps.some((value, i) => !Object.is(value, old.deps[i]))) {
                const slot = slots[index] = { deps, cleanup: old?.cleanup };
                pending.push(() => { slot.cleanup?.(); slot.cleanup = callback(); });
            }
        },
        create: () => new Promise((resolve, reject) => { starts.push(resolve); failures.push(reject); }),
    };
    const unmount = () => slots.forEach(slot => slot?.cleanup?.());
    const originals = new Map();
    for (const [name, value] of Object.entries({ [key]: hooks, requestAnimationFrame: () => 1, cancelAnimationFrame() {} })) {
        originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
        Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    }
    t.after(() => {
        unmount();
        for (const [name, original] of originals) {
            if (original) Object.defineProperty(globalThis, name, original);
            else delete globalThis[name];
        }
    });
    function nodes(node) {
        if (!node || typeof node !== 'object') return [];
        return [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)];
    }
    const find = predicate => nodes(view).find(predicate)?.props;
    const render = () => {
        cursor = 0; view = Page();
        const container = find(node => node.props?.className === 'dancing-fractals__canvas-wrapper');
        container.ref.current = {};
        pending.splice(0).forEach(run => run());
    };
    const host = { selections: [], patches: [], lifetimes: [], disposed: 0,
        setFractal(ctor, config) { this.selections.push({ kind: ctor.name, config }); },
        updateConfig(patch) { this.patches.push(patch); },
        setLifetime(seconds) { this.lifetimes.push(seconds); },
        dispose() { this.disposed++; }, restart() {}, getStats() { return { fps: 0, remainingLifetime: null }; },
    };
    render();
    return { host, starts, failures, render, unmount, find, stateUpdates: () => stateUpdates,
        component: type => find(node => node.type === type),
        button: text => find(node => node.type === 'button' && node.props.children === text),
        ready: async () => { starts[0](host); await flush(); render(); },
    };
}

test('a host finishing startup uses the latest selected fractal, config and lifetime', async t => {
    const f = fixture(t);
    f.component('Dropdown').onChange('flower'); f.render();
    f.component('FlowerSpiralControls').onChange({ flowerAmount: 17 }); f.render();
    f.find(n => n.type === 'input' && n.props.type === 'checkbox').onChange({ target: { checked: true } });
    f.find(n => n.type === 'input' && n.props.type === 'range').onChange({ target: { value: '45' } });
    f.render(); await f.ready();
    assert.equal(f.host.selections.length, 1);
    assert.equal(f.host.selections[0].kind, 'FlowerSpiral');
    assert.equal(f.host.selections[0].config.flowerAmount, 17);
    assert.equal(f.host.lifetimes.at(-1), 45);
});

test('Reset defaults works while host startup is pending', async t => {
    const f = fixture(t);
    const original = f.component('TreeControls').config;
    f.component('TreeControls').onChange({ branchScale: 1.75 }); f.render();
    f.button('Reset defaults').onClick(); f.render();
    assert.deepEqual(f.component('TreeControls').config, original);
    await f.ready();
    assert.deepEqual(f.host.selections[0].config, original);
});

for (const [kind, controls, patch] of [
    ['tree', 'TreeControls', { branchScale: 1.75 }],
    ['flower', 'FlowerSpiralControls', { flowerAmount: 17 }],
    ['mandelbrot', 'MandelbrotControls', { tourRotationSpeedRadPerSec: 0.5 }],
]) {
    test(`${kind}: patch updates the host once and Reset defaults updates both UI and host`, async t => {
        const f = fixture(t); await f.ready();
        f.component('Dropdown').onChange(kind); f.render();
        const defaults = f.component(controls).config;
        f.component(controls).onChange(patch); f.render();
        assert.deepEqual(f.host.patches, [patch], 'React updater replay must not repeat renderer effects');
        assert.deepEqual(f.component(controls).config, { ...defaults, ...patch });
        const beforeReset = f.host.selections.length;
        f.button('Reset defaults').onClick(); f.render();
        assert.equal(f.host.selections.length, beforeReset + 1);
        assert.deepEqual(f.component(controls).config, defaults);
        assert.deepEqual(f.host.selections.at(-1).config, defaults);
    });
}

test('a host finishing startup after unmount is disposed without initializing a fractal', async t => {
    const f = fixture(t);
    f.unmount();
    f.starts[0](f.host); await flush();
    assert.equal(f.host.disposed, 1);
    assert.equal(f.host.selections.length, 0);
});

test('host startup failure reaches the route error boundary with a safe message', async t => {
    const f = fixture(t);
    f.failures[0](new Error('Internal renderer diagnostic'));
    await flush();
    assert.throws(() => f.render(), {
        message: 'Dancing Fractals could not start.',
    });
    assert.equal(f.host.selections.length, 0);
});

test('host startup rejection after unmount is handled without updating page state', async t => {
    const f = fixture(t);
    f.unmount();
    const updatesBefore = f.stateUpdates();
    f.failures[0](new Error('Renderer unavailable after navigation'));
    await flush();
    assert.equal(f.stateUpdates(), updatesBefore);
});
