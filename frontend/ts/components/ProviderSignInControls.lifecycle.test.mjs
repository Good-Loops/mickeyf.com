import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createViteTestServer } from '../testSupport/createViteTestServer.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const fixtureKey = '__providerControlsLifecycle';
const scope = `globalThis.${fixtureKey}`;
const mocks = {
    react: `export const useState = initial => ${scope}.state(initial);
        export const useRef = initial => ${scope}.ref(initial);
        export const useEffect = (callback, deps) => ${scope}.effect(callback, deps);
        export const useId = () => 'provider-choice-test';`,
    'jsx-runtime': 'export const jsx = (type, props) => ({ type, props }); export const jsxs = jsx;',
    'jsx-dev-runtime': 'export const jsxDEV = (type, props) => ({ type, props });',
    AuthContext: `export const useAuth = () => ${scope}.auth;`,
    providerClient: `export const getAvailableProviderClients = (...args) => ${scope}.clients(...args);
        export const preloadProviderCredential = async () => {};
        export const acquireGoogleCredentialInline = (...args) => ${scope}.acquire(...args);
        export const acquireProviderCredential = (...args) => ${scope}.acquire(...args);`,
    providerSignupPrompt: `export const requestProviderUsername = (...args) => ${scope}.username(...args);`,
    siteAlert: `export default {
        fire: options => ${scope}.alert.fire(options),
        getPopup: () => ${scope}.alert.getPopup(),
        close: () => ${scope}.alert.close(),
    };`,
    apiConfig: 'export const LEGACY_PUBLIC_API_PREVIEW = false;',
};
const server = await createViteTestServer({
    root, configFile: `${root}/vite.config.ts`, appType: 'custom', logLevel: 'silent',
    server: { middlewareMode: true }, ssr: { noExternal: [/^react$/] },
    plugins: [{
        name: 'provider-control-lifecycle-fixture', enforce: 'pre',
        resolveId(source) {
            const name = source.replaceAll('\\', '/').split('/').at(-1).replace(/\.tsx?$/, '');
            if (Object.hasOwn(mocks, name)) return `\0provider-lifecycle:${name}`;
        },
        load(id) {
            if (id.startsWith('\0provider-lifecycle:')) return mocks[id.slice('\0provider-lifecycle:'.length)];
        },
    }],
});
after(() => server.close());
const { default: ProviderSignInControls, InlineGoogleSignIn, ProviderSignInButtons } =
    await server.ssrLoadModule('/ts/components/ProviderSignInControls.tsx');
const google = { clientKey: 'google-web', provider: 'google', platform: 'web', clientId: 'synthetic' };

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

function nodes(node) {
    if (!node || typeof node !== 'object') return [];
    return [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)];
}

