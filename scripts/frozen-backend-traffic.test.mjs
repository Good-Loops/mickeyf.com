import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { accountDeletionEnvironment, googleSignInEnvironment, APPROVED_GOOGLE_WEB_CLIENT_ID,
    ACCOUNT_DELETION_JOURNAL_BUCKET, ORIGINAL_ACCOUNT_IDENTITY_EPOCH,
    frozenDeploymentApproval } from './render-frozen-backend-deploy.mjs';
import {
    PROJECT, REGION, SERVICE, IMAGE, REVISION_TYPE, fingerprint, revisionName,
    deploymentStepsFingerprint, validatePins, validateDeployment, validateFrozenRevision,
    validateService, planFrozenTraffic, applyFrozenTraffic, createCloudProvider, main,
} from './frozen-backend-traffic.mjs';

const copy = structuredClone;
const now = Date.parse('2026-09-08T12:00:00Z');
const steps = [{ id: 'Verify frozen candidate', name: 'pinned-sdk@sha256:example', entrypoint: 'python3', args: ['-c', 'reviewed code'] }];
const pins = {
    sourceBuildId: '11111111-1111-4111-8111-111111111111', sourceCommit: 'a'.repeat(40),
    imageDigest: `sha256:${'b'.repeat(64)}`, deploymentBuildId: '22222222-2222-4222-8222-222222222222',
    deploymentTriggerId: '33333333-3333-4333-8333-333333333333', deploymentStepsSha256: deploymentStepsFingerprint(steps),
    sessionSecretVersion: '2',
};

test('Windows token command selects the installed cmd wrapper without changing execution policy', async () => {
    const source = await readFile(new URL('./frozen-backend-traffic.mjs', import.meta.url), 'utf8');
    const tokenHelper = source.slice(source.indexOf('function accessToken()'), source.indexOf('async function readJson('));
    assert.ok(tokenHelper.includes("execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'gcloud.cmd auth print-access-token'], { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim()"));
    assert.ok(!tokenHelper.includes('ExecutionPolicy'));
    assert.ok(tokenHelper.includes("catch { fail('Could not obtain a short-lived gcloud access token'); }"));
});

