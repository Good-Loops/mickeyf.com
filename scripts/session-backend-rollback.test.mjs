import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { PROJECT, REGION, SERVICE, fingerprint, revisionConfiguration, sessionRevisionName } from './frozen-backend-traffic.mjs';
import { rollbackRevisionName, planSessionTraffic } from './session-backend-traffic.mjs';
import { rollbackTemplate, planRollbackDeployment, applyRollbackDeployment,
    planProviderRollbackDeployment, applyProviderRollbackDeployment,
    createRollbackDeploymentProvider, main } from './session-backend-rollback.mjs';
import { fixture, now } from './test-support/session-release-fixture.mjs';
import { deploymentFixture as providerDeploymentFixture } from './test-support/provider-release-fixture.mjs';

function deploymentFixture() {
    const f = fixture();
    for (const revision of [f.baseline, f.candidate, f.rollback]) revision.launchStage = 'GA';
    f.pins.baseline.configurationSha256 = fingerprint(revisionConfiguration(f.baseline));
    const name = sessionRevisionName(f.pins.candidate.deployment);
    f.service.launchStage = 'GA';
    f.service.template = { revision: name, containers: structuredClone(f.candidate.containers) };
    f.service.latestCreatedRevision = f.service.latestReadyRevision = `${SERVICE}/revisions/${name}`;
    f.service.traffic = f.service.traffic.filter(item => item.revision !== rollbackRevisionName(f.pins));
    f.service.trafficStatuses = structuredClone(f.service.traffic);
    f.secret = { name: `projects/1012884798546/secrets/SESSION_SECRET/versions/18`, state: 'ENABLED', createTime: '2026-09-30T19:00:00Z' };
    let exists = false;
    f.provider.getRollbackIfExists = async () => exists ? structuredClone(f.rollback) : null;
    f.provider.getSessionSecretVersion = async () => structuredClone(f.secret);
    f.provider.patchRollbackTemplate = async (body, pins) => {
        assert.equal(body.etag, f.service.etag);
        assert.deepEqual(Object.keys(body).sort(), ['etag', 'name', 'template']);
        assert.equal(body.template.revision, rollbackRevisionName(pins));
        f.patches.push(structuredClone(body));
        exists = true;
        f.service.template = structuredClone(body.template);
        f.service.latestCreatedRevision = f.service.latestReadyRevision = `${SERVICE}/revisions/${body.template.revision}`;
        f.service.generation = f.service.observedGeneration = '147';
        f.service.etag = 'etag-147';
    };
    f.provider.waitForRollback = async () => structuredClone(f.service);
    return f;
}

test('plan is read-only; one template-only creation preserves traffic and satisfies promotion prerequisites', async () => {
    const f = deploymentFixture();
    const traffic = structuredClone(f.service.traffic);
    const plan = await planRollbackDeployment(f.provider, f.pins, now);
    assert.equal(f.patches.length, 0);
    assert.deepEqual(plan.request.template, rollbackTemplate(f.baseline, f.pins));
    assert.equal(plan.request.template.containers[0].image, f.baseline.containers[0].image);
    assert.equal(plan.request.template.containers[0].env.find(e => e.name === 'SESSION_SECRET').valueSource.secretKeyRef.version, '18');
    const result = await applyRollbackDeployment(f.provider, plan, fingerprint(plan), now + 1000);
    assert.deepEqual(result, { revision: rollbackRevisionName(f.pins), ready: true, percent: 0,
        tagged: false, trafficUnchanged: true, generation: '147' });
    assert.equal(f.patches.length, 1);
    assert.deepEqual(f.service.traffic, traffic);
    const promotion = await planSessionTraffic(f.provider, f.pins, 'promote', now + 2000);
    assert.equal(promotion.desiredTraffic[0].revision, sessionRevisionName(f.pins.candidate.deployment));
    await assert.rejects(planRollbackDeployment(f.provider, f.pins, now), /already exists/);
});

