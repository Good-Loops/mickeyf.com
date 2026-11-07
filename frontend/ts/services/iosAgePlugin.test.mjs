import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const pluginUrl = new URL('../../ios/App/App/LudolumeAgePlugin.swift', import.meta.url);

test('iOS age bridge is registered once, built into the app, and keeps its minimum supported OS', async () => {
    const { default: xcode } = await import('xcode'), { default: plist } = await import('plist');
    const project = xcode.project(fileURLToPath(new URL('../../ios/App/App.xcodeproj/project.pbxproj', import.meta.url)));
    project.parseSync();
    const target = Object.entries(project.pbxNativeTargetSection()).find(([, value]) => value?.name === 'App');
    assert.ok(target);
    const sources = project.pbxSourcesBuildPhaseObj(target[0]).files;
    const matches = sources.filter(({ comment }) => comment === 'LudolumeAgePlugin.swift in Sources');
    assert.equal(matches.length, 1);
    const reference = project.pbxBuildFileSection()[matches[0].value].fileRef;
    assert.equal(project.pbxFileReferenceSection()[reference].path, 'LudolumeAgePlugin.swift');
    const configurations = Object.values(project.pbxXCBuildConfigurationSection()).filter(value => value?.buildSettings);
    assert.equal(configurations.length, 4);
    assert.ok(configurations.every(({ buildSettings }) => String(buildSettings.IPHONEOS_DEPLOYMENT_TARGET) === '15.0'));
    const targetConfigurations = project.pbxXCConfigurationList()[target[1].buildConfigurationList].buildConfigurations
        .map(({ value }) => project.pbxXCBuildConfigurationSection()[value]);
    assert.ok(targetConfigurations.every(({ buildSettings }) => buildSettings.CODE_SIGN_ENTITLEMENTS === 'App/App.entitlements'));
    const entitlements = plist.parse(await readFile(new URL('../../ios/App/App/App.entitlements', import.meta.url), 'utf8'));
    assert.equal(entitlements['com.apple.developer.declared-age-range'], true);
    assert.deepEqual(entitlements['com.apple.developer.applesignin'], ['Default']);
    const bridge = await readFile(new URL('../../ios/App/App/LudolumeApiPlugin.swift', import.meta.url), 'utf8');
    assert.equal(bridge.split('bridge?.registerPluginInstance(LudolumeAgePlugin())').length - 1, 1);
});