function fixture() {
    const revision = {
        name: `${SERVICE}/revisions/${revisionName(pins)}`, service: 'mickeyf-org', uid: 'revision-uid',
        conditions: [{ type: 'Ready', state: 'CONDITION_SUCCEEDED' }],
        labels: { 'source-build-id': pins.sourceBuildId, 'source-commit': pins.sourceCommit },
        serviceAccount: `mickeyf-runtime@${PROJECT}.iam.gserviceaccount.com`,
        maxInstanceRequestConcurrency: 80, timeout: '300s', scaling: { maxInstanceCount: 10 },
        containers: [{ image: `${IMAGE}@${pins.imageDigest}`, ports: [{ containerPort: 8080, name: 'http1' }],
            resources: { limits: { cpu: '1', memory: '512Mi' }, startupCpuBoost: true },
            startupProbe: { timeoutSeconds: 240, periodSeconds: 240, failureThreshold: 1, tcpSocket: { port: 8080 } },
            env: Object.entries({ NODE_ENV: 'production', CLOUD_SQL_CONNECTION_NAME: `${PROJECT}:${REGION}:cms-mickeyf`,
                DB_USER: 'cms_mickeyf', DB_NAME: 'cms', P4_VEGA_SCORE_SUBMISSIONS_ENABLED: 'false', THREE_BOSSES_RUN_SUBMISSIONS_ENABLED: 'false',
                ACCOUNT_DELETION_ENABLED: 'false', PROVIDER_AUTH_ENABLED: 'false', PROVIDER_GOOGLE_SIGNUP_ENABLED: 'false' })
                .map(([name, value]) => ({ name, value }))
                .concat([['DB_PASS', '1'], ['SESSION_SECRET', pins.sessionSecretVersion]]
                    .map(([name, version]) => ({ name, valueSource: { secretKeyRef: { secret: name, version } } }))),
            volumeMounts: [{ name: 'cloudsql', mountPath: '/cloudsql' }],
        }],
        volumes: [{ name: 'cloudsql', cloudSqlInstance: { instances: [`${PROJECT}:${REGION}:cms-mickeyf`] } }],
    };
    const previousRevision = copy(revision);
    const traffic = [
        { type: REVISION_TYPE, revision: 'mickeyf-org-old-enabled', percent: 100 },
        { type: REVISION_TYPE, revision: revisionName(pins), tag: 'frozen-candidate' },
        { type: REVISION_TYPE, revision: 'mickeyf-org-old-enabled', tag: 'old-enabled-tag' },
    ];
    const service = {
        name: SERVICE, uid: 'service-uid', generation: '126', observedGeneration: '126', etag: 'etag-before',
        terminalCondition: { type: 'Ready', state: 'CONDITION_SUCCEEDED' }, reconciling: false,
        template: { revision: revisionName(pins), containers: copy(revision.containers) },
        latestReadyRevision: revisionName(pins), latestCreatedRevision: revisionName(pins),
        ingress: 'INGRESS_TRAFFIC_ALL', traffic, trafficStatuses: traffic.map(t => ({ ...t, uri: 'https://example.run.app' })),
    };
    const build = {
        id: pins.deploymentBuildId, projectId: PROJECT, buildTriggerId: pins.deploymentTriggerId,
        serviceAccount: `projects/${PROJECT}/serviceAccounts/mickeyf-backend-deploy@${PROJECT}.iam.gserviceaccount.com`,
        status: 'SUCCESS', approval: { config: { approvalRequired: true }, state: 'APPROVED', result: { decision: 'APPROVED' } },
        options: { logging: 'CLOUD_LOGGING_ONLY' }, timeout: '2400s',
        substitutions: { _DEPLOY_TRIGGER_ID: pins.deploymentTriggerId,
            _APPROVAL: frozenDeploymentApproval(pins) },
        steps: steps.map(step => ({ ...copy(step), status: 'SUCCESS', exitCode: 0, timing: {} })),
    };
    let patches = 0;
    const provider = {
        getService: async () => copy(service),
        getRevision: async name => name === revisionName(pins) ? copy(revision)
            : { ...copy(previousRevision), name: `${SERVICE}/revisions/${name}` },
        getDeployment: async () => copy(build),
        assertAutomationPaused: async () => {},
        patchTraffic: async body => {
            patches++;
            assert.deepEqual(Object.keys(body).sort(), ['etag', 'name', 'traffic']);
            assert.equal(body.name, SERVICE);
            assert.equal(body.etag, 'etag-before');
            service.traffic = copy(body.traffic);
            service.trafficStatuses = copy(body.traffic);
            service.generation = service.observedGeneration = '127';
            service.etag = 'etag-after';
        },
        waitForService: async () => copy(service),
    };
    return { revision, previousRevision, service, build, provider, patches: () => patches };
}

test('read-only plan includes every tag; one explicit etag PATCH freezes all traffic', async () => {
    const f = fixture();
    const plan = await planFrozenTraffic(f.provider, pins, now);
    assert.equal(f.patches(), 0);
    assert.deepEqual(plan.removeTags, ['frozen-candidate', 'old-enabled-tag']);
    const result = await applyFrozenTraffic(f.provider, plan, fingerprint(plan), now + 1000);
    assert.deepEqual(result, { revision: revisionName(pins), percent: 100, tags: [], submissions: 'frozen', generation: '127' });
    assert.equal(f.patches(), 1);
});

test('fresh plan supports frozen service rollback, not an old enabled revision', async () => {
    const f = fixture();
    f.service.traffic = [{ type: REVISION_TYPE, revision: 'mickeyf-org-new-enabled', percent: 100 }];
    f.service.trafficStatuses = copy(f.service.traffic);
    const plan = await planFrozenTraffic(f.provider, pins, now);
    await applyFrozenTraffic(f.provider, plan, fingerprint(plan), now);
    assert.equal(f.patches(), 1);
    f.revision.containers[0].env.find(e => e.name === 'THREE_BOSSES_RUN_SUBMISSIONS_ENABLED').value = 'true';
    await assert.rejects(planFrozenTraffic(f.provider, pins, now), /Frozen environment differs/);
});

