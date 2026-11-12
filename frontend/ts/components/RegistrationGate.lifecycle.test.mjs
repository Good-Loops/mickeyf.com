import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createViteTestServer } from '../testSupport/createViteTestServer.mjs';

const key = '__registrationGateLifecycle';
const scope = `globalThis.${key}`;
const mocks = {
    SignupProviderChoices: 'export default "SignupProviderChoices";',
    react: `export const useState = value => ${scope}.state(value); export const useRef = value => ${scope}.ref(value);
        export const useEffect = (callback, deps) => ${scope}.effect(callback, deps);`,
    'jsx-runtime': 'export const jsx = (type, props) => ({ type, props }); export const jsxs = jsx;',
    'jsx-dev-runtime': 'export const jsxDEV = (type, props) => ({ type, props });',
    'react-router-dom': 'export const Link = "a";',
    authService: `export const registrationConfigRequest = (...args) => ${scope}.config(...args);
        export const beginRegistration = (...args) => ${scope}.begin(...args);
        export const observeRegistration = (...args) => ${scope}.observe(...args);
        export const beginNativeAgeCheck = (...args) => ${scope}.beginNative(...args);
        export const finishNativeAgeCheck = (...args) => ${scope}.finishNative(...args);
        export const cancelRegistration = (...args) => ${scope}.cancel(...args);`,
    registrationAge: `export const registrationAge = { parentRequired: () => ${scope}.parentRequired,
        minorProviderRestricted: () => ${scope}.minorRestricted,
        rememberMinorProvider: () => { ${scope}.minorRestricted = true; },
        nativeFirst: (...args) => ${scope}.nativeFirst(...args),
        manual: selected => ${scope}.parentRequired ? 'parent-required' : selected,
        check: (...args) => ${scope}.check(...args) };`,
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
const { default: Component, classifyRegistrationAge } = await server.ssrLoadModule('/ts/components/RegistrationGate.tsx');
const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)];

function mount(t, policy, purpose = 'signup') {
    const slots = [], effects = [], calls = [], children = [];
    let cursor = 0, dirty = false, tree;
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    const hooks = {
        parentRequired: false, minorRestricted: false,
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
        async observe() { return true; },
        async beginNative() { return 'synthetic-attempt'; },
        async finishNative() { return true; },
        async nativeFirst() { return { kind: 'manual' }; },
        async check(selected) { if (selected === 'parent-required') hooks.parentRequired = true; return selected; },
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
    const ensureManual = async () => {
        if (find(node => node.props?.id === 'registration-age')) return;
        await find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); render(); await settle();
    };
    const change = async (id, value) => { if (id === 'registration-age') await ensureManual();
        find(node => node.props?.id === id).props.onChange({ target: { value } }); render(); await settle(); };
    const start = async () => { await settle(); };
    const unmount = () => slots.forEach(slot => slot.cleanup?.());
    return { calls, children, render, settle, find, change, ensureManual, start, hooks, unmount };
}

test('numeric ages classify at the reviewed country boundaries and reject malformed input', () => {
    for (const [country, threshold, samples] of [
        ['US', 13, [[0, 'parent-required'], [12, 'parent-required'], [13, 'minor'], [17, 'minor'], [18, 'adult'], [120, 'adult']]],
        ['BR', 18, [[0, 'parent-required'], [12, 'parent-required'], [13, 'parent-required'], [17, 'parent-required'], [18, 'adult'], [120, 'adult']]],
    ]) {
        for (const [age, expected] of samples) assert.equal(classifyRegistrationAge(String(age), threshold, 18), expected, `${country} age ${age}`);
    }
    for (const invalid of ['', '121', '999', '-1', '+18', '18.0', '1e2', ' 18', '18 ', '１２', 'Infinity', '0000']) {
        assert.equal(classifyRegistrationAge(invalid, 13, 18), '', invalid);
    }
});

