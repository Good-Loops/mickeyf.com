import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fixture, now } from './test-support/provider-release-fixture.mjs';
import { SERVICE, PROJECT, REGION, IMAGE, REVISION_TYPE, fingerprint, sessionRevisionName } from './frozen-backend-traffic.mjs';
import { observeProviderReaderBoundary, planProviderActiveRevision, applyProviderActiveRevision, activeRevisionTemplate,
    planProviderActiveTraffic, applyProviderActiveTraffic, activeRevisionName, activeRollbackRevisionName,
    createProviderActivationCloudProvider, validateProviderActivationPins, validateProviderActivationSource, READER_DRAIN_MS } from './provider-backend-activation.mjs';

const activeConfiguration = JSON.parse(readFileSync(new URL('./provider-release-general.json', import.meta.url), 'utf8'));
function activationFixture() {
    const f = fixture('prepare');
    f.candidate.launchStage = f.rollback.launchStage = f.service.launchStage = 'GA';
    const pins = { closed: f.pins, activeConfiguration: structuredClone(activeConfiguration) };
    const revisions = {};
    const oldGet = f.provider.getRevision;
    f.provider.getRevision = async name => revisions[name] ? structuredClone(revisions[name]) : oldGet(name);
    f.provider.getActiveRevisionIfExists = async name => revisions[name] ? structuredClone(revisions[name]) : null;
    f.provider.getSessionSecretVersion = async version => ({ name: `projects/1012884798546/secrets/SESSION_SECRET/versions/${version}`, state: 'ENABLED' });
    f.provider.assertSourceQualified = async () => {};
    f.service.traffic = [{ type: REVISION_TYPE, revision: sessionRevisionName(f.pins.candidate.deployment), percent: 100 }];
    f.service.trafficStatuses = structuredClone(f.service.traffic);
    f.provider.patchActiveTemplate = async body => {
        assert.equal(body.etag, f.service.etag);
        f.patches.push(structuredClone(body));
        const revision = { ...structuredClone(f.candidate), ...structuredClone(body.template),
            name: `${SERVICE}/revisions/${body.template.revision}`, uid: `${body.template.revision}-uid` };
        delete revision.revision;
        revisions[body.template.revision] = revision;
        f.service.template = structuredClone(body.template);
        f.service.latestCreatedRevision = f.service.latestReadyRevision = revision.name;
        advance();
    };
    const advance = () => {
        f.service.generation = f.service.observedGeneration = String(BigInt(f.service.generation) + 1n);
        f.service.etag = `etag-${f.service.generation}`;
    };
    f.provider.waitForActiveTemplate = async () => structuredClone(f.service);
    f.provider.patchActiveTraffic = async body => {
        assert.equal(body.etag, f.service.etag);
        f.patches.push(structuredClone(body));
        f.service.traffic = structuredClone(body.traffic);
        f.service.trafficStatuses = structuredClone(body.traffic);
        advance();
    };
    f.provider.waitForActiveTraffic = async () => structuredClone(f.service);
    return { ...f, activationPins: pins, revisions };
}
async function prepared(f) {
    const boundary = await observeProviderReaderBoundary(f.provider, f.activationPins, now);
    const when = now + READER_DRAIN_MS;
    const fallbackPlan = await planProviderActiveRevision(f.provider, f.activationPins, boundary, 'fallback', null, when);
    const fallback = await applyProviderActiveRevision(f.provider, fallbackPlan, fingerprint(fallbackPlan), when);
    const activePlan = await planProviderActiveRevision(f.provider, f.activationPins, boundary, 'candidate', fallback, when + 1000);
    const active = await applyProviderActiveRevision(f.provider, activePlan, fingerprint(activePlan), when + 1000);
    return { boundary, fallback, active, when: when + 2000 };
}

