import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createViteTestServer } from '../testSupport/createViteTestServer.mjs';

const key = '__appStoreConsentBoundary';
const scope = `globalThis.${key}`;
const mocks = {
    react: `export const useState = value => ${scope}.state(value); export const useRef = value => ${scope}.ref(value);
        export const useEffect = (callback, deps) => ${scope}.effect(callback, deps);`,
    'jsx-runtime': 'export const jsx = (type, props) => ({ type, props }); export const jsxs = jsx; export const Fragment = "fragment";',
    'jsx-dev-runtime': 'export const jsxDEV = (type, props) => ({ type, props }); export const Fragment = "fragment";',
    core: `export const Capacitor = { isNativePlatform: () => ${scope}.platform !== 'web', getPlatform: () => ${scope}.platform };`,
    'react-router-dom': `export const useLocation = () => ({ pathname: ${scope}.path });`,
    AuthContext: `export const useAuth = () => ${scope}.auth;`,
    apiConfig: 'export const API_BASE = "https://example.test";',
    apiFetch: 'export const apiFetch = () => { throw Error("Unexpected network request"); };',
    appStoreBinding: `export const createAppStoreBindingClient = () => options => ${scope}.bind(options);`,
};
const root = fileURLToPath(new URL('../../', import.meta.url));
const server = await createViteTestServer({ root, configFile: `${root}/vite.config.ts`, appType: 'custom', logLevel: 'silent',
    define: { 'import.meta.env.VITE_ENABLE_APP_STORE_CHILD_CONSENT': `${scope}.enabled` },
    server: { middlewareMode: true }, ssr: { noExternal: [/^react$/, 'react-router-dom', '@capacitor/core'] }, plugins: [{
        name: 'app-store-consent-boundary', enforce: 'pre', resolveId(source) {
            const name = source.replaceAll('\\', '/').split('/').at(-1).replace(/\.tsx?$/, '');
            if (Object.hasOwn(mocks, name)) return `\0consent-boundary:${name}`;
        }, load(id) { if (id.startsWith('\0consent-boundary:')) return mocks[id.slice('\0consent-boundary:'.length)]; },
    }] });
after(() => server.close());
const { default: Component } = await server.ssrLoadModule('/ts/components/AppStoreConsentBoundary.tsx');
const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)];

function mount(t) {
    const slots = [], effects = [], calls = [];
    let cursor = 0, dirty = false, tree;
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    const hooks = {
        enabled: '1', platform: 'ios', path: '/', action: 1, generation: 0,
        state(initial) {
            const slot = slots[cursor++] ??= { value: initial };
            return [slot.value, value => { slot.value = typeof value === 'function' ? value(slot.value) : value; dirty = true; }];
        },
        ref(initial) { return slots[cursor++] ??= { current: initial }; },
        effect(callback, deps) {
            const index = cursor++, prior = slots[index];
            if (!prior || deps.some((value, i) => !Object.is(value, prior.deps[i]))) {
                const slot = slots[index] = { deps, cleanup: prior?.cleanup };
                effects.push(() => { slot.cleanup?.(); slot.cleanup = callback(); });
            }
        },
        async bind(options) { calls.push(options); return 'linked'; },
        auth: { isAuthenticated: true, loading: false, sessionGeneration: 0,
            captureAccountAction: () => hooks.action, captureSessionGeneration: () => hooks.generation,
            async logout() { hooks.action++; hooks.auth.isAuthenticated = false; } },
    };
    Object.defineProperty(globalThis, key, { configurable: true, value: hooks });
    t.after(() => { slots.forEach(slot => slot.cleanup?.());
        if (previous) Object.defineProperty(globalThis, key, previous); else delete globalThis[key]; });
    const render = () => { cursor = 0; dirty = false; tree = Component({ children: { type: 'protected-app', props: {} } });
        effects.splice(0).forEach(run => run()); return tree; };
    const settle = async () => { for (let n = 0; n < 8; n++) {
        await new Promise(resolve => setImmediate(resolve)); if (!dirty) return; render();
    } assert.fail('Consent view did not settle'); };
    return { hooks, calls, render, settle, find: predicate => nodes(tree).find(predicate) };
}

test('the disabled switch, Android, web and guests never request an Apple association', async t => {
    const view = mount(t);
    for (const [enabled, platform, authenticated] of [['0', 'ios', true], ['1', 'android', true], ['1', 'web', true], ['1', 'ios', false]]) {
        view.hooks.enabled = enabled; view.hooks.platform = platform; view.hooks.auth.isAuthenticated = authenticated;
        view.render(); await view.settle();
        assert(view.find(node => node.type === 'protected-app'));
    }
    assert.equal(view.calls.length, 0);
});

test('account content waits for association, while adults and unknown legacy ages can proceed', async t => {
    const view = mount(t);
    for (const result of ['linked', 'not-required', 'unknown-age']) {
        let resolve;
        view.hooks.bind = options => { view.calls.push(options); return new Promise(done => { resolve = done; }); };
        view.hooks.action++;
        view.render();
        assert.equal(view.find(node => node.type === 'protected-app'), undefined);
        assert(view.find(node => node.props?.role === 'status'));
        resolve(result); await view.settle();
        assert(view.find(node => node.type === 'protected-app'));
    }
});

test('a failed association blocks content, permits a retry and leaves privacy reachable', async t => {
    const view = mount(t);
    view.hooks.bind = async options => { view.calls.push(options); return 'unavailable'; };
    view.render(); await view.settle();
    assert.equal(view.find(node => node.type === 'protected-app'), undefined);
    assert(view.find(node => node.props?.role === 'alert'));
    view.hooks.path = '/privacy'; view.render();
    assert(view.find(node => node.type === 'protected-app'));
    view.hooks.path = '/'; view.render();
    view.hooks.bind = async options => { view.calls.push(options); return 'linked'; };
    view.find(node => node.type === 'button').props.onClick(); view.render(); await view.settle();
    assert.equal(view.calls.length, 2);
    assert(view.find(node => node.type === 'protected-app'));
});

test('a session rotation discards a late association and blocks until the new session is checked', async t => {
    const view = mount(t); const pending = [];
    view.hooks.bind = options => { view.calls.push(options); return new Promise(resolve => pending.push(resolve)); };
    view.render();
    view.hooks.generation++; view.hooks.auth.sessionGeneration++;
    assert.equal(view.calls[0].isCurrent(), false);
    view.render(); assert.equal(view.calls[0].signal.aborted, true);
    pending[0]('linked'); await view.settle();
    assert.equal(view.find(node => node.type === 'protected-app'), undefined);
    pending[1]('linked'); await view.settle();
    assert(view.find(node => node.type === 'protected-app'));
});

test('a late result cannot authorize a different account and a restricted account can sign out', async t => {
    const view = mount(t); let resolve;
    view.hooks.bind = options => { view.calls.push(options); return new Promise(done => { resolve = done; }); };
    view.render(); view.hooks.action++;
    assert.equal(view.calls[0].isCurrent(), false);
    resolve('linked'); await view.settle(); view.render();
    resolve('not-permitted'); await view.settle();
    assert.equal(view.find(node => node.type === 'protected-app'), undefined);
    const buttons = nodes(view.render()).filter(node => node.type === 'button');
    buttons[1].props.onClick(); await view.settle(); view.render();
    assert.equal(view.hooks.auth.isAuthenticated, false);
    assert(view.find(node => node.type === 'protected-app'));
});
