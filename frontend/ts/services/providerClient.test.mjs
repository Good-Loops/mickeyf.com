import assert from 'node:assert/strict';
import test from 'node:test';
import { createProviderClient, ProviderCredentialError } from './providerClient.ts';

const google = { clientKey: 'google-web', provider: 'google', platform: 'web', clientId: 'synthetic.apps.googleusercontent.com' };
const apple = { clientKey: 'apple-ios', provider: 'apple', platform: 'ios', clientId: 'com.example.synthetic' };
const challenge = { state: Buffer.alloc(32, 1).toString('base64url'),
    nonce: Buffer.alloc(32, 2).toString('base64url'), expiresInSeconds: 300 };
const token = 'synthetic.header.signature';
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
const signal = () => new AbortController().signal;
const rejectsCode = (promise, code) => assert.rejects(promise, error => {
    assert.ok(error instanceof ProviderCredentialError);
    assert.equal(error.code, code);
    assert.doesNotMatch(error.message, /private|synthetic\.header/);
    assert.equal('cause' in error, false);
    return true;
});

function fixture(overrides = {}) {
    const calls = [];
    const scripts = [];
    const controls = { popup: null, alertOptions: null, sdk: undefined, initialization: null,
        rendered: null, closeCount: 0, nativeCancelCount: 0 };
    let dismiss;
    const sdk = {
        initialize(options) { controls.initialization = options; },
        renderButton(host, options) { controls.rendered = { host, options }; },
    };
    const identity = {
        async getCapabilities() { calls.push('capabilities'); return { apple: true, google: false }; },
        async signIn(input) { calls.push(['native', input]); return { identityToken: token }; },
        async cancel() { controls.nativeCancelCount++; },
        ...overrides.identity,
    };
    const alert = {
        isVisible() { return controls.popup !== null; },
        getPopup() { return controls.popup; },
        fire(options) {
            controls.alertOptions = options;
            controls.popup = { own: true };
            const popup = controls.popup;
            const result = new Promise(resolve => { dismiss = resolve; });
            queueMicrotask(() => options.didOpen?.(popup));
            return result;
        },
        close() {
            controls.closeCount++;
            const previous = controls.popup;
            controls.popup = null;
            controls.alertOptions.willClose?.(previous);
            controls.alertOptions.didDestroy?.();
            dismiss({ isDismissed: true });
        },
    };
    const document = {
        createElement(tag) {
            return { tag, style: {}, textContent: '', removed: false,
                replaceChildren() { this.textContent = ''; }, remove() { this.removed = true; } };
        },
        head: { appendChild(script) { scripts.push(script); } },
    };
    const client = createProviderClient({
        apiBase: 'https://api.example.test', platform: 'web', isNative: false, identity, alert, document,
        google: () => controls.sdk,
        async fetchRequest(url, init) {
            calls.push(['fetch', url, init]);
            return Response.json({ clients: [google, apple] });
        },
        ...overrides,
        identity,
    });
    return { client, controls, calls, scripts, sdk, alert,
        loadGoogle() { controls.sdk = sdk; scripts.at(-1).onload(); },
        completeGoogle(value = { credential: token, state: challenge.state }) { controls.initialization.callback(value); } };
}

test('discovery selects only server-configured web Google or capability-enabled native iOS Apple without loading SDKs', async () => {
    for (const [platform, isNative, expected] of [['web', false, [google]], ['ios', true, [apple]],
        ['android', true, []], ['web', true, []]]) {
        const f = fixture({ platform, isNative });
        assert.deepEqual(await f.client.getAvailableProviderClients(), expected);
        assert.equal(f.scripts.length, 0);
        assert.equal(f.controls.popup, null);
        const request = f.calls.find(call => Array.isArray(call));
        if (expected.length) {
            assert.equal(request[1], 'https://api.example.test/auth/providers/config');
            assert.equal(request[2].method, 'GET');
            assert.equal(request[2].credentials, 'include');
            assert.equal(request[2].body, undefined);
        } else assert.deepEqual(f.calls, []);
        assert.equal(f.calls.includes('capabilities'), platform === 'ios');
    }
});

