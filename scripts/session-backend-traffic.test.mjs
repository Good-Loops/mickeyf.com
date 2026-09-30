import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ACCOUNT_DELETION_JOURNAL_BUCKET,
    ORIGINAL_ACCOUNT_IDENTITY_EPOCH, APPROVED_GOOGLE_WEB_CLIENT_ID } from './render-frozen-backend-deploy.mjs';
import { PROJECT, REGION, SERVICE, REVISION_TYPE, fingerprint,
    sessionRevisionName, createSessionCloudProvider } from './frozen-backend-traffic.mjs';
import { validateSessionTrafficPins, rollbackRevisionName, captureSessionBaseline,
    planSessionTraffic, applySessionTraffic, main } from './session-backend-traffic.mjs';

import { fixture, now } from './test-support/session-release-fixture.mjs';

const copy = structuredClone;

test('baseline capture is read-only and pins the real immutable revision configuration', async () => {
    const f = fixture();
    f.service.traffic = f.service.traffic.slice(0, 1);
    f.service.trafficStatuses = copy(f.service.traffic);
    assert.deepEqual(await captureSessionBaseline(f.provider), f.pins.baseline);
    assert.equal(f.patches.length, 0);
    f.baseline.labels['source-build-id'] = '-'.repeat(36);
    await assert.rejects(captureSessionBaseline(f.provider), /provenance/);
});

test('promotion and a fresh rollback each issue one traffic-only PATCH and remove all tags', async () => {
    const f = fixture();
    const plan = await planSessionTraffic(f.provider, f.pins, 'promote', now);
    assert.equal(f.patches.length, 0);
    assert.equal(plan.removeTags.length, 2);
    const result = await applySessionTraffic(f.provider, plan, fingerprint(plan), now + 1000);
    assert.deepEqual(result, { operation: 'promote', revision: sessionRevisionName(f.pins.candidate.deployment),
        percent: 100, tags: [], submissions: 'enabled', generation: '147', freshSignInRequired: true });
    assert.equal(f.patches.length, 1);
    await assert.rejects(applySessionTraffic(f.provider, plan, fingerprint(plan), now + 1500), /starting revision/);
    const rollback = await planSessionTraffic(f.provider, f.pins, 'rollback', now + 2000);
    const restored = await applySessionTraffic(f.provider, rollback, fingerprint(rollback), now + 3000);
    assert.equal(restored.revision, rollbackRevisionName(f.pins));
    assert.equal(restored.generation, '148');
    assert.equal(f.patches.length, 2);
    assert.deepEqual(f.service.traffic, [{ type: REVISION_TYPE, revision: rollbackRevisionName(f.pins), percent: 100 }]);
    assert.equal(f.rollback.containers[0].env.find(e => e.name === 'SESSION_SECRET').valueSource.secretKeyRef.version, '18');
});

for (const [label, change, error] of [
    ['rollback missing', f => { f.provider.getRevision = async name => name === rollbackRevisionName(f.pins) ? Promise.reject(new Error('missing revision')) : copy(name.endsWith('legacy') ? f.baseline : f.candidate); }, /missing revision/],
    ['rollback unready', f => { f.rollback.conditions = []; }, /not Ready/],
    ['rollback uses candidate secret', f => { f.pins.rollback.sessionSecretVersion = '17'; }, /newer secret/],
    ['rollback uses old secret', f => { f.rollback.containers[0].env.find(e => e.name === 'SESSION_SECRET').valueSource.secretKeyRef.version = '2'; }, /Secret reference differs/],
    ['rollback image drift', f => { f.rollback.containers[0].image += 'changed'; }, /container configuration/],
    ['rollback unknown runtime drift', f => { f.rollback.executionEnvironment = 'EXECUTION_ENVIRONMENT_GEN2'; }, /previous runtime exactly/],
    ['baseline fingerprint drift', f => { f.baseline.labels.extra = 'changed'; }, /Baseline revision drifted/],
    ['candidate frozen scores', f => { f.candidate.containers[0].env.find(e => e.name === 'P4_VEGA_SCORE_SUBMISSIONS_ENABLED').value = 'false'; }, /environment differs/],
    ['candidate provider enabled', f => { f.candidate.containers[0].env.find(e => e.name === 'PROVIDER_AUTH_ENABLED').value = 'true'; }, /environment differs/],
    ['wrong approval', f => { f.build.substitutions._APPROVAL = 'frozen-deployment'; }, /substitution approval differs/],
    ['wrong deployment receipt', f => { f.build.steps[0].args = ['changed']; }, /steps differ/],
    ['unapproved build', f => { f.build.approval.state = 'PENDING'; }, /not approved/],
    ['mixed traffic', f => { f.service.traffic[0].percent = 50; f.service.traffic[1].percent = 50; }, /starting revision/],
    ['legacy direct tag', f => { f.service.traffic.push({ type: REVISION_TYPE, revision: f.pins.baseline.revisionName, tag: 'legacy-direct' }); }, /unreviewed revision or tag/],
    ['unknown template', f => { f.service.template.containers[0].image += 'changed'; }, /template/],
    ['automation active', f => { f.provider.assertAutomationPaused = async () => { throw new Error('automation active'); }; }, /automation active/],
]) test(`${label} prevents promotion without a write`, async () => {
    const f = fixture();
    change(f);
    f.service.trafficStatuses = copy(f.service.traffic);
    await assert.rejects(planSessionTraffic(f.provider, f.pins, 'promote', now), error);
    assert.equal(f.patches.length, 0);
});