function mount(t, Component = InlineGoogleSignIn, overrides = {}) {
    const slots = [], pendingEffects = [], preparation = [], acquisitions = [], completions = [], busy = [];
    const props = { client: google, action: 'login', operationLock: { current: false },
        onBusyChange: value => busy.push(value), onSuccess: t.mock.fn(), ...overrides };
    let cursor = 0, tree, dirty = false, mounted = true, hostRefs = new Set();
    const hooks = {
        auth: {
            loading: false, isAuthenticated: false,
            prepareProviderLogin: (clientKey, options, action) => {
                const response = deferred();
                preparation.push({ clientKey, action, ...options, ...response });
                return response.promise;
            },
            completeProviderLogin: (handle, credential, options) => {
                const response = deferred();
                completions.push({ handle, credential, ...options, ...response });
                return response.promise;
            },
            authenticateWithProvider: t.mock.fn(),
        },
        clients: async () => [google],
        acquire: (client, challenge, host, signal, onReady) => {
            const response = deferred();
            acquisitions.push({ client, challenge, host, signal, ...response });
            onReady?.();
            return response.promise;
        },
        username: t.mock.fn(async () => 'New Player'),
        alert: {},
        state(initial) {
            const slot = slots[cursor++] ??= { value: typeof initial === 'function' ? initial() : initial };
            return [slot.value, next => {
                const value = typeof next === 'function' ? next(slot.value) : next;
                if (!Object.is(slot.value, value)) { slot.value = value; dirty = true; }
            }];
        },
        ref(initial) { return slots[cursor++] ??= { current: initial }; },
        effect(callback, deps) {
            const index = cursor++;
            const previous = slots[index];
            if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) {
                const slot = slots[index] = { deps, cleanup: previous?.cleanup };
                pendingEffects.push(() => { slot.cleanup?.(); slot.cleanup = callback(); });
            }
        },
    };
    const previousFixture = Object.getOwnPropertyDescriptor(globalThis, fixtureKey);
    Object.defineProperty(globalThis, fixtureKey, { configurable: true, value: hooks });
    const unmount = () => {
        if (!mounted) return;
        mounted = false;
        hostRefs.forEach(ref => { ref.current = null; });
        slots.forEach(slot => { slot.cleanup?.(); slot.cleanup = undefined; });
    };
    t.after(() => {
        unmount();
        if (previousFixture) Object.defineProperty(globalThis, fixtureKey, previousFixture);
        else delete globalThis[fixtureKey];
    });
    // Controlled hook scheduling exercises real effects and dependency changes without a DOM or provider SDK.
    const render = (patch = {}) => {
        assert.equal(mounted, true);
        cursor = 0; dirty = false;
        Object.assign(props, patch);
        tree = Component(props);
        const nextRefs = new Set();
        for (const node of nodes(tree)) {
            if (typeof node.type !== 'string' || !node.props?.ref) continue;
            const ref = node.props.ref;
            ref.current ??= {};
            nextRefs.add(ref);
        }
        hostRefs.forEach(ref => { if (!nextRefs.has(ref)) ref.current = null; });
        hostRefs = nextRefs;
        pendingEffects.splice(0).forEach(run => run());
        return tree;
    };
    const settle = async () => {
        for (let count = 0; count < 10; count++) {
            await new Promise(resolve => setImmediate(resolve));
            if (!mounted || !dirty) return;
            render();
        }
        assert.fail('Lifecycle fixture did not settle');
    };
    const giveCredential = async () => {
        preparation.at(-1).resolve({ handle: {}, challenge: {} });
        await settle();
        acquisitions.at(-1).resolve('synthetic-credential');
        await settle();
    };
    return { hooks, props, preparation, acquisitions, completions, busy, render, settle, giveCredential, unmount,
        find: predicate => nodes(tree).find(predicate) };
}

for (const action of ['login', 'signup']) {
    test(`${action}: a mounted authenticated page initializes Google after sign-out`, async t => {
        const view = mount(t, InlineGoogleSignIn, { action });
        view.hooks.auth.isAuthenticated = true;
        assert.equal(view.render(), null);
        assert.equal(view.preparation.length, 0);
        view.hooks.auth.isAuthenticated = false;
        view.render();
        await view.settle();
        assert.equal(view.preparation.length, 1);
        view.preparation[0].resolve({ handle: {}, challenge: {} });
        await view.settle();
        assert.equal(view.acquisitions.length, 1);
        assert.equal(view.find(node => node.props?.className === 'provider-sign-in__google-host').props.inert, false);
        view.render({ rememberMe: true });
        await view.settle();
        assert.equal(view.preparation.length, 1, 'ordinary form changes do not restart provider preparation');
        view.unmount();
        assert.equal(view.acquisitions[0].signal.aborted, true);
    });

    test(`${action}: its own authenticated state update preserves the success callback`, async t => {
        const view = mount(t, InlineGoogleSignIn, { action });
        view.render();
        await view.giveCredential();
        if (action === 'signup') {
            assert.equal(view.preparation[0].action, 'signup');
            assert.equal(view.hooks.username.mock.callCount(), 1);
            assert.equal(view.completions[0].userName, 'New Player');
        }
        const completion = view.completions.at(-1);
        // AuthContext can publish the new session before the awaited completion resumes.
        view.hooks.auth.isAuthenticated = true;
        assert.equal(view.render(), null);
        assert.equal(completion.signal.aborted, false);
        completion.resolve({ user_name: 'Player' });
        await view.settle();
        assert.equal(view.props.onSuccess.mock.callCount(), 1);
        assert.equal(view.props.operationLock.current, false);
        assert.deepEqual(view.busy, [true, false]);
        assert.equal(view.preparation.length, 1);
    });
}