test('disabled, malformed and duplicate discovery configurations fail closed', async () => {
    for (const body of [null, [], {}, { clients: [google], enabled: true }, { clients: 'google' },
        { clients: [google, google] }, { clients: [google, apple, google] }, { clients: [{ ...google, provider: 'apple' }] },
        { clients: [{ ...google, clientId: '' }] }, { clients: [{ ...google, clientId: 'x'.repeat(256) }] },
        { clients: [{ ...google, clientId: 'bad client' }] }, { clients: [{ ...google, token: 'private' }] }]) {
        const f = fixture({ fetchRequest: async () => Response.json(body) });
        assert.deepEqual(await f.client.getAvailableProviderClients(), []);
    }
    for (const status of [404, 429, 500]) {
        assert.deepEqual(await fixture({ fetchRequest: async () => Response.json({ clients: [google] }, { status }) })
            .client.getAvailableProviderClients(), []);
    }
    assert.deepEqual(await fixture({ fetchRequest: async () => { throw new Error('private connection details'); } })
        .client.getAvailableProviderClients(), []);
    for (const capabilities of [{ apple: false }, { apple: 'true' }, null, {}]) {
        assert.deepEqual(await fixture({ platform: 'ios', isNative: true,
            identity: { getCapabilities: async () => capabilities } }).client.getAvailableProviderClients(), []);
    }
});

test('discovery has a deadline even when the native capabilities promise never settles', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture({ platform: 'ios', isNative: true, identity: { getCapabilities: () => new Promise(() => {}) } });
    const discovery = f.client.getAvailableProviderClients();
    await nextTurn();
    t.mock.timers.tick(10_000);
    assert.deepEqual(await discovery, []);
});

test('signup is an explicit per-client capability and cannot leak across providers or accept truthy substitutes', async () => {
    const enabled = { ...google, signup: true };
    const f = fixture({ fetchRequest: async () => Response.json({ clients: [enabled, apple] }) });
    const clients = await f.client.getAvailableProviderClients();
    assert.deepEqual(clients, [enabled]);
    assert.equal(Object.isFrozen(clients[0]), true);
    assert.equal(f.scripts.length, 0, 'signup capability discovery does not start provider authentication');
    assert.deepEqual(await fixture().client.getAvailableProviderClients(), [google], 'old servers do not imply signup support');
    for (const client of [{ ...google, signup: false }, { ...google, signup: 'true' },
        { ...google, signup: 1 }, { ...google, signup: null }, { ...apple, signup: 'true' }]) {
        assert.deepEqual(await fixture({ fetchRequest: async () => Response.json({ clients: [client] }) })
            .client.getAvailableProviderClients(), []);
    }
    assert.deepEqual(await fixture({ platform: 'ios', isNative: true,
        fetchRequest: async () => Response.json({ clients: [enabled, apple] }) }).client.getAvailableProviderClients(), [apple]);
    const appleSignup = { ...apple, signup: true };
    assert.deepEqual(await fixture({ platform: 'ios', isNative: true,
        fetchRequest: async () => Response.json({ clients: [google, appleSignup] }) }).client.getAvailableProviderClients(), [appleSignup]);
    assert.deepEqual(await fixture({ fetchRequest: async () => Response.json({ clients: [google, appleSignup] }) })
        .client.getAvailableProviderClients(), [google]);
});

test('explicit Google acquisition loads only the official script and renders a nonce-bound official button', async () => {
    const f = fixture();
    const credential = f.client.acquireProviderCredential(google, challenge, signal());
    await nextTurn();
    assert.equal(f.scripts.length, 1);
    assert.equal(f.scripts[0].src, 'https://accounts.google.com/gsi/client');
    assert.equal(f.scripts[0].async, true);
    assert.equal(f.controls.alertOptions.showConfirmButton, false);
    assert.equal(f.controls.alertOptions.showCancelButton, true);
    assert.equal(f.controls.initialization, null, 'SDK loading does not start sign-in');
    f.loadGoogle();
    await nextTurn();
    const options = f.controls.initialization;
    assert.equal(options.client_id, google.clientId);
    assert.equal(options.nonce, challenge.nonce);
    assert.equal(options.ux_mode, 'popup');
    assert.equal(options.auto_select, false);
    assert.equal(options.button_auto_select, false);
    assert.deepEqual(f.controls.rendered.options, { type: 'standard', theme: 'outline', size: 'large',
        text: 'continue_with', state: challenge.state });
    assert.equal(f.controls.closeCount, 0);
    f.completeGoogle();
    assert.equal(await credential, token);
    assert.equal(f.controls.closeCount, 1);
    assert.equal(f.scripts[0].removed, false, 'a loaded SDK can be reused without another request');
});

