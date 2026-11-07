import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createNativePresentation } from './nativePresentation.ts';
import { createViteTestServer } from '../testSupport/createViteTestServer.mjs';

const SESSION = 'a'.repeat(32);
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test('portrait baseline precedes unlocking, and only active fullscreen owners unlock', async () => {
    const calls = [], baseline = deferred();
    const presentation = createNativePresentation(async () => ({ setFullscreen: command => {
        calls.push(command); return calls.length === 1 ? baseline.promise : Promise.resolve();
    } }), () => SESSION);
    const first = presentation.acquire(), second = presentation.acquire();
    first.setFullscreen(true);
    await tick();
    assert.deepEqual(calls, [{ active: false, sessionId: SESSION, revision: 1 }]);
    baseline.resolve(); await tick();
    assert.equal(calls.at(-1).active, true);
    second.setFullscreen(true); first.release(); await tick();
    assert.equal(calls.length, 2, 'another active owner still owns fullscreen');
    second.release(); await tick();
    assert.deepEqual(calls.map(call => call.active), [false, true, false]);
    assert.deepEqual(calls.map(call => call.revision), [1, 2, 3]);
});

test('exit does not wait behind a stalled unlock and late rejection cannot reopen rotation', async () => {
    const calls = [], entering = deferred();
    const presentation = createNativePresentation(async () => ({ setFullscreen: command => {
        calls.push(command); return command.active ? entering.promise : Promise.resolve();
    } }), () => SESSION);
    const owner = presentation.acquire(); owner.setFullscreen(true); await tick();
    owner.setFullscreen(false); await tick();
    assert.deepEqual(calls.map(call => call.active), [false, true, false]);
    entering.reject(new Error('late native acknowledgement')); await tick();
    assert.equal(calls.length, 3);
    assert.equal(calls.at(-1).revision, 3);
});

test('rapid enter/exit before readiness discards the obsolete unlock', async () => {
    const loading = deferred(), calls = [];
    const presentation = createNativePresentation(() => loading.promise, () => SESSION);
    const owner = presentation.acquire(); owner.setFullscreen(true); owner.setFullscreen(false);
    loading.resolve({ setFullscreen: async command => { calls.push(command); } }); await tick();
    assert.deepEqual(calls.map(call => call.active), [false, false]);
});

test('route reset invalidates old leases, confirms portrait and allows the destination to acquire', async () => {
    const calls = [], entering = deferred();
    const presentation = createNativePresentation(async () => ({ setFullscreen: command => {
        calls.push(command); return command.active && calls.length === 2 ? entering.promise : Promise.resolve();
    } }), () => SESSION);
    const old = presentation.acquire(); old.setFullscreen(true); await tick();
    presentation.reset(); await tick();
    old.setFullscreen(true); old.release(); entering.resolve(); await tick();
    assert.deepEqual(calls.map(call => call.active), [false, true, false]);
    const current = presentation.acquire(); current.setFullscreen(true); await tick();
    current.release(); await tick();
    assert.deepEqual(calls.map(call => call.active), [false, true, false, true, false]);
});

test('ambiguous rejection confirms portrait once and never retries an unlock', async () => {
    const calls = [];
    const presentation = createNativePresentation(async () => ({ setFullscreen: async command => {
        calls.push(command); if (command.active || calls.length === 3) throw new Error('native failure');
    } }), () => SESSION);
    const owner = presentation.acquire(); owner.setFullscreen(true); await tick();
    assert.deepEqual(calls.map(call => call.active), [false, true, false]);
    await tick(); assert.equal(calls.length, 3);
});

test('failed baseline or absent bridge never unlocks or rejects to fullscreen callers', async () => {
    const calls = [];
    for (const bridge of [null, { setFullscreen: async command => { calls.push(command); throw new Error('unavailable'); } }]) {
        const presentation = createNativePresentation(async () => bridge, () => SESSION);
        const owner = presentation.acquire(); owner.setFullscreen(true); await tick();
        owner.release(); presentation.reset(); await tick();
    }
    assert.deepEqual(calls.map(call => call.active), [false]);
});

