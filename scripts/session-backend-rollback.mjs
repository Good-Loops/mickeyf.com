// Prepare a legacy rollback copy. Traffic promotion is a separate command.
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { validateSessionSecretVersion } from './render-frozen-backend-deploy.mjs';
import { PROJECT, REGION, SERVICE, fingerprint, revisionConfiguration, serviceConfiguration,
    sessionRevisionName, trafficShape, validateService, validateLegacySessionRevision, createSessionCloudProvider, createCloudRequest,
    readJson, accessToken } from './frozen-backend-traffic.mjs';
import { validateSessionTrafficPins, rollbackRevisionName, checkedSessionCandidate,
    checkSessionTraffic, validateSessionRollback } from './session-backend-traffic.mjs';

const MAX_PLAN_AGE = 5 * 60_000;
const SHA = /^[0-9a-f]{64}$/u;
const requireThat = (condition, message) => { if (!condition) throw new Error(message); };
const same = (a, b) => fingerprint(a) === fingerprint(b);
const TEMPLATE_FIELDS = ['labels', 'annotations', 'scaling', 'timeout', 'serviceAccount', 'containers',
    'volumes', 'maxInstanceRequestConcurrency', 'executionEnvironment', 'sessionAffinity', 'client', 'clientVersion'];
const REVISION_METADATA = ['name', 'uid', 'generation', 'createTime', 'updateTime', 'launchStage', 'service',
    'conditions', 'observedGeneration', 'logUri', 'creator', 'etag', 'reconciling', 'scalingStatus'];
function keys(value, expected, label) {
    requireThat(value && typeof value === 'object' && !Array.isArray(value)
        && same(Object.keys(value).sort(), [...expected].sort()), `${label}: unexpected fields`);
}

export function rollbackTemplate(baseline, pins) {
    requireThat(Object.keys(baseline).every(key => [...TEMPLATE_FIELDS, ...REVISION_METADATA].includes(key)),
        'Baseline has an unreviewed revision field; do not silently discard it');
    const template = structuredClone(Object.fromEntries(Object.entries(baseline).filter(([key]) => TEMPLATE_FIELDS.includes(key))));
    template.revision = rollbackRevisionName(pins);
    const secret = template.containers[0].env.find(entry => entry.name === 'SESSION_SECRET');
    secret.valueSource.secretKeyRef.version = pins.rollback.sessionSecretVersion;
    return template;
}

function unchangedServiceConfiguration(service) {
    const config = serviceConfiguration(service);
    for (const field of ['template', 'latestReadyRevision', 'latestCreatedRevision']) delete config[field];
    return config;
}

async function checkedSecret(provider, version) {
    const secret = await provider.getSessionSecretVersion(version);
    requireThat(secret?.state === 'ENABLED' && !secret.destroyTime
        && [`projects/${PROJECT}/secrets/SESSION_SECRET/versions/${version}`,
            `projects/1012884798546/secrets/SESSION_SECRET/versions/${version}`].includes(secret.name),
    'Rollback signing-secret version is not enabled or has the wrong identity');
    return secret;
}

export async function planRollbackDeployment(provider, pins, now = Date.now()) {
    validateSessionTrafficPins(pins);
    await provider.assertAutomationPaused();
    const [service, revisions, existing, secret] = await Promise.all([
        provider.getService(), checkedSessionCandidate(provider, pins),
        provider.getRollbackIfExists(rollbackRevisionName(pins)), checkedSecret(provider, pins.rollback.sessionSecretVersion),
    ]);
    validateService(service);
    checkSessionTraffic(service, pins, 'promote');
    requireThat(existing === null && !service.traffic.some(entry => entry.revision === rollbackRevisionName(pins)),
        'Rollback revision already exists or is referenced; inspect it instead of redeploying');
    const candidateName = sessionRevisionName(pins.candidate.deployment);
    requireThat(service.template.revision === candidateName
        && service.latestReadyRevision === `${SERVICE}/revisions/${candidateName}`
        && service.latestCreatedRevision === service.latestReadyRevision
        && same(service.template.containers, revisions.candidate.containers), 'Deploy the exact reviewed candidate first');
    requireThat(service.launchStage === revisions.baseline.launchStage, 'Service and baseline launch stages differ');
    const template = rollbackTemplate(revisions.baseline, pins);
    requireThat(same(service, await provider.getService()), 'Service changed during rollback planning');
    return { schemaVersion: 1, operation: 'prepare-rollback', createdAt: new Date(now).toISOString(), pins: structuredClone(pins),
        before: { sha256: fingerprint(service), generation: service.generation,
            configurationSha256: fingerprint(unchangedServiceConfiguration(service)), traffic: service.traffic },
        revisionSha256: Object.fromEntries(Object.entries(revisions).map(([name, revision]) => [name, fingerprint(revisionConfiguration(revision))])),
        secretSha256: fingerprint(secret),
        request: { name: SERVICE, etag: service.etag, template } };
}

