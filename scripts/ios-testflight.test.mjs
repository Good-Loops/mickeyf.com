import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { buildNumber, exportOptions, uploadArguments, uploadDistribution } from './ios-testflight.mjs';

const signing = { fingerprint: 'TEST_CERTIFICATE', profile: { uuid: 'TEST_PROFILE' } };

test('upload distribution stays internal-only unless the draft option is explicit', () => {
    assert.equal(uploadDistribution(), 'internal-only');
    assert.equal(uploadDistribution('internal-only'), 'internal-only');
    assert.equal(uploadDistribution('app-store-draft'), 'app-store-draft');
    for (const invalid of ['', 'app-store', 'release', 'true', true, false, null]) {
        assert.throws(() => uploadDistribution(invalid), /Upload distribution/);
    }
});

test('draft eligibility changes only the internal-only export restriction', () => {
    const internal = exportOptions(signing);
    assert.deepEqual(internal, {
        method: 'app-store-connect', destination: 'export', signingStyle: 'manual',
        teamID: 'AX4Z7T24C9', signingCertificate: signing.fingerprint,
        provisioningProfiles: { 'com.mickeyf.app': signing.profile.uuid },
        manageAppVersionAndBuildNumber: false, testFlightInternalTestingOnly: true, stripSwiftSymbols: true,
    });
    assert.deepEqual(exportOptions(signing, 'app-store-draft'), { ...internal, testFlightInternalTestingOnly: false });
    assert.throws(() => exportOptions(signing, 'release'), /Upload distribution/);
});

test('upload remains the same verified-app package upload, not a release operation', () => {
    assert.deepEqual(uploadArguments('App.ipa', 'TEST_KEY', 'TEST_ISSUER'), [
        'altool', '--upload-package', 'App.ipa', '--platform', 'ios', '--apple-id', '6810735137',
        '--api-key', 'TEST_KEY', '--api-issuer', 'TEST_ISSUER', '--wait', '--output-format', 'json',
    ]);
    assert.equal(buildNumber('10', '1'), '10.1.0');
    assert.throws(() => buildNumber('0', '1'), /build-number range/);
});

test('workflow keeps the default and protected branch gate for both upload modes', async () => {
    const workflow = await readFile(new URL('../.github/workflows/ios-build.yml', import.meta.url), 'utf8');
    assert.match(workflow, /upload_testflight:[\s\S]*?type: boolean\s+required: false\s+default: false/);
    assert.match(workflow, /upload_distribution:[\s\S]*?type: choice\s+required: true\s+default: internal-only\s+options:\s+- internal-only\s+- app-store-draft/);
    assert.match(workflow, /if: \$\{\{ !inputs\.compile_only && inputs\.upload_testflight && github\.ref == 'refs\/heads\/improvement\/clean-code-sweep' \}\}/);
    assert.match(workflow, /environment: ios-testflight/);
    assert.match(workflow, /IOS_UPLOAD_DISTRIBUTION: \$\{\{ inputs\.upload_distribution \|\| 'internal-only' \}\}/);
    assert.match(workflow, /node --test \.\.\/scripts\/ios-testflight\.test\.mjs/);
    assert.match(workflow, /Remove signing material and signed outputs\s+if: \$\{\{ always\(\) \}\}\s+run: node \.\.\/scripts\/ios-testflight\.mjs cleanup/);
});


test('compile-only workflow uses existing hosted tools and never signs or uploads app artifacts', async () => {
    const workflow = await readFile(new URL('../.github/workflows/ios-build.yml', import.meta.url), 'utf8');
    assert.match(workflow, /compile_only:[\s\S]*?type: boolean\s+required: false\s+default: false/);
    assert.match(workflow, /Package simulator app\s+if: \$\{\{ !inputs\.compile_only \}\}/);
    assert.match(workflow, /Upload simulator app\s+if: \$\{\{ !inputs\.compile_only \}\}/);
    const android = workflow.slice(workflow.indexOf('  android:'));
    assert.match(android, /inputs\.compile_only && !inputs\.upload_testflight/);
    assert.match(android, /runs-on: ubuntu-24.04/);
    assert.match(android, /licenses\/android-sdk-license/);
    assert.doesNotMatch(android, /^\s*sdkmanager\s|secrets\.|upload-artifact@|setup-gradle@|actions\/cache@/m);
    assert.match(android, /:app:testReleaseUnitTest :app:lintRelease :app:assembleRelease/);
});
