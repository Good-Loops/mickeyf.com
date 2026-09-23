import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createViteTestServer } from '../testSupport/createViteTestServer.mjs';

const frontendRoot = fileURLToPath(new URL('../../', import.meta.url));
const key = '__authFeedbackFixture';
const scope = `globalThis.${key}`;
const authOperations = ['loginRequest', 'logoutRequest', 'verifyRequest', 'renewRequest',
    'deleteAccountRequest', 'runProviderAuthentication', 'watchAppleCredentialChanges',
    'prepareProviderLogin', 'completeProviderLogin'];
const mocks = {
    react: `export const createContext = () => ({ Provider: 'AuthProvider' });
        export const useContext = () => undefined;
        export const useState = initial => ${scope}.state(initial);
        export const useRef = initial => ${scope}.ref(initial);
        export const useEffect = () => {};`,
    'jsx-runtime': 'export const jsx = (type, props) => ({ type, props }); export const jsxs = jsx;',
    'jsx-dev-runtime': 'export const jsxDEV = (type, props) => ({ type, props });',
    authService: authOperations.map(name => `export const ${name} = (...args) => ${scope}.request('${name}', args);`).join('\n'),
    sessionRenewalActivity: 'export const watchSessionRenewalActivity = () => {};',
    siteAlert: `export default { fire: (...args) => ${scope}.feedback(...args) };`,
};
const server = await createViteTestServer({
    root: frontendRoot, configFile: `${frontendRoot}/vite.config.ts`, logLevel: 'silent',
    appType: 'custom', server: { middlewareMode: true }, ssr: { noExternal: [/^react$/] },
    plugins: [{ name: 'auth-feedback-fixture', enforce: 'pre',
        resolveId(source) {
            const name = source.replaceAll('\\', '/').split('/').at(-1).replace(/\.tsx?$/, '');
            if (Object.hasOwn(mocks, name)) return `\0auth-feedback:${name}`;
        },
        load(id) { if (id.startsWith('\0auth-feedback:')) return mocks[id.slice('\0auth-feedback:'.length)]; },
    }],
});
after(() => server.close());
const { AuthProvider } = await server.ssrLoadModule('/ts/context/AuthContext.tsx');

function fixture(t, request) {
    const slots = [], feedback = [];
    let cursor = 0;
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value: {
        state(initial) {
            const index = cursor++;
            slots[index] ??= { value: initial };
            return [slots[index].value, value => { slots[index].value = value; }];
        },
        ref(initial) { return slots[cursor++] ??= { current: initial }; },
        request,
        feedback: async options => { feedback.push(options); return { isConfirmed: true }; },
    } });
    t.after(() => {
        if (original) Object.defineProperty(globalThis, key, original);
        else delete globalThis[key];
    });
    const render = () => { cursor = 0; return AuthProvider({ children: null }).props.value; };
    return { render, feedback };
}

test('page departure suppresses login feedback while retaining confirmed authentication', async t => {
    let finish;
    const controller = new AbortController();
    const f = fixture(t, (operation, args) => {
        assert.equal(operation, 'loginRequest');
        assert.deepEqual(args, [{ user_name: 'Player', user_password: 'synthetic', remember_me: true }]);
        return new Promise(resolve => { finish = resolve; });
    });
    const pending = f.render().login('Player', 'synthetic', { feedbackSignal: controller.signal, rememberMe: true });
    controller.abort();
    finish({ user_name: 'Player' });
    assert.equal(await pending, true);
    const auth = f.render();
    assert.equal(auth.isAuthenticated, true);
    assert.equal(auth.userName, 'Player');
    assert.equal(auth.loading, false);
    assert.deepEqual(f.feedback, []);
});

test('ordinary login still displays success feedback without a lifetime signal', async t => {
    const f = fixture(t, async operation => {
        assert.equal(operation, 'loginRequest');
        return { user_name: 'Player' };
    });
    assert.equal(await f.render().login('Player', 'synthetic'), true);
    assert.equal(f.render().isAuthenticated, true);
    assert.equal(f.feedback.length, 1);
    assert.equal(f.feedback[0].title, 'Welcome back!');
});

test('a newer logout still owns authentication when old login feedback is cancelled', async t => {
    let finishLogin;
    const controller = new AbortController();
    const f = fixture(t, operation => {
        if (operation === 'loginRequest') return new Promise(resolve => { finishLogin = resolve; });
        assert.equal(operation, 'logoutRequest');
        return Promise.resolve();
    });
    const auth = f.render();
    const pending = auth.login('Player', 'synthetic', { feedbackSignal: controller.signal });
    await auth.logout();
    controller.abort();
    finishLogin({ user_name: 'Player' });
    assert.equal(await pending, false);
    assert.equal(f.render().isAuthenticated, false);
    assert.equal(f.render().userName, null);
    assert.deepEqual(f.feedback, []);
});

for (const outcome of ['AUTH_FAILED', 'SESSION_NOT_ESTABLISHED', 'network-failure']) {
    test(`page departure suppresses ${outcome} feedback`, async t => {
        const controller = new AbortController();
        t.mock.method(console, 'error', () => {});
        const f = fixture(t, async operation => {
            assert.equal(operation, 'loginRequest');
            controller.abort();
            if (outcome === 'network-failure') throw new Error('Synthetic network failure');
            return { error: outcome };
        });
        assert.equal(await f.render().login('Player', 'synthetic', { feedbackSignal: controller.signal }), false);
        assert.equal(f.render().isAuthenticated, false);
        assert.deepEqual(f.feedback, []);
    });
}
