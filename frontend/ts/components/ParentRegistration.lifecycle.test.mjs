import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createViteTestServer } from '../testSupport/createViteTestServer.mjs';

const fixtureKey = '__parentRegistrationLifecycle';
const scope = `globalThis.${fixtureKey}`;
const mocks = {
    react: `export const useState = v => ${scope}.state(v); export const useRef = v => ${scope}.ref(v);
        export const useEffect = (fn, deps) => ${scope}.effect(fn, deps);`,
    'jsx-runtime': 'export const jsx = (type, props) => ({type, props}); export const jsxs = jsx;',
    'jsx-dev-runtime': 'export const jsxDEV = (type, props) => ({type, props});',
    'react-router-dom': 'export const Link = "a";',
};
const root = fileURLToPath(new URL('../../', import.meta.url));
const server = await createViteTestServer({ root, configFile: `${root}/vite.config.ts`, appType: 'custom', logLevel: 'silent',
    server: { middlewareMode: true }, ssr: { noExternal: [/^react$/] },
    plugins: [{ name: 'parent-registration-lifecycle', enforce: 'pre', resolveId(source) {
        const name = source.replaceAll('\\', '/').split('/').at(-1);
        if (Object.hasOwn(mocks, name)) return `\0parent-lifecycle:${name}`;
    }, load(id) { if (id.startsWith('\0parent-lifecycle:')) return mocks[id.slice('\0parent-lifecycle:'.length)]; } }],
});
after(() => server.close());
const { default: Component } = await server.ssrLoadModule('/ts/components/ParentRegistration.tsx');
const config = { enabled: true, creationEnabled: true, policyVersion: 'test', consentVersion: 'consent-test', consentText: 'Synthetic consent.', countries: ['ZZ'] };
const random = () => randomBytes(32).toString('base64url');
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { resolve, reject, promise }; };
const nodes = value => !value || typeof value !== 'object' ? [] : [value, ...[value.props?.children].flat(Infinity).flatMap(nodes)];
const text = value => typeof value === 'string' ? value : typeof value === 'object' && value ? [value.props?.children].flat(Infinity).map(text).join(' ') : '';

function mount(t, patch = {}) {
    const slots = [], effects = [], begins = [], proofs = [], acquisitions = [], creations = [], cancellations = [];
    let cursor = 0, dirty = false, mounted = true, tree;
    const props = { authenticated: true, accountKey: 'parent-one', clients: [{ clientKey: 'google-web', provider: 'google' }],
        api: { config: async () => config,
            begin(...args) { const pending = deferred(); begins.push({ ...pending, args }); return pending.promise; },
            complete(...args) { const pending = deferred(); proofs.push({ ...pending, args }); return pending.promise; },
            createChild(...args) { const pending = deferred(); creations.push({ ...pending, args }); return pending.promise; },
            async cancel(state) { cancellations.push(state); },
        }, acquire(...args) { const pending = deferred(); acquisitions.push({ ...pending, args }); return pending.promise; }, ...patch };
    globalThis[fixtureKey] = {
        state(initial) { const slot = slots[cursor++] ??= { value: initial }; return [slot.value, next => {
            const value = typeof next === 'function' ? next(slot.value) : next;
            if (!Object.is(slot.value, value)) { slot.value = value; dirty = true; }
        }]; }, ref(initial) { return slots[cursor++] ??= { current: initial }; },
        effect(callback, deps) { const index = cursor++; const previous = slots[index];
            if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) {
                const slot = slots[index] = { deps, cleanup: previous?.cleanup };
                effects.push(() => { slot.cleanup?.(); slot.cleanup = callback(); });
            }
        },
    };
    const unmount = () => { if (!mounted) return; mounted = false; slots.forEach(slot => slot.cleanup?.()); };
    t.after(() => { unmount(); delete globalThis[fixtureKey]; });
    const render = (changes = {}) => { Object.assign(props, changes); cursor = 0; dirty = false; tree = Component(props); effects.splice(0).forEach(run => run()); };
    const settle = async () => { for (let n = 0; n < 10; n++) { await new Promise(resolve => setImmediate(resolve));
        if (!mounted || !dirty) return; render(); } assert.fail('hooks did not settle'); };
    const all = predicate => nodes(tree).filter(predicate);
    const find = predicate => all(predicate)[0];
    const button = label => find(node => node.type === 'button' && text(node).replace(/\s+/gu, ' ').includes(label));
    const prepare = async () => { render(); await settle();
        find(node => node.type === 'select').props.onChange({ target: { value: 'ZZ' } });
        all(node => node.type === 'input' && node.props.type === 'checkbox').forEach(node => node.props.onChange({ target: { checked: true } }));
        render(); button('Confirm with Google').props.onClick(); await settle(); };
    const authorize = async () => { await prepare(); const state = random(); begins[0].resolve({ state, nonce: random(), expiresInSeconds: 300 });
        await settle(); acquisitions[0].resolve('synthetic-token'); await settle();
        proofs[0].resolve({ grant: random(), purpose: 'create-child', expiresInSeconds: 300 }); await settle(); return state; };
    return { props, begins, proofs, acquisitions, creations, cancellations, render, settle, all, find, button, prepare, authorize, unmount,
        text: () => text(tree) };
}

