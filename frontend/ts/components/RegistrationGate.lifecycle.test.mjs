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
    registrationAge: `export const registrationAge = { parentRequired: () => ${scope}.parentRequired,
        check: async selected => { if (selected === 'parent-required') ${scope}.parentRequired = true; return selected; } };`,
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

function mount(t, policy, purpose = 'signup') {
    const slots = [], effects = [], calls = [], children = [];
    let cursor = 0, dirty = false, tree;
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    const hooks = {
        parentRequired: false,
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
        async config(signal) { calls.push(['config']); return typeof policy === 'function' ? policy(signal) : policy ?? { enabled: true, audience: 'children-included', creationEnabled: true,
            policyVersion: 'synthetic-reviewed', parentRegistrationAvailable: true,
            countries: [{ country: 'US', parentRequiredBelow: 13, adultFrom: 18 }, { country: 'BR', parentRequiredBelow: 18, adultFrom: 18 }] }; },
        async begin(input) { calls.push(['begin', input]); return { authorized: true, expiresInSeconds: 300, scoreVisibility: 'private' }; },
        async cancel() { calls.push(['cancel']); },
    };
    Object.defineProperty(globalThis, key, { configurable: true, value: hooks });
    t.after(() => { slots.forEach(slot => slot.cleanup?.());
        if (previous) Object.defineProperty(globalThis, key, previous); else delete globalThis[key]; });
    const render = () => { cursor = 0; dirty = false; tree = Component({ purpose, children: (...args) => {
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

test('under-threshold signup records the protective server context without mounting self-service credentials', async t => {
    const view = mount(t); view.render(); await view.start();
    await view.change('registration-country', 'BR');
    await view.change('registration-age', 'parent-required');
    await view.find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
    view.render(); await view.settle();
    assert.deepEqual(view.calls[1], ['begin', { country: 'BR', ageBand: 'parent-required', policyVersion: 'synthetic-reviewed' }]);
    assert.equal(view.children.length, 0);
    assert(view.find(node => typeof node.type === 'function' && node.type.name === 'ParentRegistrationUnavailable'));
    assert.equal(view.find(node => node.type === 'button' && node.props.children === 'Back to registration'), undefined);
});

test('an older general backend cannot mount credentials or provider controls in the new source', async t => {
    const view = mount(t, { enabled: true, mode: 'general-audience', policyVersion: 'old-general',
        parentRegistrationAvailable: false, optionalDetails: false });
    view.render(); await view.settle();
    assert.equal(view.children.length, 0);
    assert.equal(view.find(node => node.type === 'form'), undefined);
    assert.deepEqual(view.calls, [['config']]);
});

const creationPaused = { enabled: true, audience: 'children-included', creationEnabled: false,
    policyVersion: 'synthetic-reviewed', parentRegistrationAvailable: false,
    countries: [{ country: 'US', parentRequiredBelow: 13, adultFrom: 18 }] };

test('paused creation never mounts signup credentials, providers or an eligibility form', async t => {
    const view = mount(t, creationPaused); view.render(); await view.settle();
    assert.equal(view.children.length, 0);
    assert.equal(view.find(node => node.type === 'form' || node.type === 'input' || node.type === 'select'), undefined);
    assert(view.find(node => node.type === 'p' && node.props.role === 'status'
        && node.props.children.startsWith('New account creation is temporarily paused.')));
    assert(view.find(node => node.props?.to === '/'));
    assert(view.find(node => node.props?.to === '/login'));
    assert.deepEqual(view.calls, [['config']]);
});

test('disabled registration shows the same pause notice and does not request a grant', async t => {
    const view = mount(t, { enabled: false }); view.render(); await view.settle();
    assert(view.find(node => node.type === 'p' && node.props.role === 'status'
        && node.props.children.startsWith('New account creation is temporarily paused.')));
    assert.equal(view.find(node => node.type === 'form' || node.type === 'input' || node.type === 'select'), undefined);
    assert(view.find(node => node.props?.to === '/'));
    assert(view.find(node => node.props?.to === '/login'));
    assert.deepEqual(view.calls, [['config']]);
});

test('an unavailable config can be retried without displaying credentials', async t => {
    let policy = null;
    const view = mount(t, () => policy); view.render(); await view.settle();
    assert(view.find(node => node.type === 'p' && node.props.children === 'We can’t check sign-up availability right now. Please try again.'));
    assert.equal(view.children.length, 0);
    policy = { enabled: false };
    view.find(node => node.type === 'button' && node.props.children === 'Check again').props.onClick();
    view.render(); await view.settle();
    assert(view.find(node => node.type === 'p' && node.props.children?.startsWith?.('New account creation is temporarily paused.')));
    assert.deepEqual(view.calls, [['config'], ['config']]);
});

test('a failed config request shows the retry message without mounting credentials', async t => {
    const view = mount(t, () => Promise.reject(new Error('offline'))); view.render(); await view.settle();
    assert(view.find(node => node.type === 'p' && node.props.children === 'We can’t check sign-up availability right now. Please try again.'));
    assert(view.find(node => node.type === 'button' && node.props.children === 'Check again'));
    assert.equal(view.children.length, 0);
    assert.deepEqual(view.calls, [['config']]);
});

test('a timed-out config fails closed and ignores a late response', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let resolveConfig, signal;
    const view = mount(t, inputSignal => { signal = inputSignal; return new Promise(resolve => { resolveConfig = resolve; }); });
    view.render();
    t.mock.timers.tick(10_000); view.render(); await view.settle();
    assert.equal(signal.aborted, true);
    assert(view.find(node => node.type === 'p' && node.props.children === 'We can’t check sign-up availability right now. Please try again.'));
    resolveConfig(creationPaused); await view.settle();
    assert(view.find(node => node.type === 'p' && node.props.children === 'We can’t check sign-up availability right now. Please try again.'));
    assert.equal(view.children.length, 0);
    assert.deepEqual(view.calls, [['config']]);
});

test('paused creation still mounts existing-account provider login after explicit eligibility approval', async t => {
    const view = mount(t, creationPaused, 'provider-login'); view.render(); await view.settle();
    assert.equal(view.children.length, 0);
    await view.change('registration-country', 'US');
    await view.change('registration-age', 'adult');
    await view.find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
    view.render(); await view.settle();
    assert.deepEqual(view.calls[1], ['begin', { country: 'US', ageBand: 'adult', policyVersion: 'synthetic-reviewed' }]);
    assert(view.find(node => node.type === 'credentials'));
});