test('drained closed readers lead to untagged active/fallback revisions and conditional activation/closure', async () => {
    const f = activationFixture();
    const originalTraffic = structuredClone(f.service.traffic);
    const { active, fallback, when } = await prepared(f);
    assert.deepEqual(f.service.traffic, originalTraffic, 'both template writes preserve closed compatible traffic');
    assert.equal(f.patches.length, 2);
    assert.notEqual(activeRevisionName(f.activationPins), sessionRevisionName(f.pins.candidate.deployment));
    assert.ok(activeRevisionName(f.activationPins).length <= 63);
    assert.ok(activeRollbackRevisionName(f.activationPins).length <= 63);
    const environment = receipt => Object.fromEntries(receipt.plan.request.template.containers[0].env.map(e => [e.name, e.value ?? e.valueSource.secretKeyRef.version]));
    assert.equal(environment(active).SESSION_SECRET, '17');
    assert.equal(environment(fallback).SESSION_SECRET, '18');
    assert.equal(environment(active).REGISTRATION_CREATION_ENABLED, 'true');
    for (const key of ['REGISTRATION_CREATION_ENABLED', 'PROVIDER_GOOGLE_SIGNUP_ENABLED', 'PROVIDER_APPLE_SIGNUP_ENABLED', 'PARENT_REGISTRATION_CREATION_ENABLED']) {
        assert.equal(environment(fallback)[key], 'false');
    }
    assert.equal(environment(fallback).PROVIDER_AUTH_ENABLED, 'true', 'passwordless account management remains usable on fallback');
    assert.equal(environment(fallback).PUBLIC_SCORE_PARTICIPATION_ENABLED, 'true', 'privacy and disclosure policy remains available');
    const plan = await planProviderActiveTraffic(f.provider, active, 'activate', when);
    const result = await applyProviderActiveTraffic(f.provider, plan, fingerprint(plan), when);
    assert.equal(result.revision, activeRevisionName(f.activationPins));
    assert.equal(result.freshSignInRequired, false, 'active uses the same candidate signing version');
    const close = await planProviderActiveTraffic(f.provider, active, 'close-active', when + 1000);
    const closed = await applyProviderActiveTraffic(f.provider, close, fingerprint(close), when + 1000);
    assert.equal(closed.revision, activeRollbackRevisionName(f.activationPins));
    assert.equal(closed.freshSignInRequired, true);
    assert.equal(f.patches.length, 4);
});

for (const [label, mutate] of [
    ['old revision at 100 percent', f => { f.service.traffic[0].revision = f.pins.baseline.revisionName; }],
    ['old tagged endpoint', f => { f.service.traffic.push({ type: REVISION_TYPE, revision: f.pins.baseline.revisionName, percent: 0, tag: 'old' }); }],
    ['latest routing', f => { f.service.traffic[0].type = 'TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST'; }],
    ['live automation', f => { f.provider.assertAutomationPaused = async () => { throw new Error('automation active'); }; }],
    ['bad deployment receipt', f => { f.build.substitutions._APPROVAL = 'unreviewed'; }],
    ['incompatible fallback', f => { f.rollback.containers[0].image = f.baseline.containers[0].image; }],
]) test(`${label} cannot establish the reader boundary`, async () => {
    const f = activationFixture(); mutate(f); f.service.trafficStatuses = structuredClone(f.service.traffic);
    await assert.rejects(observeProviderReaderBoundary(f.provider, f.activationPins, now));
    assert.equal(f.patches.length, 0);
});

test('no creation-capable revision can be prepared before the exact old-reader drain or after routing drift', async () => {
    const f = activationFixture();
    const boundary = await observeProviderReaderBoundary(f.provider, f.activationPins, now);
    for (const time of [now - 1, now, now + READER_DRAIN_MS - 1]) {
        await assert.rejects(planProviderActiveRevision(f.provider, f.activationPins, boundary, 'fallback', null, time), /drain/);
    }
    f.service.etag = 'concurrent-change';
    await assert.rejects(planProviderActiveRevision(f.provider, f.activationPins, boundary, 'fallback', null, now + READER_DRAIN_MS), /state changed/);
    assert.equal(f.patches.length, 0);
});

test('active configuration, complete runtime and safe fallback are pinned', async () => {
    const f = activationFixture();
    for (const mutate of [p => { p.activeConfiguration.environment.PARENT_REGISTRATION_CREATION_ENABLED = 'true'; },
        p => { p.activeConfiguration.environment.APPLE_WEB_REDIRECT_URI = 'https://evil.invalid/login'; },
        p => { p.closed.candidate.deployment.providerRelease.phase = 'active'; }]) {
        const changed = structuredClone(f.activationPins); mutate(changed);
        assert.throws(() => validateProviderActivationPins(changed));
    }
    f.candidate.unreviewedSetting = 'silently discard me';
    assert.throws(() => activeRevisionTemplate(f.candidate, f.activationPins), /unreviewed runtime field/);
});

