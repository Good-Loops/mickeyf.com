import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createViteTestServer } from '../../testSupport/createViteTestServer.mjs';

const frontendRoot = fileURLToPath(new URL('../../../', import.meta.url));
const fixtureKey = '__threeBossesLifecycleFixture';
const fixture = `globalThis.${fixtureKey}`;
const mocks = {
    featureFlags: `export const isThreeBossesReleaseEnabled = false;
        export const THREE_BOSSES_BUILD_BASE_PATH = '/__test-unity/';`,
    unityVisibility: `
        export const configureThreeBossesTouchControls = () => ${fixture}.record('touch');
        export const bindThreeBossesPortraitLayout = () => ${fixture}.bind('portrait');
        export const bindUnityVisibility = () => ${fixture}.bind('visibility');`,
    unityPageScroll: `export const bindUnityPageScroll = () => ${fixture}.bind('page-scroll');`,
    unitySubmissionBridge: `
        export const bindThreeBossesSubmissionBridge = () => ${fixture}.bind('submission');
        export const configureThreeBossesSubmission = (_instance, enabled) =>
            ${fixture}.record('submission:' + enabled);`,
    unityGameReady: `
        export const bindThreeBossesGameReady = () => ({
            release: () => ${fixture}.record('ready-release'),
        });
        export const handOffThreeBossesCanvas = async (_ready, onCanvasOwned) => onCanvasOwned?.();`,
};
const server = await createViteTestServer({
    root: frontendRoot, configFile: `${frontendRoot}/vite.config.ts`,
    appType: 'custom', logLevel: 'silent', server: { middlewareMode: true },
    plugins: [{
        name: 'unity-lifecycle-test-bindings', enforce: 'pre',
        resolveId(source) {
            const name = source.replaceAll('\\', '/').split('/').at(-1).replace(/\.ts$/, '');
            if (Object.hasOwn(mocks, name)) return `\0unity-test:${name}`;
        },
        load(id) {
            if (id.startsWith('\0unity-test:')) return mocks[id.slice('\0unity-test:'.length)];
        },
    }],
});
after(() => server.close());

let caseNumber = 0;
async function withPlayer(failures, check) {
    const originals = new Map(['window', 'document', 'fetch', fixtureKey]
        .map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const events = [];
    const record = event => {
        events.push(event);
        if (failures.includes(event)) throw new Error(event);
    };
    const instance = { Quit: async () => record('quit') };
    const browser = { location: { origin: 'https://unity.invalid' } };
    const controller = new AbortController();
    const values = {
        window: browser,
        document: {
            createElement(tag) {
                assert.equal(tag, 'script');
                return Object.assign(new EventTarget(), {
                    dataset: {}, remove: () => record('script-remove'),
                });
            },
            head: {
                append(script) {
                    browser.createUnityInstance = async () => instance;
                    queueMicrotask(() => script.dispatchEvent(new Event('load')));
                },
            },
        },
        fetch: async (url, options) => {
            assert.equal(url, '/__test-unity/build-manifest.json');
            assert.equal(options.signal, controller.signal);
            return { ok: true, status: 200, json: async () => ({
                loaderUrl: 'loader.js', dataUrl: 'data', frameworkUrl: 'framework.js', codeUrl: 'code.wasm',
            }) };
        },
        [fixtureKey]: { record, bind: name => { record(`bind:${name}`); return () => record(`release:${name}`); } },
    };
    try {
        for (const [key, value] of Object.entries(values)) {
            Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
        }
        // Fresh module state isolates deliberate startup/shutdown failures from subsequent cases.
        const { startThreeBossesWebGl } = await server.ssrLoadModule(
            `/ts/games/three-bosses/unityWebGl.ts?case=${++caseNumber}`,
        );
        const start = (extra = {}) => startThreeBossesWebGl({
            canvas: {}, signal: controller.signal, onProgress() {},
            issueRunTicket() { assert.fail('Lifecycle checks must not request a real ticket'); },
            submitRun() { assert.fail('Lifecycle checks must not submit a real score'); },
            ...extra,
        });
        await check({ start, events, browser, controller });
    } finally {
        for (const [key, descriptor] of originals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }
    }
}

const normalRelease = [
    'ready-release', 'release:page-scroll', 'submission:false', 'release:submission',
    'release:portrait', 'release:visibility', 'quit', 'script-remove',
];

test('normal shutdown preserves order and releases only once for repeated quit calls', async () => {
    await withPlayer([], async ({ start, events, browser }) => {
        const handle = await start();
        handle.setSubmissionEnabled(true);
        assert.equal(events.at(-1), 'submission:true');
        events.length = 0;
        await Promise.all([handle.quit(), handle.quit()]);
        handle.setSubmissionEnabled(true);
        assert.deepEqual(events, normalRelease);
        assert.equal(browser.createUnityInstance, undefined);
    });
});

test('partial initialization releases only acquired bindings without sending a shutdown command', async () => {
    await withPlayer(['bind:submission'], async ({ start, events, browser }) => {
        await assert.rejects(start(), { message: 'bind:submission' });
        assert.deepEqual(events.slice(events.indexOf('release:page-scroll')), [
            'release:page-scroll', 'release:portrait', 'release:visibility',
            'quit', 'ready-release', 'script-remove',
        ]);
        assert.ok(!events.includes('submission:false'));
        assert.equal(browser.createUnityInstance, undefined);
    });
});

test('throwing bridge cleanup remains best-effort in normal and failed initialization paths', async () => {
    const failures = ['release:submission', 'release:portrait', 'release:visibility'];
    await withPlayer(failures, async ({ start, events }) => {
        const handle = await start();
        events.length = 0;
        await handle.quit();
        assert.deepEqual(events, normalRelease);
    });
    await withPlayer([...failures, 'submission:false'], async ({ start, events }) => {
        await assert.rejects(start(), { message: 'submission:false' });
        assert.deepEqual(events.slice(events.indexOf('release:page-scroll')), [
            'release:page-scroll', 'release:submission', 'release:portrait',
            'release:visibility', 'quit', 'ready-release', 'script-remove',
        ]);
        assert.equal(events.filter(event => event === 'submission:false').length, 1);
    });
});

test('aborting during startup uses normal shutdown before rejecting the handle', async () => {
    await withPlayer([], async ({ start, events, browser, controller }) => {
        await assert.rejects(start({ onCanvasOwned: () => controller.abort() }), { name: 'AbortError' });
        assert.deepEqual(events.slice(events.indexOf('ready-release'), -2), normalRelease);
        assert.deepEqual(events.slice(-2), ['ready-release', 'script-remove']);
        assert.equal(events.filter(event => event === 'quit').length, 1);
        assert.equal(browser.createUnityInstance, undefined);
    });
});

test('page-scroll cleanup errors retain their existing propagation and still clear the loader', async () => {
    await withPlayer(['release:page-scroll'], async ({ start, events, browser }) => {
        const handle = await start();
        events.length = 0;
        await assert.rejects(handle.quit(), { message: 'release:page-scroll' });
        assert.deepEqual(events, ['ready-release', 'release:page-scroll', 'script-remove']);
        assert.equal(browser.createUnityInstance, undefined);
    });
    await withPlayer(['bind:submission', 'release:page-scroll'], async ({ start, events, browser }) => {
        await assert.rejects(start(), { message: 'release:page-scroll' });
        assert.deepEqual(events.slice(events.indexOf('release:page-scroll')), [
            'release:page-scroll', 'ready-release', 'script-remove',
        ]);
        assert.equal(browser.createUnityInstance, undefined);
    });
});