test('equivalent traffic ordering and explicit zero percentages do not look like traffic drift', async () => {
    const f = deploymentFixture();
    const plan = await planRollbackDeployment(f.provider, f.pins, now);
    f.provider.waitForRollback = async () => {
        f.service.traffic = f.service.traffic.reverse().map(entry => ({ ...entry, percent: entry.percent ?? 0 }));
        f.service.trafficStatuses = structuredClone(f.service.traffic);
        return structuredClone(f.service);
    };
    const result = await applyRollbackDeployment(f.provider, plan, fingerprint(plan), now);
    assert.equal(result.trafficUnchanged, true);
    assert.equal(f.patches.length, 1);
});

test('a Ready retired rollback preserves the exact prior serving pointer without another write', async () => {
    const f = deploymentFixture();
    const serving = f.service.latestReadyRevision;
    const patch = f.provider.patchRollbackTemplate;
    f.provider.patchRollbackTemplate = async (...args) => {
        await patch(...args);
        f.service.latestReadyRevision = serving;
        f.rollback.conditions = [
            { type: 'Ready', state: 'CONDITION_SUCCEEDED' },
            { type: 'Active', state: 'CONDITION_FAILED', severity: 'INFO', revisionReason: 'RETIRED' },
        ];
    };
    const plan = await planRollbackDeployment(f.provider, f.pins, now);
    const result = await applyRollbackDeployment(f.provider, plan, fingerprint(plan), now);
    assert.equal(result.trafficUnchanged, true);
    assert.equal(f.service.latestReadyRevision, serving);
    assert.equal(f.service.latestCreatedRevision, `${SERVICE}/revisions/${rollbackRevisionName(f.pins)}`);
    assert.equal(f.patches.length, 1);
    await planSessionTraffic(f.provider, f.pins, 'promote', now + 1000);
});

for (const [kind, fixtureFactory, planDeployment, applyDeployment] of [
    ['session', deploymentFixture, planRollbackDeployment, applyRollbackDeployment],
    ['provider', providerDeploymentFixture, planProviderRollbackDeployment, applyProviderRollbackDeployment],
]) test(`${kind} rollback planning accepts the exact baseline pointer accepted by generated preflight`, async () => {
    const f = fixtureFactory();
    const candidate = sessionRevisionName(f.pins.candidate.deployment);
    f.service.latestReadyRevision = `${SERVICE}/revisions/${f.pins.baseline.revisionName}`;
    const snapshot = {
        generation: Number(f.service.generation),
        traffic: f.service.traffic.map(entry => [entry.revision, entry.percent ?? 0, entry.tag ?? '']).sort(),
        latestCreatedRevisionName: candidate, latestReadyRevisionName: f.pins.baseline.revisionName,
    };
    const before = { ...snapshot, generation: snapshot.generation - 1,
        traffic: snapshot.traffic.filter(([revision]) => revision !== candidate),
        latestCreatedRevisionName: f.pins.baseline.revisionName };
    const source = readFileSync(new URL('./render-frozen-backend-deploy.preflight.py', import.meta.url), 'utf8');
    const verification = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-B', '-c',
        'import json,sys\np=json.load(sys.stdin)\nns={"__name__":"test"}\n'
        + 'exec(compile(p["source"],"preflight.py","exec"),ns)\n'
        + 'ns["verify_deployed_service"](p["snapshot"],p["before"],p["revision"],p["tag"])'], {
        input: JSON.stringify({ source, snapshot, before, revision: candidate,
            tag: f.service.traffic.find(entry => entry.revision === candidate).tag }),
        encoding: 'utf8', timeout: 20_000,
    });
    assert.equal(verification.error, undefined);
    assert.equal(verification.status, 0, verification.stderr);
    const containers = structuredClone(f.service.template.containers);
    const plan = await planDeployment(f.provider, f.pins, now);
    assert.deepEqual(f.service.template.containers, containers);
    assert.equal(plan.before.latestReadyRevision, f.service.latestReadyRevision);
    const patch = f.provider.patchRollbackTemplate;
    f.provider.patchRollbackTemplate = async (...args) => {
        await patch(...args);
        f.service.latestReadyRevision = plan.before.latestReadyRevision;
    };
    const result = await applyDeployment(f.provider, plan, fingerprint(plan), now);
    assert.equal(result.trafficUnchanged, true);
    assert.equal(f.patches.length, 1);
});