test('an explicitly reviewed nondefault session-secret version supports the normal traffic approval flow', async () => {
    const f = fixture();
    const reviewedPins = { ...pins, sessionSecretVersion: '17' };
    f.revision.containers[0].env.find(entry => entry.name === 'SESSION_SECRET').valueSource.secretKeyRef.version = '17';
    f.build.substitutions._APPROVAL = frozenDeploymentApproval(reviewedPins);
    const plan = await planFrozenTraffic(f.provider, reviewedPins, now);
    assert.equal(plan.pins.sessionSecretVersion, '17');
    await applyFrozenTraffic(f.provider, plan, fingerprint(plan), now);
    assert.equal(f.patches(), 1);
});

for (const [label, mutate] of Object.entries({
    'mismatched version': env => { env.valueSource.secretKeyRef.version = '3'; },
    'latest alias': env => { env.valueSource.secretKeyRef.version = 'latest'; },
    'custom alias': env => { env.valueSource.secretKeyRef.version = 'active'; },
    'numeric value': env => { env.valueSource.secretKeyRef.version = 2; },
    'padded version': env => { env.valueSource.secretKeyRef.version = '02'; },
    'wrong secret name': env => { env.valueSource.secretKeyRef.secret = 'DIFFERENT_SECRET'; },
    'foreign project': env => { env.valueSource.secretKeyRef.secret = 'projects/foreign/secrets/SESSION_SECRET'; },
    'missing reference': env => { delete env.valueSource; },
    'literal alongside reference': env => { env.value = 'not-a-secret'; },
    'literal instead of reference': env => { delete env.valueSource; env.value = 'not-a-secret'; },
})) test(`session-secret ${label} refuses traffic mutation`, async () => {
    const f = fixture();
    mutate(f.revision.containers[0].env.find(entry => entry.name === 'SESSION_SECRET'));
    await assert.rejects(planFrozenTraffic(f.provider, pins, now), /Secret reference differs: SESSION_SECRET/);
    assert.equal(f.patches(), 0);
});

for (const duplicate of [false, true]) test(`session-secret ${duplicate ? 'duplicate' : 'missing'} environment refuses traffic mutation`, async () => {
    const f = fixture();
    const env = f.revision.containers[0].env;
    const sessionSecret = env.find(entry => entry.name === 'SESSION_SECRET');
    f.revision.containers[0].env = duplicate ? [...env, copy(sessionSecret)] : env.filter(entry => entry !== sessionSecret);
    await assert.rejects(planFrozenTraffic(f.provider, pins, now), /Unexpected environment variables/);
    assert.equal(f.patches(), 0);
});

test('database secret remains fixed at version 1 even when another session-secret version is approved', async () => {
    const f = fixture();
    const reviewedPins = { ...pins, sessionSecretVersion: '17' };
    f.revision.containers[0].env.find(entry => entry.name === 'SESSION_SECRET').valueSource.secretKeyRef.version = '17';
    f.revision.containers[0].env.find(entry => entry.name === 'DB_PASS').valueSource.secretKeyRef.version = '17';
    await assert.rejects(planFrozenTraffic(f.provider, reviewedPins, now), /Secret reference differs: DB_PASS/);
    assert.equal(f.patches(), 0);
});

test('missing or malformed session-secret pins fail plan and apply before any provider call', async () => {
    const f = fixture();
    const validPlan = await planFrozenTraffic(f.provider, pins, now);
    let calls = 0;
    const untouchedProvider = Object.fromEntries(Object.keys(f.provider).map(name => [name, async () => {
        calls++;
        throw new Error('Provider must not be called');
    }]));
    for (const value of [undefined, null, '', '0', '02', 'latest', 'active', ' 2', '2 ', '2\n', '2.0', '+2', '-2', '2e1', '2,DB_PASS:3', 2, ['2'], {}]) {
        const invalidPins = { ...pins, sessionSecretVersion: value };
        if (value === undefined) delete invalidPins.sessionSecretVersion;
        assert.throws(() => validatePins(invalidPins));
        await assert.rejects(planFrozenTraffic(untouchedProvider, invalidPins, now), /Pins|strings|[Ss]ession/);
        const invalidPlan = { ...copy(validPlan), pins: invalidPins };
        await assert.rejects(applyFrozenTraffic(untouchedProvider, invalidPlan, fingerprint(invalidPlan), now), /Pins|strings|[Ss]ession/);
    }
    assert.equal(calls, 0);
    assert.equal(f.patches(), 0);
});

