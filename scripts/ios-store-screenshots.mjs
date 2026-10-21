// Unsigned, guest-only Home captures. This helper never signs, uploads to Apple, or opens account forms.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const BUNDLE = 'com.mickeyf.app';
// Only the reviewed GitHub-hosted macOS layout is accepted; environment paths never become I/O targets.
const RUNNER_TEMP = '/Users/runner/work/_temp';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const secretNames = ['IOS_DISTRIBUTION_P12_BASE64', 'IOS_DISTRIBUTION_P12_PASSWORD',
    'IOS_PROVISION_PROFILE_BASE64', 'ASC_PRIVATE_KEY_P8'];
const requireThat = (condition, message) => { if (!condition) throw new Error(message); };
const pause = ms => new Promise(done => setTimeout(done, ms));

export function inside(root, path) {
    const suffix = relative(resolve(root), resolve(path));
    return suffix !== '' && suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

export function configuration(env = process.env, platform = process.platform) {
    requireThat(platform === 'darwin' && env.GITHUB_ACTIONS === 'true' && env.GITHUB_EVENT_NAME === 'workflow_dispatch',
        'Screenshots require the manual GitHub-hosted macOS job.');
    requireThat(env.LUDOLUME_CAPTURE_STORE_SCREENSHOTS === 'true' && env.LUDOLUME_UPLOAD_TESTFLIGHT === 'false'
        && env.LUDOLUME_COMPILE_ONLY === 'false' && !secretNames.some(name => Object.hasOwn(env, name)),
    'Screenshots require explicit unsigned mode without signing material.');
    requireThat(env.RUNNER_TEMP === RUNNER_TEMP && /^[1-9]\d*$/u.test(env.GITHUB_RUN_ID ?? '')
        && /^[1-9]\d*$/u.test(env.GITHUB_RUN_ATTEMPT ?? '') && /^[0-9a-f]{40}$/u.test(env.GITHUB_SHA ?? ''),
    'Invalid runner path, run identity, or source commit.');
    const runId = Number(env.GITHUB_RUN_ID);
    const attempt = Number(env.GITHUB_RUN_ATTEMPT);
    requireThat(Number.isSafeInteger(runId) && Number.isSafeInteger(attempt), 'Run identity exceeds safe bounds.');
    const temporary = resolve(RUNNER_TEMP);
    const root = join(temporary, `ludolume-store-screenshots-${runId}-${attempt}`);
    const app = join(temporary, 'ludolume-derived-data/Build/Products/Release-iphonesimulator/App.app');
    requireThat(inside(temporary, root) && inside(temporary, app), 'Capture paths must stay in the runner temporary directory.');
    return { temporary, root, app, work: join(root, 'work'), output: join(root, 'screenshots'),
        source: env.GITHUB_SHA, owner: `${runId}-${attempt}` };
}

function versionNumber(value) {
    requireThat(typeof value === 'string' && /^\d+\.\d+(?:\.\d+)?$/u.test(value), 'Malformed simulator runtime version.');
    const [major, minor, patch = 0] = value.split('.').map(Number);
    requireThat(major <= 255 && minor <= 255 && patch <= 255, 'Simulator runtime version exceeds supported bounds.');
    return major * 65536 + minor * 256 + patch;
}

// Names come from the actual simctl inventory, not constructed simulator identifiers.
function deviceScore(type, family) {
    if (family === 'iphone' && type.productFamily === 'iPhone') {
        const max = /^iPhone (14|15|16|17|18) Pro Max$/u.exec(type.name);
        if (max) return 100 + Number(max[1]);
        const plus = /^iPhone (14|15|16) Plus$/u.exec(type.name);
        if (plus) return Number(plus[1]);
        if (type.name === 'iPhone Air') return 1;
    }
    if (family === 'ipad' && type.productFamily === 'iPad') {
        const modern = /^iPad (Pro|Air) 13-inch \(M([2-5])\)$/u.exec(type.name);
        if (modern) return (modern[1] === 'Pro' ? 100 : 0) + Number(modern[2]);
        const older = /^iPad Pro \(12\.9-inch\) \((3rd|4th|5th|6th) generation\)$/u.exec(type.name);
        if (older) return Number(older[1][0]);
    }
    return -1;
}

export function selectDevices(inventory) {
    requireThat(Array.isArray(inventory.devicetypes) && Array.isArray(inventory.runtimes), 'Simulator inventory is malformed.');
    const runtimes = inventory.runtimes.filter(runtime => runtime.isAvailable === true
        && /^com\.apple\.CoreSimulator\.SimRuntime\.iOS-\d+(?:-\d+){1,2}$/u.test(runtime.identifier ?? ''))
        .map(runtime => ({ ...runtime, numericVersion: versionNumber(runtime.version) }))
        .sort((a, b) => b.numericVersion - a.numericVersion);
    return ['iphone', 'ipad'].map(family => {
        for (const runtime of runtimes) {
            const types = inventory.devicetypes.filter(type => deviceScore(type, family) >= 0
                && /^com\.apple\.CoreSimulator\.SimDeviceType\.[A-Za-z0-9-]+$/u.test(type.identifier ?? '')
                && Number.isInteger(type.minRuntimeVersion) && Number.isInteger(type.maxRuntimeVersion)
                && type.minRuntimeVersion <= runtime.numericVersion && type.maxRuntimeVersion >= runtime.numericVersion)
                .sort((a, b) => deviceScore(b, family) - deviceScore(a, family) || a.identifier.localeCompare(b.identifier));
            if (types.length) return { family, type: types[0], runtime };
        }
        throw new Error(`No installed, compatible ${family} simulator matches the reviewed App Store screenshot sizes.`);
    });
}

export function validateGeometry(family, width, height) {
    const sizes = family === 'iphone' ? [[1320, 2868], [1290, 2796], [1260, 2736]]
        : family === 'ipad' ? [[2064, 2752], [2048, 2732]] : [];
    requireThat(sizes.some(([w, h]) => w === width && h === height), 'Native screenshot dimensions do not match the reviewed portrait display group.');
}

export function validateLaunch(output) {
    requireThat(/^com\.mickeyf\.app:\s*[1-9]\d*$/u.test(output), 'App launch did not report a process identifier.');
}

export function cleanupTarget(owned, inventory) {
    requireThat(UUID.test(owned.udid ?? '') && /^Ludolume-Store-[1-9]\d*-[1-9]\d*-(?:iphone|ipad)$/u.test(owned.name ?? ''),
        'Refusing cleanup of an unowned simulator identity.');
    requireThat(inventory?.devices && typeof inventory.devices === 'object', 'Simulator cleanup inventory is unavailable.');
    const matches = Object.entries(inventory.devices).flatMap(([runtime, devices]) => {
        requireThat(Array.isArray(devices), 'Malformed cleanup device list.');
        return devices.filter(device => device.udid === owned.udid).map(device => ({ ...device, runtime }));
    });
    requireThat(matches.length === 1 && matches[0].name === owned.name && matches[0].runtime === owned.runtime
        && matches[0].deviceTypeIdentifier === owned.type, 'Refusing cleanup of a simulator outside this capture run.');
    return matches[0];
}

function command(label, binary, args, timeout = 60_000) {
    const result = spawnSync(binary, args, { encoding: 'utf8', timeout, maxBuffer: 2 * 1024 * 1024 });
    requireThat(!result.error && result.status === 0, `${label} failed or timed out; no raw process/app output was logged.`);
    return result.stdout.trim();
}
const simctl = (label, ...args) => command(label, 'xcrun', ['simctl', ...args], 180_000);
const json = text => JSON.parse(text);
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');

async function captureHome(config, selected, owned, ocr) {
    const name = `Ludolume-Store-${config.owner}-${selected.family}`;
    const udid = simctl('Create owned screenshot simulator', 'create', name, selected.type.identifier, selected.runtime.identifier);
    requireThat(UUID.test(udid), 'Simulator creation returned an invalid UUID.');
    const record = { udid, name, type: selected.type.identifier, runtime: selected.runtime.identifier };
    owned.push(record);
    simctl('Boot screenshot simulator', 'boot', udid);
    simctl('Wait for simulator boot', 'bootstatus', udid, '-b');
    simctl('Install unsigned simulator app', 'install', udid, config.app);
    simctl('Verify installed app container', 'get_app_container', udid, BUNDLE, 'app');
    simctl('Set clean system status bar', 'status_bar', udid, 'override', '--time', '9:41',
        '--dataNetwork', 'wifi', '--wifiMode', 'active', '--wifiBars', '3', '--batteryState', 'charged', '--batteryLevel', '100');
    const launched = simctl('Launch unsigned native app', 'launch', udid, BUNDLE);
    validateLaunch(launched);
    const deadline = Date.now() + 120_000;
    let firstReady = null;
    let attempt = 0;
    while (Date.now() < deadline) {
        const frame = join(config.work, `${selected.family}-${++attempt}.png`);
        simctl('Capture native simulator screen', 'io', udid, 'screenshot', '--type=png', frame);
        const result = json(command('Check rendered Home with local Apple Vision', ocr, [frame], 30_000));
        validateGeometry(selected.family, result.width, result.height);
        if (result.home === true && result.navigation === true) {
            if (firstReady !== null && Date.now() - firstReady >= 3000) {
                const destination = join(config.output, `${selected.family}-home.jpg`);
                command('Export opaque native screenshot', 'sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '100', frame, '--out', destination]);
                const exported = json(command('Verify exported native Home', ocr, [destination], 30_000));
                requireThat(exported.home === true && exported.navigation === true
                    && exported.width === result.width && exported.height === result.height, 'Exported Home screenshot verification failed.');
                return { file: `${selected.family}-home.jpg`, sha256: sha256(destination),
                    nativePngSha256: sha256(frame), width: result.width, height: result.height,
                    deviceType: selected.type.identifier, deviceName: selected.type.name,
                    runtime: selected.runtime.identifier, runtimeVersion: selected.runtime.version,
                    scene: 'guest-home', nativeCapture: true, homeAndNavigationRecognizedTwice: true,
                    visualReview: 'pending', gameplayOrProviderAcceptance: false };
            }
            firstReady ??= Date.now();
        } else firstReady = null;
        await pause(3000);
    }
    throw new Error(`Native ${selected.family} Home did not become visibly ready within two minutes.`);
}

export async function main() {
    const config = configuration();
    requireThat(realpathSync(config.temporary) === config.temporary && !lstatSync(config.temporary).isSymbolicLink(), 'Runner temporary directory must resolve without a symlink.');
    requireThat(inside(config.temporary, realpathSync(config.app)) && lstatSync(config.app).isDirectory()
        && !lstatSync(config.app).isSymbolicLink(), 'Unsigned app must be a real bundle inside the runner temporary directory.');
    requireThat(command('Check exact checkout source', 'git', ['rev-parse', 'HEAD']) === config.source, 'Checkout differs from the workflow source commit.');
    const info = json(command('Inspect unsigned simulator app', 'plutil', ['-convert', 'json', '-o', '-', join(config.app, 'Info.plist')]));
    requireThat(info.CFBundleIdentifier === BUNDLE && info.CFBundleSupportedPlatforms?.includes('iPhoneSimulator')
        && Array.isArray(info.UIDeviceFamily) && [1, 2].every(family => info.UIDeviceFamily.includes(family)), 'Unsigned app identity/platform/device families differ.');
    const xcode = command('Inspect pinned Xcode', 'xcodebuild', ['-version']);
    requireThat(xcode.includes('Xcode 26.6'), 'Screenshot job requires the reviewed Xcode 26.6 toolchain.');
    mkdirSync(config.root, { mode: 0o700 });
    mkdirSync(config.work, { mode: 0o700 });
    mkdirSync(config.output, { mode: 0o700 });
    const inventory = { ...json(simctl('Inventory installed device types', 'list', 'devicetypes', '--json')),
        ...json(simctl('Inventory installed runtimes', 'list', 'runtimes', '--json')) };
    const selected = selectDevices(inventory);
    const ocr = join(config.work, 'check-native-home');
    command('Compile host-only Apple Vision readiness check', 'xcrun', ['swiftc', fileURLToPath(new URL('./ios-store-screenshots-ocr.swift', import.meta.url)), '-o', ocr], 120_000);
    const owned = [];
    const captures = [];
    try {
        for (const device of selected) captures.push(await captureHome(config, device, owned, ocr));
    } finally {
        const cleanupErrors = [];
        for (const record of owned) {
            try {
                const device = cleanupTarget(record, json(simctl('Verify owned cleanup target', 'list', 'devices', '--json')));
                if (device.state !== 'Shutdown') simctl('Shut down owned simulator', 'shutdown', record.udid);
                simctl('Delete owned simulator', 'delete', record.udid);
            } catch (error) { cleanupErrors.push(error.message); }
        }
        requireThat(cleanupErrors.length === 0, `Owned simulator cleanup failed: ${cleanupErrors.join('; ')}`);
    }
    writeFileSync(join(config.output, 'manifest.json'), JSON.stringify({ schemaVersion: 1, sourceCommit: config.source,
        runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT,
        bundleId: BUNDLE, appVersion: info.CFBundleShortVersionString, simulatorBuild: info.CFBundleVersion,
        unsignedSimulatorBuild: true, signedBuildEquivalence: 'Same source; simulator architecture is not the signed IPA.',
        scope: 'Two actual guest Home screenshots only; visual review required. No gameplay or provider acceptance.',
        xcode, capturedAt: new Date().toISOString(), captures }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log('Captured two native guest Home screenshots; visual review remains required.');
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
    main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
