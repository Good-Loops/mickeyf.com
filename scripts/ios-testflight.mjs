// Manual GitHub-hosted macOS signing only. Never use this helper for App Review.
import { spawnSync } from 'node:child_process';
import { createPrivateKey, randomBytes, sign, X509Certificate } from 'node:crypto';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const BRANCH = 'refs/heads/improvement/clean-code-sweep';
const TEAM = 'AX4Z7T24C9';
const BUNDLE = 'com.mickeyf.app';
const APP = '6810735137';
const SECRET_NAMES = ['IOS_DISTRIBUTION_P12_BASE64', 'IOS_DISTRIBUTION_P12_PASSWORD',
    'IOS_PROVISION_PROFILE_BASE64', 'ASC_PRIVATE_KEY_P8'];
const requireThat = (condition, message) => { if (!condition) throw new Error(message); };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function buildNumber(runNumber, attempt) {
    requireThat(/^[1-9]\d{0,3}$/.test(runNumber) && /^[1-9]\d?$/.test(attempt),
        'Run number/attempt exceeds the supported Apple build-number range.');
    return `${Number(runNumber)}.${Number(attempt)}.0`;
}

export function uploadDistribution(value = 'internal-only') {
    requireThat(value === 'internal-only' || value === 'app-store-draft',
        'Upload distribution must be internal-only or app-store-draft.');
    return value;
}

export function exportOptions(signing, distribution = 'internal-only') {
    return { method: 'app-store-connect', destination: 'export', signingStyle: 'manual',
        teamID: TEAM, signingCertificate: signing.fingerprint, provisioningProfiles: { [BUNDLE]: signing.profile.uuid },
        manageAppVersionAndBuildNumber: false,
        testFlightInternalTestingOnly: uploadDistribution(distribution) === 'internal-only', stripSwiftSymbols: true };
}

export function validateProfile(profile, now = Date.now()) {
    const entitlements = profile.entitlements;
    requireThat(UUID.test(profile.uuid) && profile.teams?.length === 1 && profile.teams[0] === TEAM,
        'Provisioning profile UUID or team does not match Ludolume.');
    requireThat(Date.parse(profile.expires) > now && profile.platforms?.includes('iOS'),
        'Provisioning profile is expired or is not for iOS.');
    requireThat(!profile.hasDevices && !profile.allDevices
        && entitlements?.['get-task-allow'] === false
        && entitlements?.['beta-reports-active'] === true,
    'An App Store distribution profile is required, not development/ad hoc/enterprise.');
    requireThat(entitlements?.['application-identifier'] === `${TEAM}.${BUNDLE}`
        && entitlements?.['com.apple.developer.team-identifier'] === TEAM,
    'Provisioning profile must explicitly match AX4Z7T24C9.com.mickeyf.app.');
    requireThat(Array.isArray(profile.certificates) && profile.certificates.length > 0,
        'Provisioning profile has no distribution certificate.');
    return profile;
}

function configuration() {
    requireThat(process.platform === 'darwin' && process.env.GITHUB_ACTIONS === 'true'
        && process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' && process.env.GITHUB_REF === BRANCH,
    'TestFlight signing requires the manual GitHub-hosted macOS job on the approved active branch.');
    requireThat(process.env.IOS_TEAM_ID === TEAM && process.env.IOS_BUNDLE_ID === BUNDLE
        && process.env.ASC_APP_ID === APP, 'Protected environment app/team/bundle variables do not match Ludolume.');
    requireThat(/^[A-Z0-9]{10}$/.test(process.env.ASC_KEY_ID ?? '')
        && UUID.test(process.env.ASC_ISSUER_ID ?? ''), 'Missing or malformed App Store Connect key/issuer IDs.');
    requireThat(isAbsolute(process.env.RUNNER_TEMP ?? '') && /^[1-9]\d*$/.test(process.env.GITHUB_RUN_ID ?? '')
        && /^[1-9]\d*$/.test(process.env.GITHUB_RUN_ATTEMPT ?? ''), 'Invalid runner temporary directory or run identifiers.');
    const root = join(resolve(process.env.RUNNER_TEMP),
        `ludolume-testflight-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`);
    return { root, keychain: join(root, 'signing.keychain-db'),
        profilePath: join(homedir(), 'Library/Developer/Xcode/UserData/Provisioning Profiles',
            `ludolume-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}.mobileprovision`),
        build: buildNumber(process.env.GITHUB_RUN_NUMBER, process.env.GITHUB_RUN_ATTEMPT),
        distribution: uploadDistribution(process.env.IOS_UPLOAD_DISTRIBUTION) };
}

