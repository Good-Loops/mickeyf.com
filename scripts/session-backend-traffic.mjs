// Session-only cutover. SQL, Hosting, secret creation and revision deployment are separate operations.
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { sessionDeploymentApproval, validateSessionPins, validateSessionSecretVersion } from './render-frozen-backend-deploy.mjs';
import { SERVICE, IMAGE, REVISION_TYPE, fingerprint, validatePins, validateDeploymentReceipt,
    validateService, validateSessionRevision, validateLegacySessionRevision, sessionRevisionName,
    serviceConfiguration, revisionConfiguration, trafficShape, createSessionCloudProvider,
    accessToken, readJson } from './frozen-backend-traffic.mjs';

const SHA = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAX_PLAN_AGE = 5 * 60_000;
const fail = message => { throw new Error(message); };
const requireThat = (condition, message) => { if (!condition) fail(message); };
const same = (left, right) => fingerprint(left) === fingerprint(right);
function keys(value, expected, label) {
    requireThat(value !== null && typeof value === 'object' && !Array.isArray(value)
        && same(Object.keys(value).sort(), [...expected].sort()), `${label}: unexpected fields`);
}

export const rollbackRevisionName = pins => `mickeyf-org-session-rollback-${pins.candidate.deployment.sourceBuildId.replaceAll('-', '')}`;
function candidatePins(pins) {
    const source = pins.candidate.deployment;
    return { sourceBuildId: source.sourceBuildId, sourceCommit: source.sourceCommit, imageDigest: source.imageDigest,
        sessionSecretVersion: source.sessionSecretVersion, deploymentBuildId: pins.candidate.receipt.buildId,
        deploymentTriggerId: pins.candidate.receipt.triggerId, deploymentStepsSha256: pins.candidate.receipt.stepsSha256 };
}

export function validateSessionTrafficPins(pins) {
    keys(pins, ['candidate', 'baseline', 'rollback'], 'Session traffic pins');
    keys(pins.candidate, ['deployment', 'receipt'], 'Candidate');
    keys(pins.candidate.receipt, ['buildId', 'triggerId', 'stepsSha256'], 'Deployment receipt');
    validateSessionPins(pins.candidate.deployment);
    requireThat(!pins.candidate.deployment.accountDeletion?.enabled && !pins.candidate.deployment.googleSignIn?.enabled,
        'This legacy rollback is only reviewed for a session-only release with providers/deletion disabled');
    const candidate = validatePins(candidatePins(pins));
    keys(pins.baseline, ['revisionName', 'sourceBuildId', 'sourceCommit', 'imageDigest', 'sessionSecretVersion', 'configurationSha256'], 'Baseline');
    keys(pins.rollback, ['sessionSecretVersion'], 'Rollback');
    validatePins({ ...candidate, sourceBuildId: pins.baseline.sourceBuildId, sourceCommit: pins.baseline.sourceCommit,
        imageDigest: pins.baseline.imageDigest, sessionSecretVersion: pins.baseline.sessionSecretVersion });
    requireThat(typeof pins.baseline.revisionName === 'string' && /^mickeyf-org-[a-z0-9-]{1,51}$/u.test(pins.baseline.revisionName)
        && SHA.test(pins.baseline.configurationSha256), 'Baseline identity/hash is malformed');
    validateSessionSecretVersion(pins.rollback.sessionSecretVersion);
    requireThat(pins.baseline.sessionSecretVersion === pins.candidate.deployment.previousSessionSecretVersion
        && BigInt(pins.rollback.sessionSecretVersion) > BigInt(candidate.sessionSecretVersion),
    'Rollback must use a newer secret than the candidate; the baseline must match the previous version pin');
    requireThat(![sessionRevisionName(candidate), rollbackRevisionName(pins)].includes(pins.baseline.revisionName),
        'Legacy baseline and new revisions must be distinct');
    return pins;
}

function sessionVersion(revision) {
    const entries = revision.containers?.[0]?.env?.filter(entry => entry.name === 'SESSION_SECRET') ?? [];
    requireThat(entries.length === 1, 'Session secret reference is not unique');
    return validateSessionSecretVersion(entries[0].valueSource?.secretKeyRef?.version);
}

// Ignore only platform identity/lifecycle metadata. Unknown runtime fields stay in the comparison.
export function rollbackRuntimeConfiguration(revision) {
    const metadata = new Set(['name', 'uid', 'generation', 'createTime', 'updateTime', 'logUri', 'creator',
        'client', 'clientVersion', 'etag', 'conditions', 'observedGeneration', 'reconciling', 'scalingStatus', 'labels']);
    const runtime = structuredClone(Object.fromEntries(Object.entries(revision).filter(([key]) => !metadata.has(key))));
    for (const container of runtime.containers ?? []) {
        container.env = container.env.map(entry => entry.name === 'SESSION_SECRET'
            ? { name: 'SESSION_SECRET', valueSource: { secretKeyRef: { secret: 'SESSION_SECRET', version: 'ROTATED' } } }
            : entry).sort((left, right) => left.name.localeCompare(right.name));
    }
    return runtime;
}