test('unmount during Google preparation aborts and ignores a late prepared attempt', async t => {
    const view = mount(t);
    view.render();
    view.unmount();
    assert.equal(view.preparation[0].signal.aborted, true);
    view.preparation[0].resolve({ handle: {}, challenge: {} });
    await view.settle();
    assert.equal(view.acquisitions.length, 0);
    assert.equal(view.props.onSuccess.mock.callCount(), 0);
    assert.deepEqual(view.busy, []);
});

test('unlinked Google login removes the widget gap and offers explicit account creation without another signup attempt', async t => {
    const view = mount(t);
    view.render();
    await view.giveCredential();
    view.completions[0].resolve({ error: 'REGISTRATION_REQUIRED' });
    await view.settle();
    assert.equal(view.find(node => node.props?.className === 'provider-sign-in__google-host'), undefined);
    assert.equal(view.find(node => node.props?.role === 'alert').props.children, 'This Google account isn’t linked yet.');
    const signup = view.find(node => node.props?.to === '/signup');
    assert(signup);
    assert.equal(signup.props.children, 'Create account');
    assert.equal(view.preparation.length, 1);
    assert.equal(view.completions.length, 1, 'showing the next action cannot create or authenticate an account');
    view.find(node => node.type === 'button' && node.props.children === 'Retry Google sign-in').props.onClick();
    await view.settle();
    assert.equal(view.preparation.length, 2, 'retry remounts the widget host before preparing a new attempt');
    assert(view.find(node => node.props?.className === 'provider-sign-in__google-host'));
    assert.equal(view.preparation[1].action, 'login');
});

test('an initial Apple maintenance outage preserves Google and restores Apple controls after checking recovered capabilities', async t => {
    const view = mount(t, ProviderSignInControls, { action: 'login' });
    const apple = { clientKey: 'apple-web', provider: 'apple', platform: 'web', clientId: 'com.example.web',
        redirectUri: 'https://example.test/login' };
    let healthy = false;
    view.hooks.clients = async () => [google, { ...apple, ...(healthy ? { signup: true } : { issuance: false }) }];
    view.render();
    await view.settle();
    assert(view.find(node => node.type === InlineGoogleSignIn));
    assert(view.find(node => node.type === ProviderSignInButtons).props.clients.some(client => client.issuance === false));
    const retry = view.find(node => node.type === 'button' && node.props.children === 'Check again');
    assert(retry);
    healthy = true;
    retry.props.onClick();
    await view.settle();
    assert.equal(view.find(node => node.type === 'button' && node.props.children === 'Check again'), undefined);
    const restored = view.find(node => node.type === ProviderSignInButtons).props.clients.find(client => client.provider === 'apple');
    assert.equal(restored.issuance, undefined);
    assert.equal(restored.signup, true);
    assert.equal(view.preparation.length, 0, 'checking public capability availability cannot start a provider attempt');
});

test('Google controls are available before the independent Apple SDK preload finishes', async t => {
    const view = mount(t, ProviderSignInControls, { action: 'login' });
    const final = deferred();
    view.hooks.clients = onAvailable => { onAvailable([google]); return final.promise; };
    view.render(); await view.settle();
    assert(view.find(node => node.type === InlineGoogleSignIn));
    const pendingApple = view.find(node => node.type === 'button' && node.props.disabled
        && node.props['aria-label'] === 'Continue with Apple');
    assert(pendingApple);
    assert.equal(view.find(node => node.type === 'button' && node.props.children === 'Check again'), undefined);
    final.resolve([google]); await view.settle();
    assert.equal(view.find(node => node.type === 'button' && node.props['aria-label'] === 'Continue with Apple'), undefined);
    assert.equal(view.find(node => node.type === InlineGoogleSignIn).props.client, google);
});

