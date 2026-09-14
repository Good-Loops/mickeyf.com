import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createNativeApiFetch } from './nativeApiFetch.ts';
import { createAuthApi } from './authApi.ts';

const base = 'https://api.example.test';
const credentials = { credentials: 'include' };

test('native JSON transport returns the status/body but never forwards response headers', async () => {
    let observed;
    const fetchApi = createNativeApiFetch(async (options) => {
        observed = options;
        return { status: 401, body: '{"error":"UNAUTHORIZED"}', headers: { 'Set-Cookie': 'private' } };
    });
    const response = await fetchApi(`${base}/api/users`, {
        ...credentials, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"type":"login"}',
    });
    assert.deepEqual(observed, { url: `${base}/api/users`, method: 'POST', body: '{"type":"login"}' });
    assert.equal(response.ok, false);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('Set-Cookie'), null);
    assert.deepEqual(await response.json(), { error: 'UNAUTHORIZED' });
});

test('GET uses the same native adapter and does not invent a body', async () => {
    const fetchApi = createNativeApiFetch(async (options) => {
        assert.deepEqual(options, { url: `${base}/auth/verify-token`, method: 'GET' });
        return { status: 200, body: '{"loggedIn":true,"user_name":"Player"}' };
    });
    assert.equal((await (await fetchApi(new URL(`${base}/auth/verify-token`), credentials)).json()).loggedIn, true);
});

test('requires the explicit JSON API contract before calling native code', async () => {
    const fetchApi = createNativeApiFetch(async () => assert.fail('native request must not run'));
    await assert.rejects(fetchApi(base), TypeError);
    await assert.rejects(fetchApi(base, { ...credentials, body: new FormData() }), TypeError);
    await assert.rejects(fetchApi(new Request(base), credentials), TypeError);
});

test('pre-aborted calls do not reach native code', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchApi = createNativeApiFetch(async () => assert.fail('native request must not run'));
    await assert.rejects(fetchApi(base, { ...credentials, signal: controller.signal }), { name: 'AbortError' });
    await assert.rejects(fetchApi(base, { ...credentials, signal: { aborted: true } }), { name: 'AbortError' });
});

test('an abort discards a late native response without an unhandled rejection', async () => {
    let finish;
    const controller = new AbortController();
    const fetchApi = createNativeApiFetch(() => new Promise((resolve) => { finish = resolve; }));
    const result = fetchApi(base, { ...credentials, signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    await assert.rejects(result, { name: 'AbortError' });
    finish({ status: 200, body: '{}' });
    await new Promise((resolve) => setImmediate(resolve));
});

test('transport failure is not converted into an anonymous successful response', async () => {
    const fetchApi = createNativeApiFetch(async () => { throw new Error('Native network failure'); });
    await assert.rejects(fetchApi(base, credentials), /Native network failure/);
});

test('auth reconstruction and logout reuse the native store, never JS credentials', async () => {
    // Models an OS-owned jar. This proves the JS contract, not physical iOS persistence.
    let nativeSession = false;
    const urls = [];
    const fetchApi = createNativeApiFetch(async ({ url, body }) => {
        urls.push(url);
        if (url.endsWith('/api/users')) {
            assert.equal(JSON.parse(body).type, 'login');
            nativeSession = true;
            return { status: 200, body: '{"success":true,"user_name":"Player"}' };
        }
        if (url.endsWith('/auth/logout')) {
            nativeSession = false;
            return { status: 200, body: '{"loggedOut":true}' };
        }
        assert.equal(body, url.endsWith('/auth/renew') ? '{}' : undefined);
        return { status: 200, body: JSON.stringify(nativeSession
            ? { loggedIn: true, user_name: 'Player' } : { loggedIn: false }) };
    });
    const api = createAuthApi(base, fetchApi);
    assert.equal((await api.loginRequest({ user_name: 'Player', user_password: 'test-only' })).success, true);
    const reopened = createAuthApi(base, fetchApi);
    assert.equal((await reopened.renewRequest()).loggedIn, true);
    await reopened.logoutRequest();
    assert.equal((await createAuthApi(base, fetchApi).renewRequest()).loggedIn, false);
    assert.equal(urls.filter((url) => url.endsWith('/api/users')).length, 1);
});

test('the native origin matches both build jobs and the plugin is included in the iOS target', async () => {
    const [native, workflow, project, scene] = await Promise.all([
        '../../ios/App/App/LudolumeApiPlugin.swift',
        '../../../.github/workflows/ios-build.yml',
        '../../ios/App/App.xcodeproj/project.pbxproj',
        '../../ios/App/App/SceneDelegate.swift',
    ].map((path) => readFile(new URL(path, import.meta.url), 'utf8')));
    const host = native.match(/static let host = "([^"]+)"/)?.[1];
    assert.ok(host, 'native origin must stay explicit');
    const buildOrigins = [...workflow.matchAll(/VITE_PROD_API_URL: (\S+)/g)].map((match) => match[1]);
    assert.equal(buildOrigins.length, 2);
    assert.ok(buildOrigins.every((origin) => origin === `https://${host}`));
    assert.match(native, /registerPluginInstance\(LudolumeApiPlugin\(\)\)/);
    assert.match(scene, /rootViewController = LudolumeBridgeViewController\(\)/);
    assert.match(project, /LudolumeApiPlugin\.swift in Sources/);
});

test('account deletion uses the native JSON transport without clearing the session before the response', async () => {
    const requests = [];
    const native = createNativeApiFetch(async (request) => {
        requests.push(request);
        return { status: 403, body: '{"error":"INVALID_PASSWORD"}' };
    });
    const api = createAuthApi(base, native);
    assert.deepEqual(await api.deleteAccountRequest('test-only'), { error: 'INVALID_PASSWORD' });
    assert.deepEqual(requests, [{
        url: `${base}/auth/delete-account`,
        method: 'POST',
        body: JSON.stringify({ password: 'test-only', confirmation: 'DELETE' }),
    }]);
});

test('native deletion and logout clear local credentials only after confirmed server success', async () => {
    // Structural safeguard only: compiled/device cookie behavior is checked on iOS.
    const native = await readFile(new URL('../../ios/App/App/LudolumeApiPlugin.swift', import.meta.url), 'utf8');
    assert.match(native, /"POST \/auth\/delete-account"/);
    assert.match(native, /"POST \/auth\/renew"/);
    assert.doesNotMatch(native, /clearSessionCookie\(completion: operation\.start\)/);
    assert.match(native, /response\.statusCode == 200/);
    assert.match(native, /JSONDecoder\(\)\.decode\(\[String: Bool\]\.self, from: body\)/);
    assert.match(native, /result == \["deleted": true\]/);
    assert.match(native, /result == \["loggedOut": true\]/);
    assert.match(native, /LudolumeApiPolicy\.clearSessionCookie\(completion: finish\)/);
});

test('native provider transport admits only explicit provider routes within the backend body limit', async () => {
    const native = await readFile(new URL('../../ios/App/App/LudolumeApiPlugin.swift', import.meta.url), 'utf8');
    const providerRoutes = [...native.matchAll(/"((?:GET|POST) \/auth\/providers\/[^"\n]+)"/g)]
        .map((match) => match[1]);
    assert.deepEqual(providerRoutes, [
        'GET /auth/providers/config', 'GET /auth/providers/account', 'POST /auth/providers/begin', 'POST /auth/providers/complete',
    ]);
    assert.match(native, /maximumRequestBytes = 32 \* 1024/);
    assert.match(native, /bodyData\?\.count \?\? 0\) <= maximumRequestBytes/);
    assert.match(native, /components\.query == nil, components\.fragment == nil/);
});

