import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createViteTestServer } from '../testSupport/createViteTestServer.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const key = '__signupAvailabilityTest';
const scope = `globalThis.${key}`;
const mocks = {
    react: `export const useState = initial => ${scope}.state(initial);
        export const useRef = initial => ${scope}.ref(initial);
        export const useEffect = (callback, deps) => ${scope}.effect(callback, deps); export default {};`,
    'jsx-runtime': 'export const jsx = (type, props) => ({type, props}); export const jsxs = jsx;',
    'jsx-dev-runtime': 'export const jsxDEV = (type, props) => ({type, props});',
    'react-router-dom': 'export const Link = "Link"; export const useNavigate = () => () => {};',
    AuthContext: 'export const useAuth = () => ({login: () => {}});',
    authService: `export const registrationConfigRequest = (...args) => ${scope}.config(...args);
        export const prepareSignupRegistration = async () => null; export const signupRequest = async () => ({});`,
    apiConfig: 'export const LEGACY_PUBLIC_API_PREVIEW = false;',
    scopedAlert: 'export const showScopedAlert = async () => {};',
    ...Object.fromEntries(['StaySignedInCheckbox', 'ProviderSignInControls', 'PublicAccountPreviewNotice']
        .map(name => [name, `export default '${name}';`])),
};
const server = await createViteTestServer({ root, configFile: `${root}/vite.config.ts`, appType: 'custom', logLevel: 'silent',
    server: { middlewareMode: true }, ssr: { noExternal: [/^react$/, /^react-router-dom$/] },
    plugins: [{ name: 'signup-availability-fixture', enforce: 'pre', resolveId(source) {
        const name = source.replaceAll('\\', '/').split('/').at(-1).replace(/\.tsx?$/, '');
        if (Object.hasOwn(mocks, name)) return `\0signup-availability:${name}`;
    }, load(id) { if (id.startsWith('\0signup-availability:')) return mocks[id.slice('\0signup-availability:'.length)]; } }],
});
after(() => server.close());
const { default: SignUp, SignupCredentials, SIGNUP_CONFIG_TIMEOUT_MS } = await server.ssrLoadModule('/ts/pages/SignUp.tsx');
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function fixture(t) {
    const slots = [], effects = [], pending = []; let cursor = 0, view, mounted = true;
    globalThis[key] = {
        state(initial) { const index = cursor++; slots[index] ??= { value: initial }; return [slots[index].value, next => {
            assert.ok(mounted, 'must not update after unmount'); slots[index].value = typeof next === 'function' ? next(slots[index].value) : next;
        }]; },
        ref(initial) { return slots[cursor++] ??= { current: initial }; },
        effect(callback, deps) { const index = cursor++; const previous = slots[index];
            if (!previous || deps.some((value, i) => value !== previous.deps[i])) {
                previous?.cleanup?.(); slots[index] = { deps }; effects.push(() => { slots[index].cleanup = callback(); });
            }
        },
        config(signal) { const item = deferred(); pending.push({ ...item, signal }); return item.promise; },
    };
    const render = () => { cursor = 0; view = SignUp(); while (effects.length) effects.shift()(); };
    const unmount = () => { if (!mounted) return; mounted = false; for (const slot of slots) slot?.cleanup?.(); };
    t.after(() => { unmount(); delete globalThis[key]; });
    const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)];
    const text = () => JSON.stringify(nodes(view).map(node => node.props?.children).flat(Infinity).filter(item => typeof item === 'string'));
    render();
    return { pending, render, unmount, text, hasCredentials: () => nodes(view).some(node => node.type === SignupCredentials),
        retryButton: () => nodes(view).find(node => node.type === 'button')?.props,
        retry: () => nodes(view).find(node => node.type === 'button')?.props.onClick() };
}

test('signup hides credential controls until the live general-audience policy is checked', async t => {
    const f = fixture(t); assert.equal(f.hasCredentials(), false); assert.match(f.text(), /Checking/);
    f.pending[0].resolve({enabled:true, mode:'general-audience'}); await flush(); f.render();
    assert.equal(f.hasCredentials(), true);
});
test('closed signup shows the pause and preserves login and guest links', async t => {
    const f = fixture(t); f.pending[0].resolve({enabled:false}); await flush(); f.render();
    assert.equal(f.hasCredentials(), false); assert.match(f.text(), /temporarily paused/); assert.match(f.text(), /Log in/);
});
test('failed or unsupported policy never presents credential controls and can retry', async t => {
    const f = fixture(t); f.pending[0].resolve(null); await flush(); f.render();
    assert.equal(f.hasCredentials(), false); assert.match(f.text(), /can’t check/);
    f.retry(); f.render(); assert.equal(f.pending.length, 2); assert.equal(f.pending[0].signal.aborted, true);
    f.pending[1].resolve({enabled:true, countries:[]}); await flush(); f.render(); assert.equal(f.hasCredentials(), false);
});
test('a late configuration response cannot update an unmounted page', async t => {
    const f = fixture(t); f.unmount(); f.pending[0].resolve({enabled:true, mode:'general-audience'}); await flush();
    assert.equal(f.pending[0].signal.aborted, true);
});
test('a hung configuration check times out, offers a stable keyboard retry, and ignores its late result', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture(t);
    t.mock.timers.tick(SIGNUP_CONFIG_TIMEOUT_MS); f.render();
    assert.equal(f.pending[0].signal.aborted, true);
    assert.equal(f.hasCredentials(), false); assert.match(f.text(), /can’t check/);
    assert.equal(f.retryButton().type, 'button');
    f.retry(); f.render(); f.render();
    assert.equal(f.pending.length, 2); assert.equal(f.retryButton()['aria-disabled'], true);
    f.retry(); f.render(); assert.equal(f.pending.length, 2);
    f.pending[0].resolve({enabled:true, mode:'general-audience'}); await flush(); f.render();
    assert.equal(f.hasCredentials(), false);
    f.pending[1].resolve({enabled:false}); await flush(); f.render();
    assert.equal(f.hasCredentials(), false); assert.match(f.text(), /temporarily paused/);
});