function inlineHost() {
    return { clears: 0, replaceChildren() { this.clears++; } };
}

test('inline Google renders the official button directly, with no selector dialog or automatic login', async () => {
    const f = fixture();
    const host = inlineHost();
    let ready = 0;
    let received = false;
    const credential = f.client.acquireGoogleCredentialInline(google, challenge, host, signal(), () => { ready++; });
    void credential.then(() => { received = true; });
    await nextTurn();
    assert.equal(f.controls.popup, null);
    assert.equal(f.controls.alertOptions, null);
    assert.equal(f.scripts[0].src, 'https://accounts.google.com/gsi/client');
    f.loadGoogle();
    await nextTurn();
    assert.equal(ready, 1);
    assert.equal(received, false, 'rendering must not authenticate');
    assert.equal(f.controls.initialization.nonce, challenge.nonce);
    assert.equal(f.controls.initialization.auto_select, false);
    assert.equal(f.controls.rendered.host, host);
    assert.deepEqual(f.controls.rendered.options, { type: 'standard', theme: 'outline', size: 'large',
        text: 'continue_with', state: challenge.state });
    f.completeGoogle();
    assert.equal(await credential, token);
    assert.equal(host.clears, 2, 'remove the used button as soon as its credential is delivered');
    assert.equal(f.controls.closeCount, 0);
});

test('inline cleanup ignores late Google callbacks and permits a fresh nonce-bound render', async () => {
    const f = fixture();
    f.controls.sdk = f.sdk;
    const host = inlineHost();
    const controller = new AbortController();
    const credential = f.client.acquireGoogleCredentialInline(google, challenge, host, controller.signal);
    const rejected = rejectsCode(credential, 'CANCELLED');
    await nextTurn();
    const lateCallback = f.controls.initialization.callback;
    await rejectsCode(f.client.acquireProviderCredential(google, challenge, signal()), 'UNAVAILABLE');
    controller.abort();
    await rejected;
    assert.equal(host.clears, 2);
    lateCallback({ credential: token, state: challenge.state });
    const next = { ...challenge, state: Buffer.alloc(32, 3).toString('base64url'), nonce: Buffer.alloc(32, 4).toString('base64url') };
    const fresh = f.client.acquireGoogleCredentialInline(google, next, host, signal());
    await nextTurn();
    assert.equal(f.controls.initialization.nonce, next.nonce);
    lateCallback({ credential: token, state: challenge.state });
    f.completeGoogle({ credential: token, state: next.state });
    assert.equal(await fresh, token);
});

test('inline Google rejects a mismatched response without exposing a token or opening an alert', async () => {
    const f = fixture();
    f.controls.sdk = f.sdk;
    const host = inlineHost();
    const credential = f.client.acquireGoogleCredentialInline(google, challenge, host, signal());
    const rejected = rejectsCode(credential, 'UNAVAILABLE');
    await nextTurn();
    f.completeGoogle({ credential: token, state: 'wrong' });
    await rejected;
    assert.equal(host.clears, 2);
    assert.equal(f.controls.popup, null);
});

test('inline Google expires without leaving an actionable stale button', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture();
    f.controls.sdk = f.sdk;
    const host = inlineHost();
    const credential = f.client.acquireGoogleCredentialInline(google, { ...challenge, expiresInSeconds: 1 }, host, signal());
    const rejected = rejectsCode(credential, 'CANCELLED');
    await nextTurn();
    t.mock.timers.tick(1000);
    await rejected;
    assert.equal(host.clears, 2);
    assert.equal(f.controls.closeCount, 0);
});

test('Google cancellation during loading removes its script, settles promptly and permits a fresh attempt', async () => {
    const f = fixture();
    const credential = f.client.acquireProviderCredential(google, challenge, signal());
    const rejected = rejectsCode(credential, 'CANCELLED');
    await nextTurn();
    f.alert.close();
    await rejected;
    await nextTurn();
    assert.equal(f.scripts[0].removed, true);
    assert.equal(f.scripts[0].onload, null);
    const retry = f.client.acquireProviderCredential(google, challenge, signal());
    await nextTurn();
    assert.equal(f.scripts.length, 2);
    f.loadGoogle();
    await nextTurn();
    f.completeGoogle();
    assert.equal(await retry, token);
});