test('a shared device age skips manual entry and is recorded before provider controls mount', async t => {
    const view = mount(t, undefined, 'provider-login'); const order = [];
    view.hooks.beginNative = async () => { order.push('reserve'); return 'synthetic-attempt'; };
    view.hooks.nativeFirst = async (_threshold, reserve) => { assert.equal(await reserve(), true); order.push('device'); return { kind: 'shared', ageBand: 'adult' }; };
    view.hooks.finishNative = async input => { order.push(`finish:${input.ageBand}`); return true; };
    view.hooks.begin = async input => { order.push(`begin:${input.ageBand}`); return { authorized: true, expiresInSeconds: 300, scoreVisibility: 'private' }; };
    view.render(); await view.settle(); await view.change('registration-country', 'US');
    assert.equal(view.find(node => node.props?.id === 'registration-age'), undefined);
    await view.find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); view.render(); await view.settle();
    assert.deepEqual(order, ['reserve', 'device', 'finish:adult', 'begin:adult']);
    assert.equal(view.children.length, 1);
});

test('unshared device age asks manually and completes its reservation without a second prompt', async t => {
    const view = mount(t); const order = [];
    view.hooks.beginNative = async () => { order.push('reserve'); return 'synthetic-attempt'; };
    view.hooks.nativeFirst = async (_threshold, reserve) => { assert.equal(await reserve(), true); order.push('device'); return { kind: 'manual' }; };
    view.hooks.check = async () => { assert.fail('must not prompt again after manual fallback'); };
    view.hooks.finishNative = async input => { order.push(`finish:${input.ageBand}`); return true; };
    view.hooks.begin = async input => { order.push(`begin:${input.ageBand}`); return { authorized: true, expiresInSeconds: 300, scoreVisibility: 'private' }; };
    view.render(); await view.settle(); await view.change('registration-country', 'US'); await view.ensureManual();
    assert.equal(view.find(node => node.props?.id === 'registration-country').props.disabled, true);
    await view.change('registration-age', '18');
    await view.find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); view.render(); await view.settle();
    assert.deepEqual(order, ['reserve', 'device', 'finish:adult', 'begin:adult']);
    assert.equal(view.children.length, 1);
});

test('a platform verification requirement never falls through to manual age or provider credentials', async t => {
    const view = mount(t, undefined, 'provider-login');
    view.hooks.nativeFirst = async () => ({ kind: 'verification-required' });
    view.render(); await view.settle(); await view.change('registration-country', 'US');
    await view.find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); view.render(); await view.settle();
    assert.equal(view.find(node => node.props?.id === 'registration-age'), undefined);
    assert.equal(view.children.length, 0);
    assert(view.find(node => node.type === 'p' && node.props.role === 'alert' && node.props.children.includes('requires age verification')));
});

test('a late native-first child result is recorded even after the screen closes', async t => {
    const view = mount(t); let resolveRange; const recorded = [];
    view.hooks.nativeFirst = async (_threshold, reserve) => {
        assert.equal(await reserve(), true);
        return new Promise(resolve => { resolveRange = resolve; });
    };
    view.hooks.finishNative = async input => { recorded.push(input.ageBand); return true; };
    view.render(); await view.settle(); await view.change('registration-country', 'US');
    const pending = view.find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
    await new Promise(resolve => setImmediate(resolve));
    view.unmount(); resolveRange({ kind: 'shared', ageBand: 'parent-required' });
    await pending; await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(recorded, ['parent-required']);
    assert.equal(view.children.length, 0);
    assert.equal(view.calls.some(call => call[0] === 'begin'), false);
});

test('the age input does not expose threshold choices and rejects invalid values', async t => {
    const view = mount(t); view.render(); await view.settle();
    await view.change('registration-country', 'US');
    await view.ensureManual();
    const input = view.find(node => node.props?.id === 'registration-age');
    assert.equal(input.type, 'input');
    assert.equal(input.props.inputMode, 'numeric');
    assert.equal(view.find(node => node.type === 'option' && /under|older|13|17|18/i.test(String(node.props.children))), undefined);
    for (const invalid of ['121', '18.0', '-1']) {
        await view.change('registration-age', invalid);
        assert(view.find(node => node.type === 'p' && node.props.role === 'status' && node.props.children === 'Enter your age as a whole number from 0 to 120.'));
        assert.equal(view.find(node => node.type === 'button' && node.props.type === 'submit').props.disabled, true);
        await view.find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
        assert.deepEqual(view.calls, [['config']]);
    }
});