test('changing the reviewed session-secret pin invalidates plan approval and never patches', async () => {
    const f = fixture();
    const plan = await planFrozenTraffic(f.provider, pins, now);
    const approval = fingerprint(plan);
    plan.pins.sessionSecretVersion = '17';
    assert.notEqual(fingerprint(plan), approval);
    await assert.rejects(applyFrozenTraffic(f.provider, plan, approval, now), /Plan SHA256 confirmation differs/);
    // A newly calculated hash still cannot authorize a revision with a different secret reference.
    await assert.rejects(applyFrozenTraffic(f.provider, plan, fingerprint(plan), now), /Secret reference differs: SESSION_SECRET/);
    assert.equal(f.patches(), 0);
});

const enabledDeletion = {
    enabled: true, journalBucket: ACCOUNT_DELETION_JOURNAL_BUCKET, identityEpoch: ORIGINAL_ACCOUNT_IDENTITY_EPOCH,
};
function setDeletion(containers, settings) {
    containers[0].env = containers[0].env.filter(item => !['ACCOUNT_DELETION_ENABLED', 'ACCOUNT_DELETION_JOURNAL_BUCKET', 'ACCOUNT_IDENTITY_EPOCH'].includes(item.name))
        .concat(Object.entries(accountDeletionEnvironment(settings)).map(([name, value]) => ({ name, value })));
}

const enabledGoogle = { enabled: true, clientId: APPROVED_GOOGLE_WEB_CLIENT_ID };
function setGoogle(containers, settings) {
    containers[0].env = containers[0].env.filter(item => !['PROVIDER_AUTH_ENABLED', 'PROVIDER_GOOGLE_SIGNUP_ENABLED', 'GOOGLE_WEB_CLIENT_ID'].includes(item.name))
        .concat(Object.entries(googleSignInEnvironment(settings, enabledDeletion)).map(([name, value]) => ({ name, value })));
}

test('Google candidate requires full signup/login, exact client, and reviewed deletion pins', () => {
    const f = fixture();
    const enabledPins = { ...pins, accountDeletion: enabledDeletion, googleSignIn: enabledGoogle };
    setDeletion(f.revision.containers, enabledDeletion);
    setGoogle(f.revision.containers, enabledGoogle);
    validatePins(enabledPins);
    validateFrozenRevision(f.revision, enabledPins);
    assert.throws(() => validatePins({ ...pins, googleSignIn: enabledGoogle }), /deletion/iu);
    for (const settings of [{ ...enabledGoogle, clientId: 'foreign.apps.googleusercontent.com' },
        { ...enabledGoogle, signupEnabled: false }, { enabled: true }, { enabled: false, clientId: APPROVED_GOOGLE_WEB_CLIENT_ID }]) {
        assert.throws(() => validatePins({ ...enabledPins, googleSignIn: settings }));
    }
    for (const change of [env => env.filter(item => item.name !== 'GOOGLE_WEB_CLIENT_ID'),
        env => [...env, { name: 'GOOGLE_WEB_CLIENT_ID', value: APPROVED_GOOGLE_WEB_CLIENT_ID }],
        env => env.map(item => item.name === 'PROVIDER_GOOGLE_SIGNUP_ENABLED' ? { ...item, value: 'false' } : item)]) {
        const revision = copy(f.revision);
        revision.containers[0].env = change(revision.containers[0].env);
        assert.throws(() => validateFrozenRevision(revision, enabledPins), /environment/iu);
    }
});