test('aborting Google ignores late credentials and never closes a replacement alert', async () => {
    const controller = new AbortController();
    const f = fixture();
    f.controls.sdk = f.sdk;
    const credential = f.client.acquireProviderCredential(google, challenge, controller.signal);
    const rejected = rejectsCode(credential, 'CANCELLED');
    await nextTurn();
    const unrelated = { unrelated: true };
    f.controls.popup = unrelated;
    controller.abort('private reason');
    await rejected;
    f.completeGoogle();
    assert.equal(f.controls.popup, unrelated);
    assert.equal(f.controls.closeCount, 0);
});

test('an existing alert or another active acquisition is never overwritten', async () => {
    const f = fixture();
    f.controls.popup = { unrelated: true };
    await rejectsCode(f.client.acquireProviderCredential(google, challenge, signal()), 'UNAVAILABLE');
    assert.equal(f.scripts.length, 0);
    f.controls.popup = null;
    f.controls.sdk = f.sdk;
    const controller = new AbortController();
    const first = f.client.acquireProviderCredential(google, challenge, controller.signal);
    const rejected = rejectsCode(first, 'CANCELLED');
    await nextTurn();
    await rejectsCode(f.client.acquireProviderCredential(google, challenge, signal()), 'UNAVAILABLE');
    controller.abort();
    await rejected;
});

test('Google script and credential failures are sanitized and bounded', async t => {
    for (const response of [null, {}, { credential: token, state: 'wrong' },
        { credential: '', state: challenge.state }, { credential: 'x'.repeat(16_385), state: challenge.state }]) {
        const f = fixture();
        f.controls.sdk = f.sdk;
        const credential = f.client.acquireProviderCredential(google, challenge, signal());
        const rejected = rejectsCode(credential, 'UNAVAILABLE');
        await nextTurn();
        f.completeGoogle(response);
        await rejected;
        assert.equal(f.controls.closeCount, 1);
    }
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture();
    const loading = f.client.acquireProviderCredential(google, challenge, signal());
    const rejected = rejectsCode(loading, 'UNAVAILABLE');
    await nextTurn();
    t.mock.timers.tick(10_000);
    await rejected;
    assert.equal(f.scripts[0].removed, true);
    assert.equal(f.controls.closeCount, 1);
});

test('the challenge deadline closes only the owned Google popup and clears pending work', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture();
    f.controls.sdk = f.sdk;
    const credential = f.client.acquireProviderCredential(google, { ...challenge, expiresInSeconds: 1 }, signal());
    const rejected = rejectsCode(credential, 'CANCELLED');
    await nextTurn();
    t.mock.timers.tick(1000);
    await rejected;
    assert.equal(f.controls.closeCount, 1);
    assert.equal(f.controls.popup, null);
});

test('native Apple requests only the configured audience and server challenge, returning only the token', async () => {
    const f = fixture({ platform: 'ios', isNative: true });
    assert.equal(await f.client.acquireProviderCredential(apple, challenge, signal()), token);
    assert.deepEqual(f.calls, ['capabilities', ['native', { provider: 'apple', clientId: apple.clientId,
        nonce: challenge.nonce, state: challenge.state }]]);
    assert.equal(f.scripts.length, 0);
    assert.equal(f.controls.popup, null);
    assert.equal(f.controls.nativeCancelCount, 0);
});

test('native abort calls cancel and discards late native success', async () => {
    let finish;
    const f = fixture({ platform: 'ios', isNative: true,
        identity: { signIn: () => new Promise(resolve => { finish = resolve; }) } });
    const controller = new AbortController();
    const credential = f.client.acquireProviderCredential(apple, challenge, controller.signal);
    const rejected = rejectsCode(credential, 'CANCELLED');
    await nextTurn();
    controller.abort();
    await rejected;
    assert.equal(f.controls.nativeCancelCount, 1);
    finish({ identityToken: token });
    await nextTurn();
    assert.equal(f.controls.nativeCancelCount, 1);
});