export async function captureSessionBaseline(provider) {
    await provider.assertAutomationPaused();
    const service = await provider.getService();
    validateService(service);
    const traffic = trafficShape(service.traffic);
    requireThat(traffic.length === 1 && traffic[0].percent === 100 && !traffic[0].tag,
        'Capture requires one explicit serving revision without tags');
    const revision = await provider.getRevision(traffic[0].revision);
    const baseline = { revisionName: traffic[0].revision,
        sourceBuildId: revision.labels?.['source-build-id'], sourceCommit: revision.labels?.['source-commit'],
        imageDigest: revision.containers?.[0]?.image?.slice(IMAGE.length + 1),
        sessionSecretVersion: sessionVersion(revision), configurationSha256: fingerprint(revisionConfiguration(revision)) };
    requireThat(typeof baseline.sourceBuildId === 'string' && UUID.test(baseline.sourceBuildId)
        && /^[0-9a-f]{40}$/u.test(baseline.sourceCommit) && /^sha256:[0-9a-f]{64}$/u.test(baseline.imageDigest),
    'Baseline must have exact source/image provenance');
    validateLegacySessionRevision(revision, baseline, baseline.revisionName);
    requireThat(same(service, await provider.getService()), 'Serving state changed while capturing the baseline');
    return baseline;
}

export async function checkedSessionCandidate(provider, pins) {
    const candidate = candidatePins(pins);
    const [baseline, target, build] = await Promise.all([
        provider.getRevision(pins.baseline.revisionName), provider.getRevision(sessionRevisionName(candidate)),
        provider.getDeployment(candidate.deploymentBuildId),
    ]);
    validateLegacySessionRevision(baseline, pins.baseline, pins.baseline.revisionName);
    requireThat(fingerprint(revisionConfiguration(baseline)) === pins.baseline.configurationSha256, 'Baseline revision drifted');
    validateSessionRevision(target, candidate);
    validateDeploymentReceipt(build, candidate, sessionDeploymentApproval(pins.candidate.deployment));
    return { baseline, candidate: target };
}

export function validateSessionRollback(rollback, baseline, pins) {
    validateLegacySessionRevision(rollback, { ...pins.baseline, sessionSecretVersion: pins.rollback.sessionSecretVersion }, rollbackRevisionName(pins));
    requireThat(same(rollbackRuntimeConfiguration(rollback), rollbackRuntimeConfiguration(baseline)),
        'Rollback must preserve the previous runtime exactly apart from its fresh session-secret reference');
    return rollback;
}

async function checkedRevisions(provider, pins) {
    const [revisions, rollback] = await Promise.all([
        checkedSessionCandidate(provider, pins), provider.getRevision(rollbackRevisionName(pins)),
    ]);
    validateSessionRollback(rollback, revisions.baseline, pins);
    return { ...revisions, rollback };
}

export function checkSessionTraffic(service, pins, operation) {
    const candidate = sessionRevisionName(candidatePins(pins));
    const rollback = rollbackRevisionName(pins);
    const serving = operation === 'promote' ? pins.baseline.revisionName : candidate;
    const compact = pins.candidate.deployment.sourceBuildId.replaceAll('-', '');
    const tags = { [candidate]: `s-${compact}`, [rollback]: `r-${compact}` };
    const traffic = trafficShape(service.traffic);
    requireThat(traffic.filter(item => item.percent > 0).length === 1
        && traffic.some(item => item.revision === serving && item.percent === 100 && !item.tag),
    'Traffic no longer serves the exact reviewed starting revision');
    requireThat(traffic.every(item => item.percent === 100 || item.percent === 0 && tags[item.revision] === item.tag),
        'Traffic contains an unreviewed revision or tag');
}

export async function planSessionTraffic(provider, pins, operation, now = Date.now()) {
    validateSessionTrafficPins(pins);
    requireThat(['promote', 'rollback'].includes(operation), 'Choose promote or rollback explicitly');
    await provider.assertAutomationPaused();
    const [service, revisions] = await Promise.all([provider.getService(), checkedRevisions(provider, pins)]);
    validateService(service);
    checkSessionTraffic(service, pins, operation);
    requireThat([revisions.candidate, revisions.rollback].some(revision => same(service.template.containers, revision.containers)),
        'Service template is not the reviewed candidate or rollback runtime');
    const target = operation === 'promote' ? sessionRevisionName(candidatePins(pins)) : rollbackRevisionName(pins);
    return {
        schemaVersion: 1, operation, createdAt: new Date(now).toISOString(), pins: structuredClone(pins),
        before: { etag: service.etag, generation: service.generation, sha256: fingerprint(service),
            configurationSha256: fingerprint(serviceConfiguration(service)), traffic: service.traffic },
        revisionSha256: Object.fromEntries(Object.entries(revisions).map(([key, revision]) => [key, fingerprint(revisionConfiguration(revision))])),
        desiredTraffic: [{ type: REVISION_TYPE, revision: target, percent: 100 }],
        removeTags: service.traffic.filter(item => item.tag).map(item => item.tag).sort(),
    };
}

