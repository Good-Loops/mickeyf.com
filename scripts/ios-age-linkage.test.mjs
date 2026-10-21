import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { verifyAgeFrameworkLinkage } from './ios-age-linkage.mjs';

function image({ kind = 'LC_LOAD_WEAK_DYLIB', minimum = '15.0', framework = 'DeclaredAgeRange' } = {}) {
    return `/synthetic/App (architecture arm64):
Load command 0
      cmd LC_SEGMENT_64
  cmdsize 72
Load command 1
      cmd LC_BUILD_VERSION
  cmdsize 32
 platform 7
    minos ${minimum}
      sdk 26.6
Load command 2
      cmd ${kind}
  cmdsize 112
     name /System/Library/Frameworks/${framework}.framework/${framework} (offset 24)
 time stamp 2 Thu Jan  1 00:00:02 1970
 current version 1.0.0
compatibility version 1.0.0
`;
}

test('accepts an optional age framework with unchanged minimum OS in every architecture', () => {
    assert.deepEqual(verifyAgeFrameworkLinkage(image()), {
        images: 1, framework: 'DeclaredAgeRange', linkage: 'weak', minimumOS: '15.0',
    });
    assert.equal(verifyAgeFrameworkLinkage(image() + image({ minimum: '15.0.0' })).images, 2);
    assert.equal(verifyAgeFrameworkLinkage(image().replaceAll('\n', '\r\n')).images, 1);
});

test('rejects strong, re-exported, misplaced or absent age framework linkage', () => {
    for (const kind of ['LC_LOAD_DYLIB', 'LC_REEXPORT_DYLIB', 'LC_LOAD_UPWARD_DYLIB']) {
        assert.throws(() => verifyAgeFrameworkLinkage(image({ kind })), /optional system framework/);
    }
    assert.throws(() => verifyAgeFrameworkLinkage(image({ framework: 'Foundation' })), /exactly once/);
    assert.throws(() => verifyAgeFrameworkLinkage(image().replace('/System/Library/Frameworks/', '@rpath/')),
        /optional system framework/);
    const duplicate = image() + `Load command 3
      cmd LC_LOAD_DYLIB
     name /System/Library/Frameworks/DeclaredAgeRange.framework/DeclaredAgeRange (offset 24)
`;
    assert.throws(() => verifyAgeFrameworkLinkage(duplicate), /exactly once/);
    assert.throws(() => verifyAgeFrameworkLinkage(image() + image({ kind: 'LC_LOAD_DYLIB' })), /optional system framework/);
    assert.throws(() => verifyAgeFrameworkLinkage(image() + image({ framework: 'Foundation' })), /exactly once/);
});

test('rejects a raised or missing minimum OS in any image', () => {
    for (const minimum of ['15.1', '16.0', '26.0', '14.0', '15.0garbage']) {
        assert.throws(() => verifyAgeFrameworkLinkage(image({ minimum })), /minimum supported OS/);
    }
    assert.throws(() => verifyAgeFrameworkLinkage(image() + image({ minimum: '26.0' })), /minimum supported OS/);
    assert.throws(() => verifyAgeFrameworkLinkage(image().replace('LC_BUILD_VERSION', 'LC_UUID')), /one build version/);
    assert.throws(() => verifyAgeFrameworkLinkage(image().replace('    minos 15.0\n', '')), /minimum supported OS/);
    assert.throws(() => verifyAgeFrameworkLinkage(image().replace('    minos 15.0', '    minos 15.0\n    minos 26.0')),
        /minimum supported OS/);
});

test('rejects missing, truncated or malformed inspection metadata', () => {
    for (const output of ['', null, undefined, 'otool: inspection failed', 'x'.repeat(1_048_577)]) {
        assert.throws(() => verifyAgeFrameworkLinkage(output), /metadata|No Mach-O/);
    }
    assert.throws(() => verifyAgeFrameworkLinkage(image().replace('Load command 1', 'Load command 7')), /sequence/);
    assert.throws(() => verifyAgeFrameworkLinkage(image().replace('      cmd LC_LOAD_WEAK_DYLIB', '')), /command type/);
    assert.throws(() => verifyAgeFrameworkLinkage(image().replace('      cmd LC_LOAD_WEAK_DYLIB',
        '      cmd LC_LOAD_WEAK_DYLIB\n      cmd LC_LOAD_DYLIB')), /command type/);
});

test('only the unsigned compile mode gains inspection, and signed IPA inspection precedes upload', async () => {
    const workflow = await readFile(new URL('../.github/workflows/ios-build.yml', import.meta.url), 'utf8');
    const simulator = workflow.slice(workflow.indexOf('  simulator:'), workflow.indexOf('  testflight:'));
    assert.match(simulator, /Verify optional age framework linkage\s+if: \$\{\{ inputs\.compile_only \}\}/);
    assert.match(simulator, /xcrun otool -l "\$RUNNER_TEMP\/ludolume-derived-data\/Build\/Products\/Release-iphonesimulator\/App\.app\/App"/);
    assert.match(simulator, /node \.\.\/scripts\/ios-age-linkage\.mjs/);
    assert.ok(simulator.indexOf('Compile the simulator app without signing credentials')
        < simulator.indexOf('Verify optional age framework linkage'));
    const signing = await readFile(new URL('./ios-testflight.mjs', import.meta.url), 'utf8');
    const verify = signing.slice(signing.indexOf('function verifyIpa('), signing.indexOf('function cleanup('));
    assert.match(verify, /info\.CFBundleExecutable === 'App'/);
    assert.match(verify, /verifyAgeFrameworkLinkage\(run\('Inspect optional age framework linkage', 'otool', \['-l', join\(app, 'App'\)\]\)\.stdout\)/);
    assert.ok(signing.indexOf('const info = verifyIpa(config, signing, ipa);') < signing.indexOf("run('Apple build upload'"));
});