test('a transient discovery outage retries and restores both trusted web providers without reloading', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const view = mount(t, ProviderSignInControls, { action: 'login' });
    const apple = { clientKey: 'apple-web', provider: 'apple', platform: 'web', clientId: 'com.example.web',
        redirectUri: 'https://example.test/login' };
    let calls = 0;
    view.hooks.clients = async (_onAvailable, onUnavailable) => {
        calls += 1;
        if (calls === 1) { onUnavailable?.(); return []; }
        return [google, apple];
    };
    view.render(); await view.settle();
    assert.equal(view.find(node => node.type === InlineGoogleSignIn), undefined);
    assert.equal(view.find(node => node.type === ProviderSignInButtons), undefined);
    t.mock.timers.tick(1000); await view.settle();
    assert.equal(calls, 2);
    assert.equal(view.find(node => node.type === InlineGoogleSignIn).props.client, google);
    assert.deepEqual(view.find(node => node.type === ProviderSignInButtons).props.clients, [google, apple]);
    assert.deepEqual(view.busy, [], 'configuration retry cannot lock the password form or begin authentication');
    assert.equal(view.preparation.length, 0);
});

test('a trusted empty provider configuration stays empty without automatic retries or error feedback', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const view = mount(t, ProviderSignInControls, { action: 'login' });
    view.hooks.clients = t.mock.fn(async () => []);
    view.render(); await view.settle();
    assert.equal(view.render(), null);
    t.mock.timers.tick(10000); await view.settle();
    assert.equal(view.hooks.clients.mock.callCount(), 1);
    assert.equal(view.find(node => node.props?.role === 'alert'), undefined);
});

test('persistent discovery failure is bounded and exposes an explicit safe retry for native signup', { timeout: 10_000 }, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const view = mount(t, ProviderSignInControls, { action: 'signup' });
    const firstRetryScheduled = deferred(), secondRetryScheduled = deferred();
    const schedule = globalThis.setTimeout;
    t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
        const handle = schedule(callback, delay, ...args);
        if (delay === 1000) firstRetryScheduled.resolve();
        if (delay === 2000) secondRetryScheduled.resolve();
        return handle;
    });
    const native = { clientKey: 'apple-ios', provider: 'apple', platform: 'ios', clientId: 'com.example.app', signup: true };
    let healthy = false, calls = 0;
    view.hooks.clients = async (_onAvailable, onUnavailable) => {
        calls += 1;
        if (healthy) return [native];
        onUnavailable?.(); return [];
    };
    view.render();
    await firstRetryScheduled.promise;
    t.mock.timers.tick(999); assert.equal(calls, 1);
    t.mock.timers.tick(1);
    await secondRetryScheduled.promise;
    t.mock.timers.tick(1999); assert.equal(calls, 2);
    t.mock.timers.tick(1); await view.settle();
    assert.equal(calls, 3);
    assert.equal(view.find(node => node.props?.role === 'status').props.children, 'Sign-in options are temporarily unavailable.');
    const retry = view.find(node => node.type === 'button' && node.props.children === 'Retry sign-in options');
    assert(retry);
    assert.equal(view.find(node => node.type === ProviderSignInButtons), undefined);
    assert.equal(view.find(node => node.type === InlineGoogleSignIn), undefined);
    t.mock.timers.tick(60000); await view.settle();
    assert.equal(calls, 3, 'no background retry loop continues after the bounded attempts');
    view.props.operationLock.current = true;
    retry.props.onClick(); await view.settle();
    assert.equal(calls, 3, 'retry cannot interrupt another form operation');
    view.props.operationLock.current = false;
    healthy = true;
    retry.props.onClick(); await view.settle();
    assert.equal(calls, 4);
    assert.deepEqual(view.find(node => node.type === ProviderSignInButtons).props.clients, [native]);
    assert.equal(view.preparation.length, 0);
    assert.equal(view.acquisitions.length, 0);
    assert.equal(view.props.operationLock.current, false);
});

test('unmount cancels discovery backoff before another request', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const view = mount(t, ProviderSignInControls, { action: 'link' });
    view.hooks.clients = t.mock.fn(async (_onAvailable, onUnavailable) => { onUnavailable?.(); return []; });
    view.render(); await view.settle();
    view.unmount();
    t.mock.timers.tick(10000); await view.settle();
    assert.equal(view.hooks.clients.mock.callCount(), 1);
    assert.deepEqual(view.busy, []);
});

