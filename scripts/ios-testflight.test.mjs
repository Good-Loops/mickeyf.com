import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { buildNumber, exportOptions, uploadArguments, uploadDistribution, signingBranchAllowed,
    applySigningSettings, validateProfile, validateSignedEntitlements, verifySignedEntitlements } from './ios-testflight.mjs';

const signing = { fingerprint: 'TEST_CERTIFICATE', profile: { uuid: 'TEST_PROFILE' } };

const appleEntitlements = {
    'application-identifier': 'AX4Z7T24C9.com.mickeyf.app',
    'com.apple.developer.team-identifier': 'AX4Z7T24C9',
    'get-task-allow': false,
    'beta-reports-active': true,
    'com.apple.developer.applesignin': ['Default'],
    'com.apple.developer.declared-age-range': true,
};
const profile = () => ({ uuid: '10000000-0000-4000-8000-000000000000', teams: ['AX4Z7T24C9'],
    expires: '2030-01-01T00:00:00Z', platforms: ['iOS'], hasDevices: false, allDevices: false,
    entitlements: structuredClone(appleEntitlements), certificates: ['SYNTHETIC_CERTIFICATE'] });

test('distribution profile must explicitly authorize native Apple sign-in', () => {
    assert.equal(validateProfile(profile(), Date.parse('2026-10-17T00:00:00Z')).uuid, profile().uuid);
    for (const value of [undefined, true, 'Default', [], ['default'], ['Default', 'Other']]) {
        const invalid = profile();
        invalid.entitlements['com.apple.developer.applesignin'] = value;
        assert.throws(() => validateProfile(invalid), /Provisioning profile must grant.*Apple Default/);
    }
});

test('distribution profile must authorize Declared Age Range before signing material can be installed', () => {
    assert.equal(validateProfile(profile(), Date.parse('2026-10-20T00:00:00Z')).uuid, profile().uuid);
    for (const value of [undefined, null, false, 0, 1, 'true', 'Default', [], {}]) {
        const invalid = profile();
        invalid.entitlements['com.apple.developer.declared-age-range'] = value;
        assert.throws(() => validateProfile(invalid), /Provisioning profile must grant the Declared Age Range entitlement as Boolean true/);
    }
});

test('exported signed IPA must actually claim Apple sign-in and the distribution identity', () => {
    assert.deepEqual(validateSignedEntitlements(appleEntitlements, profile()), appleEntitlements);
    for (const value of [undefined, true, 'Default', [], ['default'], ['Default', 'Other']]) {
        assert.throws(() => validateSignedEntitlements({ ...appleEntitlements,
            'com.apple.developer.applesignin': value }, profile()), /Signed IPA must grant.*Apple Default/);
    }
    for (const changed of [{ 'application-identifier': 'OTHER.com.mickeyf.app' },
        { 'com.apple.developer.team-identifier': 'OTHER' }, { 'get-task-allow': true }]) {
        assert.throws(() => validateSignedEntitlements({ ...appleEntitlements, ...changed }, profile()),
            /distribution identity/);
    }
    const missingGrant = profile();
    delete missingGrant.entitlements['com.apple.developer.applesignin'];
    assert.throws(() => validateSignedEntitlements(appleEntitlements, missingGrant),
        /Embedded provisioning profile must grant/);
});

test('both embedded authorization and exported signature must include Declared Age Range', () => {
    assert.deepEqual(validateSignedEntitlements(appleEntitlements, profile()), appleEntitlements);
    for (const value of [undefined, null, false, 0, 1, 'true', [], {}]) {
        const invalid = { ...appleEntitlements, 'com.apple.developer.declared-age-range': value };
        assert.throws(() => validateSignedEntitlements(invalid, profile()), /Signed IPA must grant the Declared Age Range/);
        const unauthorized = profile();
        unauthorized.entitlements['com.apple.developer.declared-age-range'] = value;
        assert.throws(() => validateSignedEntitlements(appleEntitlements, unauthorized),
            /Embedded provisioning profile must grant the Declared Age Range/);
    }
});

test('signed entitlement verification reads the exported app signature, not the source or profile alone', () => {
    const calls = [];
    const run = (label, command, args, options) => {
        calls.push({ command, args, options });
        return { stdout: command === 'codesign' ? '<synthetic-signed-entitlements/>' : JSON.stringify(appleEntitlements) };
    };
    assert.deepEqual(verifySignedEntitlements('/synthetic/Payload/App.app', profile(), run), appleEntitlements);
    assert.deepEqual(calls, [
        { command: 'codesign', args: ['--display', '--entitlements', '-', '--xml', '/synthetic/Payload/App.app'], options: undefined },
        { command: 'plutil', args: ['-convert', 'json', '-o', '-', '-'], options: { input: '<synthetic-signed-entitlements/>' } },
    ]);
    assert.throws(() => verifySignedEntitlements('/synthetic/Payload/App.app', profile(),
        (label, command) => ({ stdout: command === 'codesign' ? '<synthetic/>' : '{"private-fixture":' })),
    error => /raw output was not logged/.test(error.message) && !error.message.includes('private-fixture'));
});

