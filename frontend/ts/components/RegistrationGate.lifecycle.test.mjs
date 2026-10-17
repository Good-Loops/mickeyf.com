import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createViteTestServer } from '../testSupport/createViteTestServer.mjs';

const key = '__registrationGateLifecycle';
const scope = `globalThis.${key}`;
const mocks = {
    react: `export const useState = value => ${scope}.state(value); export const useRef = value => ${scope}.ref(value);
        export const useEffect = (callback, deps) => ${scope}.effect(callback, deps);`,
    'jsx-runtime': 'export const jsx = (type, props) => ({ type, props }); export const jsxs = jsx;',
    'jsx-dev-runtime': 'export const jsxDEV = (type, props) => ({ type, props });',
    'react-router-dom': 'export const Link = "a";',
    authService: `export const registrationConfigRequest = (...args) => ${scope}.config(...args);
        export const beginRegistration = (...args) => ${scope}.begin(...args);
        export const cancelRegistration = (...args) => ${scope}.cancel(...args);`,
};
const root = fileURLToPath(new URL('../../', import.meta.url));
const server = await createViteTestServer({ root, configFile: `${root}/vite.config.ts`, appType: 'custom', logLevel: 'silent',
    server: { middlewareMode: true }, ssr: { noExternal: [/^react$/] }, plugins: [{
        name: 'registration-gate-lifecycle', enforce: 'pre', resolveId(source) {
            const name = source.replaceAll('\\', '/').split('/').at(-1).replace(/\.tsx?$/, '');
            if (Object.hasOwn(mocks, name)) return `\0registration-gate:${name}`;
        }, load(id) { if (id.startsWith('\0registration-gate:')) return mocks[id.slice('\0registration-gate:'.length)]; },
    }] });
after(() => server.close());
const { default: Component } = await server.ssrLoadModule('/ts/components/RegistrationGate.tsx');
const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)];

function mount(t) {
    const slots = [], effects = [], calls = [], children = [];
    let cursor = 0, dirty = false, tree;
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    const hooks = {
        state(initial) {
            const slot = slots[cursor++] ??= { value: initial };
            return [slot.value, value => { slot.value = typeof value === 'function' ? value(slot.value) : value; dirty = true; }];
        },
        ref(initial) { return slots[cursor++] ??= { current: initial }; },
        effect(callback, deps) {
            const index = cursor++;
            const prior = slots[index];
            if (!prior || deps.some((value, i) => !Object.is(value, prior.deps[i]))) {
                const slot = slots[index] = { deps, cleanup: prior?.cleanup };
                effects.push(() => { slot.cleanup?.(); slot.cleanup = callback(); });
            }
        },
        async config() { calls.push(['config']); return { enabled: true, policyVersion: 'synthetic-reviewed',
            countries: [{ country: 'US', parentRequiredBelow: 13 }, { country: 'BR', parentRequiredBelow: 18 }] }; },
        async begin(input) { calls.push(['begin', input]); return { authorized: true, expiresInSeconds: 300, scoreVisibility: 'private' }; },
        async cancel() { calls.push(['cancel']); },
    };
    Object.defineProperty(globalThis, key, { configurable: true, value: hooks });
    t.after(() => { slots.forEach(slot => slot.cleanup?.());
        if (previous) Object.defineProperty(globalThis, key, previous); else delete globalThis[key]; });
    const render = () => { cursor = 0; dirty = false; tree = Component({ children: (...args) => {
        children.push(args); return { type: 'credentials', props: {} }; } }); effects.splice(0).forEach(run => run()); return tree; };
    const settle = async () => { for (let index = 0; index < 8; index++) {
        await new Promise(resolve => setImmediate(resolve)); if (!dirty) return; render();
    } assert.fail('Registration view did not settle'); };
    const find = predicate => nodes(tree).find(predicate);
    const change = async (id, value) => { find(node => node.props?.id === id).props.onChange({ target: { value } }); render(); await settle(); };
    const start = async () => { await settle(); };
    return { calls, children, render, settle, find, change, start };
}

test('the retained server eligibility component has no extra create-account step or Who selector', async t => {
    const view = mount(t); view.render(); await view.settle();
    assert.equal(view.find(node => node.type === 'button' && node.props.children === 'Create account'), undefined);
    assert.equal(view.children.length, 0);
    assert(view.find(node => node.props?.id === 'registration-country'));
    assert.equal(view.find(node => node.props?.id === 'registration-for'), undefined);
    assert.equal(view.find(node => node.type === 'input'), undefined);
    assert.deepEqual(view.calls, [['config']]);
});

test('credentials remain unavailable until explicit reviewed eligibility receives a server grant', async t => {
    const view = mount(t); view.render(); await view.start();
    await view.change('registration-country', 'US');
    await view.change('registration-age', 'minor');
    assert.equal(view.children.length, 0);
    await view.find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
    view.render(); await view.settle();
    assert.deepEqual(view.calls[1], ['begin', { country: 'US', ageBand: 'minor', policyVersion: 'synthetic-reviewed' }]);
    assert(view.find(node => node.type === 'credentials'));
    assert.equal(view.children[0][1], 'private');
});

test('under-threshold signup preserves the parent route without attempting self-service authorization', async t => {
    const view = mount(t); view.render(); await view.start();
    await view.change('registration-country', 'BR');
    await view.change('registration-age', 'parent-required');
    await view.find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
    view.render(); await view.settle();
    assert.equal(view.calls.some(call => call[0] === 'begin'), false);
    assert.equal(view.children.length, 0);
    assert(view.find(node => typeof node.type === 'function' && node.type.name === 'ParentRegistrationUnavailable'));
});