test('iOS age request is explicit, foreground-only and serialized, with protective fallbacks', async () => {
    // Structural guards are not a substitute for compiling against Apple's SDK or testing a device.
    const source = await readFile(pluginUrl, 'utf8');
    assert.match(source, /^import DeclaredAgeRange$/m);
    assert.doesNotMatch(source, /canImport\(DeclaredAgeRange\)/);
    assert.match(source, /public let jsName = "LudolumeAge"/);
    assert.deepEqual([...source.matchAll(/CAPPluginMethod\(name: "([^"]+)"/g)].map(match => match[1]), ['requestAgeRange']);
    assert.match(source, /guard call\.options\.count == 0 else/);
    assert.match(source, /Task \{ @MainActor in/);
    assert.match(source, /guard #available\(iOS 26\.0, \*\) else \{\s*call\.resolve\(LudolumeAgeRangeResult\.nonShared\(\.unsupported\)\)/);
    assert.match(source, /guard !self\.requestIsActive,/);
    assert.match(source, /controller\.viewIfLoaded\?\.window\?\.windowScene/);
    assert.match(source, /scene\.activationState == \.foregroundActive/);
    assert.match(source, /controller\.presentedViewController == nil/);
    assert.match(source, /self\.requestIsActive = true\s*defer \{ self\.requestIsActive = false \}/);
    assert.equal(source.split('AgeRangeService.shared.requestAgeRange(').length - 1, 1);
    assert.match(source, /AgeRangeService\.shared\.requestAgeRange\(\s*ageGates: 13, 16, 18,\s*in: controller/);
    assert.match(source, /case let \.sharing\(range\):[\s\S]*lowerBound: range\.lowerBound, exclusiveUpperBound: range\.upperBound/);
    assert.match(source, /case \.declinedSharing:\s*call\.resolve\(LudolumeAgeRangeResult\.nonShared\(\.notShared\)\)/);
    assert.match(source, /@unknown default:\s*call\.resolve\(LudolumeAgeRangeResult\.nonShared\(\.unavailable\)\)/);
    assert.match(source, /\} catch \{\s*\/\/[^\n]*\n\s*call\.resolve\(LudolumeAgeRangeResult\.nonShared\(\.unavailable\)\)/);
    assert.doesNotMatch(source, /func load\(|URLSession|UserDefaults|Keychain|NSLog|print\(|ageRangeDeclaration|activeParentalControls|identityToken|DateOfBirth/);
});

test('actual Swift normalization preserves regional bounds, inclusive maxima and nulls', {
    skip: process.platform !== 'darwin' ? 'Requires macOS Swift; the Windows checks do not compile Swift.' : false,
}, async () => {
    const source = await readFile(pluginUrl, 'utf8');
    const marker = 'enum LudolumeAgeRangeResult {';
    assert.equal(source.split(marker).length - 1, 1);
    const helper = source.slice(source.indexOf(marker));
    const directory = await mkdtemp(join(tmpdir(), 'ludolume-age-normalization-'));
    try {
        const harness = join(directory, 'main.swift');
        await writeFile(harness, `import Foundation\n${helper}\n
func expect(_ lower: Int?, _ upper: Int?, _ status: String, _ minimum: Int?, _ maximum: Int?) {
    let result = LudolumeAgeRangeResult.shared(lowerBound: lower, exclusiveUpperBound: upper)
    let expected: [String: Any] = ["status": status, "minimumAge": minimum.map { $0 as Any } ?? NSNull(),
        "maximumAge": maximum.map { $0 as Any } ?? NSNull()]
    precondition(NSDictionary(dictionary: result).isEqual(to: expected), "Incorrect normalized age range")
    precondition(JSONSerialization.isValidJSONObject(result), "Response must be JSON-compatible")
}
expect(nil, 13, "shared", nil, 12)
expect(13, 16, "shared", 13, 15)
expect(16, 18, "shared", 16, 17)
expect(18, nil, "shared", 18, nil)
expect(nil, 12, "shared", nil, 11)
expect(12, 16, "shared", 12, 15)
expect(0, 1, "shared", 0, 0)
expect(nil, 1, "shared", nil, 0)
expect(150, 151, "shared", 150, 150)
expect(150, nil, "shared", 150, nil)
expect(nil, nil, "unavailable", nil, nil)
expect(-1, 13, "unavailable", nil, nil)
expect(151, nil, "unavailable", nil, nil)
expect(nil, 0, "unavailable", nil, nil)
expect(nil, -1, "unavailable", nil, nil)
expect(nil, 152, "unavailable", nil, nil)
expect(13, 13, "unavailable", nil, nil)
expect(18, 16, "unavailable", nil, nil)
expect(Int.min, 13, "unavailable", nil, nil)
expect(nil, Int.min, "unavailable", nil, nil)
expect(Int.max, nil, "unavailable", nil, nil)
expect(nil, Int.max, "unavailable", nil, nil)
for status in [LudolumeAgeRangeResult.NonSharedStatus.notShared, .unsupported, .unavailable] {
    let expected: [String: Any] = ["status": status.rawValue, "minimumAge": NSNull(), "maximumAge": NSNull()]
    precondition(NSDictionary(dictionary: LudolumeAgeRangeResult.nonShared(status)).isEqual(to: expected))
}
`, 'utf8');
        const result = spawnSync('xcrun', ['swift', harness], { encoding: 'utf8', timeout: 60_000 });
        assert.ifError(result.error);
        assert.equal(result.status, 0, `Swift normalization failed:\n${result.stdout}\n${result.stderr}`);
    } finally {
        assert.equal(dirname(directory), resolve(tmpdir()));
        assert.ok(basename(directory).startsWith('ludolume-age-normalization-'));
        await rm(directory, { recursive: true, force: true });
    }
});