test('child credential fields stay absent through consent and provider acquisition, and mount only after parent approval', async t => {
    const view = mount(t); await view.prepare();
    assert.equal(view.all(node => node.type === 'input' && node.props.type !== 'checkbox').length, 0);
    view.begins[0].resolve({ state: random(), nonce: random(), expiresInSeconds: 300 }); await view.settle();
    assert.equal(view.find(node => node.type === 'form'), undefined);
    view.acquisitions[0].resolve('token'); await view.settle(); assert.equal(view.find(node => node.type === 'form'), undefined);
    view.proofs[0].resolve({ grant: random(), purpose: 'create-child', expiresInSeconds: 300 }); await view.settle();
    assert.ok(view.find(node => node.type === 'input' && node.props.type === 'password'));
    assert.equal(view.all(node => node.type === 'input' && node.props.type === 'email').length, 0);
});

test('late begin response after cancellation is explicitly cancelled and cannot launch provider collection', async t => {
    const view = mount(t); await view.prepare(); view.button('Cancel parent').props.onClick(); view.render();
    const state = random(); view.begins[0].resolve({ state, nonce: random(), expiresInSeconds: 300 }); await view.settle();
    assert.deepEqual(view.cancellations, [state]); assert.equal(view.acquisitions.length, 0); assert.equal(view.find(node => node.type === 'form'), undefined);
});

test('cancellation during verification ignores a late approval and aborts the active request', async t => {
    const view = mount(t); await view.prepare(); const state = random();
    view.begins[0].resolve({ state, nonce: random(), expiresInSeconds: 300 }); await view.settle();
    view.acquisitions[0].resolve('token'); await view.settle(); view.button('Cancel parent').props.onClick(); view.render();
    assert.equal(view.proofs[0].args[2].aborted, true);
    view.proofs[0].resolve({ grant: random(), purpose: 'create-child', expiresInSeconds: 300 }); await view.settle();
    assert.equal(view.find(node => node.type === 'form'), undefined); assert.deepEqual(view.cancellations, [state]);
});

test('account change discards the old parent grant and clears entered child credentials', async t => {
    const view = mount(t); const state = await view.authorize();
    view.find(node => node.type === 'input' && node.props.type === 'password').props.onChange({ target: { value: 'synthetic-secret' } }); view.render();
    view.render({ accountKey: 'different-parent' }); await view.settle();
    assert.equal(view.find(node => node.type === 'form'), undefined); assert.deepEqual(view.cancellations, [state]);
});

test('unmount aborts provider acquisition and cancels the exact pending challenge', async t => {
    const view = mount(t); await view.prepare(); const state = random();
    view.begins[0].resolve({ state, nonce: random(), expiresInSeconds: 300 }); await view.settle(); view.unmount();
    assert.equal(view.acquisitions[0].args[2].aborted, true); assert.deepEqual(view.cancellations, [state]);
});

test('confirmed creation clears secrets and truthfully keeps the parent account signed in', async t => {
    const view = mount(t); await view.authorize();
    view.find(node => node.type === 'input' && node.props.type === 'password').props.onChange({ target: { value: 'synthetic-secret' } });
    view.find(node => node.type === 'input' && !node.props.type).props.onChange({ target: { value: 'nickname' } }); view.render();
    void view.find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); await view.settle();
    assert.equal(view.creations.length, 1); assert.equal(view.creations[0].args[1], 'nickname');
    view.creations[0].resolve({ accountId: randomUUID(), userName: 'nickname', scoreVisibility: 'private' }); await view.settle();
    assert.equal(view.find(node => node.type === 'form'), undefined); assert.match(view.text(), /still signed in to your parent account/u);
    view.render({ accountKey: 'another-parent' }); await view.settle();
    assert.doesNotMatch(view.text(), /Created nickname/u);
    assert.equal(view.find(node => node.type === 'select').props.value, '');
    assert.ok(view.all(node => node.type === 'input' && node.props.type === 'checkbox').every(node => !node.props.checked));
});

test('unknown creation outcome never retries automatically or reports cancellation as rollback', async t => {
    const view = mount(t); await view.authorize();
    void view.find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); await view.settle();
    view.creations[0].reject(new Error('synthetic delivery failure')); await view.settle();
    assert.equal(view.creations.length, 1); assert.equal(view.find(node => node.type === 'form'), undefined);
    assert.match(view.text(), /check the account before trying again/u);
});

test('an unauthenticated parent sees login guidance without child credentials', async t => {
    const view = mount(t, { authenticated: false }); view.render(); await view.settle();
    assert.match(view.text(), /Log in to your own Ludolume account/u); assert.equal(view.all(node => node.type === 'input').length, 0);
});