for (const location of ['template', 'live', 'tagged']) test(`Google ${location} state cannot be implicitly disabled by a traffic plan`, async () => {
    const f = fixture();
    const reviewedDeletionPins = { ...pins, accountDeletion: enabledDeletion };
    setDeletion(f.revision.containers, enabledDeletion);
    const activeContainers = location === 'template' ? f.service.template.containers : f.previousRevision.containers;
    setDeletion(activeContainers, enabledDeletion);
    setGoogle(activeContainers, enabledGoogle);
    if (location === 'tagged') {
        f.service.traffic = [
            { type: REVISION_TYPE, revision: revisionName(pins), percent: 100 },
            { type: REVISION_TYPE, revision: 'mickeyf-org-old-enabled', tag: 'old-enabled-tag' },
        ];
        f.service.trafficStatuses = copy(f.service.traffic);
    }
    await assert.rejects(planFrozenTraffic(f.provider, reviewedDeletionPins, now), /disable active Google/iu);
    assert.equal(f.patches(), 0);
    const plan = await planFrozenTraffic(f.provider, { ...reviewedDeletionPins, googleSignIn: { enabled: false } }, now);
    assert.deepEqual(plan.pins.googleSignIn, { enabled: false });
    await applyFrozenTraffic(f.provider, plan, fingerprint(plan), now);
    assert.equal(f.patches(), 1);
});

test('Google activation works with a legacy source; configuration drift prevents traffic changes', async () => {
    const f = fixture();
    for (const containers of [f.service.template.containers, f.previousRevision.containers]) {
        containers[0].env = containers[0].env.filter(item => !item.name.startsWith('PROVIDER_'));
    }
    setDeletion(f.revision.containers, enabledDeletion);
    setGoogle(f.revision.containers, enabledGoogle);
    const enabledPins = { ...pins, accountDeletion: enabledDeletion, googleSignIn: enabledGoogle };
    const plan = await planFrozenTraffic(f.provider, enabledPins, now);
    assert.deepEqual(plan.pins.googleSignIn, enabledGoogle);
    f.revision.containers[0].env.find(item => item.name === 'GOOGLE_WEB_CLIENT_ID').value = 'foreign.apps.googleusercontent.com';
    await assert.rejects(applyFrozenTraffic(f.provider, plan, fingerprint(plan), now), /environment/iu);
    assert.equal(f.patches(), 0);
});

test('unsupported or incomplete active provider settings reject even an explicit disable', async () => {
    for (const change of [
        env => [...env, { name: 'APPLE_CLIENT_ID', value: 'com.mickeyf.app' }],
        env => [...env, { name: 'GOOGLE_IOS_CLIENT_ID', value: 'native-client' }],
        env => [...env, { name: 'PROVIDER_FUTURE_SETTING', value: 'true' }],
        env => [...env, { name: 'GOOGLE_WEB_CLIENT_ID', value: APPROVED_GOOGLE_WEB_CLIENT_ID }],
        env => env.map(item => item.name === 'GOOGLE_WEB_CLIENT_ID' ? { name: item.name, valueSource: { secretKeyRef: {} } } : item),
        env => env.map(item => item.name === 'PROVIDER_GOOGLE_SIGNUP_ENABLED' ? { ...item, value: 'false' } : item),
        env => env.map(item => item.name === 'GOOGLE_WEB_CLIENT_ID' ? { ...item, value: 'foreign.apps.googleusercontent.com' } : item),
        env => env.filter(item => item.name !== 'ACCOUNT_DELETION_ENABLED'),
    ]) {
        const f = fixture();
        setDeletion(f.revision.containers, enabledDeletion);
        setDeletion(f.previousRevision.containers, enabledDeletion);
        setGoogle(f.previousRevision.containers, enabledGoogle);
        f.previousRevision.containers[0].env = change(f.previousRevision.containers[0].env);
        await assert.rejects(planFrozenTraffic(f.provider, { ...pins, accountDeletion: enabledDeletion, googleSignIn: { enabled: false } }, now));
        assert.equal(f.patches(), 0);
    }
});