for (const [label, mutate, expected] of [
    ['existing revision', f => { f.provider.getRollbackIfExists = async () => f.rollback; }, /already exists/],
    ['lookup permission error', f => { f.provider.getRollbackIfExists = async () => { throw new Error('HTTP 403'); }; }, /403/],
    ['secret disabled', f => { f.secret.state = 'DISABLED'; }, /not enabled/],
    ['secret wrong identity', f => { f.secret.name = f.secret.name.replace('/18', '/17'); }, /wrong identity/],
    ['candidate receipt changed', f => { f.build.substitutions._APPROVAL = 'changed'; }, /approval differs/],
    ['candidate not newest template', f => { f.service.template.revision = f.pins.baseline.revisionName; }, /candidate first/],
    ['foreign candidate serving pointer', f => { f.service.latestReadyRevision = `${SERVICE}/revisions/mickeyf-org-foreign`; }, /candidate first/],
    ['unrelated old candidate serving pointer', f => { f.service.latestReadyRevision = `${SERVICE}/revisions/mickeyf-org-previous-unreviewed`; }, /candidate first/],
    ['changed candidate template with captured baseline pointer', f => {
        f.service.latestReadyRevision = `${SERVICE}/revisions/${f.pins.baseline.revisionName}`;
        f.service.template.containers[0].image += '-changed';
    }, /candidate first/],
    ['failed candidate Ready with captured baseline pointer', f => {
        f.service.latestReadyRevision = `${SERVICE}/revisions/${f.pins.baseline.revisionName}`;
        f.candidate.conditions = [{ type: 'Ready', state: 'CONDITION_FAILED' }];
    }, /not Ready/],
    ['mutable traffic', f => { f.service.traffic[0].type = 'TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST'; f.service.trafficStatuses = structuredClone(f.service.traffic); }, /LATEST/],
    ['launch stage drift', f => { f.service.launchStage = 'BETA'; }, /launch stages differ/],
    ['unknown runtime field', f => { f.baseline.unknownRuntimeSetting = true; f.pins.baseline.configurationSha256 = fingerprint(revisionConfiguration(f.baseline)); }, /unreviewed revision field/],
    ['automation active', f => { f.provider.assertAutomationPaused = async () => { throw new Error('automation active'); }; }, /automation active/],
]) test(`${label} refuses rollback preparation without a write`, async () => {
    const f = deploymentFixture(); mutate(f);
    await assert.rejects(planRollbackDeployment(f.provider, f.pins, now), expected);
    assert.equal(f.patches.length, 0);
});

test('drift, stale plans and changed approval cannot authorize a creation', async () => {
    const f = deploymentFixture();
    const plan = await planRollbackDeployment(f.provider, f.pins, now);
    for (const when of [now - 1, now + 300_001]) {
        await assert.rejects(applyRollbackDeployment(f.provider, plan, fingerprint(plan), when), /stale, future/);
    }
    const changed = structuredClone(plan); changed.request.template.containers[0].image += 'changed';
    await assert.rejects(applyRollbackDeployment(f.provider, changed, fingerprint(plan), now), /SHA256/);
    await assert.rejects(applyRollbackDeployment(f.provider, changed, fingerprint(changed), now), /plan drifted/);
    f.secret.createTime = '2026-09-30T19:01:00Z';
    await assert.rejects(applyRollbackDeployment(f.provider, plan, fingerprint(plan), now), /plan drifted/);
    assert.equal(f.patches.length, 0);
});

for (const problem of ['HTTP 409', 'connection lost after send']) test(`${problem} produces one attempt without retry or traffic change`, async () => {
    const f = deploymentFixture();
    const plan = await planRollbackDeployment(f.provider, f.pins, now);
    f.provider.patchRollbackTemplate = async body => { f.patches.push(body); throw new Error(problem); };
    await assert.rejects(applyRollbackDeployment(f.provider, plan, fingerprint(plan), now), /inspect live state before retrying/);
    assert.equal(f.patches.length, 1);
    assert.deepEqual(f.service.traffic, plan.before.traffic);
});