function childEnvironment(extra = {}) {
    const env = { ...process.env, ...extra };
    // Do not expose the GitHub secrets to Xcode scripts or upload subprocesses.
    for (const name of SECRET_NAMES) delete env[name];
    return env;
}

export function safeDiagnostics(output, env = process.env) {
    let sanitized = output;
    for (const name of [...SECRET_NAMES, 'ASC_KEY_ID']) {
        const value = env[name];
        if (!value) continue;
        for (const fragment of [value, JSON.stringify(value).slice(1, -1), ...value.split(/\r?\n/)].filter(Boolean)) {
            sanitized = sanitized.replaceAll(fragment, '[redacted]');
        }
    }
    sanitized = sanitized.replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g, '[redacted JWT]')
        .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
    return sanitized.split(/\r?\n/).filter(line => /error|ITMS-|validation failed|archive failed|export failed/i.test(line))
        .slice(-10).map(line => line.slice(0, 600)).join('\n');
}

function run(label, command, args, options = {}) {
    const { diagnostics = false, ...spawnOptions } = options;
    const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
        timeout: 20 * 60_000, env: childEnvironment(), ...spawnOptions });
    if (diagnostics && (result.error || result.status !== 0)) {
        const detail = safeDiagnostics(`${result.stdout ?? ''}\n${result.stderr ?? ''}`);
        if (detail) console.error(detail);
    }
    // Security command output stays private; build/upload errors are explicitly redacted.
    requireThat(!result.error && result.status === 0,
        `${label} failed${result.status === null ? ' or timed out' : ` (exit ${result.status})`}; raw signing output was not logged.`);
    return result;
}

function privateFile(path, data) {
    writeFileSync(path, data, { mode: 0o600, flag: 'wx' });
}

function readProfile(path) {
    const xml = run('Decode provisioning profile', 'security', ['cms', '-D', '-i', path]).stdout;
    const parser = `import base64,json,plistlib,sys
p=plistlib.loads(sys.stdin.buffer.read())
print(json.dumps(dict(uuid=p.get('UUID'),teams=p.get('TeamIdentifier'),
expires=p['ExpirationDate'].isoformat()+'Z',platforms=p.get('Platform'),
hasDevices='ProvisionedDevices' in p,allDevices=p.get('ProvisionsAllDevices',False),
entitlements=p.get('Entitlements'),
certificates=[base64.b64encode(c).decode() for c in p.get('DeveloperCertificates',[])])))`;
    return validateProfile(JSON.parse(run('Read provisioning metadata', 'python3', ['-c', parser], { input: xml }).stdout));
}

function readPlist(path) {
    return JSON.parse(run('Read app metadata', 'plutil', ['-convert', 'json', '-o', '-', path]).stdout);
}

