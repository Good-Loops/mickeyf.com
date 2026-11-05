import { createHash } from 'node:crypto';
import { IMAGE, PROJECT, REVISION_TYPE, SERVICE, fingerprint, trafficShape, validateService } from './frozen-backend-traffic.mjs';

const SCRIPT_SHA = '64dcad1948c3a59c507bab9f117c8d49aac26b6726a28810a1a78627d20277df';
const IMAGE_DIGEST = 'sha256:f5ea9476818c13081781c3feccdc3bab2d6ab825e6e275f7202bc1835de871bd';
const BASE_IMAGE = 'sha256:b55b86a563f8c988cd5b273f45f6221f8c3473ade2667d876c076b02ab0c5fe3';
const ACTIVE = 'mickeyf-org-session-active-0f3eb4c14a6148cdb2330ed50d60d053';
const CANDIDATE = 'mickeyf-org-session-fd9db469519d4c9c8d8ebb18d4560841';
const MAINTENANCE = 'mickeyf-org-maint-64dcad1948c3';
const RESTORE = 'mickeyf-org-restore-64dcad1948c3';
const TAG = 'maintenance-64dcad';
const BASE_TRAFFIC = [
    { type: REVISION_TYPE, revision: ACTIVE, percent: 100 },
    { type: REVISION_TYPE, revision: CANDIDATE, tag: 's-fd9db469519d4c9c8d8ebb18d4560841' },
];
const equal = (a, b) => fingerprint(a) === fingerprint(b);
const assert = (condition, message) => { if (!condition) throw new Error(message); };

/** Prepare only a tagged zero-traffic revision; keep the secret-bearing baseline in memory. */
export function prepareMaintenanceStage(service, source) {
    validateService(service);
    assert(service.name === SERVICE && service.generation === '187', 'Production service changed since staging review');
    assert(equal(trafficShape(service.traffic), trafficShape(BASE_TRAFFIC)), 'Unexpected production traffic');
    assert(typeof source === 'string' && createHash('sha256').update(source).digest('hex') === SCRIPT_SHA, 'Maintenance source differs');
    const baseline = structuredClone(service.template);
    assert(baseline.containers?.length === 1 && baseline.containers[0].image === `${IMAGE}@${BASE_IMAGE}`, 'Baseline template image differs');
    const template = structuredClone(baseline);
    template.revision = MAINTENANCE;
    template.labels = { purpose: 'recovery-maintenance' };
    template.serviceAccount = `ludolume-maintenance-503@${PROJECT}.iam.gserviceaccount.com`;
    template.scaling = { maxInstanceCount: 1 };
    delete template.volumes;
    const container = template.containers[0];
    delete container.env;
    delete container.volumeMounts;
    container.image = `${IMAGE}@${IMAGE_DIGEST}`;
    container.command = ['node'];
    container.args = [`--import=data:text/javascript;base64,${Buffer.from(source).toString('base64')}`, '--eval', '0'];
    const traffic = [...structuredClone(service.traffic), { type: REVISION_TYPE, revision: MAINTENANCE, tag: TAG }];
    return { uid: service.uid, generation: service.generation, baseline, template, traffic,
        patch: { name: SERVICE, etag: service.etag, template, traffic } };
}

/** Restore the exact prior template under a fresh revision, preserving every traffic target. */
export function prepareMaintenanceRestore(service, plan) {
    assert(service.name === SERVICE && service.uid === plan.uid && !service.reconciling
        && service.observedGeneration === service.generation && typeof service.etag === 'string' && service.etag
        && BigInt(service.generation) === BigInt(plan.generation) + 1n, 'Unexpected service generation');
    assert(equal(trafficShape(service.traffic), trafficShape(plan.traffic)), 'Traffic changed during maintenance staging');
    const observedTraffic = trafficShape(service.trafficStatuses, true);
    assert(equal(observedTraffic, trafficShape(BASE_TRAFFIC)) || equal(observedTraffic, trafficShape(plan.traffic)),
        'Resolved traffic changed during maintenance staging');
    assert(equal(service.template, plan.template), 'Maintenance template changed or was normalized unexpectedly');
    const template = structuredClone(plan.baseline);
    template.revision = RESTORE;
    return { name: SERVICE, etag: service.etag, template };
}

export function verifyMaintenanceRestored(service, plan) {
    validateService(service);
    assert(service.uid === plan.uid && BigInt(service.generation) === BigInt(plan.generation) + 2n, 'Unexpected restored generation');
    assert(equal(trafficShape(service.traffic), trafficShape(plan.traffic)), 'Traffic changed during template restoration');
    assert(equal(service.template, { ...plan.baseline, revision: RESTORE }), 'The original template was not restored');
}

/** The provider supplies bounded read/patch/wait and a synthetic-only smoke test. */
export async function executeMaintenanceStage(provider, source) {
    const plan = prepareMaintenanceStage(await provider.read(), source);
    let issuePossible = false, failure, smoke;
    try {
        issuePossible = true; // A timeout can hide a successful request; reconcile by reading, never retry it.
        await provider.stage(plan.patch);
        const staged = await provider.wait(plan, 'stage');
        prepareMaintenanceRestore(staged, plan);
        assert(staged.terminalCondition?.state === 'CONDITION_SUCCEEDED', 'Maintenance revision is not ready');
        smoke = await provider.smoke(staged, TAG);
    } catch (error) { failure = error; }
    if (issuePossible) {
        try {
            const settled = await provider.wait(plan, 'stage');
            if (settled.generation !== plan.generation) {
                await provider.restore(prepareMaintenanceRestore(settled, plan));
                verifyMaintenanceRestored(await provider.wait(plan, 'restore'), plan);
            } else {
                assert(equal(settled.template, plan.baseline) && equal(trafficShape(settled.traffic), trafficShape(BASE_TRAFFIC)),
                    'Stage outcome is uncertain; inspect before retrying');
            }
        } catch (restoreError) {
            throw new AggregateError([...(failure ? [failure] : []), restoreError],
                'Maintenance staging or template restoration requires inspection');
        }
    }
    if (failure) throw failure;
    return { revision: MAINTENANCE, tag: TAG, restoredRevision: RESTORE, smoke };
}

export const maintenanceStageIds = Object.freeze({ revision: MAINTENANCE, restoreRevision: RESTORE, tag: TAG });
