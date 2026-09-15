import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createViteTestServer } from '../../testSupport/createViteTestServer.mjs';

const frontendRoot = fileURLToPath(new URL('../../../', import.meta.url));
const fixtureKey = '__dancingCirclesMountFixture';
const fixture = `globalThis.${fixtureKey}`;
const mocks = {
    react: `export const useEffect = effect => ${fixture}.effects.push(effect);
        export const useRef = () => ${fixture}.ref;
        export const useState = initial => [typeof initial === 'function' ? initial() : initial, () => {}];
        export default { createElement: () => null };`,
    'jsx-dev-runtime': 'export const jsxDEV = () => null;',
    'jsx-runtime': 'export const jsx = () => null; export const jsxs = jsx;',
    runDancingCircles: `export const DEFAULT_DANCING_CIRCLES_CUSTOM_COLOR = '#46515b';
        export const runDancingCircles = options => ${fixture}.start(options);`,
    AudioEngine: 'export const audioEngine = { dispose() {} };',
    useAudioEngineState: 'export const useAudioEngineState = () => ({});',
    FullscreenButton: 'export default () => null;',
    MusicControls: 'export default () => null;',
    MusicUpload: 'export default () => null;',
};
const server = await createViteTestServer({
    root: frontendRoot, configFile: `${frontendRoot}/vite.config.ts`,
    appType: 'custom', logLevel: 'silent', server: { middlewareMode: true },
    ssr: { noExternal: [/^react$/] },
    plugins: [{
        name: 'circles-page-lifecycle-fixture', enforce: 'pre',
        resolveId(source) {
            const name = source.replaceAll('\\', '/').split('/').at(-1).replace(/\.tsx?$/, '');
            if (Object.hasOwn(mocks, name)) return `\0circles-test:${name}`;
        },
        load(id) {
            if (id.startsWith('\0circles-test:')) return mocks[id.slice('\0circles-test:'.length)];
        },
    }],
});
after(() => server.close());
const { default: DancingCircles } = await server.ssrLoadModule('/ts/pages/animations/DancingCircles.tsx');
const settle = () => new Promise(resolve => setImmediate(resolve));

function mountFixture(context) {
    const original = Object.getOwnPropertyDescriptor(globalThis, fixtureKey);
    const container = {};
    const starts = [];
    const effects = [];
    const ref = { current: container };
    Object.defineProperty(globalThis, fixtureKey, { configurable: true, value: {
        effects, ref, start: options => new Promise(resolve => starts.push({ ...options, resolve })),
    } });
    context.after(() => {
        if (original) Object.defineProperty(globalThis, fixtureKey, original);
        else delete globalThis[fixtureKey];
    });
    // Exercise the real page effect with controlled hook scheduling, not a real GPU/React DOM mount.
    DancingCircles();
    return { mount: effects[0], starts, ref, container };
}

test('a renderer that finishes after unmount is immediately released', async context => {
    const { mount, starts, ref, container } = mountFixture(context);
    let releases = 0;
    const unmount = mount();
    assert.equal(starts[0].container, container);
    ref.current = null;
    unmount();
    starts[0].resolve(() => { releases += 1; });
    await settle();
    assert.equal(releases, 1);
});

test('an active renderer lives until its page is unmounted', async context => {
    const { mount, starts } = mountFixture(context);
    let releases = 0;
    const unmount = mount();
    starts[0].resolve(() => { releases += 1; });
    await settle();
    assert.equal(releases, 0);
    unmount();
    assert.equal(releases, 1);
});

test('setup-cleanup-setup keeps the new renderer when the old setup resolves late', async context => {
    const { mount, starts } = mountFixture(context);
    const released = [];
    mount()();
    const unmountNew = mount();
    starts[1].resolve(() => released.push('new'));
    starts[0].resolve(() => released.push('old'));
    await settle();
    assert.deepEqual(released, ['old']);
    unmountNew();
    assert.deepEqual(released, ['old', 'new']);
});