async function verifyUploadTarget(privateKey) {
    const timestamp = Math.floor(Date.now() / 1000);
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${encode({ alg: 'ES256', kid: process.env.ASC_KEY_ID, typ: 'JWT' })}.${encode({
        iss: process.env.ASC_ISSUER_ID, iat: timestamp, exp: timestamp + 300,
        aud: 'appstoreconnect-v1', scope: [`GET /v1/apps/${APP}`],
    })}`;
    const token = `${unsigned}.${sign('sha256', Buffer.from(unsigned),
        { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
    const response = await fetch(`https://api.appstoreconnect.apple.com/v1/apps/${APP}`, {
        headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000), redirect: 'error',
    });
    requireThat(response.ok, `App Store Connect app verification failed (HTTP ${response.status}).`);
    const app = (await response.json()).data;
    requireThat(app?.id === APP && app?.attributes?.bundleId === BUNDLE,
        'App Store Connect app ID does not match the signed bundle ID.');
}

export function uploadArguments(ipa, keyId, issuerId) {
    // Identity/build metadata is verified in the IPA; avoid duplicate CLI overrides.
    return ['altool', '--upload-package', ipa, '--platform', 'ios', '--apple-id', APP,
        '--api-key', keyId, '--api-issuer', issuerId, '--wait', '--output-format', 'json'];
}

function preflight() {
    const config = configuration();
    requireThat(process.env.DEVELOPER_DIR === '/Applications/Xcode_26.6.app/Contents/Developer',
        'Use the reviewed stable Xcode 26.6 installation.');
    requireThat(run('Check Xcode version', 'xcodebuild', ['-version']).stdout.includes('Xcode 26.6'),
        'The pinned Xcode 26.6 version is unavailable.');
    const help = run('Read Xcode export capabilities', 'xcodebuild', ['-help']);
    for (const option of ['app-store-connect', 'testFlightInternalTestingOnly', 'manageAppVersionAndBuildNumber']) {
        requireThat(`${help.stdout}${help.stderr}`.includes(option), `Pinned Xcode does not expose ${option}.`);
    }
    const altool = run('Read Apple uploader capabilities', 'xcrun', ['altool', '--help']);
    const requiredOptions = uploadArguments('App.ipa', process.env.ASC_KEY_ID, process.env.ASC_ISSUER_ID)
        .filter(argument => argument.startsWith('--'));
    const missingOptions = requiredOptions.filter(option => !`${altool.stdout}${altool.stderr}`.includes(option));
    requireThat(missingOptions.length === 0, `Pinned altool does not expose: ${missingOptions.join(', ')}.`);
    console.log(`Pinned native tools and protected app identifiers verified; build ${config.build}, ${config.distribution}.`);
}

function installSigningMaterial(config) {
    const originalKeychains = [...run('Read keychain search list', 'security', ['list-keychains', '-d', 'user'])
        .stdout.matchAll(/"([^"]+)"/g)].map(match => match[1]);
    requireThat(originalKeychains.length > 0, 'Cannot preserve the runner keychain search list.');
    privateFile(join(config.root, 'cleanup.json'), JSON.stringify({ originalKeychains }));
    const certificatePath = join(config.root, 'distribution.p12');
    const profileSource = join(config.root, 'distribution.mobileprovision');
    privateFile(certificatePath, Buffer.from(process.env.IOS_DISTRIBUTION_P12_BASE64, 'base64'));
    privateFile(profileSource, Buffer.from(process.env.IOS_PROVISION_PROFILE_BASE64, 'base64'));
    const profile = readProfile(profileSource);
    const password = randomBytes(32).toString('hex');
    run('Create ephemeral keychain', 'security', ['create-keychain', '-p', password, config.keychain]);
    run('Set keychain timeout', 'security', ['set-keychain-settings', '-lut', '3600', config.keychain]);
    run('Unlock signing keychain', 'security', ['unlock-keychain', '-p', password, config.keychain]);
    run('Import distribution identity', 'security', ['import', certificatePath, '-P', process.env.IOS_DISTRIBUTION_P12_PASSWORD,
        '-t', 'cert', '-f', 'pkcs12', '-k', config.keychain, '-T', '/usr/bin/codesign', '-T', '/usr/bin/security']);
    run('Permit Apple signing tools', 'security', ['set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:',
        '-s', '-k', password, config.keychain]);
    rmSync(certificatePath);
    const identities = run('Verify imported code-signing identity', 'security',
        ['find-identity', '-v', '-p', 'codesigning', config.keychain]).stdout;
    const certificate = profile.certificates.map(value => new X509Certificate(Buffer.from(value, 'base64')))
        .find(cert => cert.subject.split('\n').includes(`OU=${TEAM}`)
            && cert.subject.split('\n').some(part => part.startsWith('CN=Apple Distribution: '))
            && Date.parse(cert.validTo) > Date.now()
            && identities.includes(cert.fingerprint.replaceAll(':', '')));
    requireThat(certificate, 'No valid Apple Distribution private-key identity matches the profile and team.');
    run('Activate signing keychain', 'security', ['list-keychains', '-d', 'user', '-s', config.keychain, ...originalKeychains]);
    mkdirSync(dirname(config.profilePath), { recursive: true });
    privateFile(config.profilePath, readFileSync(profileSource));
    return { profile, fingerprint: certificate.fingerprint.replaceAll(':', '') };
}

export function applySigningSettings(project, config, signing) {
    // Target-level settings avoid accidentally giving CocoaPods frameworks an app profile.
    const target = Object.values(project.pbxNativeTargetSection()).find(value => value?.name === 'App');
    requireThat(target, 'App target is missing from the Xcode project.');
    const configurations = project.pbxXCConfigurationList()[target.buildConfigurationList].buildConfigurations;
    const release = configurations.map(({ value }) => project.pbxXCBuildConfigurationSection()[value])
        .find(value => value.name === 'Release');
    requireThat(release, 'App Release configuration is missing from the Xcode project.');
    Object.assign(release.buildSettings, { CODE_SIGN_STYLE: 'Manual', DEVELOPMENT_TEAM: TEAM,
        CODE_SIGN_IDENTITY: signing.fingerprint, PROVISIONING_PROFILE_SPECIFIER: signing.profile.uuid,
        CURRENT_PROJECT_VERSION: config.build });
}

function archiveAndExport(config, signing) {
    // Capacitor already supplies this parser through the locked frontend dependencies.
    const xcode = createRequire(new URL('../frontend/package.json', import.meta.url))('xcode');
    const projectPath = resolve('ios/App/App.xcodeproj/project.pbxproj');
    const project = xcode.project(projectPath);
    project.parseSync();
    applySigningSettings(project, config, signing);
    writeFileSync(projectPath, project.writeSync());
    const archive = join(config.root, 'Ludolume.xcarchive');
    console.log('Archiving signed iPhone app.');
    run('Signed iPhone archive', 'xcodebuild', ['-quiet', '-workspace', 'ios/App/App.xcworkspace', '-scheme', 'App',
        '-configuration', 'Release', '-sdk', 'iphoneos', '-destination', 'generic/platform=iOS',
        '-derivedDataPath', join(config.root, 'derived-data'), '-archivePath', archive, 'archive'], { diagnostics: true });
    const options = join(config.root, 'ExportOptions.plist');
    privateFile(options, JSON.stringify(exportOptions(signing, config.distribution)));
    run('Encode export options', 'plutil', ['-convert', 'xml1', options]);
    const exportPath = join(config.root, 'export');
    run(`Export ${config.distribution} IPA`, 'xcodebuild', ['-quiet', '-exportArchive', '-archivePath', archive,
        '-exportPath', exportPath, '-exportOptionsPlist', options], { diagnostics: true });
    const files = readdirSync(exportPath).filter(file => file.endsWith('.ipa'));
    requireThat(files.length === 1, 'Expected exactly one exported IPA.');
    return join(exportPath, files[0]);
}

function verifyIpa(config, signing, ipa) {
    const unpacked = join(config.root, 'ipa-check');
    run('Inspect exported IPA', 'ditto', ['-x', '-k', ipa, unpacked]);
    const apps = readdirSync(join(unpacked, 'Payload')).filter(file => file.endsWith('.app'));
    requireThat(apps.length === 1, 'Expected one application in the IPA.');
    const app = join(unpacked, 'Payload', apps[0]);
    const info = readPlist(join(app, 'Info.plist'));
    requireThat(info.CFBundleIdentifier === BUNDLE && info.CFBundleVersion === config.build
        && info.CFBundleSupportedPlatforms?.includes('iPhoneOS'), 'Exported app identity, build number or platform is wrong.');
    run('Verify signed application and embedded frameworks', 'codesign', ['--verify', '--deep', '--strict', app]);
    const embedded = readProfile(join(app, 'embedded.mobileprovision'));
    requireThat(embedded.uuid === signing.profile.uuid, 'Exported IPA uses a different provisioning profile.');
    const certificatePrefix = join(config.root, 'signed-certificate-');
    // This optional argument must use '='; a separate prefix is interpreted as another app path.
    run('Inspect application signing certificate', 'codesign', ['-d', `--extract-certificates=${certificatePrefix}`, app]);
    requireThat(new X509Certificate(readFileSync(`${certificatePrefix}0`)).fingerprint.replaceAll(':', '') === signing.fingerprint,
        'Exported IPA uses a different signing certificate.');
    return info;
}

function cleanup(config) {
    if (!existsSync(config.root)) return;
    requireThat(dirname(config.root) === resolve(process.env.RUNNER_TEMP)
        && !lstatSync(config.root).isSymbolicLink(), 'Cleanup path must be a direct, non-symlink runner-temp child.');
    const ownerPath = join(config.root, 'owner.json');
    requireThat(existsSync(ownerPath), 'Refusing to clean a directory without this job\'s ownership marker.');
    const owner = JSON.parse(readFileSync(ownerPath, 'utf8'));
    requireThat(owner.runId === process.env.GITHUB_RUN_ID && owner.attempt === process.env.GITHUB_RUN_ATTEMPT
        && owner.root === config.root, 'Refusing to clean another run\'s signing directory.');
    const statePath = join(config.root, 'cleanup.json');
    const errors = [];
    if (existsSync(statePath)) {
        const state = JSON.parse(readFileSync(statePath, 'utf8'));
        try { run('Restore keychain search list', 'security', ['list-keychains', '-d', 'user', '-s', ...state.originalKeychains]); }
        catch { errors.push('restore keychain search list'); }
        if (existsSync(config.keychain)) {
            try { run('Delete ephemeral signing keychain', 'security', ['delete-keychain', config.keychain]); }
            catch { errors.push('delete signing keychain'); }
        }
        rmSync(config.profilePath, { force: true });
    }
    rmSync(config.root, { recursive: true, force: true });
    requireThat(errors.length === 0, `Cleanup failed to ${errors.join(' and ')}; GitHub must discard this hosted runner.`);
}

async function upload() {
    const config = configuration();
    for (const name of SECRET_NAMES) requireThat(process.env[name]?.trim(), `Missing protected secret ${name}.`);
    const privateKey = createPrivateKey(process.env.ASC_PRIVATE_KEY_P8);
    requireThat(privateKey.asymmetricKeyType === 'ec' && privateKey.asymmetricKeyDetails?.namedCurve === 'prime256v1',
        'App Store Connect requires an EC P-256 API key.');
    await verifyUploadTarget(privateKey);
    requireThat(!existsSync(config.root) && !existsSync(config.profilePath), 'Refusing to overwrite an existing signing path.');
    mkdirSync(config.root, { mode: 0o700 });
    privateFile(join(config.root, 'owner.json'), JSON.stringify({ runId: process.env.GITHUB_RUN_ID,
        attempt: process.env.GITHUB_RUN_ATTEMPT, root: config.root }));
    try {
        const signing = installSigningMaterial(config);
        const ipa = archiveAndExport(config, signing);
        const info = verifyIpa(config, signing, ipa);
        // altool's documented relative key lookup keeps credentials inside owned temp storage.
        const keyDirectory = join(config.root, 'private_keys');
        mkdirSync(keyDirectory, { mode: 0o700 });
        privateFile(join(keyDirectory, `AuthKey_${process.env.ASC_KEY_ID}.p8`), process.env.ASC_PRIVATE_KEY_P8);
        console.log(`Uploading verified ${config.distribution} build ${config.build}; no App Review submission.`);
        run('Apple build upload', 'xcrun', uploadArguments(ipa, process.env.ASC_KEY_ID, process.env.ASC_ISSUER_ID),
            { cwd: config.root, diagnostics: true });
        appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### ${config.distribution} upload command completed\n\nSource commit: ${process.env.GITHUB_SHA}\n\n`
            + `App ${APP}, version ${info.CFBundleShortVersionString}, build ${config.build}.\n\n`
            + 'Apple processing, tester assignment and draft association remain separate. No App Review submission or public release was performed.\n');
    } finally { cleanup(config); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    try {
        const command = process.argv[2];
        if (command === 'preflight') preflight();
        else if (command === 'upload') await upload();
        else if (command === 'cleanup') cleanup(configuration());
        else throw new Error('Use preflight, upload, or cleanup.');
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