test('preparation plans reject stale approvals, tampering, duplicate deployments and missing metadata', async () => {
    const f = activationFixture();
    const boundary = await observeProviderReaderBoundary(f.provider, f.activationPins, now);
    const when = now + READER_DRAIN_MS;
    const plan = await planProviderActiveRevision(f.provider, f.activationPins, boundary, 'fallback', null, when);
    for (const time of [when - 1, when + 300001]) await assert.rejects(applyProviderActiveRevision(f.provider, plan, fingerprint(plan), time), /stale/);
    const changed = structuredClone(plan); changed.request.template.containers[0].image = f.baseline.containers[0].image;
    await assert.rejects(applyProviderActiveRevision(f.provider, changed, fingerprint(plan), when), /SHA256/);
    await assert.rejects(applyProviderActiveRevision(f.provider, changed, fingerprint(changed), when), /drifted/);
    f.provider.getActiveRevisionIfExists = async () => ({});
    await assert.rejects(applyProviderActiveRevision(f.provider, plan, fingerprint(plan), when), /already exists/);
    f.provider.getActiveRevisionIfExists = async () => null;
    f.provider.getSessionSecretVersion = async () => ({ state: 'DISABLED' });
    await assert.rejects(applyProviderActiveRevision(f.provider, plan, fingerprint(plan), when), /signing-secret/);
    assert.equal(f.patches.length, 0);
});

test('candidate preparation requires the verified fallback receipt and its unchanged reader boundary', async () => {
    const f = activationFixture();
    const boundary = await observeProviderReaderBoundary(f.provider, f.activationPins, now);
    await assert.rejects(planProviderActiveRevision(f.provider, f.activationPins, boundary, 'candidate', null, now + READER_DRAIN_MS));
    const fallbackPlan = await planProviderActiveRevision(f.provider, f.activationPins, boundary, 'fallback', null, now + READER_DRAIN_MS);
    const fallback = await applyProviderActiveRevision(f.provider, fallbackPlan, fingerprint(fallbackPlan), now + READER_DRAIN_MS);
    const changed = structuredClone(fallback); changed.revisionSha256 = '0'.repeat(64);
    await assert.rejects(planProviderActiveRevision(f.provider, f.activationPins, boundary, 'candidate', changed, now + READER_DRAIN_MS), /revision drifted/);
    f.service.etag = 'different';
    await assert.rejects(planProviderActiveRevision(f.provider, f.activationPins, boundary, 'candidate', fallback, now + READER_DRAIN_MS), /state changed/);
});

for (const kind of ['template', 'traffic']) test(`ambiguous ${kind} write is attempted once and never authorizes an automatic retry`, async () => {
    const f = activationFixture();
    if (kind === 'template') {
        const boundary = await observeProviderReaderBoundary(f.provider, f.activationPins, now);
        const plan = await planProviderActiveRevision(f.provider, f.activationPins, boundary, 'fallback', null, now + READER_DRAIN_MS);
        f.provider.patchActiveTemplate = async body => { f.patches.push(body); throw new Error('connection lost after send'); };
        await assert.rejects(applyProviderActiveRevision(f.provider, plan, fingerprint(plan), now + READER_DRAIN_MS), /inspect live state/);
        assert.equal(f.patches.length, 1);
    } else {
        const { active, when } = await prepared(f);
        const plan = await planProviderActiveTraffic(f.provider, active, 'activate', when);
        f.provider.patchActiveTraffic = async body => { f.patches.push(body); throw new Error('connection lost after send'); };
        await assert.rejects(applyProviderActiveTraffic(f.provider, plan, fingerprint(plan), when), /inspect live state/);
        assert.equal(f.patches.length, 3);
    }
});

test('activation cannot reuse a stale plan, changed route or altered usable fallback', async () => {
    const f = activationFixture();
    const { active, when } = await prepared(f);
    const plan = await planProviderActiveTraffic(f.provider, active, 'activate', when);
    await assert.rejects(applyProviderActiveTraffic(f.provider, plan, fingerprint(plan), when + 300001), /stale/);
    const changed = structuredClone(plan); changed.request.traffic[0].revision = f.pins.baseline.revisionName;
    await assert.rejects(applyProviderActiveTraffic(f.provider, changed, fingerprint(changed), when), /drifted/);
    f.revisions[activeRollbackRevisionName(f.activationPins)].containers[0].env.find(e => e.name === 'PROVIDER_AUTH_ENABLED').value = 'false';
    await assert.rejects(applyProviderActiveTraffic(f.provider, plan, fingerprint(plan), when), /environment differs/);
    assert.equal(f.patches.length, 2);
});