test('enabled deletion revision requires exact reviewed pins and exact environment; disabled revision requires literal false', () => {
    const f = fixture();
    setDeletion(f.revision.containers, enabledDeletion);
    const enabledPins = { ...pins, accountDeletion: enabledDeletion };
    validatePins(enabledPins);
    validateFrozenRevision(f.revision, enabledPins);
    assert.throws(() => validateFrozenRevision(f.revision, pins), /environment/iu);
    for (const changed of [{ ...enabledDeletion, identityEpoch: '2026-09-13 00:15:39.954172' },
        { ...enabledDeletion, journalBucket: 'other' }, { ...enabledDeletion, arbitrary: 'value' }]) {
        assert.throws(() => validatePins({ ...pins, accountDeletion: changed }));
    }
    f.revision.containers[0].env.find(item => item.name === 'ACCOUNT_IDENTITY_EPOCH').value = '2026-09-13 00:15:39.954172';
    assert.throws(() => validateFrozenRevision(f.revision, enabledPins), /environment/iu);
    const missing = fixture().revision;
    missing.containers[0].env = missing.containers[0].env.filter(item => item.name !== 'ACCOUNT_DELETION_ENABLED');
    assert.throws(() => validateFrozenRevision(missing, pins), /environment/iu);
});

for (const location of ['template', 'live', 'tagged']) test(`default-off traffic plan refuses silently disabling ${location} deletion`, async () => {
    const f = fixture();
    if (location === 'template') setDeletion(f.service.template.containers, enabledDeletion);
    else setDeletion(f.previousRevision.containers, enabledDeletion);
    if (location === 'tagged') {
        f.service.traffic = [
            { type: REVISION_TYPE, revision: revisionName(pins), percent: 100 },
            { type: REVISION_TYPE, revision: 'mickeyf-org-old-enabled', tag: 'old-enabled-tag' },
        ];
        f.service.trafficStatuses = copy(f.service.traffic);
    }
    await assert.rejects(planFrozenTraffic(f.provider, pins, now), /explicitly review/iu);
    assert.equal(f.patches(), 0);
    const explicitDisable = { ...pins, accountDeletion: { enabled: false } };
    const plan = await planFrozenTraffic(f.provider, explicitDisable, now);
    assert.deepEqual(plan.pins.accountDeletion, { enabled: false });
    await applyFrozenTraffic(f.provider, plan, fingerprint(plan), now);
    assert.equal(f.patches(), 1);
});

test('explicit activation plan permits matching enabled target and refuses a missing active revision', async () => {
    const f = fixture();
    setDeletion(f.revision.containers, enabledDeletion);
    const plan = await planFrozenTraffic(f.provider, { ...pins, accountDeletion: enabledDeletion }, now);
    assert.deepEqual(plan.pins.accountDeletion, enabledDeletion);
    f.provider.getRevision = async () => { throw new Error('revision read unavailable'); };
    await assert.rejects(planFrozenTraffic(f.provider, pins, now), /unavailable/u);
    assert.equal(f.patches(), 0);
});

for (const [label, mutate] of Object.entries({
    'p4 writes enabled': r => { r.containers[0].env.find(e => e.name === 'P4_VEGA_SCORE_SUBMISSIONS_ENABLED').value = 'true'; },
    'Three Bosses writes enabled': r => { r.containers[0].env.find(e => e.name === 'THREE_BOSSES_RUN_SUBMISSIONS_ENABLED').value = 'true'; },
    'missing flag': r => r.containers[0].env.pop(),
    'duplicate flag': r => { r.containers[0].env[0] = r.containers[0].env[1]; },
    'mutable image tag': r => { r.containers[0].image = `${IMAGE}:latest`; },
    'foreign commit': r => { r.labels['source-commit'] = 'c'.repeat(40); },
    'foreign revision': r => { r.name += '-other'; },
    'wrong runtime identity': r => { r.serviceAccount = 'owner@example.com'; },
    'command override': r => { r.containers[0].command = ['sh']; },
    'args override': r => { r.containers[0].args = ['--enable']; },
    'secret latest': r => { r.containers[0].env.find(e => e.name === 'DB_PASS').valueSource.secretKeyRef.version = 'latest'; },
    'different database': r => { r.volumes[0].cloudSqlInstance.instances = ['other']; },
    'not Ready': r => { r.conditions[0].state = 'CONDITION_FAILED'; },
    'sidecar': r => r.containers.push(copy(r.containers[0])),
})) test(`rejects ${label} before traffic mutation`, async () => {
    const f = fixture(); mutate(f.revision);
    await assert.rejects(planFrozenTraffic(f.provider, pins, now));
    assert.equal(f.patches(), 0);
});