test('invalid input and a reviewed provider/deletion activation are outside session-only authority', () => {
    const f = fixture();
    for (const change of [
        p => { p.rollback.sessionSecretVersion = 'latest'; }, p => { p.rollback.extra = true; },
        p => { p.baseline.sessionSecretVersion = '1'; }, p => { p.baseline.configurationSha256 = 'bad'; },
    ]) {
        const pins = copy(f.pins); change(pins);
        assert.throws(() => validateSessionTrafficPins(pins));
    }
    f.pins.candidate.deployment.accountDeletion = { enabled: true,
        journalBucket: ACCOUNT_DELETION_JOURNAL_BUCKET, identityEpoch: ORIGINAL_ACCOUNT_IDENTITY_EPOCH };
    assert.throws(() => validateSessionTrafficPins(f.pins), /session-only release/);
    f.pins.candidate.deployment.googleSignIn = { enabled: true, clientId: APPROVED_GOOGLE_WEB_CLIENT_ID };
    assert.throws(() => validateSessionTrafficPins(f.pins), /session-only release/);
});

test('stale, future, modified and drifted plans cannot write', async () => {
    const f = fixture();
    const plan = await planSessionTraffic(f.provider, f.pins, 'promote', now);
    for (const when of [now - 1, now + 300_001]) {
        await assert.rejects(applySessionTraffic(f.provider, plan, fingerprint(plan), when), /stale or future/);
    }
    const altered = copy(plan); altered.operation = 'rollback';
    await assert.rejects(applySessionTraffic(f.provider, altered, fingerprint(plan), now), /SHA256/);
    f.candidate.labels.extra = 'drift';
    await assert.rejects(applySessionTraffic(f.provider, plan, fingerprint(plan), now), /Plan drift/);
    assert.equal(f.patches.length, 0);
});

for (const failure of ['HTTP 409', 'connection lost after send']) test(`${failure} never retries or rolls back automatically`, async () => {
    const f = fixture();
    const plan = await planSessionTraffic(f.provider, f.pins, 'promote', now);
    f.provider.patchTraffic = async body => { f.patches.push(copy(body)); throw new Error(failure); };
    await assert.rejects(applySessionTraffic(f.provider, plan, fingerprint(plan), now), /inspect live state/);
    assert.equal(f.patches.length, 1);
});

test('a post-write configuration change is reported without another mutation', async () => {
    const f = fixture();
    const plan = await planSessionTraffic(f.provider, f.pins, 'promote', now);
    f.provider.waitForService = async () => ({ ...copy(f.service), ingress: 'CHANGED' });
    await assert.rejects(applySessionTraffic(f.provider, plan, fingerprint(plan), now), /Unexpected state after traffic change/);
    assert.equal(f.patches.length, 1);
});

test('session adapter only permits a single exact session/rollback revision with updateMask=traffic', async () => {
    const f = fixture();
    const requests = [];
    const provider = createSessionCloudProvider('fixture-token-with-sufficient-length', async (url, options) => {
        requests.push({ url, options });
        return new Response(JSON.stringify({ name: `projects/${PROJECT}/locations/${REGION}/operations/fixture` }));
    });
    for (const revision of [sessionRevisionName(f.pins.candidate.deployment), rollbackRevisionName(f.pins)]) {
        await provider.patchTraffic({ name: SERVICE, etag: 'etag', traffic: [{ type: REVISION_TYPE, revision, percent: 100 }] });
    }
    assert.equal(requests.length, 2);
    for (const request of requests) {
        assert.equal(request.url, `https://run.googleapis.com/v2/${SERVICE}?updateMask=traffic`);
        assert.equal(request.options.method, 'PATCH');
        assert.deepEqual(Object.keys(JSON.parse(request.options.body)).sort(), ['etag', 'name', 'traffic']);
    }
    for (const revision of [f.pins.baseline.revisionName, 'mickeyf-org-freeze-' + 'a'.repeat(32), 'LATEST']) {
        await assert.rejects(provider.patchTraffic({ name: SERVICE, etag: 'etag', traffic: [{ type: REVISION_TYPE, revision, percent: 100 }] }));
    }
    await assert.rejects(provider.patchTraffic({ name: SERVICE, etag: 'etag', template: {}, traffic: [] }));
    assert.equal(requests.length, 2);
});

test('CLI rejects default mutations and wrong operation confirmations before cloud access', async () => {
    for (const args of [[], ['promote'], ['baseline', '--output'], ['baseline', '--output', 'a', '--output', 'b']]) {
        await assert.rejects(main(args), /Choose|Missing|Invalid/);
    }
    const directory = await mkdtemp(join(tmpdir(), 'session-traffic-test-'));
    try {
        const f = fixture();
        const plan = await planSessionTraffic(f.provider, f.pins, 'promote', now);
        const path = join(directory, 'plan.json');
        await writeFile(path, JSON.stringify(plan));
        await assert.rejects(main(['apply', '--plan', path, '--confirm-plan', fingerprint(plan), '--confirm-session-rollback']), /unexpected fields/);
    } finally { await rm(directory, { recursive: true, force: true }); }
});
