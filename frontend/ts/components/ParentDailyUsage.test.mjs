import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createViteTestServer } from '../testSupport/createViteTestServer.mjs';

const key = '__parentDailyUsageTest', scope = `globalThis.${key}`;
const mocks = {
    react: `export const useState = v => ${scope}.state(v); export const useRef = v => ${scope}.ref(v); export const useEffect = (fn, deps) => ${scope}.effect(fn, deps);`,
    'jsx-runtime': 'export const jsx = (type, props) => ({type, props}); export const jsxs = jsx;',
    'jsx-dev-runtime': 'export const jsxDEV = (type, props) => ({type, props});',
    apiConfig: 'export const API_BASE = "";', apiFetch: `export const apiFetch = (...args) => ${scope}.fetch(...args);`,
    pageOwnership: `export const capturePageOwnership = () => () => ${scope}.pageCurrent;`,
};
const root = fileURLToPath(new URL('../../', import.meta.url));
const server = await createViteTestServer({ root, configFile: `${root}/vite.config.ts`, appType: 'custom', logLevel: 'silent',
    server: { middlewareMode: true }, ssr: { noExternal: [/^react$/] }, plugins: [{ name: 'daily-usage-test', enforce: 'pre',
        resolveId(source) { const name = source.replaceAll('\\', '/').split('/').at(-1).replace(/\.tsx?$/, ''); if (Object.hasOwn(mocks, name)) return `\0daily:${name}`; },
        load(id) { if (id.startsWith('\0daily:')) return mocks[id.slice('\0daily:'.length)]; },
    }],
});
after(() => server.close());
const { default: Component } = await server.ssrLoadModule('/ts/components/ParentDailyUsage.tsx');
const nodes = value => !value || typeof value !== 'object' ? [] : [value, ...[value.props?.children].flat(Infinity).flatMap(nodes)];
const text = value => typeof value === 'string' ? value : typeof value === 'object' && value ? [value.props?.children].flat(Infinity).map(text).join(' ') : '';
const reply = value => ({ ok: true, json: async () => value });

function mount(t, language = 'en') {
    const slots = [], effects = [], requests = []; let cursor = 0, dirty = false, tree, selected = true;
    const childAccountId = randomUUID(), selectionIsCurrent = () => selected, captureSessionGeneration = () => 1, captureAccountAction = () => 0;
    globalThis[key] = { pageCurrent: true, fetch(...args) { let resolve; const promise = new Promise(yes => { resolve = yes; }); requests.push({ resolve, args }); return promise; },
        state(initial) { const slot = slots[cursor++] ??= { value: initial }; return [slot.value, next => { const value = typeof next === 'function' ? next(slot.value) : next; if (!Object.is(value, slot.value)) { slot.value = value; dirty = true; } }]; },
        ref(initial) { return slots[cursor++] ??= { current: initial }; },
        effect(callback, deps) { const index = cursor++, before = slots[index]; if (!before || deps.some((v, i) => !Object.is(v, before.deps[i]))) { const slot = slots[index] = { deps, cleanup: before?.cleanup }; effects.push(() => { slot.cleanup?.(); slot.cleanup = callback(); }); } },
    };
    const render = () => { cursor = 0; dirty = false; tree = Component({ language, childAccountId, sessionGeneration: 1, selectionIsCurrent, captureSessionGeneration, captureAccountAction }); effects.splice(0).forEach(run => run()); };
    const settle = async () => { for (let i = 0; i < 8; i++) { await new Promise(resolve => setImmediate(resolve)); if (dirty) render(); } assert.equal(dirty, false); };
    t.after(() => { slots.forEach(slot => slot.cleanup?.()); delete globalThis[key]; });
    return { render, settle, requests, childAccountId, text: () => text(tree), nodes: () => nodes(tree), deselect: () => { selected = false; } };
}

test('parent can view and change the selected child limit only after confirmation', async t => {
    const view = mount(t); view.render(); await view.settle();
    const usage = { day: '2026-11-05', timeZone: 'America/Sao_Paulo', dailyLimitMs: 120_000, usedMs: 60_000, remainingMs: 60_000 };
    view.requests[0].resolve(reply({ usage })); await view.settle();
    assert.match(view.text(), /Used on 2026-11-05: 1 min/u);
    const number = view.nodes().find(node => node.type === 'input' && node.props.type === 'number');
    number.props.onChange({ target: { value: '3' } }); view.render();
    view.nodes().find(node => node.type === 'button' && text(node).includes('Save limit')).props.onClick(); await view.settle();
    assert.deepEqual(JSON.parse(view.requests[1].args[1].body), { childAccountId: view.childAccountId, timeZone: usage.timeZone, dailyLimitMs: 180_000 });
    assert.doesNotMatch(view.text(), /Limit saved/u);
    view.requests[1].resolve(reply({ usage: { ...usage, dailyLimitMs: 180_000 } })); await view.settle();
    assert.match(view.text(), /Limit saved/u);
    view.nodes().find(node => node.type === 'button' && text(node).includes('Turn off limit')).props.onClick(); await view.settle();
    assert.deepEqual(JSON.parse(view.requests[2].args[1].body), { childAccountId: view.childAccountId });
    view.requests[2].resolve({ ok: true }); await view.settle();
    assert.match(view.text(), /Limit and current total removed/u);
});

test('late responses for a deselected child do not appear', async t => {
    const view = mount(t, 'pt-BR'); view.render(); await view.settle(); view.deselect();
    view.requests[0].resolve(reply({ usage: { day: '2026-11-05', timeZone: 'UTC', dailyLimitMs: 60_000, usedMs: 0, remainingMs: 60_000 } }));
    await view.settle(); assert.doesNotMatch(view.text(), /Uso em 2026/u);
});

test('parent controls and the online-only limitation are available in Portuguese', async t => {
    const view = mount(t, 'pt-BR'); view.render(); await view.settle();
    view.requests[0].resolve(reply({ usage: null })); await view.settle();
    assert.match(view.text(), /Nenhum limite diário definido/u);
    assert.match(view.text(), /Não limita o uso como visitante, offline/u);
    assert.match(view.text(), /Salvar limite/u);
});
