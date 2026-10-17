import assert from 'node:assert/strict';
import test from 'node:test';
import { createProviderClient, ProviderCredentialError } from './providerClient.ts';

const client = { clientKey: 'apple-web', provider: 'apple', platform: 'web', clientId: 'com.example.web',
    redirectUri: 'https://example.test/login', signup: true };
const challenge = { state: Buffer.alloc(32, 1).toString('base64url'), nonce: Buffer.alloc(32, 2).toString('base64url'), expiresInSeconds: 300 };
const proof = { authorization: { code: 'synthetic-code', id_token: 'synthetic.identity.signature', state: challenge.state },
    user: { email: 'do-not-use@example.test', name: { firstName: 'Do not use' } } };
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture({ result = proof, deferred = false, sdkPresent = true, config = [client], userActivation = true } = {}) {
    const state = { calls: [], scripts: [], sdk: undefined, alertCalls: 0, elements: [], userActivation, result };
    let finishProvider;
    const sdk = { auth: { init(value) { state.calls.push(['init', value]); }, signIn() {
        state.calls.push(['signIn']);
        return deferred ? new Promise(resolve => { finishProvider = resolve; })
            : state.result instanceof Error || state.result?.error ? Promise.reject(state.result) : Promise.resolve(state.result);
    } } };
    if (sdkPresent) state.sdk = sdk;
    const alert = { isVisible: () => false, getPopup: () => null,
        fire() { state.alertCalls += 1; assert.fail('Apple must not open an intermediate credential dialog'); },
        close() { assert.fail('Apple does not own an application dialog'); } };
    const document = { createElement(tag) {
        state.elements.push(tag);
        return { tag, style: {}, remove() { this.removed = true; } };
    }, head: { appendChild(script) { state.scripts.push(script); } } };
    const api = createProviderClient({ apiBase: '', platform: 'web', isNative: false, document, alert,
        google: () => undefined, apple: () => state.sdk, hasUserActivation: () => state.userActivation,
        identity: { getCapabilities: async () => assert.fail('No native bridge'), signIn: async () => assert.fail('No native bridge'), cancel: async () => {} },
        fetchRequest: async () => Response.json({ clients: config }),
    });
    const controller = new AbortController();
    return { api, state, controller, alert,
        begin: (selected = client, request = challenge) => api.acquireProviderCredential(selected, request, controller.signal),
        load: () => { state.sdk = sdk; state.scripts.at(-1).onload(); },
        finish: value => finishProvider(value),
    };
}
const rejected = (promise, code) => assert.rejects(promise, error => {
    assert(error instanceof ProviderCredentialError);
    assert.equal(error.code, code);
    assert.doesNotMatch(JSON.stringify(error), /synthetic-code|private|do-not-use/);
    assert.equal('cause' in error, false);
    return true;
});

test('browser Apple discovery is explicit and malformed redirects fail closed without loading an SDK', async () => {
    const valid = fixture();
    assert.deepEqual(await valid.api.getAvailableProviderClients(), [client]);
    assert.deepEqual(valid.state.scripts, []);
    for (const redirectUri of [undefined, '', 'http://example.test/login', 'https://127.0.0.1/login',
        'https://localhost/login', 'https://example.test/login#state', 'https://example.test/login?code=x',
        'https://user@example.test/login', 'https://example.test:443/login']) {
        assert.deepEqual(await fixture({ config: [{ ...client, redirectUri }] }).api.getAvailableProviderClients(), []);
    }
});

test('discovery preloads only the SDK and one acquisition opens Apple directly with the exact server challenge', async () => {
    const f = fixture({ sdkPresent: false });
    const discovery = f.api.getAvailableProviderClients(); await tick();
    assert.equal(f.state.scripts[0].src, 'https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js');
    assert.deepEqual(f.state.calls, []);
    f.load(); assert.deepEqual(await discovery, [client]);
    assert.deepEqual(f.state.calls, []);
    assert.deepEqual(await f.begin(), { idToken: proof.authorization.id_token, authorizationCode: proof.authorization.code });
    assert.deepEqual(f.state.calls, [['init', { clientId: client.clientId, redirectURI: client.redirectUri,
        scope: 'email', state: challenge.state, nonce: challenge.nonce, usePopup: true }], ['signIn']]);
    assert.equal(f.state.alertCalls, 0);
    assert.deepEqual(f.state.elements, ['script']);
});