test('post-write service drift is reported without a second mutation', async () => {
    const f = activationFixture();
    const { active, when } = await prepared(f);
    const plan = await planProviderActiveTraffic(f.provider, active, 'activate', when);
    f.provider.waitForActiveTraffic = async () => { f.service.ingress = 'INGRESS_TRAFFIC_INTERNAL_ONLY'; return structuredClone(f.service); };
    await assert.rejects(applyProviderActiveTraffic(f.provider, plan, fingerprint(plan), when), /mutation attempted/);
    assert.equal(f.patches.length, 3);
});

test('adapter reads signing metadata without payloads and only treats 404 as absent', async () => {
    const calls = [];
    let status = 404;
    const provider = createProviderActivationCloudProvider('synthetic-token-with-sufficient-length', async (url, options) => {
        calls.push({ url, ...options });
        if (url.includes('secretmanager')) return new Response(JSON.stringify({ state: 'ENABLED' }));
        return new Response('{}', { status });
    });
    assert.equal(await provider.getActiveRevisionIfExists(activeRevisionName(activationFixture().activationPins)), null);
    status = 403;
    await assert.rejects(provider.getActiveRevisionIfExists(activeRevisionName(activationFixture().activationPins)), /403/);
    await provider.getSessionSecretVersion('3');
    assert.throws(() => provider.getSessionSecretVersion('latest'));
    assert.throws(() => provider.getActiveRevisionIfExists('mickeyf-org-legacy'));
    assert.equal(calls.some(call => call.url.includes(':access') || call.method !== 'GET'), false);
});

test('activation rechecks source freshness, newest image, full-SHA tag and mutable security findings', () => {
    const pins = activationFixture().pins.candidate.deployment;
    const source = { url: 'https://github.com/Good-Loops/mickeyf.com.git', revision: pins.sourceCommit };
    const packageName = `projects/${PROJECT}/locations/${REGION}/repositories/cloud-run-source-deploy/packages/cloud-run-source-deploy`;
    const discovery = { name: `projects/${PROJECT}/locations/${REGION}/occurrences/11111111-1111-4111-8111-111111111111`,
        resourceUri: `https://${IMAGE}@${pins.imageDigest}`, kind: 'DISCOVERY',
        noteName: `projects/goog-analysis/locations/${REGION}/notes/PACKAGE_VULNERABILITY`,
        discovery: { analysisStatus: 'FINISHED_SUCCESS', continuousAnalysis: 'ACTIVE', lastScanTime: new Date(now).toISOString(),
            analysisCompleted: { analysisType: ['OS', 'NPM', 'SECRET'] } } };
    const data = { build: { id: pins.sourceBuildId, status: 'SUCCESS', projectId: PROJECT, buildTriggerId: pins.sourceTriggerId,
        source: { gitSource: source }, sourceProvenance: { resolvedGitSource: source }, createTime: new Date(now - 2000).toISOString(), finishTime: new Date(now - 1000).toISOString(),
        results: { images: [{ name: `${IMAGE}:${pins.sourceCommit}`, digest: pins.imageDigest }] } },
        newest: { builds: [{ id: pins.sourceBuildId, buildTriggerId: pins.sourceTriggerId, createTime: new Date(now - 2000).toISOString() }] },
        tag: { name: `${packageName}/tags/${pins.sourceCommit}`, version: `${packageName}/versions/${pins.imageDigest}` },
        discoveries: [discovery], vulnerabilities: [] };
    validateProviderActivationSource(data, pins, now);
    for (const mutate of [
        d => { d.build.finishTime = new Date(now - 7_200_001).toISOString(); },
        d => { d.build.sourceProvenance.resolvedGitSource.revision = '0'.repeat(40); },
        d => { d.newest.builds[0].id = 'different'; },
        d => { d.newest.builds.push(structuredClone(d.newest.builds[0])); },
        d => { d.newest.builds[0].createTime = 'invalid'; },
        d => { d.newest.builds[0].buildTriggerId = 'different'; },
        d => { d.newest.builds.push({ id: '99999999-9999-4999-8999-999999999999', buildTriggerId: pins.sourceTriggerId, createTime: new Date(now).toISOString() }); },
        d => { d.tag.version += 'different'; },
        d => { d.discoveries[0].discovery.analysisStatus = 'SCANNING'; },
        d => { d.discoveries[0].discovery.continuousAnalysis = 'INACTIVE'; },
        d => { d.discoveries[0].discovery.analysisCompleted.analysisType = ['OS']; },
        d => { d.discoveries[0].discovery.analysisError = [{ code: 1 }]; },
        d => { d.vulnerabilities.push({ ...structuredClone(discovery), kind: 'VULNERABILITY',
            noteName: `projects/goog-vulnz/locations/${REGION}/notes/synthetic`,
            vulnerability: { effectiveSeverity: 'LOW', packageIssue: [{ effectiveSeverity: 'HIGH' }] } }); },
    ]) {
        const changed = structuredClone(data); mutate(changed);
        assert.throws(() => validateProviderActivationSource(changed, pins, now));
    }
});