for (const [label, mutate] of Object.entries({
    'LATEST': s => { s.traffic[0].type = 'TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST'; },
    'unresolved': s => { s.trafficStatuses[0].percent = 99; },
    'missing etag': s => { delete s.etag; },
    'pending generation': s => { s.observedGeneration = '125'; },
    'reconciling': s => { s.reconciling = true; },
    'duplicate tag': s => { s.traffic[2].tag = 'frozen-candidate'; },
    'unknown traffic property': s => { s.traffic[0].surprise = true; },
})) test(`rejects service ${label}`, () => {
    const f = fixture(); mutate(f.service); assert.throws(() => validateService(f.service));
});

for (const [label, mutate] of Object.entries({
    'approval absent': b => { delete b.approval; },
    'approval rejected': b => { b.approval.result.decision = 'REJECTED'; },
    'wrong trigger': b => { b.buildTriggerId = pins.sourceBuildId; },
    'wrong source approval': b => { b.substitutions._APPROVAL = 'INVALID'; },
    'legacy approval without session version': b => { b.substitutions._APPROVAL = `freeze-zero-traffic:${pins.sourceCommit}:${pins.sourceBuildId}:${pins.imageDigest}`; },
    'approval for another session version': b => { b.substitutions._APPROVAL = frozenDeploymentApproval({ ...pins, sessionSecretVersion: '17' }); },
    'wrong trigger approval': b => { b.substitutions._DEPLOY_TRIGGER_ID = pins.sourceBuildId; },
    'source present': b => { b.source = { gitSource: {} }; },
    'global environment override': b => { b.options.env = ['PYTHONPATH=/malicious']; },
    'global volume override': b => { b.options.volumes = [{ name: 'v', path: '/workspace' }]; },
    'private pool override': b => { b.options.pool = { name: 'foreign-pool' }; },
    'prefetched dependencies': b => { b.dependencies = [{ custom: 'code' }]; },
    'secret override': b => { b.availableSecrets = { secretManager: [{ env: 'PYTHONPATH' }] }; },
    'step added': b => b.steps.push(copy(b.steps[0])),
    'step modified': b => { b.steps[0].args = ['evil']; },
    'step unsuccessful': b => { b.steps[0].status = 'FAILURE'; },
    'allowed failure': b => { b.steps[0].allowFailure = true; },
})) test(`rejects deployment ${label}`, () => {
    const f = fixture(); mutate(f.build); assert.throws(() => validateDeployment(f.build, pins));
});

test('stale/future plans, incorrect confirmations and changed service never patch', async () => {
    for (const time of [now - 1, now + 300001]) {
        const f = fixture(); const plan = await planFrozenTraffic(f.provider, pins, now);
        await assert.rejects(applyFrozenTraffic(f.provider, plan, fingerprint(plan), time), /stale or future/);
        assert.equal(f.patches(), 0);
    }
    const f = fixture(); const plan = await planFrozenTraffic(f.provider, pins, now);
    await assert.rejects(applyFrozenTraffic(f.provider, plan, '0'.repeat(64), now), /confirmation/);
    f.service.template.extra = true;
    await assert.rejects(applyFrozenTraffic(f.provider, plan, fingerprint(plan), now), /drift/);
    assert.equal(f.patches(), 0);
});

test('changed revision or automation state invalidates a reviewed plan', async () => {
    const f = fixture(); const plan = await planFrozenTraffic(f.provider, pins, now);
    f.revision.uid = 'recreated-revision';
    await assert.rejects(applyFrozenTraffic(f.provider, plan, fingerprint(plan), now), /drift/);
    f.provider.assertAutomationPaused = async () => { throw new Error('automation enabled'); };
    await assert.rejects(applyFrozenTraffic(f.provider, plan, fingerprint(plan), now), /automation enabled/);
    assert.equal(f.patches(), 0);
});