test('expired user activation stops before SDK launch and the original control can retry with a fresh challenge', async () => {
    const f = fixture({ userActivation: false });
    await rejected(f.begin(), 'UNAVAILABLE');
    assert.deepEqual(f.state.calls, []);
    assert.equal(f.state.alertCalls, 0);
    f.state.userActivation = true;
    const freshChallenge = { ...challenge, state: Buffer.alloc(32, 3).toString('base64url') };
    f.state.result = { ...proof, authorization: { ...proof.authorization, state: freshChallenge.state } };
    assert.deepEqual(await f.begin(client, freshChallenge),
        { idToken: proof.authorization.id_token, authorizationCode: proof.authorization.code });
    assert.equal(f.state.calls.filter(call => call[0] === 'signIn').length, 1);
    assert.equal(f.state.calls[0][1].state, freshChallenge.state);
    assert.equal(f.state.alertCalls, 0);
});

test('activation that expires during asynchronous SDK loading does not open a late popup', async () => {
    const f = fixture({ sdkPresent: false });
    const pending = f.begin();
    const check = rejected(pending, 'UNAVAILABLE');
    await tick();
    f.state.userActivation = false;
    f.load();
    await check;
    assert.deepEqual(f.state.calls, []);
    assert.equal(f.state.alertCalls, 0);

    f.state.userActivation = true;
    const freshChallenge = { ...challenge, state: Buffer.alloc(32, 4).toString('base64url') };
    f.state.result = { authorization: { ...proof.authorization, state: freshChallenge.state } };
    assert.deepEqual(await f.begin(client, freshChallenge),
        { idToken: proof.authorization.id_token, authorizationCode: proof.authorization.code });
    assert.equal(f.state.calls.filter(call => call[0] === 'signIn').length, 1);
});

test('wrong state, absent code and malformed callbacks are discarded without exposing provider user data', async () => {
    for (const result of [null, {}, { authorization: { ...proof.authorization, state: 'wrong' } },
        { authorization: { ...proof.authorization, code: '' } }, { authorization: { ...proof.authorization, id_token: 'bad' } },
        { authorization: { ...proof.authorization, code: 'secret\n' } }]) {
        const f = fixture({ result }); const pending = f.begin(); const check = rejected(pending, 'UNAVAILABLE');
        await check;
    }
});

test('blocked popup and provider cancellation are sanitized and a completed rejection permits a fresh attempt', async () => {
    for (const [result, expected] of [[{ error: 'popup_blocked_by_browser', private: 'secret' }, 'UNAVAILABLE'],
        [{ error: 'popup_closed_by_user' }, 'CANCELLED'], [{ error: 'user_cancelled_authorize' }, 'CANCELLED'],
        [new Error('private token details'), 'UNAVAILABLE']]) {
        const f = fixture({ result }); const pending = f.begin(); const check = rejected(pending, expected);
        await check; await tick();
        const retry = f.begin(); const retryCheck = rejected(retry, expected);
        await retryCheck;
        assert.equal(f.state.alertCalls, 0);
    }
});

test('cancellation ignores a late callback and prevents a second SDK popup until the old one settles', async () => {
    const f = fixture({ deferred: true });
    const pending = f.begin(); const check = rejected(pending, 'CANCELLED');
    await tick();
    f.controller.abort(); await check;
    await rejected(f.api.acquireProviderCredential(client, challenge, new AbortController().signal), 'UNAVAILABLE');
    assert.equal(f.state.calls.filter(call => call[0] === 'signIn').length, 1);
    f.finish(proof); await tick();
    const freshController = new AbortController();
    const retry = f.api.acquireProviderCredential(client, challenge, freshController.signal);
    const cancelled = rejected(retry, 'CANCELLED');
    await tick(); freshController.abort(); await cancelled;
    f.finish(proof); await tick();
});

test('expiry cancels a stalled popup and late success remains ignored', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture({ deferred: true });
    const pending = f.begin(client, { ...challenge, expiresInSeconds: 1 });
    const check = rejected(pending, 'CANCELLED');
    await tick(); t.mock.timers.tick(1000); await check;
    f.finish(proof); await tick();
    assert.equal(f.state.alertCalls, 0);
});

test('SDK load failure and load cancellation remove handlers and allow a clean retry', async () => {
    for (const cancel of [false, true]) {
        const f = fixture({ sdkPresent: false }); const pending = f.begin();
        const check = rejected(pending, cancel ? 'CANCELLED' : 'UNAVAILABLE');
        await tick(); const script = f.state.scripts[0];
        if (cancel) f.controller.abort(); else script.onerror();
        await check; await tick();
        assert.equal(script.removed, true); assert.equal(script.onload, null); assert.equal(script.onerror, null);
        assert.deepEqual(f.state.calls, []);
    }
});