export function verifyRollbackService(service, plan, settled = false) {
    requireThat(fingerprint(unchangedServiceConfiguration(service)) === plan.before.configurationSha256
        && same(trafficShape(service.traffic), trafficShape(plan.before.traffic)), 'Service configuration or traffic changed during rollback deployment');
    requireThat([plan.before.generation, String(BigInt(plan.before.generation) + 1n)].includes(service.generation),
        'Concurrent service generation change');
    if (!settled) return;
    validateService(service);
    const name = `${SERVICE}/revisions/${rollbackRevisionName(plan.pins)}`;
    requireThat(service.generation === String(BigInt(plan.before.generation) + 1n)
        && service.etag !== plan.request.etag && same(service.template, plan.request.template)
        && service.latestReadyRevision === name && service.latestCreatedRevision === name,
    'Rollback revision did not become the exact Ready template');
}

export async function applyRollbackDeployment(provider, plan, confirmation, now = Date.now()) {
    const started = performance.now();
    requireThat(SHA.test(confirmation) && fingerprint(plan) === confirmation, 'Plan SHA256 confirmation differs');
    keys(plan, ['schemaVersion', 'operation', 'createdAt', 'pins', 'before', 'revisionSha256', 'secretSha256', 'request'], 'Rollback plan');
    const age = now - Date.parse(plan.createdAt);
    requireThat(plan.schemaVersion === 1 && plan.operation === 'prepare-rollback'
        && Number.isFinite(age) && age >= 0 && age <= MAX_PLAN_AGE, 'Plan is stale, future-dated or for another operation');
    const fresh = await planRollbackDeployment(provider, plan.pins, Date.parse(plan.createdAt));
    requireThat(same(plan, fresh), 'Rollback plan drifted; generate and review a new plan');
    await provider.assertAutomationPaused();
    requireThat(age + performance.now() - started <= MAX_PLAN_AGE, 'Rollback plan expired during preflight');
    try {
        const expiresAt = Date.now() + MAX_PLAN_AGE - age - (performance.now() - started);
        await provider.patchRollbackTemplate(plan.request, plan.pins, expiresAt);
        const service = await provider.waitForRollback(plan);
        verifyRollbackService(service, plan, true);
        const [revisions, rollback] = await Promise.all([
            checkedSessionCandidate(provider, plan.pins), provider.getRevision(rollbackRevisionName(plan.pins)),
        ]);
        requireThat(Object.entries(revisions).every(([name, revision]) =>
            fingerprint(revisionConfiguration(revision)) === plan.revisionSha256[name]), 'Existing revision changed during deployment');
        validateSessionRollback(rollback, revisions.baseline, plan.pins);
        await checkedSecret(provider, plan.pins.rollback.sessionSecretVersion);
        await provider.assertAutomationPaused();
        return { revision: rollbackRevisionName(plan.pins), ready: true, percent: 0, tagged: false,
            trafficUnchanged: true, generation: service.generation };
    } catch (error) {
        throw new Error(`Rollback creation attempted; inspect live state before retrying. ${error.message}`);
    }
}

