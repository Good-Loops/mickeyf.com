import assert from 'node:assert/strict';
import { sessionDeploymentApproval } from '../render-frozen-backend-deploy.mjs';
import { PROJECT, REGION, SERVICE, IMAGE, REVISION_TYPE, fingerprint, deploymentStepsFingerprint,
    revisionConfiguration, sessionRevisionName } from '../frozen-backend-traffic.mjs';
import { rollbackRevisionName } from '../session-backend-traffic.mjs';

const copy = structuredClone;
export const now = Date.parse('2026-09-30T20:00:00Z');
const steps = [{ id: 'Reviewed session candidate', name: 'sdk@sha256:fixture', args: ['reviewed deployment'] }];
export function fixture() {
    const deployment = {
        sourceBuildId: '11111111-1111-4111-8111-111111111111', sourceCommit: 'a'.repeat(40),
        imageDigest: `sha256:${'b'.repeat(64)}`, sourceTriggerId: '648fadca-3cd1-4b57-9d35-0f62a1468443',
        sourceTriggerName: 'session-image-candidate', sourceRef: 'refs/heads/improvement/clean-code-sweep',
        deploymentTriggerName: 'session-backend-candidate', previousSessionSecretVersion: '2', sessionSecretVersion: '17',
    };
    const pins = {
        candidate: { deployment, receipt: { buildId: '22222222-2222-4222-8222-222222222222',
            triggerId: '33333333-3333-4333-8333-333333333333', stepsSha256: deploymentStepsFingerprint(steps) } },
        baseline: { revisionName: 'mickeyf-org-legacy', sourceBuildId: '44444444-4444-4444-8444-444444444444',
            sourceCommit: 'c'.repeat(40), imageDigest: `sha256:${'d'.repeat(64)}`, sessionSecretVersion: '2', configurationSha256: '' },
        rollback: { sessionSecretVersion: '18' },
    };
    function revision(source, name, legacy) {
        return {
            name: `${SERVICE}/revisions/${name}`, uid: `${name}-uid`, generation: '1', service: 'mickeyf-org',
            createTime: '2026-09-30T19:00:00Z', conditions: [{ type: 'Ready', state: 'CONDITION_SUCCEEDED' }],
            labels: { 'source-build-id': source.sourceBuildId, 'source-commit': source.sourceCommit },
            serviceAccount: `mickeyf-runtime@${PROJECT}.iam.gserviceaccount.com`,
            maxInstanceRequestConcurrency: 80, timeout: '300s', scaling: { maxInstanceCount: 10 },
            containers: [{ name: 'backend', image: `${IMAGE}@${source.imageDigest}`,
                ports: [{ containerPort: 8080, name: 'http1' }],
                resources: { limits: { cpu: '1', memory: '512Mi' }, startupCpuBoost: true },
                startupProbe: { timeoutSeconds: 240, periodSeconds: 240, failureThreshold: 1, tcpSocket: { port: 8080 } },
                env: Object.entries({ NODE_ENV: 'production', CLOUD_SQL_CONNECTION_NAME: `${PROJECT}:${REGION}:cms-mickeyf`,
                    DB_USER: 'cms_mickeyf', DB_NAME: 'cms', P4_VEGA_SCORE_SUBMISSIONS_ENABLED: 'true', THREE_BOSSES_RUN_SUBMISSIONS_ENABLED: 'true',
                    ...legacy ? {} : { ACCOUNT_DELETION_ENABLED: 'false', PROVIDER_AUTH_ENABLED: 'false', PROVIDER_GOOGLE_SIGNUP_ENABLED: 'false' } })
                    .map(([name, value]) => ({ name, value }))
                    .concat([['DB_PASS', '1'], ['SESSION_SECRET', source.sessionSecretVersion]]
                        .map(([name, version]) => ({ name, valueSource: { secretKeyRef: { secret: name, version } } }))),
                volumeMounts: [{ name: 'cloudsql', mountPath: '/cloudsql' }],
            }],
            volumes: [{ name: 'cloudsql', cloudSqlInstance: { instances: [`${PROJECT}:${REGION}:cms-mickeyf`] } }],
        };
    }
    const baseline = revision(pins.baseline, pins.baseline.revisionName, true);
    pins.baseline.configurationSha256 = fingerprint(revisionConfiguration(baseline));
    const candidate = revision(deployment, sessionRevisionName(deployment), false);
    const rollback = revision({ ...pins.baseline, ...pins.rollback }, rollbackRevisionName(pins), true);
    rollback.createTime = '2026-09-30T19:20:00Z';
    const traffic = [
        { type: REVISION_TYPE, revision: pins.baseline.revisionName, percent: 100 },
        { type: REVISION_TYPE, revision: sessionRevisionName(deployment), tag: `s-${deployment.sourceBuildId.replaceAll('-', '')}` },
        { type: REVISION_TYPE, revision: rollbackRevisionName(pins), tag: `r-${deployment.sourceBuildId.replaceAll('-', '')}` },
    ];
    const service = { name: SERVICE, uid: 'service-uid', generation: '146', observedGeneration: '146', etag: 'etag-146',
        terminalCondition: { type: 'Ready', state: 'CONDITION_SUCCEEDED' }, reconciling: false,
        template: { revision: rollbackRevisionName(pins), containers: copy(rollback.containers) },
        latestReadyRevision: rollbackRevisionName(pins), latestCreatedRevision: rollbackRevisionName(pins),
        ingress: 'INGRESS_TRAFFIC_ALL', traffic, trafficStatuses: copy(traffic) };
    const receipt = pins.candidate.receipt;
    const build = { id: receipt.buildId, projectId: PROJECT, buildTriggerId: receipt.triggerId,
        serviceAccount: `projects/${PROJECT}/serviceAccounts/mickeyf-backend-deploy@${PROJECT}.iam.gserviceaccount.com`,
        status: 'SUCCESS', approval: { config: { approvalRequired: true }, state: 'APPROVED', result: { decision: 'APPROVED' } },
        options: { logging: 'CLOUD_LOGGING_ONLY' }, timeout: '2400s',
        substitutions: { _DEPLOY_TRIGGER_ID: receipt.triggerId, _APPROVAL: sessionDeploymentApproval(deployment) },
        steps: steps.map(step => ({ ...copy(step), status: 'SUCCESS', exitCode: 0, timing: {} })) };
    const revisions = { [pins.baseline.revisionName]: baseline, [sessionRevisionName(deployment)]: candidate, [rollbackRevisionName(pins)]: rollback };
    const patches = [];
    const provider = {
        getService: async () => copy(service), getRevision: async name => copy(revisions[name]), getDeployment: async () => copy(build),
        assertAutomationPaused: async () => {},
        patchTraffic: async body => {
            assert.deepEqual(Object.keys(body).sort(), ['etag', 'name', 'traffic']);
            assert.equal(body.etag, service.etag);
            patches.push(copy(body));
            service.traffic = copy(body.traffic);
            service.trafficStatuses = copy(body.traffic);
            service.generation = service.observedGeneration = String(BigInt(service.generation) + 1n);
            service.etag = `etag-${service.generation}`;
        },
        waitForService: async () => copy(service),
    };
    return { pins, baseline, candidate, rollback, service, build, provider, patches };
}
