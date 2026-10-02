import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createViteTestServer } from '../testSupport/createViteTestServer.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const fixtureKey = '__fullscreenButtonHooks';
const server = await createViteTestServer({
    root, configFile: `${root}/vite.config.ts`, appType: 'custom', logLevel: 'silent',
    server: { middlewareMode: true }, ssr: { noExternal: [/^react$/] },
    plugins: [{
        name: 'fullscreen-button-hook-fixture', enforce: 'pre',
        resolveId(source) {
            if (source === 'react') return '\0fullscreen-react';
            if (source.startsWith('react/jsx-')) return '\0fullscreen-jsx';
        },
        load(id) {
            if (id === '\0fullscreen-jsx') return `export const jsxDEV = (type, props) => ({ type, props });
                export const jsx = jsxDEV; export const jsxs = jsxDEV;`;
            if (id !== '\0fullscreen-react') return;
            return `export default {};
                export const useState = initial => [initial, value => globalThis.${fixtureKey}.states.push(value)];
                export const useRef = initial => ({ current: initial });
                export const useCallback = callback => callback;
                export const useEffect = effect => globalThis.${fixtureKey}.effects.push(effect);`;
        },
    }],
});
after(() => server.close());
const { default: FullscreenButton } = await server.ssrLoadModule('/ts/components/FullscreenButton.tsx');

function mount(t, { previousFocus = 'button' } = {}) {
    const listeners = new Map(), focused = [], hooks = { effects: [], states: [] };
    let finishExit, cleanups = [];
    class Element {
        isConnected = true;
        constructor(name) { this.name = name; }
        getAttribute() { return null; }
        removeAttribute() {}
        focus(options) {
            assert.deepEqual(options, { preventScroll: true });
            focused.push(this.name);
            page.activeElement = this;
        }
    }
    const trigger = new Element('button'), canvas = new Element('canvas'), target = new Element('target');
    const page = {
        activeElement: previousFocus === 'none' ? null : trigger,
        documentElement: { getAttribute: () => null, classList: { remove() {} } },
        fullscreenElement: null,
        querySelector: () => null,
        addEventListener(type, listener) {
            if (!listeners.has(type)) listeners.set(type, new Set());
            listeners.get(type).add(listener);
        },
        removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
        exitFullscreen() {
            page.fullscreenElement = null;
            return new Promise(resolve => { finishExit = resolve; });
        },
    };
    target.requestFullscreen = async () => { page.fullscreenElement = target; };
    const globals = { [fixtureKey]: hooks, document: page, HTMLElement: Element };
    const previousGlobals = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    for (const [key, value] of Object.entries(globals)) {
        Object.defineProperty(globalThis, key, { configurable: true, value });
    }
    const unmount = () => {
        cleanups.splice(0).forEach(cleanup => cleanup?.());
    };
    t.after(() => {
        unmount();
        for (const [key, previous] of previousGlobals) {
            if (previous) Object.defineProperty(globalThis, key, previous);
            else delete globalThis[key];
        }
    });
    // Controlled events exercise the real fullscreen helper and component callbacks,
    // including either native event/promise order, without emulating browser painting.
    const view = FullscreenButton({ targetRef: { current: target }, focusRef: { current: canvas } });
    cleanups = hooks.effects.map(effect => effect());
    const emitExit = (type = 'fullscreenchange') => {
        for (const listener of listeners.get(type) ?? []) listener();
    };
    return {
        click: view.props.onClick, focused, trigger, target, page, hooks,
        finishExit: () => finishExit(), emitExit, unmount,
        listenerCount: () => [...listeners.values()].reduce((sum, entries) => sum + entries.size, 0),
    };
}

for (const event of ['fullscreenchange', 'webkitfullscreenchange']) {
    for (const order of ['before', 'after']) {
        test(`${event} ${order} exit resolution restores the original focus exactly once`, async t => {
            const view = mount(t);
            await view.click();
            view.focused.length = 0;
            const exit = view.click();
            if (order === 'before') view.emitExit(event);
            view.finishExit();
            await exit;
            if (order === 'after') view.emitExit(event);
            view.emitExit(event);
            assert.deepEqual(view.focused, ['button']);
            assert.equal(view.page.activeElement, view.trigger);
        });
    }
}

for (const previousFocus of ['none', 'detached']) {
    test(`${previousFocus === 'none' ? 'missing' : 'detached'} previous focus uses the canvas fallback exactly once`, async t => {
        const view = mount(t, { previousFocus });
        await view.click();
        if (previousFocus === 'detached') view.trigger.isConnected = false;
        view.focused.length = 0;
        const exit = view.click();
        view.emitExit();
        view.finishExit();
        await exit;
        view.emitExit();
        assert.deepEqual(view.focused, ['canvas']);
    });
}

test('unmount consumes restoration and ignores the pending exit completion', async t => {
    const view = mount(t);
    await view.click();
    view.focused.length = 0;
    const exit = view.click();
    view.unmount();
    assert.deepEqual(view.focused, ['button']);
    assert.equal(view.listenerCount(), 0);
    const updates = view.hooks.states.length;
    view.finishExit();
    await exit;
    view.emitExit();
    assert.deepEqual(view.focused, ['button']);
    assert.equal(view.hooks.states.length, updates);
});
