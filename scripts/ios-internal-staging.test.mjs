import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { internalStagingConfiguration, signingInfoPlist, stagingIndexHtml, verifySignedApiConfiguration } from './ios-internal-staging.mjs';

const host = 'fictional-device-check.trycloudflare.com';
const origin = `https://${host}`;
const staging = internalStagingConfiguration(host, 'internal-only', origin);
const ordinaryInfo = { CFBundleDisplayName: 'Ludolume', LudolumeGoogleSignInEnabled: true, LudolumeAppleSignInEnabled: true,
    LudolumeStagingAPIHost: '$(LUDOLUME_STAGING_API_HOST)' };
const html = '<!doctype html><html><body><div id="root"></div></body></html>';
const bundle = value => `const options={productionUrl:${JSON.stringify(value)}};`;

test('only an explicit exact Quick Tunnel origin can enter internal-only staging', () => {
    assert.deepEqual(staging, { host, origin });
    assert.equal(internalStagingConfiguration(), undefined);
    for (const invalid of ['https://' + host, host + '/', host + ':443', ' ' + host, host.toUpperCase(),
        'localhost', '127.0.0.1', 'mickeyf-org-j7yuum4tiq-uc.a.run.app', 'a.b.trycloudflare.com',
        'test.trycloudflare.com.attacker.test', '-test.trycloudflare.com', 'a'.repeat(64) + '.trycloudflare.com']) {
        assert.throws(() => internalStagingConfiguration(invalid, 'internal-only', `https://${invalid}`));
    }
    assert.throws(() => internalStagingConfiguration(host, 'app-store-draft', origin), /App Store eligible/);
    for (const wrong of ['http://' + host, origin + '/', 'https://another.trycloudflare.com']) {
        assert.throws(() => internalStagingConfiguration(host, 'internal-only', wrong), /match exactly/);
    }
    assert.throws(() => internalStagingConfiguration('', 'app-store-draft', origin), /production web API origin/);
});

test('staging marks only the copied app metadata and document and disables both provider entries', () => {
    const info = signingInfoPlist(ordinaryInfo, staging), index = stagingIndexHtml(html, staging);
    assert.equal(ordinaryInfo.CFBundleDisplayName, 'Ludolume');
    assert.equal(info.CFBundleDisplayName, 'SYNTHETIC Ludolume');
    assert.equal(info.LudolumeGoogleSignInEnabled, false); assert.equal(info.LudolumeAppleSignInEnabled, false);
    assert.equal(info.LudolumeInternalStaging, true); assert.equal(info.LudolumeStagingAPIHost, host);
    assert.match(index, /role="status"[^>]*>SYNTHETIC TEST/);
    assert.equal(stagingIndexHtml(html), html);
    assert.throws(() => stagingIndexHtml(index, staging), /already contain/);
    assert.throws(() => signingInfoPlist(info, staging), /ordinary source plist/);
    assert.throws(() => stagingIndexHtml('<html></html>', staging), /one compiled/);
});

test('signed export rejects wrong origins, reopened providers, missing marker and store-eligible staging', () => {
    const info = signingInfoPlist(ordinaryInfo, staging), index = stagingIndexHtml(html, staging);
    const verify = (metadata = info, page = index, script = bundle(origin), distribution = 'internal-only') =>
        verifySignedApiConfiguration(metadata, page, script, staging, distribution);
    assert.doesNotThrow(() => verify());
    for (const change of [{ LudolumeInternalStaging: false }, { LudolumeStagingAPIHost: 'other.trycloudflare.com' },
        { LudolumeGoogleSignInEnabled: true }, { LudolumeAppleSignInEnabled: true }, { CFBundleDisplayName: 'Ludolume' }]) {
        assert.throws(() => verify({ ...info, ...change }), /identity, provider closure or visible notice/);
    }
    assert.throws(() => verify(info, html), /visible notice/);
    assert.throws(() => verify(info, index, bundle(origin), 'app-store-draft'), /internal-only/);
    for (const script of ['', bundle('https://another.trycloudflare.com'), bundle(origin) + bundle(origin)]) {
        assert.throws(() => verify(info, index, script), /exact expected API origin/);
    }
});

test('normal export retains production routing and rejects every staging marker', () => {
    const info = signingInfoPlist(ordinaryInfo), script = bundle('https://mickeyf-org-j7yuum4tiq-uc.a.run.app');
    assert.equal(info.LudolumeGoogleSignInEnabled, true); assert.equal(info.LudolumeAppleSignInEnabled, true);
    assert.doesNotThrow(() => verifySignedApiConfiguration(info, html, script, undefined, 'app-store-draft'));
    for (const change of [{ LudolumeInternalStaging: true }, { LudolumeInternalStaging: false },
        { LudolumeStagingAPIHost: host }, { CFBundleDisplayName: 'SYNTHETIC Ludolume' }]) {
        assert.throws(() => verifySignedApiConfiguration({ ...info, ...change }, html, script), /staging configuration/);
    }
    assert.throws(() => verifySignedApiConfiguration(info, stagingIndexHtml(html, staging), script), /staging configuration/);
    assert.throws(() => verifySignedApiConfiguration(info, html, bundle(origin)), /exact expected API origin/);
});

test('manual workflow scopes staging to the protected signing job and never shell-interpolates the input', async () => {
    const workflow = await readFile(new URL('../.github/workflows/ios-build.yml', import.meta.url), 'utf8');
    assert.match(workflow, /internal_staging_host:[\s\S]*?type: string\s+required: false\s+default: ""/);
    assert.match(workflow, /invalid-staging-mode:[\s\S]*?inputs\.upload_distribution != 'internal-only'/);
    const signed = workflow.slice(workflow.indexOf('  testflight:'), workflow.indexOf('  android:'));
    assert.match(signed, /IOS_INTERNAL_STAGING_HOST: \$\{\{ inputs\.internal_staging_host \}\}/);
    assert.match(workflow, /app_store_consent:[\s\S]*?default: "off"/);
    assert.match(workflow, /invalid-consent-mode:[\s\S]*?inputs\.app_store_consent == 'on'[\s\S]*?inputs\.upload_distribution != 'internal-only'/);
    assert.match(signed, /inputs\.app_store_consent != 'on' \|\| inputs\.internal_staging_host != ''/);
    assert.match(signed, /VITE_PROD_API_URL: \$\{\{ inputs\.internal_staging_host != '' && format\('https:\/\/\{0\}', inputs\.internal_staging_host\)/);
    assert.match(signed, /ios-internal-staging\.test\.mjs/);
    for (const script of signed.split(/\n {8}run:/u).slice(1)) {
        assert.doesNotMatch(script.split(/\n      - name:/u)[0], /\$\{\{ inputs\.internal_staging_host/);
    }
});