test('etag conflict or ambiguous PATCH fails without retry or automatic rollback', async () => {
    for (const message of ['HTTP 409', 'network timeout']) {
        const f = fixture(); let attempts = 0;
        const plan = await planFrozenTraffic(f.provider, pins, now);
        f.provider.patchTraffic = async () => { attempts++; throw new Error(message); };
        await assert.rejects(applyFrozenTraffic(f.provider, plan, fingerprint(plan), now), /do not retry or migrate/);
        assert.equal(attempts, 1);
    }
});

test('post-PATCH foreign state is reported as indeterminate, never success', async () => {
    const f = fixture(); const plan = await planFrozenTraffic(f.provider, pins, now);
    f.provider.waitForService = async () => { const result = copy(f.service); result.template.changed = true; return result; };
    await assert.rejects(applyFrozenTraffic(f.provider, plan, fingerprint(plan), now), /Unexpected state/);
    assert.equal(f.patches(), 1);
});

test('pins and CLI reject unknown fields, missing mode and missing explicit apply authority before network', async () => {
    assert.throws(() => validatePins({ ...pins, enabled: true }));
    assert.throws(() => validatePins({ ...pins, sourceBuildId: '../foreign' }));
    assert.throws(() => validatePins({ ...pins, sourceBuildId: [pins.sourceBuildId] }), /must be strings/);
    await assert.rejects(main([]), /No default mutation/);
    await assert.rejects(main(['apply', '--plan', 'missing.json']), /unexpected fields/);
    await assert.rejects(main(['plan', '--pins', 'missing.json', '--pins', 'second.json']), /duplicate/);
});

test('REST adapter only sends exact traffic updateMask with etag; no other write capability', async () => {
    const calls = [];
    const provider = createCloudProvider('not-a-real-token-1234567890', async (url, options) => {
        calls.push({ url, options });
        return new Response(JSON.stringify({ name: `projects/${PROJECT}/locations/${REGION}/operations/example` }), { status: 200 });
    });
    const body = { name: SERVICE, etag: 'etag', traffic: [{ type: REVISION_TYPE, revision: revisionName(pins), percent: 100 }] };
    await provider.patchTraffic(body);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `https://run.googleapis.com/v2/${SERVICE}?updateMask=traffic`);
    assert.equal(calls[0].options.method, 'PATCH');
    assert.equal(calls[0].options.redirect, 'error');
    assert.deepEqual(JSON.parse(calls[0].options.body), body);
    await assert.rejects(provider.patchTraffic({ ...body, template: {} }));
    await assert.rejects(provider.patchTraffic({ ...body, traffic: [{ ...body.traffic[0], tag: 'keep-old-route' }] }));
    assert.equal(calls.length, 1);
});

test('automation inventory is paginated, requires both canonical triggers, rejects any enabled trigger or active build', async () => {
    const ids = ['ef5a2981-95be-4f4d-af91-f997fde73356', 'd71109da-8350-4f2f-a3be-2053bb6ccd45'];
    for (const bad of ['', 'enabled', 'active', 'missing', 'repeat-token']) {
        let pages = 0;
        const provider = createCloudProvider('not-a-real-token-1234567890', async url => {
            let result = {};
            if (url.includes('/global/triggers')) {
                pages++;
                result = url.includes('pageToken=next') ? { triggers: bad === 'missing' ? [] : [{ id: ids[1], disabled: true }] }
                    : { triggers: [{ id: ids[0], disabled: bad !== 'enabled' }], nextPageToken: 'next' };
                if (bad === 'repeat-token') result.nextPageToken = 'next';
            }
            if (url.includes('/global/builds') && bad === 'active') result = { builds: [{ status: 'WORKING' }] };
            return new Response(JSON.stringify(result), { status: 200 });
        });
        if (bad) await assert.rejects(provider.assertAutomationPaused());
        else { await provider.assertAutomationPaused(); assert.equal(pages, 2); }
    }
});