test('a thrown discovery failure is retried but a late rejection after unmount cannot restart it', { timeout: 10_000 }, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const view = mount(t, ProviderSignInControls, { action: 'login' });
    const retryScheduled = deferred(), retryStarted = deferred();
    const schedule = globalThis.setTimeout;
    t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
        const handle = schedule(callback, delay, ...args);
        if (delay === 1000) retryScheduled.resolve();
        return handle;
    });
    let calls = 0, rejectPending;
    view.hooks.clients = () => {
        calls += 1;
        if (calls === 1) return Promise.reject(new Error('private transport details must not appear'));
        return new Promise((_resolve, reject) => { rejectPending = reject; retryStarted.resolve(); });
    };
    view.render();
    // Hook rendering alone does not prove an asynchronous rejected request installed its retry timer.
    await retryScheduled.promise;
    t.mock.timers.tick(999); assert.equal(calls, 1);
    t.mock.timers.tick(1);
    await retryStarted.promise;
    await view.settle();
    assert.equal(calls, 2);
    view.unmount();
    rejectPending(new Error('late private transport details'));
    await view.settle();
    t.mock.timers.tick(10000); await view.settle();
    assert.equal(calls, 2);
    assert.equal(view.preparation.length, 0);
    assert.deepEqual(view.busy, []);
});

test('closed signup choices explain availability without preparing or acquiring credentials', async t => {
    const view = mount(t, ProviderSignInControls, { action: 'signup' });
    const apple = { clientKey: 'apple-web', provider: 'apple', platform: 'web', clientId: 'com.example.web',
        redirectUri: 'https://example.test/login' };
    view.hooks.clients = async () => [google, apple];
    view.render(); await view.settle();
    assert.equal(view.find(node => node.type === InlineGoogleSignIn), undefined);
    const choices = view.find(node => node.type === ProviderSignInButtons);
    for (const client of [google, apple]) {
        choices.props.onSelect(client); await view.settle();
        assert.equal(view.find(node => node.props?.role === 'alert').props.children,
            `Account creation with ${client.provider === 'google' ? 'Google' : 'Apple'} is temporarily unavailable. Please try again later.`);
    }
    assert.equal(view.preparation.length, 0);
    assert.equal(view.acquisitions.length, 0);
    assert.equal(view.completions.length, 0);
    assert.equal(view.hooks.auth.authenticateWithProvider.mock.callCount(), 0);
    assert.deepEqual(view.busy, []);
    assert.equal(view.props.operationLock.current, false);
});

test('unmount during Google completion releases the lock and ignores late success', async t => {
    const view = mount(t);
    view.render();
    await view.giveCredential();
    assert.equal(view.props.operationLock.current, true);
    view.unmount();
    assert.equal(view.completions[0].signal.aborted, true);
    view.completions[0].resolve({ user_name: 'Player' });
    await view.settle();
    assert.equal(view.props.onSuccess.mock.callCount(), 0);
    assert.equal(view.props.operationLock.current, false);
    assert.deepEqual(view.busy, [true, false]);
});

for (const ownsPopup of [true, false]) {
    test(`a delayed linking dialog after unmount ${ownsPopup ? 'closes its own popup' : 'preserves another popup'}`, async t => {
        const view = mount(t, ProviderSignInControls, { action: 'link' });
        const popup = {}, decision = deferred();
        let options;
        const close = t.mock.fn(() => {
            options.didDestroy();
            decision.resolve({ isConfirmed: false });
        });
        view.hooks.alert = {
            fire: supplied => { options = supplied; return decision.promise; },
            getPopup: () => ownsPopup ? popup : {}, close,
        };
        view.render();
        await view.settle();
        view.find(node => node.type === ProviderSignInButtons).props.onSelect(google);
        assert.equal(view.props.operationLock.current, true);
        view.unmount();
        assert.equal(close.mock.callCount(), 0, 'didOpen has not supplied the owned popup yet');
        options.didOpen(popup);
        assert.equal(close.mock.callCount(), ownsPopup ? 1 : 0);
        if (!ownsPopup) {
            options.didDestroy();
            decision.resolve({ isConfirmed: false });
        }
        await view.settle();
        assert.equal(view.hooks.auth.authenticateWithProvider.mock.callCount(), 0);
        assert.equal(view.props.onSuccess.mock.callCount(), 0);
        assert.equal(view.props.operationLock.current, false);
        assert.deepEqual(view.busy, [true, false]);
    });
}
