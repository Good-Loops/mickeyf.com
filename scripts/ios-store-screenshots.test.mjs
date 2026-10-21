import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { cleanupTarget, configuration, inside, selectDevices, validateGeometry, validateLaunch } from './ios-store-screenshots.mjs';

const env = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch',
    LUDOLUME_CAPTURE_STORE_SCREENSHOTS: 'true', LUDOLUME_UPLOAD_TESTFLIGHT: 'false', LUDOLUME_COMPILE_ONLY: 'false',
    RUNNER_TEMP: tmpdir(), GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: 'a'.repeat(40) };
const runtime = { identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-6', version: '26.6', isAvailable: true };
const type = (name, productFamily, identifier) => ({ name, productFamily,
    identifier: `com.apple.CoreSimulator.SimDeviceType.${identifier}`, minRuntimeVersion: 26 * 65536, maxRuntimeVersion: 0xffffffff });
const inventory = { runtimes: [runtime], devicetypes: [
    type('iPhone 16 Pro Max', 'iPhone', 'real-iphone-inventory-id'),
    type('iPad Pro 13-inch (M4)', 'iPad', 'real-ipad-inventory-id'),
    type('iPhone 16 Pro', 'iPhone', 'wrong-size'),
] };

test('capture requires manual unsigned opt-in and never accepts signing material or compile-only mode', () => {
    const config = configuration(env, 'darwin');
    assert.ok(inside(env.RUNNER_TEMP, config.root));
    for (const [key, value] of [['LUDOLUME_CAPTURE_STORE_SCREENSHOTS', 'false'], ['LUDOLUME_UPLOAD_TESTFLIGHT', 'true'],
        ['LUDOLUME_COMPILE_ONLY', 'true'], ['GITHUB_EVENT_NAME', 'push'], ['RUNNER_TEMP', 'relative'],
        ['GITHUB_RUN_ID', '../123'], ['GITHUB_SHA', 'HEAD'], ['IOS_DISTRIBUTION_P12_BASE64', 'synthetic']]) {
        assert.throws(() => configuration({ ...env, [key]: value }, 'darwin'), undefined, key);
    }
    assert.throws(() => configuration(env, 'win32'), /macOS/);
});

test('capture paths must be strict children, never siblings, parents or the root itself', () => {
    const root = join(tmpdir(), 'screenshot-root');
    assert.equal(inside(root, join(root, 'work', 'image.png')), true);
    for (const path of [root, join(root, '..'), join(root, '..', 'screenshot-root-other', 'file'), join(root, '..', 'file')]) {
        assert.equal(inside(root, path), false);
    }
});

test('device selection uses compatible installed types and runtimes and fails for missing supported families', () => {
    const chosen = selectDevices(inventory);
    assert.equal(chosen[0].type.identifier, inventory.devicetypes[0].identifier);
    assert.equal(chosen[1].type.identifier, inventory.devicetypes[1].identifier);
    const future = structuredClone(inventory);
    future.devicetypes.unshift({ ...type('iPhone 18 Pro Max', 'iPhone', 'future'), minRuntimeVersion: 27 * 65536 });
    assert.equal(selectDevices(future)[0].type.identifier, inventory.devicetypes[0].identifier);
    assert.throws(() => selectDevices({ ...inventory, runtimes: [{ ...runtime, isAvailable: false }] }), /No installed/);
    assert.throws(() => selectDevices({ ...inventory, devicetypes: inventory.devicetypes.slice(0, 1) }), /ipad/);
    assert.throws(() => selectDevices({ ...inventory, devicetypes: [inventory.devicetypes[2], inventory.devicetypes[1]] }), /iphone/);
    assert.throws(() => selectDevices({ ...inventory, runtimes: [{ ...runtime, version: 'latest' }] }), /Malformed/);
});

test('only actual Apple-accepted portrait pixel dimensions pass, including both supported iPad variants', () => {
    validateGeometry('iphone', 1320, 2868);
    validateGeometry('iphone', 1290, 2796);
    validateGeometry('ipad', 2064, 2752);
    validateGeometry('ipad', 2048, 2732);
    for (const [family, width, height] of [['iphone', 1179, 2556], ['ipad', 1668, 2388], ['iphone', 2868, 1320], ['other', 1320, 2868]]) {
        assert.throws(() => validateGeometry(family, width, height), /dimensions/);
    }
});

test('cleanup requires the exact created UUID, run name, device type and runtime', () => {
    const owned = { udid: '11111111-1111-4111-8111-111111111111', name: 'Ludolume-Store-123-1-iphone',
        type: inventory.devicetypes[0].identifier, runtime: runtime.identifier };
    const devices = { devices: { [runtime.identifier]: [{ udid: owned.udid, name: owned.name,
        deviceTypeIdentifier: owned.type, state: 'Booted' }] } };
    assert.equal(cleanupTarget(owned, devices).udid, owned.udid);
    for (const change of [{ udid: 'all' }, { udid: '22222222-2222-4222-8222-222222222222' },
        { name: 'Someone elses iPhone' }, { name: 'Ludolume-Store-999-1-iphone' },
        { type: inventory.devicetypes[1].identifier }, { runtime: `${runtime.identifier}-other` }]) {
        assert.throws(() => cleanupTarget({ ...owned, ...change }, devices), /cleanup/);
    }
    assert.throws(() => cleanupTarget(owned, { devices: { [runtime.identifier]: [...devices.devices[runtime.identifier], ...devices.devices[runtime.identifier]] } }), /cleanup/);
});

test('native launch proof requires the exact app bundle and a positive process identifier', () => {
    validateLaunch('com.mickeyf.app: 1234');
    for (const output of ['', 'com.mickeyf.app: 0', 'com.mickeyf.other: 1234', 'comXmickeyfXapp: 1234', 'App launched']) {
        assert.throws(() => validateLaunch(output), /process identifier/);
    }
});

test('workflow capture remains default-off, unsigned, separate from signing and limited to final guest images', () => {
    const workflow = readFileSync(new URL('../.github/workflows/ios-build.yml', import.meta.url), 'utf8');
    assert.match(workflow, /capture_store_screenshots:[\s\S]*?type: boolean\s+required: false\s+default: false/);
    assert.match(workflow, /Capture actual native Home screenshots\s+if: \$\{\{ inputs\.capture_store_screenshots && !inputs\.compile_only && !inputs\.upload_testflight \}\}/);
    assert.match(workflow, /LUDOLUME_UPLOAD_TESTFLIGHT: "false"/);
    assert.match(workflow, /screenshots\/iphone-home\.jpg/);
    assert.match(workflow, /screenshots\/ipad-home\.jpg/);
    assert.match(workflow, /screenshots\/manifest\.json/);
    assert.match(workflow, /Upload simulator app\s+if: \$\{\{ !inputs\.compile_only && !inputs\.capture_store_screenshots \}\}/);
    assert.match(workflow, /Upload Xcode diagnostics on failure\s+if: \$\{\{ failure\(\) && !inputs\.compile_only && !inputs\.capture_store_screenshots \}\}/);
    const signing = workflow.slice(workflow.indexOf('  testflight:'), workflow.indexOf('  android:'));
    assert.doesNotMatch(signing, /capture_store_screenshots|ios-store-screenshots/);
});