test('a source qualification failure stops all activation preparation without a write', async () => {
    const f = activationFixture();
    const boundary = await observeProviderReaderBoundary(f.provider, f.activationPins, now);
    f.provider.assertSourceQualified = async () => { throw new Error('source build expired'); };
    await assert.rejects(planProviderActiveRevision(f.provider, f.activationPins, boundary, 'fallback', null, now + READER_DRAIN_MS), /expired/);
    assert.equal(f.patches.length, 0);
});

test('closing new creation remains possible after source expiry or candidate signing-key disablement', async () => {
    const f = activationFixture();
    const { active, when } = await prepared(f);
    const activation = await planProviderActiveTraffic(f.provider, active, 'activate', when);
    await applyProviderActiveTraffic(f.provider, activation, fingerprint(activation), when);
    f.provider.assertSourceQualified = async () => { throw new Error('source expired after launch'); };
    const originalSecret = f.provider.getSessionSecretVersion;
    f.provider.getSessionSecretVersion = async version => version === '17' ? { state: 'DISABLED' } : originalSecret(version);
    const closure = await planProviderActiveTraffic(f.provider, active, 'close-active', when + 7_200_000);
    const result = await applyProviderActiveTraffic(f.provider, closure, fingerprint(closure), when + 7_200_000);
    assert.equal(result.revision, activeRollbackRevisionName(f.activationPins));
    assert.equal(f.patches.length, 4);
});