test('native bridge diagnostics cannot log provider credentials in debug builds', async () => {
    const config = await readFile(new URL('../../capacitor.config.ts', import.meta.url), 'utf8');
    assert.match(config, /loggingBehavior:\s*'none'/);
});

test('Apple identity bridge is registered in the App target but remains explicitly disabled', async () => {
    const [native, identity, info] = await Promise.all([
        '../../ios/App/App/LudolumeApiPlugin.swift',
        '../../ios/App/App/LudolumeIdentityPlugin.swift',
        '../../ios/App/App/Info.plist',
    ].map((path) => readFile(new URL(path, import.meta.url), 'utf8')));
    assert.match(native, /registerPluginInstance\(LudolumeIdentityPlugin\(\)\)/);
    assert.match(info, /<key>LudolumeAppleSignInEnabled<\/key>\s*<false\/>/);
    assert.match(identity, /forInfoDictionaryKey: "LudolumeAppleSignInEnabled"\) as\? Bool == true/);
    assert.match(identity, /call\.resolve\(\["apple": appleSignInEnabled, "google": false\]\)/);
    for (const method of ['getCapabilities', 'signIn', 'cancel']) {
        assert.ok(identity.includes(`CAPPluginMethod(name: "${method}", returnType: CAPPluginReturnPromise)`));
    }
    const { default: xcode } = await import('xcode');
    const project = xcode.project(fileURLToPath(new URL('../../ios/App/App.xcodeproj/project.pbxproj', import.meta.url)));
    project.parseSync();
    const target = Object.entries(project.pbxNativeTargetSection()).find(([, value]) => value?.name === 'App');
    assert.ok(target);
    const sources = project.pbxSourcesBuildPhaseObj(target[0]).files;
    assert.ok(sources.some(({ comment }) => comment === 'LudolumeIdentityPlugin.swift in Sources'));
});

test('Apple native contract preserves the server challenge and discards cancelled or invalid credentials', async () => {
    // Structural guards only; AuthenticationServices still needs macOS compilation and device validation.
    const identity = await readFile(new URL('../../ios/App/App/LudolumeIdentityPlugin.swift', import.meta.url), 'utf8');
    assert.match(identity, /clientId == Bundle\.main\.bundleIdentifier/);
    assert.match(identity, /Self\.isChallengeValue\(nonce\)/);
    assert.match(identity, /Self\.isChallengeValue\(state\)/);
    assert.match(identity, /value\.utf8\.count == 43/);
    assert.match(identity, /bytes\.count == 32/);
    assert.match(identity, /bytes\.base64EncodedString\(\)/);
    assert.match(identity, /request\.nonce = nonce/);
    assert.match(identity, /request\.state = state/);
    assert.match(identity, /credential\.state == self\.state/);
    assert.match(identity, /guard self\.pendingRequest == nil/);
    assert.match(identity, /controller\.delegate = self/);
    assert.match(identity, /controller\.presentationContextProvider = self/);
    assert.match(identity, /if #available\(iOS 16\.0, \*\) \{\s*controller\.cancel\(\)/);
    assert.match(identity, /call\?\.reject\("Native sign-in was cancelled\.", "CANCELLED"\)\s*call = nil/);
    assert.match(identity, /guard !self\.finished, let call = self\.call else \{ return \}/);
    assert.match(identity, /tokenData\.count <= 16_384/);
    assert.match(identity, /call\.resolve\(\["identityToken": identityToken\]\)/);
    assert.doesNotMatch(identity, /NSLog|print\(|localizedDescription|SHA256|WKWebView|UserDefaults|Keychain/);
});