export async function applySessionTraffic(provider, plan, confirmation, now = Date.now()) {
    const started = performance.now();
    requireThat(SHA.test(confirmation) && fingerprint(plan) === confirmation, 'Plan SHA256 confirmation differs');
    keys(plan, ['schemaVersion', 'operation', 'createdAt', 'pins', 'before', 'revisionSha256', 'desiredTraffic', 'removeTags'], 'Session plan');
    const age = now - Date.parse(plan.createdAt);
    requireThat(plan.schemaVersion === 1 && Number.isFinite(age) && age >= 0 && age <= MAX_PLAN_AGE, 'Plan is stale or future-dated');
    const fresh = await planSessionTraffic(provider, plan.pins, plan.operation, Date.parse(plan.createdAt));
    requireThat(same(plan, fresh), 'Plan drift detected; generate and review a new plan');
    await provider.assertAutomationPaused();
    requireThat(age + performance.now() - started <= MAX_PLAN_AGE, 'Plan expired during preflight');
    // One conditional traffic mutation only; an ambiguous result never authorizes a retry or rollback.
    try {
        await provider.patchTraffic({ name: SERVICE, etag: plan.before.etag, traffic: plan.desiredTraffic });
        const service = await provider.waitForService(plan);
        validateService(service);
        requireThat(BigInt(service.generation) === BigInt(plan.before.generation) + 1n && service.etag !== plan.before.etag
            && fingerprint(serviceConfiguration(service)) === plan.before.configurationSha256
            && same(trafficShape(service.traffic), trafficShape(plan.desiredTraffic)), 'Unexpected state after traffic change');
        const revisions = await checkedRevisions(provider, plan.pins);
        requireThat(Object.entries(revisions).every(([key, revision]) =>
            fingerprint(revisionConfiguration(revision)) === plan.revisionSha256[key]), 'Revision drift after traffic change');
        await provider.assertAutomationPaused();
        return { operation: plan.operation, revision: plan.desiredTraffic[0].revision,
            percent: 100, tags: [], submissions: 'enabled', generation: service.generation, freshSignInRequired: true };
    } catch (error) {
        fail(`Traffic mutation attempted; inspect live state before any retry or rollback. ${error.message}`);
    }
}

export async function main(args) {
    const [mode, ...rest] = args;
    if (mode === '--help') {
        console.log('Read-only: baseline --output <new.json> OR plan --operation promote|rollback --pins <reviewed.json> --output <new-plan.json>\nTraffic-only write: apply --plan <plan.json> --confirm-plan <sha256> --confirm-session-promotion OR --confirm-session-rollback');
        return;
    }
    const options = {};
    for (let index = 0; index < rest.length; index++) {
        const key = rest[index];
        requireThat(key.startsWith('--') && !(key in options), 'Invalid or duplicate option');
        options[key] = ['--confirm-session-promotion', '--confirm-session-rollback'].includes(key) ? true : rest[++index];
        requireThat(options[key] && !String(options[key]).startsWith('--'), 'Missing option value');
    }
    if (mode === 'baseline') {
        keys(options, ['--output'], 'Baseline arguments');
        const baseline = await captureSessionBaseline(createSessionCloudProvider(accessToken()));
        await writeFile(options['--output'], JSON.stringify(baseline, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
        console.log(JSON.stringify({ baseline, writes: false }));
    } else if (mode === 'plan') {
        keys(options, ['--operation', '--pins', '--output'], 'Plan arguments');
        const pins = validateSessionTrafficPins(await readJson(options['--pins']));
        requireThat(['promote', 'rollback'].includes(options['--operation']), 'Choose promote or rollback explicitly');
        const plan = await planSessionTraffic(createSessionCloudProvider(accessToken()), pins, options['--operation']);
        await writeFile(options['--output'], JSON.stringify(plan, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
        console.log(JSON.stringify({ planSha256: fingerprint(plan), operation: plan.operation, traffic: plan.desiredTraffic, removeTags: plan.removeTags, writes: false }));
    } else if (mode === 'apply') {
        const plan = await readJson(options['--plan']);
        requireThat(['promote', 'rollback'].includes(plan.operation), 'Unknown session operation');
        const confirmationFlag = plan.operation === 'promote' ? '--confirm-session-promotion' : '--confirm-session-rollback';
        keys(options, ['--plan', '--confirm-plan', confirmationFlag], 'Apply arguments');
        requireThat(SHA.test(options['--confirm-plan']) && fingerprint(plan) === options['--confirm-plan'], 'Plan confirmation differs');
        validateSessionTrafficPins(plan.pins);
        console.log(JSON.stringify(await applySessionTraffic(createSessionCloudProvider(accessToken()), plan, options['--confirm-plan'])));
    } else fail('Choose baseline, plan or apply; no default mutation is permitted.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main(process.argv.slice(2)).catch(error => { console.error(`Session traffic refused: ${error.message}`); process.exitCode = 1; });
}