test('default native loader resolves a plain facade without invoking Capacitor then', async () => {
    const key = '__nativePresentationLoader', previous = Object.getOwnPropertyDescriptor(globalThis, key);
    let thenReads = 0;
    const calls = [], fixture = { native: true, platform: 'ios', onCommand() {}, register: name => {
        assert.equal(name, 'LudolumePresentation');
        return new Proxy({}, { get: (_, name) => {
            if (name === 'then') { thenReads++; throw new Error('then is not implemented'); }
            if (name === 'setFullscreen') return async command => { calls.push(command); fixture.onCommand(command); };
        } });
    } };
    Object.defineProperty(globalThis, key, { configurable: true, value: fixture });
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const server = await createViteTestServer({ root, configFile: `${root}/vite.config.ts`, appType: 'custom',
        logLevel: 'silent', server: { middlewareMode: true }, ssr: { noExternal: ['@capacitor/core'] }, plugins: [{
            name: 'presentation-loader-fixture', enforce: 'pre',
            resolveId(source) { if (source === '@capacitor/core') return '\0presentation-capacitor'; },
            load(id) { if (id === '\0presentation-capacitor') return `const fixture = () => globalThis.${key};
                export const Capacitor = { isNativePlatform: () => fixture().native, getPlatform: () => fixture().platform };
                export const registerPlugin = name => fixture().register(name);`; },
        }] });
    try {
        const module = await server.ssrLoadModule('/ts/services/nativePresentation.ts');
        for (const platform of ['ios', 'android']) {
            fixture.platform = platform;
            const entered = deferred();
            fixture.onCommand = command => { if (command.active) entered.resolve(); };
            const presentation = module.createNativePresentation(undefined, () => SESSION);
            const owner = presentation.acquire(); owner.setFullscreen(true); await entered.promise;
            owner.release(); await tick();
        }
        assert.deepEqual(calls.map(call => call.active), [false, true, false, false, true, false]);
        fixture.native = false;
        const web = module.createNativePresentation(undefined, () => assert.fail('web needs no session'));
        web.acquire().setFullscreen(true); await tick();
        assert.equal(calls.length, 6); assert.equal(thenReads, 0);
    } finally {
        await server.close();
        if (previous) Object.defineProperty(globalThis, key, previous); else delete globalThis[key];
    }
});

test('iOS target includes the separate bridge and preserves iPad multitasking', async () => {
    const { default: xcode } = await import('xcode'), { default: plist } = await import('plist');
    const project = xcode.project(fileURLToPath(new URL('../../ios/App/App.xcodeproj/project.pbxproj', import.meta.url)));
    project.parseSync();
    const target = Object.entries(project.pbxNativeTargetSection()).find(([, value]) => value?.name === 'App');
    const sources = project.pbxSourcesBuildPhaseObj(target[0]).files;
    assert.equal(sources.filter(({ comment }) => comment === 'LudolumePresentationPlugin.swift in Sources').length, 1);
    const source = sources.find(({ comment }) => comment === 'LudolumePresentationPlugin.swift in Sources');
    const reference = project.pbxBuildFileSection()[source.value].fileRef;
    assert.equal(project.pbxFileReferenceSection()[reference].path, 'LudolumePresentationPlugin.swift');
    const info = plist.parse(await readFile(new URL('../../ios/App/App/Info.plist', import.meta.url), 'utf8'));
    assert.ok(!('UIRequiresFullScreen' in info) || info.UIRequiresFullScreen === false);
    assert.deepEqual(info['UISupportedInterfaceOrientations~ipad'].sort(), ['UIInterfaceOrientationLandscapeLeft',
        'UIInterfaceOrientationLandscapeRight', 'UIInterfaceOrientationPortrait', 'UIInterfaceOrientationPortraitUpsideDown'].sort());
    assert.ok(info.UISupportedInterfaceOrientations.includes('UIInterfaceOrientationLandscapeLeft'));
});
