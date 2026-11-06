import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createViteTestServer } from '../testSupport/createViteTestServer.mjs';

const key = '__childDailyUsageGuardTest', scope = `globalThis.${key}`;
const mocks = {
    react: `export const useState=v=>${scope}.state(v); export const useEffect=(f,d)=>${scope}.effect(f,d);`,
    'jsx-runtime': 'export const Fragment=Symbol.for("fragment"); export const jsx=(type,props)=>({type,props}); export const jsxs=jsx;',
    'jsx-dev-runtime': 'export const Fragment=Symbol.for("fragment"); export const jsxDEV=(type,props)=>({type,props});',
    apiConfig: 'export const API_BASE="";', apiFetch: `export const apiFetch=(...args)=>${scope}.fetch(...args);`,
};
const root = fileURLToPath(new URL('../../', import.meta.url));
const server = await createViteTestServer({ root, configFile: `${root}/vite.config.ts`, appType: 'custom', logLevel: 'silent',
    server: { middlewareMode: true }, ssr: { noExternal: [/^react$/] }, plugins: [{ name: 'child-usage-guard-test', enforce: 'pre',
        resolveId(source) { const name = source.replaceAll('\\', '/').split('/').at(-1).replace(/\.tsx?$/, ''); if (Object.hasOwn(mocks, name)) return `\0guard:${name}`; },
        load(id) { if (id.startsWith('\0guard:')) return mocks[id.slice('\0guard:'.length)]; },
    }],
});
after(() => server.close());
const { default: Component } = await server.ssrLoadModule('/ts/components/ChildDailyUsageGuard.tsx');
const text = value => typeof value === 'string' ? value : typeof value === 'object' && value ? [value.props?.children].flat(Infinity).map(text).join(' ') : '';

function mount(t) {
    const slots = [], effects = [], requests = []; let cursor = 0, dirty = false, tree, generation = 1;
    const oldDocument = globalThis.document, document = new EventTarget(); document.visibilityState = 'visible'; globalThis.document = document;
    const props = { children: 'GAME CONTENT', authenticated: true, sessionGeneration: 1, captureSessionGeneration: () => generation, language: 'en' };
    globalThis[key] = { fetch(...args) { let resolve; const promise = new Promise(yes => { resolve = yes; }); requests.push({ resolve, args }); return promise; },
        state(initial) { const slot = slots[cursor++] ??= { value: initial }; return [slot.value, next => { slot.value = typeof next === 'function' ? next(slot.value) : next; dirty = true; }]; },
        effect(fn, deps) { const index = cursor++, before = slots[index]; if (!before || deps.some((v, i) => !Object.is(v, before.deps[i]))) { const slot = slots[index] = { deps, cleanup: before?.cleanup }; effects.push(() => { slot.cleanup?.(); slot.cleanup = fn(); }); } },
    };
    const render = () => { cursor = 0; dirty = false; tree = Component(props); effects.splice(0).forEach(run => run()); };
    const settle = async () => { for (let i = 0; i < 6; i++) { await new Promise(resolve => setImmediate(resolve)); if (dirty) render(); } };
    t.after(() => { slots.forEach(slot => slot.cleanup?.()); globalThis.document = oldDocument; delete globalThis[key]; });
    return { props, requests, document, render, settle, text: () => text(tree), changeSession() { generation++; props.sessionGeneration = generation; } };
}

test('child content is available only during the issued time window', async t => {
    const view = mount(t); view.render(); await view.settle(); assert.doesNotMatch(view.text(), /GAME CONTENT/u);
    view.requests[0].resolve({ ok: true, json: async () => ({ status: 'configured', remainingMs: 1000, allowedForMs: 1000 }) });
    await view.settle(); assert.match(view.text(), /daily time limit/u); assert.match(view.text(), /GAME CONTENT/u);
    await new Promise(resolve => setTimeout(resolve, 1100)); await view.settle(); assert.doesNotMatch(view.text(), /GAME CONTENT/u);
});

test('a late response cannot reveal content after an account change', async t => {
    const view = mount(t); view.render(); await view.settle(); view.changeSession(); view.render(); await view.settle();
    view.requests[0].resolve({ ok: true, json: async () => ({ status: 'not-managed' }) }); await view.settle();
    assert.doesNotMatch(view.text(), /GAME CONTENT/u);
    view.requests[1].resolve({ ok: true, json: async () => ({ status: 'configured', remainingMs: 0, allowedForMs: 0 }) });
    await view.settle(); assert.match(view.text(), /reached the daily time limit/u);
});

test('hiding the app expires its view and rejects the in-flight response', async t => {
    const view = mount(t); view.render(); await view.settle();
    view.document.visibilityState = 'hidden'; view.document.dispatchEvent(new Event('visibilitychange')); await view.settle();
    view.requests[0].resolve({ ok: true, json: async () => ({ status: 'not-managed' }) }); await view.settle();
    assert.doesNotMatch(view.text(), /GAME CONTENT/u);
    view.document.visibilityState = 'visible'; view.document.dispatchEvent(new Event('visibilitychange')); await view.settle();
    view.requests[1].resolve({ ok: false }); await view.settle();
    assert.match(view.text(), /cannot check your daily time limit/u);
    assert.doesNotMatch(view.text(), /GAME CONTENT/u);
});

test('unmanaged accounts do not poll, but are rechecked when returning to the foreground', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const view = mount(t); view.render(); await view.settle();
    view.requests[0].resolve({ ok: true, json: async () => ({ status: 'not-managed' }) }); await view.settle();
    assert.match(view.text(), /GAME CONTENT/u);
    t.mock.timers.tick(90_000); await view.settle(); assert.equal(view.requests.length, 1);
    view.document.visibilityState = 'hidden'; view.document.dispatchEvent(new Event('visibilitychange')); await view.settle();
    view.document.visibilityState = 'visible'; view.document.dispatchEvent(new Event('visibilitychange')); await view.settle();
    assert.equal(view.requests.length, 2);
});

test('a managed account without a limit continues checking for a new parent setting', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const view = mount(t); view.render(); await view.settle();
    view.requests[0].resolve({ ok: true, json: async () => ({ status: 'not-configured' }) }); await view.settle();
    assert.match(view.text(), /GAME CONTENT/u);
    t.mock.timers.tick(30_000); await view.settle(); assert.equal(view.requests.length, 2);
    view.requests[1].resolve({ ok: true, json: async () => ({ status: 'configured', remainingMs: 0, allowedForMs: 0 }) });
    await view.settle(); assert.match(view.text(), /reached the daily time limit/u);
});