test('HTTP adapter executes only the four exact template/traffic patches and rechecks security before activation', async () => {
    const f = activationFixture();
    const sourcePins = f.pins.candidate.deployment;
    const source = { url: 'https://github.com/Good-Loops/mickeyf.com.git', revision: sourcePins.sourceCommit };
    const packageName = `projects/${PROJECT}/locations/${REGION}/repositories/cloud-run-source-deploy/packages/cloud-run-source-deploy`;
    const timestamp = new Date().toISOString();
    const sourceBuild = { id: sourcePins.sourceBuildId, projectId: PROJECT, status: 'SUCCESS', buildTriggerId: sourcePins.sourceTriggerId,
        source: { gitSource: source }, sourceProvenance: { resolvedGitSource: source }, createTime: timestamp, finishTime: timestamp,
        results: { images: [{ name: `${IMAGE}:${sourcePins.sourceCommit}`, digest: sourcePins.imageDigest }] } };
    const discovery = { name: `projects/${PROJECT}/locations/${REGION}/occurrences/11111111-1111-4111-8111-111111111111`,
        kind: 'DISCOVERY', resourceUri: `https://${IMAGE}@${sourcePins.imageDigest}`,
        noteName: `projects/goog-analysis/locations/${REGION}/notes/PACKAGE_VULNERABILITY`,
        discovery: { analysisStatus: 'FINISHED_SUCCESS', continuousAnalysis: 'ACTIVE', lastScanTime: timestamp,
            analysisCompleted: { analysisType: ['OS', 'NPM', 'SECRET'] } } };
    const calls = [];
    let listingProblem = '';
    let listingPage = 0;
    const provider = createProviderActivationCloudProvider('synthetic-token-with-sufficient-length', async (raw, options) => {
        const url = new URL(raw); calls.push({ url, ...options });
        const ok = value => new Response(JSON.stringify(value));
        if (options.method === 'PATCH') {
            const body = JSON.parse(options.body);
            assert.equal(body.name, SERVICE);
            if (url.searchParams.get('updateMask') === 'template') await f.provider.patchActiveTemplate(body);
            else if (url.searchParams.get('updateMask') === 'traffic') await f.provider.patchActiveTraffic(body);
            else assert.fail('unexpected mutation mask');
            return ok({ name: `projects/${PROJECT}/locations/${REGION}/operations/synthetic` });
        }
        if (url.hostname === 'secretmanager.googleapis.com') return ok(await f.provider.getSessionSecretVersion(url.pathname.split('/').at(-1)));
        if (url.hostname === 'artifactregistry.googleapis.com') return ok({ name: `${packageName}/tags/${sourcePins.sourceCommit}`, version: `${packageName}/versions/${sourcePins.imageDigest}` });
        if (url.hostname === 'containeranalysis.googleapis.com') return ok({ occurrences: url.searchParams.get('filter').includes('"DISCOVERY"') ? [discovery] : [] });
        if (url.pathname.endsWith('/triggers')) return ok({ triggers: ['ef5a2981-95be-4f4d-af91-f997fde73356', 'd71109da-8350-4f2f-a3be-2053bb6ccd45'].map(id => ({ id, disabled: true })) });
        if (url.pathname.endsWith('/builds')) {
            assert.equal(url.searchParams.has('orderBy'), false, 'Cloud Build does not support an orderBy query');
            if (!url.searchParams.get('filter').includes('buildTriggerId')) return ok({ builds: [] });
            assert.equal(url.searchParams.get('pageSize'), '100');
            if (listingProblem === 'malformed') return ok({ builds: 'invalid' });
            if (listingProblem === 'repeated token') return ok({ builds: [], nextPageToken: 'same-token' });
            if (listingProblem === 'truncated') return ok({ builds: [], nextPageToken: `more-${listingPage++}` });
            if (!url.searchParams.get('pageToken')) return ok({ builds: [{ id: '99999999-9999-4999-8999-999999999999',
                buildTriggerId: sourcePins.sourceTriggerId, createTime: new Date(Date.parse(timestamp) - 1000).toISOString() }], nextPageToken: 'synthetic-page-2' });
            assert.equal(url.searchParams.get('pageToken'), 'synthetic-page-2');
            return ok({ builds: [{ id: sourcePins.sourceBuildId, buildTriggerId: sourcePins.sourceTriggerId, createTime: timestamp }] });
        }
        if (url.pathname.endsWith(`/builds/${sourcePins.sourceBuildId}`)) return ok(sourceBuild);
        if (url.pathname.endsWith(`/builds/${f.pins.candidate.receipt.buildId}`)) return ok(f.build);
        if (url.pathname.endsWith(SERVICE)) return ok(f.service);
        if (url.pathname.includes('/revisions/')) {
            const revision = await f.provider.getRevision(url.pathname.split('/').at(-1));
            return revision ? ok(revision) : new Response('{}', { status: 404 });
        }
        assert.fail(`Unexpected read ${url.pathname}`);
    });
    const time = Date.now();
    const boundary = await observeProviderReaderBoundary(provider, f.activationPins, time - READER_DRAIN_MS - 1000);
    const fallbackPlan = await planProviderActiveRevision(provider, f.activationPins, boundary, 'fallback');
    const fallback = await applyProviderActiveRevision(provider, fallbackPlan, fingerprint(fallbackPlan));
    const activePlan = await planProviderActiveRevision(provider, f.activationPins, boundary, 'candidate', fallback);
    const active = await applyProviderActiveRevision(provider, activePlan, fingerprint(activePlan));
    const traffic = await planProviderActiveTraffic(provider, active, 'activate');
    await applyProviderActiveTraffic(provider, traffic, fingerprint(traffic));
    const close = await planProviderActiveTraffic(provider, active, 'close-active');
    await applyProviderActiveTraffic(provider, close, fingerprint(close));
    assert.deepEqual(calls.filter(call => call.method === 'PATCH').map(call => call.url.searchParams.get('updateMask')), ['template', 'template', 'traffic', 'traffic']);
    assert.ok(calls.filter(call => call.url.hostname === 'containeranalysis.googleapis.com').length > 4);
    assert.equal(calls.some(call => call.url.href.includes(':access') || call.url.searchParams.get('filter')?.includes('kind="SECRET"')), false);
    assert.equal(calls.every(call => call.redirect === 'error'), true);
    for (const problem of ['malformed', 'repeated token', 'truncated']) {
        listingProblem = problem; listingPage = 0;
        await assert.rejects(provider.assertSourceQualified(sourcePins), /listing|pagination/);
    }
    assert.equal(calls.filter(call => call.method === 'PATCH').length, 4);
});