for (const [label, mutate] of [
    ['traffic', f => { f.service.traffic[0].revision = rollbackRevisionName(f.pins); }],
    ['service IAM setting', f => { f.service.invokerIamDisabled = true; }],
    ['generation', f => { f.service.generation = f.service.observedGeneration = '148'; }],
    ['rollback runtime', f => { f.rollback.timeout = '301s'; }],
    ['serving pointer', f => { f.service.latestReadyRevision = `${SERVICE}/revisions/mickeyf-org-foreign`; }],
    ['created pointer', f => { f.service.latestCreatedRevision = `${SERVICE}/revisions/mickeyf-org-foreign`; }],
    ['failed rollback Ready condition', f => { f.rollback.conditions = [
        { type: 'Ready', state: 'CONDITION_FAILED', revisionReason: 'RETIRED' },
    ]; }],
]) test(`post-write ${label} drift fails verification without another mutation`, async () => {
    const f = deploymentFixture();
    const plan = await planRollbackDeployment(f.provider, f.pins, now);
    f.provider.waitForRollback = async () => { mutate(f); return structuredClone(f.service); };
    await assert.rejects(applyRollbackDeployment(f.provider, plan, fingerprint(plan), now), /creation attempted/);
    assert.equal(f.patches.length, 1);
});

test('adapter reads only secret metadata; only 404 means absence; its sole write updates template', async () => {
    const f = deploymentFixture();
    const requests = [];
    let lookupStatus = 404;
    const provider = createRollbackDeploymentProvider('fixture-token-with-sufficient-length', async (url, options) => {
        requests.push({ url, ...options });
        if (url.includes('secretmanager')) return new Response(JSON.stringify(f.secret));
        if (options.method === 'PATCH') return new Response(JSON.stringify({ name: `projects/${PROJECT}/locations/${REGION}/operations/fixture` }));
        if (url.endsWith(f.pins.baseline.revisionName)) return new Response(JSON.stringify(f.baseline));
        return new Response('{}', { status: lookupStatus });
    });
    assert.equal(await provider.getRollbackIfExists(rollbackRevisionName(f.pins)), null);
    lookupStatus = 403;
    await assert.rejects(provider.getRollbackIfExists(rollbackRevisionName(f.pins)), /403/);
    await provider.getSessionSecretVersion('18');
    assert.throws(() => provider.getSessionSecretVersion('latest'));
    const body = { name: SERVICE, etag: 'reviewed-etag', template: rollbackTemplate(f.baseline, f.pins) };
    await provider.patchRollbackTemplate(body, f.pins, Date.now() + 10000);
    await assert.rejects(provider.patchRollbackTemplate({ ...body, traffic: [] }, f.pins, Date.now() + 10000), /unexpected fields/);
    const altered = structuredClone(body); altered.template.containers[0].resources.limits.memory = '1Gi';
    await assert.rejects(provider.patchRollbackTemplate(altered, f.pins, Date.now() + 10000), /exact reviewed/);
    await assert.rejects(provider.patchRollbackTemplate(body, f.pins, Date.now() - 1), /expired/);
    const writes = requests.filter(request => request.method !== 'GET');
    assert.equal(writes.length, 1);
    assert.equal(writes[0].url, `https://run.googleapis.com/v2/${SERVICE}?updateMask=template`);
    assert.deepEqual(JSON.parse(writes[0].body), body);
    assert.equal(requests.some(request => request.url.includes(':access')), false);
});

test('CLI requires exact explicit creation confirmation before cloud access', async () => {
    for (const args of [[], ['deploy'], ['plan', '--pins'], ['apply'], ['apply', '--plan', 'a', '--confirm-plan', 'b', '--confirm-session-rollback']]) {
        await assert.rejects(main(args), /Choose|Missing|unexpected fields/);
    }
});
