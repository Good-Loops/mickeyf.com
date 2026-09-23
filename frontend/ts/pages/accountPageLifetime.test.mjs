import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createViteTestServer } from '../testSupport/createViteTestServer.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const key = '__accountPageLifetimeTest';
const scope = `globalThis.${key}`;
const mocks = {
    react: `export const useState = initial => ${scope}.state(initial);
        export const useRef = initial => ${scope}.ref(initial);
        export const useEffect = callback => ${scope}.effect(callback); export default {};`,
    'jsx-runtime': 'export const jsx = (type, props) => ({type, props}); export const jsxs = jsx;',
    'jsx-dev-runtime': 'export const jsxDEV = (type, props) => ({type, props});',
    'react-router-dom': `export const useNavigate = () => path => ${scope}.navigations.push(path);`,
    AuthContext: `export const useAuth = () => ({ login: (...args) => ${scope}.login(...args) });`,
    authService: `export const signupRequest = (...args) => ${scope}.signup(...args);`,
    apiConfig: 'export const LEGACY_PUBLIC_API_PREVIEW = false;',
    scopedAlert: `export const showScopedAlert = (...args) => ${scope}.alert(...args);`,
    ...Object.fromEntries(['StaySignedInCheckbox', 'ProviderSignInControls', 'PublicAccountPreviewNotice']
        .map(name => [name, `export default '${name}';`])),
};
const server = await createViteTestServer({
    root, configFile: `${root}/vite.config.ts`, appType: 'custom', logLevel: 'silent',
    server: { middlewareMode: true }, ssr: { noExternal: [/^react$/, /^react-router-dom$/] },
    plugins: [{ name: 'account-page-lifetime-fixture', enforce: 'pre',
        resolveId(source) {
            const name = source.replaceAll('\\', '/').split('/').at(-1).replace(/\.tsx?$/, '');
            if (Object.hasOwn(mocks, name)) return `\0account-page:${name}`;
        },
        load(id) { if (id.startsWith('\0account-page:')) return mocks[id.slice('\0account-page:'.length)]; },
    }],
});
after(() => server.close());
const { default: Login } = await server.ssrLoadModule('/ts/pages/Login.tsx');
const { default: SignUp } = await server.ssrLoadModule('/ts/pages/SignUp.tsx');
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};

// A hook fixture, not a browser/layout test. Transport and alerts are controlled promises.
function fixture(t, Page) {
    const slots = [], effects = [], navigations = [], logins = [], alerts = [];
    const registration = deferred(), authentication = deferred(), feedback = deferred();
    let cursor = 0, view, mounted = true;
    const hooks = {
        navigations,
        state(initial) {
            const index = cursor++;
            slots[index] ??= { value: initial };
            return [slots[index].value, next => {
                assert.ok(mounted, 'departed pages must not update state'); slots[index].value = next;
            }];
        },
        ref(initial) { return slots[cursor++] ??= { current: initial }; },
        effect(callback) {
            const index = cursor++;
            if (!slots[index]) { slots[index] = {}; effects.push(callback); }
        },
        signup: () => registration.promise,
        login: (...args) => { logins.push(args); return authentication.promise; },
        alert: (options, signal) => {
            assert.equal(signal.aborted, false, 'departed pages must not request feedback');
            alerts.push(options); return feedback.promise;
        },
    };
    globalThis[key] = hooks;
    const render = () => { cursor = 0; view = Page(); };
    render();
    let cleanups = effects.map(effect => effect());
    const unmount = () => { mounted = false; cleanups.forEach(cleanup => cleanup?.()); };
    t.after(() => { unmount(); delete globalThis[key]; });
    function nodes(node) {
        if (!node || typeof node !== 'object') return [];
        return [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)];
    }
    const find = predicate => nodes(view).find(predicate)?.props;
    return { render, unmount, registration, authentication, feedback, logins, alerts, navigations,
        submit: () => find(node => node.type === 'form').onSubmit({ preventDefault() {} }),
        remember: () => { find(node => node.type === 'StaySignedInCheckbox').onChange(true); render(); },
        replayEffects: () => {
            cleanups.forEach(cleanup => cleanup?.()); cleanups = effects.map(effect => effect());
        },
    };
}