test('manual release signing retains the app entitlement binding without changing framework or Debug signing', () => {
    const debug = { name: 'Debug', buildSettings: { CODE_SIGN_STYLE: 'Automatic', CODE_SIGN_ENTITLEMENTS: 'App/App.entitlements' } };
    const release = { name: 'Release', buildSettings: {} };
    const framework = { name: 'Release', buildSettings: { CODE_SIGN_STYLE: 'Automatic' } };
    const project = {
        pbxNativeTargetSection: () => ({ APP: { name: 'App', buildConfigurationList: 'APP_CONFIGS' } }),
        pbxXCConfigurationList: () => ({ APP_CONFIGS: { buildConfigurations: [{ value: 'DEBUG' }, { value: 'RELEASE' }] } }),
        pbxXCBuildConfigurationSection: () => ({ DEBUG: debug, RELEASE: release, FRAMEWORK: framework }),
    };
    applySigningSettings(project, { build: '20.1.0' }, signing);
    assert.equal(release.buildSettings.CODE_SIGN_ENTITLEMENTS, 'App/App.entitlements');
    assert.equal(release.buildSettings.CURRENT_PROJECT_VERSION, '20.1.0');
    assert.equal(release.buildSettings.CODE_SIGN_STYLE, 'Manual');
    assert.equal(debug.buildSettings.CODE_SIGN_STYLE, 'Automatic');
    assert.deepEqual(framework.buildSettings, { CODE_SIGN_STYLE: 'Automatic' });
});

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

test('signing accepts only main and the current reviewed release branch', () => {
    assert.equal(signingBranchAllowed('refs/heads/main'), true);
    assert.equal(signingBranchAllowed('refs/heads/feature/auth-family-leaderboards'), true);
    for (const ref of [undefined, '', 'main', 'refs/heads/improvement/clean-code-sweep',
        'refs/heads/feature/auth-family-leaderboards-extra', 'refs/pull/342/merge']) {
        assert.equal(signingBranchAllowed(ref), false);
    }
});

test('workflow keeps the default and protected branch gate for both upload modes', async () => {
    const workflow = await readFile(new URL('../.github/workflows/ios-build.yml', import.meta.url), 'utf8');
    assert.match(workflow, /upload_testflight:[\s\S]*?type: boolean\s+required: false\s+default: false/);
    assert.match(workflow, /upload_distribution:[\s\S]*?type: choice\s+required: true\s+default: internal-only\s+options:\s+- internal-only\s+- app-store-draft/);
    assert.match(workflow, /if: \$\{\{ !inputs\.compile_only && inputs\.upload_testflight && \(github\.ref == 'refs\/heads\/main' \|\| github\.ref == 'refs\/heads\/feature\/auth-family-leaderboards'\) \}\}/);
    assert.match(workflow, /environment: ios-testflight/);
    assert.match(workflow, /IOS_UPLOAD_DISTRIBUTION: \$\{\{ inputs\.upload_distribution \|\| 'internal-only' \}\}/);
    assert.match(workflow, /node --test \.\.\/scripts\/ios-testflight\.test\.mjs/);
    assert.match(workflow, /Remove signing material and signed outputs\s+if: \$\{\{ always\(\) \}\}\s+run: node \.\.\/scripts\/ios-testflight\.mjs cleanup/);
});


test('compile-only workflow uses existing hosted tools and never signs or uploads app artifacts', async () => {
    const workflow = await readFile(new URL('../.github/workflows/ios-build.yml', import.meta.url), 'utf8');
    assert.match(workflow, /compile_only:[\s\S]*?type: boolean\s+required: false\s+default: false/);
    assert.match(workflow, /Package simulator app\s+if: \$\{\{ !inputs\.compile_only && !inputs\.capture_store_screenshots \}\}/);
    assert.match(workflow, /Upload simulator app\s+if: \$\{\{ !inputs\.compile_only && !inputs\.capture_store_screenshots \}\}/);
    const android = workflow.slice(workflow.indexOf('  android:'));
    assert.match(android, /inputs\.compile_only && !inputs\.upload_testflight/);
    assert.match(android, /runs-on: ubuntu-24.04/);
    assert.match(android, /licenses\/android-sdk-license/);
    assert.doesNotMatch(android, /^\s*sdkmanager\s|secrets\.|upload-artifact@|setup-gradle@|actions\/cache@/m);
    assert.match(android, /:app:testReleaseUnitTest :app:lintRelease :app:assembleRelease/);
});