test('changing countries clears the entered age and uses the new country policy', async t => {
    const view = mount(t); view.render(); await view.settle();
    await view.change('registration-country', 'US');
    await view.change('registration-age', '17');
    await view.change('registration-country', 'BR');
    await view.ensureManual();
    assert.equal(view.find(node => node.props?.id === 'registration-age').props.value, '');
    await view.change('registration-age', '17');
    await view.find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
    view.render(); await view.settle();
    assert.deepEqual(view.calls[1], ['begin', { country: 'BR', ageBand: 'parent-required', policyVersion: 'synthetic-reviewed' }]);
    assert.equal(view.children.length, 0);
});

test('a stricter asynchronous native age signal prevails over the entered age', async t => {
    const view = mount(t); view.hooks.check = async (selected, threshold) => {
        assert.equal(selected, 'adult'); assert.equal(threshold, 13);
        await new Promise(resolve => setImmediate(resolve));
        view.hooks.parentRequired = true;
        return 'parent-required';
    };
    view.render(); await view.settle();
    await view.change('registration-country', 'US');
    await view.change('registration-age', '18');
    await view.find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
    view.render(); await view.settle();
    assert.deepEqual(view.calls[1], ['begin', { country: 'US', ageBand: 'parent-required', policyVersion: 'synthetic-reviewed' }]);
    assert.equal(view.children.length, 0);
});

test('an unavailable asynchronous native age signal fails closed', async t => {
    const view = mount(t); view.hooks.check = async () => { await new Promise(resolve => setImmediate(resolve)); return null; };
    view.render(); await view.settle();
    await view.change('registration-country', 'US');
    await view.change('registration-age', '18');
    await view.find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
    view.render(); await view.settle();
    assert.deepEqual(view.calls, [['config']]);
    assert.equal(view.children.length, 0);
    assert(view.find(node => node.type === 'p' && node.props.role === 'alert' && node.props.children.startsWith('Your device could not confirm')));
});

test('a submitted minor provider age is protected while the native check is pending', async t => {
    const view = mount(t, creationPaused, 'provider-login');
    let resolveCheck;
    const observations = [];
    view.hooks.observe = async input => { observations.push(input); return true; };
    view.hooks.check = () => new Promise(resolve => { resolveCheck = resolve; });
    view.render(); await view.settle();
    await view.change('registration-country', 'US');
    await view.change('registration-age', '13');
    const pending = view.find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
    await Promise.resolve();
    view.render();
    assert.equal(view.hooks.minorRestricted, true);
    assert.deepEqual(observations, [{ country: 'US', ageBand: 'minor', policyVersion: 'synthetic-reviewed' }]);
    assert.equal(view.find(node => node.props?.id === 'registration-age').props.value, '');
    assert.equal(view.find(node => node.props?.id === 'registration-age').props.disabled, true);
    resolveCheck('minor'); await pending;
    view.render(); await view.settle();
    assert.deepEqual(view.calls, [['config']]);
    assert.equal(view.children.length, 0);
});

test('a native timeout blocks credentials but still records a late restrictive result', async t => {
    const view = mount(t, creationPaused, 'provider-login');
    let resolveCheck;
    const observations = [];
    view.hooks.check = () => new Promise(resolve => { resolveCheck = resolve; });
    view.hooks.observe = async input => { observations.push(input); return true; };
    view.render(); await view.settle();
    await view.change('registration-country', 'US');
    await view.change('registration-age', '18');
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const pending = view.find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
    t.mock.timers.tick(10_000); await pending;
    view.render();
    assert.equal(view.children.length, 0);
    assert.deepEqual(view.calls, [['config']]);
    assert(view.find(node => node.type === 'p' && node.props.role === 'alert' && node.props.children.startsWith('Your device could not confirm')));
    resolveCheck('minor');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(observations, [{ country: 'US', ageBand: 'minor', policyVersion: 'synthetic-reviewed' }]);
    assert.deepEqual(view.calls, [['config']]);
});

test('a rejected observation is handled while the native check is still pending', async t => {
    const view = mount(t, creationPaused, 'provider-login');
    let resolveCheck;
    view.hooks.check = () => new Promise(resolve => { resolveCheck = resolve; });
    view.hooks.observe = async () => { throw new Error('offline'); };
    view.render(); await view.settle();
    await view.change('registration-country', 'US');
    await view.change('registration-age', '13');
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const pending = view.find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
    await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(10_000); await pending;
    resolveCheck('minor');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(view.calls, [['config']]);
    assert.equal(view.children.length, 0);
});