for (const cancellation of ['abort', 'challenge timeout']) {
    test(`native ${cancellation} keeps retries blocked until cancellation is acknowledged`, async t => {
        if (cancellation === 'challenge timeout') t.mock.timers.enable({ apis: ['setTimeout'] });
        let finishInitial;
        let acknowledgeCancel;
        let nativeStarts = 0;
        let nativeCancels = 0;
        const f = fixture({ platform: 'ios', isNative: true, identity: {
            signIn: () => ++nativeStarts === 1
                ? new Promise(resolve => { finishInitial = resolve; })
                : Promise.resolve({ identityToken: token }),
            cancel: () => {
                nativeCancels++;
                return new Promise(resolve => { acknowledgeCancel = resolve; });
            },
        } });
        const controller = new AbortController();
        const credential = f.client.acquireProviderCredential(apple,
            { ...challenge, expiresInSeconds: 1 }, controller.signal);
        const rejected = rejectsCode(credential, 'CANCELLED');
        try {
            await nextTurn();
            if (cancellation === 'abort') controller.abort();
            else t.mock.timers.tick(1000);
            await rejected;
            assert.equal(nativeCancels, 1);
            finishInitial({ identityToken: token });
            await nextTurn();
            await rejectsCode(f.client.acquireProviderCredential(apple, challenge, signal()), 'UNAVAILABLE');
            assert.equal(nativeStarts, 1, 'late native success must not release the cancellation gate');
            acknowledgeCancel();
            await nextTurn();
            assert.equal(await f.client.acquireProviderCredential(apple, challenge, signal()), token);
            assert.equal(nativeStarts, 2);
            assert.equal(nativeCancels, 1);
        } finally {
            finishInitial?.({ identityToken: token });
            acknowledgeCancel?.();
        }
    });
}

test('native cancellation rejection is handled and keeps retries fail-closed after late success', async () => {
    let finishInitial;
    let rejectCancel;
    let nativeStarts = 0;
    const f = fixture({ platform: 'ios', isNative: true, identity: {
        signIn: () => ++nativeStarts === 1
            ? new Promise(resolve => { finishInitial = resolve; })
            : Promise.resolve({ identityToken: token }),
        cancel: () => new Promise((_resolve, reject) => { rejectCancel = reject; }),
    } });
    const controller = new AbortController();
    const credential = f.client.acquireProviderCredential(apple, challenge, controller.signal);
    const rejected = rejectsCode(credential, 'CANCELLED');
    try {
        await nextTurn();
        controller.abort();
        await rejected;
        rejectCancel(new Error('private cancellation details'));
        await nextTurn();
        finishInitial({ identityToken: token });
        await nextTurn();
        await rejectsCode(f.client.acquireProviderCredential(apple, challenge, signal()), 'UNAVAILABLE');
        assert.equal(nativeStarts, 1);
    } finally {
        finishInitial?.({ identityToken: token });
    }
});

test('unavailable native capability, malformed results and native errors never expose raw details', async () => {
    for (const identity of [
        { getCapabilities: async () => ({ apple: false }) },
        { signIn: async () => ({ identityToken: token, private: 'unwanted' }) },
        { signIn: async () => ({ identityToken: 'invalid' }) },
        { signIn: async () => { throw new Error('private identity token'); } },
    ]) {
        await rejectsCode(fixture({ platform: 'ios', isNative: true, identity }).client
            .acquireProviderCredential(apple, challenge, signal()), 'UNAVAILABLE');
    }
    await rejectsCode(fixture({ platform: 'ios', isNative: true,
        identity: { signIn: async () => { throw { code: 'CANCELLED', message: 'private' }; } } }).client
        .acquireProviderCredential(apple, challenge, signal()), 'CANCELLED');
});

test('unsupported platform, malformed client/challenge and pre-abort never start native or web sign-in', async () => {
    for (const [client, request, overrides] of [
        [google, challenge, { platform: 'android', isNative: true }],
        [google, challenge, { platform: 'ios', isNative: true }], [apple, challenge, {}],
        [{ ...google, clientId: '' }, challenge, {}], [google, { ...challenge, nonce: 'wrong' }, {}],
        [google, { ...challenge, expiresInSeconds: 301 }, {}],
    ]) {
        const f = fixture(overrides);
        await rejectsCode(f.client.acquireProviderCredential(client, request, signal()), 'UNAVAILABLE');
        assert.deepEqual(f.calls, []);
        assert.equal(f.scripts.length, 0);
    }
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    await rejectsCode(f.client.acquireProviderCredential(google, challenge, controller.signal), 'CANCELLED');
    assert.equal(f.scripts.length, 0);
    assert.equal(f.controls.popup, null);
});
