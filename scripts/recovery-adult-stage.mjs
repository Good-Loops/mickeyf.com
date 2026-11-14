import { IMAGE, REVISION_TYPE, SERVICE, fingerprint, trafficShape, validateService } from './frozen-backend-traffic.mjs';

const ACTIVE = 'mickeyf-org-session-active-0f3eb4c14a6148cdb2330ed50d60d053';
const CANDIDATE = 'mickeyf-org-session-fd9db469519d4c9c8d8ebb18d4560841';
const MAINTENANCE = 'mickeyf-org-maint-64dcad1948c3';
const ADULT = 'mickeyf-org-recovery-adult-fd9db469';
const RESTORE = 'mickeyf-org-adult-restore-fd9db469';
const TAG = 'recovery-adult-fd9';
const BASE_TRAFFIC = [
    { type: REVISION_TYPE, revision: ACTIVE, percent: 100 },
    { type: REVISION_TYPE, revision: CANDIDATE, tag: 's-fd9db469519d4c9c8d8ebb18d4560841' },
    { type: REVISION_TYPE, revision: MAINTENANCE, tag: 'maintenance-64dcad' },
];
const liveDigest = 'sha256:cb197dfd3594dd16b03cdec54679c75d0c9a1658a4181d199517ecf2d882c75f';
const recoveryDigest = 'sha256:b55b86a563f8c988cd5b273f45f6221f8c3473ade2667d876c076b02ab0c5fe3';
const equal = (a, b) => fingerprint(a) === fingerprint(b);
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const ready = revision => revision?.conditions?.some(c => c.type === 'Ready' && c.state === 'CONDITION_SUCCEEDED');
const runtimeKeys = ['scaling', 'timeout', 'serviceAccount', 'volumes', 'maxInstanceRequestConcurrency', 'executionEnvironment', 'sessionAffinity'];
const runtime = revision => Object.fromEntries(runtimeKeys.filter(k => revision[k] !== undefined).map(k => [k, revision[k]]));
const containerRuntime = c => Object.fromEntries(Object.entries(c).filter(([k]) => !['env', 'image'].includes(k)));

/** Stage the recovery-aware image with the exact currently serving adult policy and session secret. */
export function prepareRecoveryAdultStage(service, active, candidate) {
    validateService(service);
    assert(service.generation === '189' && equal(trafficShape(service.traffic), trafficShape(BASE_TRAFFIC)), 'Production traffic or generation changed');
    assert(active?.name === `${SERVICE}/revisions/${ACTIVE}` && ready(active)
        && candidate?.name === `${SERVICE}/revisions/${CANDIDATE}` && ready(candidate), 'Reviewed revisions are not ready');
    assert(active.containers?.length === 1 && candidate.containers?.length === 1
        && active.containers[0].image === `${IMAGE}@${liveDigest}` && candidate.containers[0].image === `${IMAGE}@${recoveryDigest}`,
    'Reviewed source images differ');
    assert(equal(runtime(active), runtime(candidate)) && equal(containerRuntime(active.containers[0]), containerRuntime(candidate.containers[0])),
        'Recovery candidate differs from the live runtime beyond image and environment');
    const liveEnv = active.containers[0].env;
    assert(Array.isArray(liveEnv) && new Set(liveEnv.map(e => e.name)).size === liveEnv.length, 'Live environment is ambiguous');
    const values = Object.fromEntries(liveEnv.map(e => [e.name, e.value]));
    for (const name of ['REGISTRATION_CREATION_ENABLED', 'PROVIDER_GOOGLE_SIGNUP_ENABLED', 'PROVIDER_APPLE_SIGNUP_ENABLED']) {
        assert(values[name] === 'true', 'The reviewed adult signup policy changed');
    }
    assert(values.PARENT_REGISTRATION_CREATION_ENABLED === 'false'
        && (values.CHILD_INACTIVITY_ENABLED === undefined || values.CHILD_INACTIVITY_ENABLED === 'false'), 'Child features are not closed');
    const baseline = structuredClone(service.template), template = structuredClone(baseline);
    assert(template.containers?.length === 1 && template.containers[0].image === `${IMAGE}@${recoveryDigest}`, 'Current template image differs');
    template.revision = ADULT;
    template.containers[0].env = structuredClone(liveEnv);
    const traffic = [...structuredClone(service.traffic), { type: REVISION_TYPE, revision: ADULT, tag: TAG }];
    return { uid: service.uid, generation: service.generation, baseline, template, traffic, baseTraffic: structuredClone(service.traffic), revision: ADULT, tag: TAG,
        restoreRevision: RESTORE, patch: { name: SERVICE, etag: service.etag, template, traffic } };
}

export function prepareRecoveryAdultRestore(service, plan) {
    assert(service.name === SERVICE && service.uid === plan.uid && !service.reconciling && service.observedGeneration === service.generation
        && typeof service.etag === 'string' && service.etag && BigInt(service.generation) === BigInt(plan.generation) + 1n,
    'Unexpected service generation');
    assert(equal(trafficShape(service.traffic), trafficShape(plan.traffic)), 'Traffic changed during staging');
    const observed = trafficShape(service.trafficStatuses, true);
    assert(equal(observed, trafficShape(BASE_TRAFFIC)) || equal(observed, trafficShape(plan.traffic)), 'Resolved traffic changed');
    assert(equal(service.template, plan.template), 'Staged template changed');
    return { name: SERVICE, etag: service.etag, template: { ...structuredClone(plan.baseline), revision: RESTORE } };
}

export function verifyRecoveryAdultRestored(service, plan) {
    validateService(service);
    assert(service.uid === plan.uid && BigInt(service.generation) === BigInt(plan.generation) + 2n, 'Unexpected restored generation');
    assert(equal(trafficShape(service.traffic), trafficShape(plan.traffic)), 'Traffic changed during template restoration');
    assert(equal(service.template, { ...plan.baseline, revision: RESTORE }), 'The original template was not restored');
}