export function createRollbackDeploymentProvider(token, fetcher = fetch) {
    const reads = createSessionCloudProvider(token, fetcher);
    const request = createCloudRequest(token, fetcher);
    const run = (path, method, body, missing) => request('https://run.googleapis.com/v2/', path, method, body, missing);
    const validName = name => requireThat(/^mickeyf-org-session-rollback-[0-9a-f]{32}$/u.test(name), 'Invalid rollback revision name');
    return {
        getService: reads.getService, getRevision: reads.getRevision, getDeployment: reads.getDeployment,
        assertAutomationPaused: reads.assertAutomationPaused,
        getRollbackIfExists: name => { validName(name); return run(`${SERVICE}/revisions/${name}`, 'GET', undefined, true); },
        getSessionSecretVersion: version => {
            validateSessionSecretVersion(version);
            return request('https://secretmanager.googleapis.com/v1/', `projects/${PROJECT}/secrets/SESSION_SECRET/versions/${version}`);
        },
        async patchRollbackTemplate(body, pins, expiresAt) {
            validateSessionTrafficPins(pins);
            keys(body, ['name', 'etag', 'template'], 'Rollback patch');
            requireThat(body.name === SERVICE && typeof body.etag === 'string' && body.etag
                && body.template?.revision === rollbackRevisionName(pins)
                && Object.keys(body.template).every(key => ['revision', ...TEMPLATE_FIELDS].includes(key)), 'Patch exceeds rollback-template authority');
            // Re-read the immutable baseline at the adapter boundary; accept no independently supplied runtime.
            const baseline = await reads.getRevision(pins.baseline.revisionName);
            validateLegacySessionRevision(baseline, pins.baseline, pins.baseline.revisionName);
            requireThat(fingerprint(revisionConfiguration(baseline)) === pins.baseline.configurationSha256, 'Baseline revision drifted');
            requireThat(same(body.template, rollbackTemplate(baseline, pins)), 'Patch is not the exact reviewed rollback template');
            requireThat(Number.isFinite(expiresAt) && Date.now() <= expiresAt, 'Rollback plan expired before the write');
            const operation = await run(`${SERVICE}?updateMask=template`, 'PATCH', body);
            requireThat(new RegExp(`^projects/(?:${PROJECT}|1012884798546)/locations/${REGION}/operations/[^/]+$`).test(operation.name)
                && !operation.error, 'Rollback deployment operation was rejected or malformed');
        },
        async waitForRollback(plan) {
            const deadline = Date.now() + 60_000;
            while (Date.now() < deadline) {
                const service = await reads.getService();
                verifyRollbackService(service, plan);
                requireThat(service.terminalCondition?.state !== 'CONDITION_FAILED', 'Rollback reconciliation failed');
                if (service.generation !== plan.before.generation && !service.reconciling
                    && service.observedGeneration === service.generation) return service;
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
            throw new Error('Rollback reconciliation did not settle within 60 seconds');
        },
    };
}

export async function main(args) {
    const [mode, ...rest] = args;
    if (mode === '--help') {
        console.log('Read-only: plan --pins <traffic-pins.json> --output <new-plan.json>\nDeploy zero-traffic rollback: apply --plan <plan.json> --confirm-plan <sha256> --confirm-create-zero-traffic-rollback');
        return;
    }
    const options = {};
    for (let index = 0; index < rest.length; index++) {
        const key = rest[index];
        requireThat(key.startsWith('--') && !(key in options), 'Invalid or duplicate option');
        options[key] = key === '--confirm-create-zero-traffic-rollback' ? true : rest[++index];
        requireThat(options[key] && !String(options[key]).startsWith('--'), 'Missing option value');
    }
    if (mode === 'plan') {
        keys(options, ['--pins', '--output'], 'Plan arguments');
        const pins = validateSessionTrafficPins(await readJson(options['--pins']));
        const plan = await planRollbackDeployment(createRollbackDeploymentProvider(accessToken()), pins);
        await writeFile(options['--output'], JSON.stringify(plan, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
        console.log(JSON.stringify({ planSha256: fingerprint(plan), revision: plan.request.template.revision, writes: false }));
    } else if (mode === 'apply') {
        keys(options, ['--plan', '--confirm-plan', '--confirm-create-zero-traffic-rollback'], 'Apply arguments');
        const plan = await readJson(options['--plan']);
        requireThat(SHA.test(options['--confirm-plan']) && fingerprint(plan) === options['--confirm-plan'], 'Plan confirmation differs');
        validateSessionTrafficPins(plan.pins);
        console.log(JSON.stringify(await applyRollbackDeployment(createRollbackDeploymentProvider(accessToken()), plan, options['--confirm-plan'])));
    } else throw new Error('Choose plan or apply; no default mutation is permitted.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main(process.argv.slice(2)).catch(error => { console.error(`Rollback deployment refused: ${error.message}`); process.exitCode = 1; });
}