test('a stalled observation times out without mounting a credential form', async t => {
    const view = mount(t);
    let resolveObservation;
    view.hooks.observe = () => new Promise(resolve => { resolveObservation = resolve; });
    view.render(); await view.settle();
    await view.change('registration-country', 'US');
    await view.change('registration-age', '13');
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const pending = view.find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
    await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(10_000); await pending;
    view.render();
    assert(view.find(node => node.type === 'p' && node.props.role === 'alert' && node.props.children.startsWith('We couldn’t confirm this age check.')));
    assert.deepEqual(view.calls, [['config']]);
    assert.equal(view.children.length, 0);
    resolveObservation(true);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(view.calls, [['config']]);
});

test('a native age prompt is reserved before it starts and finished before credentials mount', async t => {
    const view = mount(t);
    const operations = [];
    view.hooks.beginNative = async () => { operations.push('reserve'); return 'synthetic-attempt'; };
    view.hooks.check = async (_selected, _threshold, beforeNative) => {
        assert.equal(await beforeNative(), true); operations.push('prompt'); return 'adult';
    };
    view.hooks.finishNative = async input => { operations.push(['finish', input]); return true; };
    view.hooks.begin = async input => { operations.push(['begin', input]); return { authorized: true, expiresInSeconds: 300, scoreVisibility: 'private' }; };
    view.render(); await view.settle();
    await view.change('registration-country', 'US');
    await view.change('registration-age', '18');
    await view.find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
    view.render(); await view.settle();
    assert.deepEqual(operations, ['reserve', 'prompt',
        ['finish', { attempt: 'synthetic-attempt', country: 'US', ageBand: 'adult', policyVersion: 'synthetic-reviewed' }],
        ['begin', { country: 'US', ageBand: 'adult', policyVersion: 'synthetic-reviewed' }]]);
    assert(view.find(node => node.type === 'credentials'));
});

test('a native reservation failure never opens the native prompt or creates a grant', async t => {
    const view = mount(t);
    let prompted = false;
    view.hooks.beginNative = async () => null;
    view.hooks.check = async (_selected, _threshold, beforeNative) => {
        if (!await beforeNative()) return null;
        prompted = true; return 'adult';
    };
    view.render(); await view.settle();
    await view.change('registration-country', 'US');
    await view.change('registration-age', '18');
    await view.find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
    view.render(); await view.settle();
    assert.equal(prompted, false);
    assert.deepEqual(view.calls, [['config']]);
    assert.equal(view.children.length, 0);
});

test('a reservation arriving after the screen times out does not launch a surprise native prompt', async t => {
    const view = mount(t);
    let resolveReservation, prompted = false, finished = false;
    view.hooks.beginNative = () => new Promise(resolve => { resolveReservation = resolve; });
    view.hooks.check = async (_selected, _threshold, beforeNative) => {
        if (!await beforeNative()) return null;
        prompted = true; return 'adult';
    };
    view.hooks.finishNative = async () => { finished = true; return true; };
    view.render(); await view.settle();
    await view.change('registration-country', 'US');
    await view.change('registration-age', '18');
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const pending = view.find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
    t.mock.timers.tick(10_000); await pending;
    resolveReservation('synthetic-attempt');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(prompted, false);
    assert.equal(finished, false);
    assert.deepEqual(view.calls, [['config']]);
});

test('an unresolved reserved prompt fails closed and its late restrictive result still finishes the reservation', async t => {
    const view = mount(t);
    const finishes = [];
    let resolvePrompt;
    view.hooks.check = async (_selected, _threshold, beforeNative) => {
        if (!await beforeNative()) return null;
        return new Promise(resolve => { resolvePrompt = resolve; });
    };
    view.hooks.finishNative = async input => { finishes.push(input); return true; };
    view.render(); await view.settle();
    await view.change('registration-country', 'US');
    await view.change('registration-age', '18');
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const pending = view.find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
    await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(10_000); await pending;
    view.render();
    assert(view.find(node => node.type === 'p' && node.props.role === 'alert' && node.props.children.includes('up to 24 hours')));
    resolvePrompt('parent-required');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(finishes, [{ attempt: 'synthetic-attempt', country: 'US', ageBand: 'parent-required', policyVersion: 'synthetic-reviewed' }]);
    assert.deepEqual(view.calls, [['config']]);
    assert.equal(view.children.length, 0);
});