test('login preserves stay-signed-in and normal successful navigation', async t => {
    const f = fixture(t, Login); f.remember();
    const submitted = f.submit();
    assert.equal(f.logins[0][2].rememberMe, true);
    assert.equal(f.logins[0][2].feedbackSignal.aborted, false);
    f.authentication.resolve(true); await submitted;
    assert.deepEqual(f.navigations, ['/']);
});

test('leaving login aborts feedback and prevents its late redirect', async t => {
    const f = fixture(t, Login);
    const submitted = f.submit(); f.unmount();
    assert.equal(f.logins[0][2].feedbackSignal.aborted, true);
    f.authentication.resolve(true); await submitted;
    assert.deepEqual(f.navigations, []);
});

test('effect replay replaces the signal without reviving earlier work', async t => {
    const f = fixture(t, Login);
    const submitted = f.submit();
    const oldSignal = f.logins[0][2].feedbackSignal;
    f.replayEffects(); f.authentication.resolve(true); await submitted;
    assert.equal(oldSignal.aborted, true);
    assert.deepEqual(f.navigations, []);
    await f.submit();
    assert.notEqual(f.logins[1][2].feedbackSignal, oldSignal);
    assert.equal(f.logins[1][2].feedbackSignal.aborted, false);
});

test('leaving during signup prevents automatic login, feedback and navigation', async t => {
    const f = fixture(t, SignUp);
    const submitted = f.submit(); f.unmount();
    f.registration.resolve({ success: true }); await submitted;
    assert.deepEqual(f.logins, []);
    assert.deepEqual(f.alerts, []);
    assert.deepEqual(f.navigations, []);
});

test('leaving during signup automatic login suppresses its late feedback', async t => {
    const f = fixture(t, SignUp);
    const submitted = f.submit(); f.registration.resolve({ success: true }); await flush();
    assert.equal(f.logins.length, 1);
    f.unmount(); f.authentication.resolve(true); await submitted;
    assert.deepEqual(f.alerts, []);
    assert.deepEqual(f.navigations, []);
});

for (const authenticated of [true, false]) {
    test(`signup ${authenticated ? 'success' : 'login fallback'} redirects only while its page is current`, async t => {
        const f = fixture(t, SignUp); f.remember();
        const submitted = f.submit(); await f.submit(); // Duplicate submit is ignored.
        f.registration.resolve({ success: true }); f.authentication.resolve(authenticated); await flush();
        assert.equal(f.logins.length, 1);
        assert.deepEqual(f.logins[0][2], { rememberMe: true, showFeedback: false });
        assert.equal(f.alerts[0].title, authenticated ? "You're all set!" : 'Account created');
        f.feedback.resolve(); await submitted;
        assert.deepEqual(f.navigations, [authenticated ? '/' : '/login']);
    });
    test(`leaving the signup ${authenticated ? 'success' : 'fallback'} alert prevents navigation`, async t => {
        const f = fixture(t, SignUp);
        const submitted = f.submit();
        f.registration.resolve({ success: true }); f.authentication.resolve(authenticated); await flush();
        assert.equal(f.alerts.length, 1);
        f.unmount(); f.feedback.resolve(); await submitted;
        assert.deepEqual(f.navigations, []);
    });
}

for (const response of ['rejected', 'network failure']) {
    test(`departed signup ignores a late ${response}`, async t => {
        const f = fixture(t, SignUp);
        const submitted = f.submit(); f.unmount();
        if (response === 'rejected') f.registration.resolve({ error: 'DUPLICATE_USER' });
        else f.registration.reject(new Error('synthetic network failure'));
        await submitted;
        assert.deepEqual(f.alerts, []);
        assert.deepEqual(f.logins, []);
    });
}

test('current signup still shows registration rejection feedback', async t => {
    const f = fixture(t, SignUp);
    const submitted = f.submit(); f.registration.resolve({ error: 'DUPLICATE_USER' }); await flush();
    assert.equal(f.alerts[0].title, 'Duplicate user');
    assert.deepEqual(f.logins, []);
    f.feedback.resolve(); await submitted;
});
