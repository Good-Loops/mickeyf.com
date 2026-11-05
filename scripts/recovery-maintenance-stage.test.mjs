import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { IMAGE, REVISION_TYPE, SERVICE } from './frozen-backend-traffic.mjs';
import { maintenanceStageIds, prepareMaintenanceRestore, prepareMaintenanceStage } from './recovery-maintenance-stage.mjs';

const source = readFileSync('scripts/recovery-maintenance-response.mjs', 'utf8');
const traffic = [
    { type: REVISION_TYPE, revision: 'mickeyf-org-session-active-0f3eb4c14a6148cdb2330ed50d60d053', percent: 100 },
    { type: REVISION_TYPE, revision: 'mickeyf-org-session-fd9db469519d4c9c8d8ebb18d4560841', tag: 's-fd9db469519d4c9c8d8ebb18d4560841' },
];
function fixture() {
    return { name: SERVICE, uid: 'synthetic', generation: '187', observedGeneration: '187', etag: 'e1',
        terminalCondition: { type: 'Ready', state: 'CONDITION_SUCCEEDED' }, latestReadyRevision: 'ready', latestCreatedRevision: 'created',
        traffic: structuredClone(traffic), trafficStatuses: structuredClone(traffic),
        template: { revision: 'old', serviceAccount: 'original', volumes: [{ name: 'secret' }], scaling: { maxInstanceCount: 10 },
            containers: [{ image: `${IMAGE}@sha256:b55b86a563f8c988cd5b273f45f6221f8c3473ade2667d876c076b02ab0c5fe3`,
                env: [{ name: 'SYNTHETIC_SECRET', value: 'fixture' }], volumeMounts: [{ name: 'secret', mountPath: '/secret' }] }] } };
}

test('staging strips credentials and retains live traffic; restoration recovers the exact template', () => {
    const before = fixture(), original = structuredClone(before.template);
    const plan = prepareMaintenanceStage(before, source);
    assert.equal(plan.template.serviceAccount, 'ludolume-maintenance-503@noted-reef-387021.iam.gserviceaccount.com');
    assert.equal(plan.template.containers[0].env, undefined);
    assert.equal(plan.template.containers[0].volumeMounts, undefined);
    assert.equal(plan.template.volumes, undefined);
    assert.deepEqual(plan.traffic.slice(0, 2), traffic);
    assert.equal(plan.traffic[2].tag, maintenanceStageIds.tag);
    assert.equal(plan.traffic[2].percent, undefined);
    const staged = { ...before, generation: '188', observedGeneration: '188', etag: 'e2',
        template: structuredClone(plan.template), traffic: structuredClone(plan.traffic), trafficStatuses: structuredClone(plan.traffic) };
    const restore = prepareMaintenanceRestore(staged, plan);
    assert.equal(restore.etag, 'e2');
    assert.deepEqual(restore.template, { ...original, revision: maintenanceStageIds.restoreRevision });
    assert.equal(restore.traffic, undefined);
    staged.traffic[0].percent = 0;
    assert.throws(() => prepareMaintenanceRestore(staged, plan));
});

test('staging rejects changed production state and unreviewed source', () => {
    const changed = fixture(); changed.generation = '188'; changed.observedGeneration = '188';
    assert.throws(() => prepareMaintenanceStage(changed, source), /changed since staging review/u);
    assert.throws(() => prepareMaintenanceStage(fixture(), `${source} `), /source differs/u);
    const changedImage = fixture(); changedImage.template.containers[0].image = 'unreviewed';
    assert.throws(() => prepareMaintenanceStage(changedImage, source), /image differs/u);
});