test('provider login fails closed when the underage server observation fails', async t => {
    const view = mount(t, creationPaused, 'provider-login');
    view.hooks.observe = async () => false;
    view.render(); await view.settle();
    await view.change('registration-country', 'US');
    await view.change('registration-age', '13');
    await view.find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
    view.render(); await view.settle();
    assert.deepEqual(view.calls, [['config']]);
    assert.equal(view.children.length, 0);
    assert(view.find(node => node.type === 'p' && node.props.role === 'alert' && node.props.children.startsWith('We couldn’t confirm this age check.')));
});

test('a native underage result is observed even if its screen was unmounted while awaiting it', async t => {
    const view = mount(t, creationPaused, 'provider-login');
    let resolveCheck;
    const observations = [];
    view.hooks.check = () => new Promise(resolve => { resolveCheck = resolve; });
    view.hooks.observe = async input => { observations.push(input); return true; };
    view.render(); await view.settle();
    await view.change('registration-country', 'US');
    await view.change('registration-age', '18');
    const pending = view.find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
    view.unmount();
    resolveCheck('minor'); await pending;
    assert.deepEqual(observations, [{ country: 'US', ageBand: 'minor', policyVersion: 'synthetic-reviewed' }]);
    assert.deepEqual(view.calls, [['config']]);
    assert.equal(view.children.length, 0);
});

test('a stricter native parent result is recorded after the entered minor result', async t => {
    const view = mount(t);
    const observations = [];
    view.hooks.check = async () => 'parent-required';
    view.hooks.observe = async input => { observations.push(input); return true; };
    view.render(); await view.settle();
    await view.change('registration-country', 'US');
    await view.change('registration-age', '13');
    await view.find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
    assert.deepEqual(observations, [
        { country: 'US', ageBand: 'minor', policyVersion: 'synthetic-reviewed' },
        { country: 'US', ageBand: 'parent-required', policyVersion: 'synthetic-reviewed' },
    ]);
});

test('a delayed first observation does not block reporting a stricter native result', async t => {
    const view = mount(t);
    const observations = [];
    let resolveInitial;
    view.hooks.check = async () => 'parent-required';
    view.hooks.observe = input => {
        observations.push(input);
        return input.ageBand === 'minor' ? new Promise(resolve => { resolveInitial = resolve; }) : Promise.resolve(true);
    };
    view.render(); await view.settle();
    await view.change('registration-country', 'US');
    await view.change('registration-age', '13');
    const pending = view.find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(observations.map(item => item.ageBand), ['minor', 'parent-required']);
    resolveInitial(true); await pending;
});

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
    await view.change('registration-age', '13');
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
    await view.change('registration-age', '17');
    await view.find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
    view.render(); await view.settle();
    assert.deepEqual(view.calls[1], ['begin', { country: 'BR', ageBand: 'parent-required', policyVersion: 'synthetic-reviewed' }]);
    assert.equal(view.children.length, 0);
    assert(view.find(node => typeof node.type === 'function' && node.type.name === 'ParentRegistrationUnavailable'));
    assert.equal(view.find(node => node.type === 'button' && node.props.children === 'Back to registration'), undefined);
});

test('a restricted signup shows the unavailable parent flow without mounting credentials', async t => {
    const view = mount(t, { enabled: true, audience: 'children-included', creationEnabled: true,
        policyVersion: 'synthetic-reviewed', parentRegistrationAvailable: false,
        countries: [{ country: 'US', parentRequiredBelow: 13, adultFrom: 18 }] });
    view.hooks.begin = async input => { view.calls.push(['begin', input]); return { error: 'PARENT_REQUIRED' }; };
    view.render(); await view.start();
    await view.change('registration-country', 'US');
    await view.change('registration-age', '17');
    await view.find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
    view.render(); await view.settle();
    const notice = view.find(node => typeof node.type === 'function' && node.type.name === 'ParentRegistrationUnavailable');
    assert.equal(notice.props.available, false);
    assert.equal(view.children.length, 0);
    assert(view.find(node => node.props?.to === '/'));
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
    await view.change('registration-age', '18');
    await view.find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
    view.render(); await view.settle();
    assert.deepEqual(view.calls[1], ['begin', { country: 'US', ageBand: 'adult', policyVersion: 'synthetic-reviewed' }]);
    assert(view.find(node => node.type === 'credentials'));
});

