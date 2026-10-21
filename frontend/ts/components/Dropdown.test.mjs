import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createViteTestServer } from '../testSupport/createViteTestServer.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const fixtureKey = '__dropdownTestHooks';
const server = await createViteTestServer({
    root, configFile: `${root}/vite.config.ts`, logLevel: 'silent',
    appType: 'custom', server: { middlewareMode: true },
    ssr: { noExternal: [/^react$/] },
    plugins: [{
        name: 'dropdown-hook-fixture', enforce: 'pre',
        resolveId(source) {
            if (source === 'react') return '\0dropdown-react';
            if (source.startsWith('react/jsx-')) return '\0dropdown-jsx';
        },
        load(id) {
            if (id === '\0dropdown-jsx') return `export const jsxDEV = (type, props) => ({ type, props, ref: props.ref });
                export const jsx = jsxDEV; export const jsxs = jsxDEV;`;
            if (id !== '\0dropdown-react') return;
            return `export default {};
                export const useState = () => globalThis.${fixtureKey}.useState();
                export const useRef = () => globalThis.${fixtureKey}.useRef();
                export const useEffect = effect => globalThis.${fixtureKey}.effects.push(effect);
                export const useId = () => 'dropdown-options-test';`;
        },
    }],
});
after(() => server.close());
const { default: Dropdown } = await server.ssrLoadModule('/ts/components/Dropdown.tsx');

function mount(t, overrides = {}) {
    let open = false;
    let refIndex = 0;
    let cleanups = [];
    const listeners = new Set();
    const selected = [];
    const focused = [];
    const trigger = { focus: () => focused.push('trigger') };
    const option = {};
    const wrapper = { contains: node => node === trigger || node === option };
    const refs = [{ current: wrapper }, { current: trigger }];
    const hooks = {
        effects: [],
        useState: () => [open, next => { open = typeof next === 'function' ? next(open) : next; }],
        useRef: () => refs[refIndex++],
    };
    const props = {
        options: [{ value: 'C', label: 'C' }, { value: 'D', label: 'D' }],
        value: 'C', onChange: value => selected.push(value), ...overrides,
    };
    const previousHooks = Object.getOwnPropertyDescriptor(globalThis, fixtureKey);
    const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    Object.defineProperty(globalThis, fixtureKey, { configurable: true, value: hooks });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: {
        addEventListener: (type, handler) => { assert.equal(type, 'click'); listeners.add(handler); },
        removeEventListener: (type, handler) => { assert.equal(type, 'click'); listeners.delete(handler); },
    } });
    const unmount = () => { cleanups.forEach(cleanup => cleanup?.()); cleanups = []; };
    t.after(() => {
        unmount();
        for (const [key, previous] of [[fixtureKey, previousHooks], ['document', previousDocument]]) {
            if (previous) Object.defineProperty(globalThis, key, previous);
            else delete globalThis[key];
        }
    });
    // Controlled hook scheduling tests handlers/markup; real browser focus is checked separately.
    const render = (patch = {}) => {
        unmount(); refIndex = 0; hooks.effects = [];
        Object.assign(props, patch);
        const wrapper = Dropdown(props);
        cleanups = hooks.effects.map(effect => effect());
        const [button, menu] = wrapper.props.children;
        return { wrapper, button, menu };
    };
    const show = () => { render().button.props.onClick(); return render(); };
    return { render, show, listeners, selected, focused, trigger, option, unmount };
}

test('closed dropdown is inert and its trigger identifies the controlled list', t => {
    const { render, listeners } = mount(t);
    const { button, menu } = render();
    assert.equal(menu.props.inert, true);
    assert.equal(button.props['aria-expanded'], false);
    assert.equal(button.props['aria-controls'], menu.props.id);
    assert.equal(menu.props.role, undefined, 'plain buttons must not claim ARIA menu semantics');
    assert.equal(listeners.size, 0);
});

test('outside listener exists only while open and is removed on close/unmount', t => {
    const view = mount(t);
    assert.equal(view.show().menu.props.inert, false);
    assert.equal(view.listeners.size, 1);
    [...view.listeners][0]({ target: view.option });
    assert.equal(view.render().button.props['aria-expanded'], true);
    [...view.listeners][0]({ target: {} });
    assert.equal(view.render().menu.props.inert, true);
    assert.equal(view.listeners.size, 0);
    view.show();
    view.unmount();
    assert.equal(view.listeners.size, 0);
});

test('Escape closes and restores trigger focus without affecting other keys', t => {
    const view = mount(t);
    const { wrapper } = view.show();
    const events = [];
    const event = { preventDefault: () => events.push('prevent'), stopPropagation: () => events.push('stop') };
    wrapper.props.onKeyDown({ ...event, key: 'ArrowDown' });
    assert.deepEqual(events, []);
    wrapper.props.onKeyDown({ ...event, key: 'Escape' });
    assert.deepEqual(events, ['prevent', 'stop']);
    assert.deepEqual(view.focused, ['trigger']);
    assert.equal(view.render().menu.props.inert, true);
});

test('focus leaving the dropdown closes it without moving focus back', t => {
    const view = mount(t);
    const { wrapper } = view.show();
    const currentTarget = wrapper.ref.current;
    wrapper.props.onBlur({ currentTarget, relatedTarget: view.option });
    assert.equal(view.render().button.props['aria-expanded'], true);
    wrapper.props.onBlur({ currentTarget, relatedTarget: {} });
    assert.equal(view.render().menu.props.inert, true);
    assert.deepEqual(view.focused, []);
});

test('selection preserves the value contract, closes and returns focus', t => {
    const view = mount(t, { className: 'p4-key', renderSelected: (_, label) => `Key: ${label}` });
    const { wrapper, button } = view.show();
    assert.match(wrapper.props.className, /dropdown--open active p4-key/);
    assert.equal(button.props.children[0].props.children, 'Key: C');
    wrapper.props.onBlur({ currentTarget: wrapper.ref.current, relatedTarget: null });
    const afterBlur = view.render();
    assert.equal(afterBlur.menu.props.inert, false, 'null blur must not swallow the later option click');
    afterBlur.menu.props.children[1].props.children.props.onClick();
    assert.deepEqual(view.selected, ['D']);
    assert.deepEqual(view.focused, ['trigger']);
    assert.equal(view.render().menu.props.inert, true);
});

test('disabling an open dropdown closes it and does not reopen when re-enabled', t => {
    const view = mount(t);
    view.show();
    const disabled = view.render({ disabled: true });
    assert.equal(disabled.menu.props.inert, true);
    assert.equal(disabled.button.props.disabled, true);
    disabled.menu.props.children[0].props.children.props.onClick();
    disabled.button.props.onClick();
    assert.deepEqual(view.selected, []);
    assert.equal(view.listeners.size, 0);
    assert.equal(view.render({ disabled: false }).menu.props.inert, true);
});
