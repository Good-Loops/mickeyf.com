import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IMAGE, REVISION_TYPE, SERVICE } from './frozen-backend-traffic.mjs';
import { executeMaintenanceStage } from './recovery-maintenance-stage.mjs';
import { prepareRecoveryAdultRestore, prepareRecoveryAdultStage, verifyRecoveryAdultRestored } from './recovery-adult-stage.mjs';

const activeName = 'mickeyf-org-session-active-0f3eb4c14a6148cdb2330ed50d60d053';
const candidateName = 'mickeyf-org-session-fd9db469519d4c9c8d8ebb18d4560841';
const traffic = [
    { type: REVISION_TYPE, revision: activeName, percent: 100 },
    { type: REVISION_TYPE, revision: candidateName, tag: 's-fd9db469519d4c9c8d8ebb18d4560841' },
    { type: REVISION_TYPE, revision: 'mickeyf-org-maint-64dcad1948c3', tag: 'maintenance-64dcad' },
];
const liveEnv = [
    { name: 'REGISTRATION_CREATION_ENABLED', value: 'true' },
    { name: 'PROVIDER_GOOGLE_SIGNUP_ENABLED', value: 'true' },
    { name: 'PROVIDER_APPLE_SIGNUP_ENABLED', value: 'true' },
    { name: 'PARENT_REGISTRATION_CREATION_ENABLED', value: 'false' },
    { name: 'SESSION_SECRET', valueSource: { secretKeyRef: { secret: 'SESSION_SECRET', version: 'fixture' } } },
];
function fixture() {
    const common = { conditions: [{ type: 'Ready', state: 'CONDITION_SUCCEEDED' }], scaling: { maxInstanceCount: 10 },
        timeout: '300s', serviceAccount: 'runtime', volumes: [{ name: 'cloudsql' }], maxInstanceRequestConcurrency: 80 };
    const container = { resources: { limits: { cpu: '1', memory: '512Mi' } }, ports: [{ containerPort: 8080 }] };
    const active = { ...structuredClone(common), name: `${SERVICE}/revisions/${activeName}`,
        containers: [{ ...structuredClone(container), image: `${IMAGE}@sha256:cb197dfd3594dd16b03cdec54679c75d0c9a1658a4181d199517ecf2d882c75f`, env: structuredClone(liveEnv) }] };
    const candidate = { ...structuredClone(common), name: `${SERVICE}/revisions/${candidateName}`,
        containers: [{ ...structuredClone(container), image: `${IMAGE}@sha256:b55b86a563f8c988cd5b273f45f6221f8c3473ade2667d876c076b02ab0c5fe3`, env: [] }] };
    const template = { revision: 'previous', scaling: common.scaling, timeout: common.timeout, serviceAccount: common.serviceAccount,
        volumes: common.volumes, maxInstanceRequestConcurrency: common.maxInstanceRequestConcurrency, containers: structuredClone(candidate.containers) };
    const service = { name: SERVICE, uid: 'synthetic', generation: '189', observedGeneration: '189', etag: 'e1',
        terminalCondition: { type: 'Ready', state: 'CONDITION_SUCCEEDED' }, latestReadyRevision: 'ready', latestCreatedRevision: 'created',
        traffic: structuredClone(traffic), trafficStatuses: structuredClone(traffic), template };
    return { service, active, candidate };
}

test('recovery candidate preserves the complete live environment and restores the previous template', () => {
    const { service, active, candidate } = fixture();
    const plan = prepareRecoveryAdultStage(service, active, candidate);
    assert.deepEqual(plan.template.containers[0].env, liveEnv);
    assert.equal(plan.traffic[0].percent, 100);
    assert.equal(plan.traffic[3].tag, 'recovery-adult-fd9');
    assert.equal(plan.traffic[3].percent, undefined);
    const staged = { ...service, generation: '190', observedGeneration: '190', etag: 'e2', template: structuredClone(plan.template),
        traffic: plan.traffic, trafficStatuses: structuredClone(plan.traffic) };
    const restore = prepareRecoveryAdultRestore(staged, plan);
    const restored = { ...staged, generation: '191', observedGeneration: '191', etag: 'e3', template: restore.template };
    verifyRecoveryAdultRestored(restored, plan);
    staged.template.containers[0].env = [];
    assert.throws(() => prepareRecoveryAdultRestore(staged, plan), /template changed/u);
});

test('recovery staging rejects policy, runtime, and source-image drift', () => {
    const one = fixture(); one.active.containers[0].env[0].value = 'false';
    assert.throws(() => prepareRecoveryAdultStage(one.service, one.active, one.candidate), /signup policy/u);
    const two = fixture(); two.candidate.timeout = '301s';
    assert.throws(() => prepareRecoveryAdultStage(two.service, two.active, two.candidate), /runtime beyond/u);
    const three = fixture(); three.candidate.containers[0].image = 'unreviewed';
    assert.throws(() => prepareRecoveryAdultStage(three.service, three.active, three.candidate), /source images/u);
});

test('adult staging restores its original template when the smoke test fails', async () => {
    const f = fixture(); let state = f.service, restored = false;
    const provider = {
        async read() { return structuredClone(state); },
        async stage(p) { state = { ...state, generation: '190', observedGeneration: '190', etag: 'e2', template: p.template,
            traffic: p.traffic, trafficStatuses: structuredClone(p.traffic) }; },
        async wait() { return structuredClone(state); },
        async smoke() { throw new Error('synthetic adult smoke failure'); },
        async restore(p) { restored = true; state = { ...state, generation: '191', observedGeneration: '191', etag: 'e3', template: p.template }; },
    };
    await assert.rejects(executeMaintenanceStage(provider, null, {
        prepare: service => prepareRecoveryAdultStage(service, f.active, f.candidate),
        prepareRestore: prepareRecoveryAdultRestore, verifyRestored: verifyRecoveryAdultRestored,
    }), /synthetic adult smoke failure/u);
    assert.equal(restored, true);
    assert.equal(state.traffic[0].percent, 100);
});