test('minor provider login shows a temporary notice and does not request a grant or mount provider controls', async t => {
    const view = mount(t, creationPaused, 'provider-login'); view.render(); await view.settle();
    await view.change('registration-country', 'US');
    await view.change('registration-age', '13');
    assert.equal(view.find(node => node.type === 'p' && typeof node.props.children === 'string'
        && node.props.children.includes('scores will be private')), undefined);
    await view.find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
    view.render(); await view.settle();
    assert(view.find(node => node.type === 'p' && node.props.role === 'alert'
        && node.props.children.startsWith('Google and Apple sign-in are temporarily unavailable.')));
    assert(view.find(node => node.props?.to === '/privacy#privacy-children'));
    assert.deepEqual(view.calls, [['config']]);
    assert.equal(view.children.length, 0);
    await view.change('registration-age', '18');
    await view.find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
    view.render(); await view.settle();
    assert.deepEqual(view.calls, [['config']], 'adult reselection must not bypass a known minor result');
    assert.equal(view.children.length, 0);
});

test('disabled policy explains available login choices without asking for an unavailable age check', async t => {
    const view = mount(t, { enabled: false }, 'provider-login'); view.render(); await view.settle();
    assert(view.find(node => node.type === 'p' && typeof node.props.children === 'string'
        && node.props.children === 'Google and Apple sign-in are currently unavailable.'));
    assert(view.find(node => node.type === 'h2' && node.props.children === 'Other sign-in options'));
    assert(view.find(node => node.props?.to === '/'));
    assert.equal(view.find(node => node.type === 'button' && node.props.children === 'Check again'), undefined);
    assert.equal(view.find(node => node.type === 'p' && typeof node.props.children === 'string'
        && (node.props.children.includes('choose your country') || node.props.children.includes('parent-managed'))), undefined);
    assert.equal(view.find(node => node.type === 'form' || node.type === 'select'), undefined);
    assert.equal(view.children.length, 0);
});

test('provider availability is clearly labeled while loading and can be checked again', async t => {
    let policy = null;
    const view = mount(t, () => policy, 'provider-login'); view.render();
    assert(view.find(node => node.type === 'p' && node.props.role === 'status' && node.props.children === 'Checking sign-in options…'));
    await view.settle();
    policy = creationPaused;
    view.find(node => node.type === 'button' && node.props.children === 'Check again').props.onClick();
    view.render(); await view.settle();
    assert(view.find(node => node.type === 'p' && node.props.children.startsWith('Choose your country.')));
    assert.equal(view.children.length, 0, 'retry must not mount provider controls without a grant');
    assert.deepEqual(view.calls, [['config'], ['config']]);
});

test('provider eligibility asks for age only when the eligibility form is actually available', async t => {
    const view = mount(t, creationPaused, 'provider-login'); view.render(); await view.settle();
    assert(view.find(node => node.type === 'p' && node.props.children.startsWith('Choose your country.')));
    assert(view.find(node => node.type === 'form'));
    assert.equal(view.children.length, 0);
});

test('typing an adult age one digit at a time does not create a minor restriction', async t => {
    const view = mount(t, creationPaused, 'provider-login'); view.render(); await view.settle();
    await view.change('registration-country', 'US');
    await view.change('registration-age', '1');
    await view.change('registration-age', '18');
    await view.find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
    view.render(); await view.settle();
    assert.deepEqual(view.calls[1], ['begin', { country: 'US', ageBand: 'adult', policyVersion: 'synthetic-reviewed' }]);
    assert(view.find(node => node.type === 'credentials'));
});

test('a submitted parent-required provider age persists and cannot be changed to adult', async t => {
    const view = mount(t, creationPaused, 'provider-login'); view.render(); await view.settle();
    await view.change('registration-country', 'US');
    await view.change('registration-age', '12');
    await view.find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
    view.render(); await view.settle();
    assert(view.find(node => typeof node.type === 'function' && node.type.name === 'ParentRegistrationUnavailable'));
    assert.equal(view.find(node => node.props?.id === 'registration-age'), undefined);
    assert.deepEqual(view.calls[1], ['begin', { country: 'US', ageBand: 'parent-required', policyVersion: 'synthetic-reviewed' }]);
    assert.equal(view.children.length, 0);
});
