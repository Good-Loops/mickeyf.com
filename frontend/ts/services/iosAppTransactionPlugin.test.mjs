import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const sourceUrl = new URL('../../ios/App/App/LudolumeAppTransactionPlugin.swift', import.meta.url);

test('the App Store bridge is compiled and registered once for the opt-in client', async () => {
    const { default: xcode } = await import('xcode');
    const project = xcode.project(fileURLToPath(new URL('../../ios/App/App.xcodeproj/project.pbxproj', import.meta.url)));
    project.parseSync();
    const target = Object.entries(project.pbxNativeTargetSection()).find(([, value]) => value?.name === 'App');
    assert.ok(target);
    const matches = project.pbxSourcesBuildPhaseObj(target[0]).files
        .filter(({ comment }) => comment === 'LudolumeAppTransactionPlugin.swift in Sources');
    assert.equal(matches.length, 1);
    const reference = project.pbxBuildFileSection()[matches[0].value].fileRef;
    assert.equal(project.pbxFileReferenceSection()[reference].path, 'LudolumeAppTransactionPlugin.swift');
    const bridge = await readFile(new URL('../../ios/App/App/LudolumeApiPlugin.swift', import.meta.url), 'utf8');
    assert.equal(bridge.split('registerPluginInstance(LudolumeAppTransactionPlugin())').length - 1, 1);
});

test('device verification uses Apple nonce ordering and rejects a different device', {
    skip: process.platform !== 'darwin' ? 'Requires macOS CryptoKit; Windows does not compile Swift.' : false,
}, async () => {
    const source = await readFile(sourceUrl, 'utf8');
    const marker = 'enum LudolumeAppTransactionDeviceCheck {';
    assert.equal(source.split(marker).length - 1, 1);
    const helper = source.slice(source.indexOf(marker));
    const directory = await mkdtemp(join(tmpdir(), 'ludolume-store-device-'));
    try {
        const harness = join(directory, 'main.swift');
        await writeFile(harness, `import Foundation\nimport CryptoKit\n${helper}\n
let nonce = UUID(uuidString: "550E8400-E29B-41D4-A716-446655440000")!
let device = UUID(uuidString: "123E4567-E89B-12D3-A456-426614174000")!
let expectedHex = "c3517c8c79fa0fd89bb5e72f76087f5946fe8edd61cece8b3685cc6240d778134a5c1cbc1548089cc806fbefce3170ef"
var bytes = [UInt8]()
var index = expectedHex.startIndex
while index < expectedHex.endIndex {
    let end = expectedHex.index(index, offsetBy: 2)
    bytes.append(UInt8(expectedHex[index..<end], radix: 16)!)
    index = end
}
let expected = Data(bytes)
precondition(LudolumeAppTransactionDeviceCheck.matches(nonce: nonce, deviceID: device, expected: expected))
precondition(!LudolumeAppTransactionDeviceCheck.matches(nonce: device, deviceID: nonce, expected: expected))
precondition(!LudolumeAppTransactionDeviceCheck.matches(nonce: nonce, deviceID: device, expected: Data()))
`, 'utf8');
        const result = spawnSync('xcrun', ['swift', harness], { encoding: 'utf8', timeout: 60_000 });
        assert.ifError(result.error);
        assert.equal(result.status, 0, `Swift device check failed:\n${result.stdout}\n${result.stderr}`);
    } finally {
        assert.equal(dirname(directory), resolve(tmpdir()));
        await rm(directory, { recursive: true, force: true });
    }
});
