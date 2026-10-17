// Complete the reviewed provider release with conditional template/traffic writes only.
import { providerReleaseEnvironment } from './provider-release-config.mjs';
import { SERVICE, PROJECT, REGION, IMAGE, REVISION_TYPE, fingerprint, revisionConfiguration, serviceConfiguration,
    sessionRevisionName, validateService, validateProviderRevision, trafficShape, createSessionCloudProvider,
    createCloudRequest } from './frozen-backend-traffic.mjs';
import { validateProviderTrafficPins, checkedProviderCandidate, validateProviderRollback, rollbackRevisionName,
    rollbackRuntimeConfiguration } from './session-backend-traffic.mjs';

const MAX_PLAN_AGE = 300_000;
export const READER_DRAIN_MS = 300_000;
const SHA = /^[0-9a-f]{64}$/u;
const BASE_ENVIRONMENT = ['NODE_ENV', 'CLOUD_SQL_CONNECTION_NAME', 'DB_USER', 'DB_NAME',
    'P4_VEGA_SCORE_SUBMISSIONS_ENABLED', 'THREE_BOSSES_RUN_SUBMISSIONS_ENABLED', 'DB_PASS', 'SESSION_SECRET'];
const TEMPLATE_FIELDS = ['labels', 'annotations', 'scaling', 'timeout', 'serviceAccount', 'containers',
    'volumes', 'maxInstanceRequestConcurrency', 'executionEnvironment', 'sessionAffinity', 'client', 'clientVersion'];
const REVISION_METADATA = ['name', 'uid', 'generation', 'createTime', 'updateTime', 'launchStage', 'service',
    'conditions', 'observedGeneration', 'logUri', 'creator', 'etag', 'reconciling', 'scalingStatus'];
const requireThat = (condition, message) => { if (!condition) throw new Error(message); };
const same = (left, right) => fingerprint(left) === fingerprint(right);
function keys(value, expected, label) {
    requireThat(value && typeof value === 'object' && !Array.isArray(value)
        && same(Object.keys(value).sort(), [...expected].sort()), `${label}: unexpected fields`);
}
export const activeRevisionName = pins => `mickeyf-org-session-active-${pins.closed.candidate.deployment.sourceBuildId.replaceAll('-', '')}`;
export const activeRollbackRevisionName = pins => `mickeyf-org-auth-rollback-${pins.closed.candidate.deployment.sourceBuildId.replaceAll('-', '')}`;

export function validateProviderActivationPins(pins) {
    keys(pins, ['closed', 'activeConfiguration'], 'Activation pins');
    validateProviderTrafficPins(pins.closed);
    requireThat(pins.closed.candidate.deployment.providerRelease.phase === 'prepare', 'Start with the reviewed closed preparation deployment');
    const active = providerReleaseEnvironment(pins.activeConfiguration);
    requireThat(pins.activeConfiguration.phase === 'active' && active.REGISTRATION_GENERAL_AUDIENCE_ENABLED === 'true'
        && active.PARENT_REGISTRATION_CREATION_ENABLED === 'false', 'Activation requires the reviewed general signup bundle with new parent accounts closed');
    return pins;
}

function revisionPins(pins, fallback = false) {
    return { ...pins.closed.candidate.deployment, providerRelease: pins.activeConfiguration,
        sessionSecretVersion: fallback ? pins.closed.rollback.sessionSecretVersion : pins.closed.candidate.deployment.sessionSecretVersion };
}
export function activeRevisionTemplate(closed, pins, fallback = false) {
    validateProviderActivationPins(pins);
    requireThat(Object.keys(closed).every(key => [...TEMPLATE_FIELDS, ...REVISION_METADATA].includes(key)),
        'Closed revision has an unreviewed runtime field');
    const template = structuredClone(Object.fromEntries(Object.entries(closed).filter(([key]) => TEMPLATE_FIELDS.includes(key))));
    template.revision = fallback ? activeRollbackRevisionName(pins) : activeRevisionName(pins);
    const environment = providerReleaseEnvironment(pins.activeConfiguration, fallback);
    const container = template.containers[0];
    container.env = container.env.filter(entry => BASE_ENVIRONMENT.includes(entry.name));
    container.env.find(entry => entry.name === 'SESSION_SECRET').valueSource.secretKeyRef.version = revisionPins(pins, fallback).sessionSecretVersion;
    container.env.push(...Object.entries(environment).map(([name, value]) => ({ name, value })));
    return template;
}
function validateActiveRevision(revision, closed, pins, fallback = false) {
    validateProviderRevision(revision, revisionPins(pins, fallback), fallback ? activeRollbackRevisionName(pins) : activeRevisionName(pins), fallback);
    const expected = { ...structuredClone(closed), ...activeRevisionTemplate(closed, pins, fallback) };
    delete expected.revision;
    requireThat(same(rollbackRuntimeConfiguration(revision), rollbackRuntimeConfiguration(expected)),
        'Active revision changed the reviewed image/runtime beyond provider policy and signing reference');
}
function exactTraffic(service, name) {
    validateService(service);
    requireThat(same(trafficShape(service.traffic), [{ type: REVISION_TYPE, revision: name, percent: 100, tag: '' }]),
        'Expected one exact serving revision at 100 percent without any tags');
}
async function checked(provider, pins, qualifySource = true) {
    validateProviderActivationPins(pins);
    await provider.assertAutomationPaused();
    if (qualifySource) await provider.assertSourceQualified(pins.closed.candidate.deployment);
    const [service, revisions, rollback] = await Promise.all([provider.getService(), checkedProviderCandidate(provider, pins.closed),
        provider.getRevision(rollbackRevisionName(pins.closed))]);
    validateService(service);
    validateProviderRollback(rollback, revisions.candidate, pins.closed);
    return { service, ...revisions, rollback };
}

/** The preparation receipt already binds provenance; recheck mutable source/tag/scan state before cutover. */
export function validateProviderActivationSource(data, pins, now = Date.now()) {
    const build = data.build;
    const source = { url: 'https://github.com/Good-Loops/mickeyf.com.git', revision: pins.sourceCommit };
    const finished = Date.parse(build?.finishTime);
    requireThat(build?.id === pins.sourceBuildId && build.status === 'SUCCESS' && build.projectId === PROJECT
        && build.buildTriggerId === pins.sourceTriggerId && same(build.source?.gitSource, source)
        && same(build.sourceProvenance?.resolvedGitSource, source)
        && build.results?.images?.length === 1 && build.results.images[0].digest === pins.imageDigest
        && build.results.images[0].name === `${IMAGE}:${pins.sourceCommit}`
        && Number.isFinite(finished) && now - finished <= 7_200_000 && finished <= now + 300_000,
        'Source build identity, digest or two-hour freshness gate failed');
    const builds = data.newest?.builds;
    requireThat(Array.isArray(builds) && builds.length > 0 && builds.length <= 2000
        && new Set(builds.map(item => item?.id)).size === builds.length
        && builds.every(item => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(item?.id ?? '')
            && item.buildTriggerId === pins.sourceTriggerId && Number.isFinite(Date.parse(item.createTime))
            && Date.parse(item.createTime) <= now + 300_000), 'Source build listing is incomplete, duplicated or malformed');
    const sourceEntry = builds.find(item => item.id === pins.sourceBuildId);
    requireThat(sourceEntry && sourceEntry.createTime === build.createTime
        && builds.every(item => item.id === pins.sourceBuildId || Date.parse(item.createTime) < Date.parse(sourceEntry.createTime)),
        'Source image is no longer the unique newest build of its dedicated trigger');
    const packageName = `projects/${PROJECT}/locations/${REGION}/repositories/cloud-run-source-deploy/packages/cloud-run-source-deploy`;
    requireThat(data.tag?.name === `${packageName}/tags/${pins.sourceCommit}` && data.tag.version === `${packageName}/versions/${pins.imageDigest}`,
        'Full-SHA image tag no longer points to the reviewed digest');
    requireThat(Array.isArray(data.discoveries) && data.discoveries.length === 1 && Array.isArray(data.vulnerabilities),
        'Artifact Analysis results are missing or ambiguous');
    const resource = `https://${IMAGE}@${pins.imageDigest}`;
    const discovery = data.discoveries[0];
    const body = discovery?.discovery;
    const scanTime = Date.parse(body?.lastScanTime);
    const validOccurrence = item => typeof item?.name === 'string'
        && new RegExp(`^projects/${PROJECT}/locations/${REGION}/occurrences/[0-9a-f-]{36}$`).test(item.name)
        && item.resourceUri === resource;
    requireThat(validOccurrence(discovery) && discovery.kind === 'DISCOVERY'
        && discovery.noteName === `projects/goog-analysis/locations/${REGION}/notes/PACKAGE_VULNERABILITY`
        && body?.analysisStatus === 'FINISHED_SUCCESS' && body.continuousAnalysis === 'ACTIVE'
        && [body.analysisError, body.analysisStatusError].every(value => value === undefined || value === null
            || value === '' || same(value, []) || same(value, {}))
        && Number.isFinite(scanTime) && scanTime <= now + 300_000
        && Array.isArray(body.analysisCompleted?.analysisType)
        && ['OS', 'NPM', 'SECRET'].every(type => body.analysisCompleted.analysisType.includes(type)),
        'Artifact Analysis must have completed successfully with continuous analysis active');
    const severities = ['SEVERITY_UNSPECIFIED', 'MINIMAL', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
    for (const occurrence of data.vulnerabilities) {
        const issue = occurrence?.vulnerability;
        requireThat(validOccurrence(occurrence) && occurrence.kind === 'VULNERABILITY'
            && typeof occurrence.noteName === 'string' && occurrence.noteName.startsWith(`projects/goog-vulnz/locations/${REGION}/notes/`)
            && issue && severities.includes(issue.effectiveSeverity) && Array.isArray(issue.packageIssue) && issue.packageIssue.length > 0,
            'Vulnerability occurrence has an unknown identity or effective severity');
        const levels = [issue.effectiveSeverity, ...issue.packageIssue.map(item => item?.effectiveSeverity)];
        requireThat(levels.every(level => severities.includes(level)), 'Package issue has an unknown effective severity');
        requireThat(!levels.some(level => ['HIGH', 'CRITICAL'].includes(level)), 'Artifact Analysis found HIGH or CRITICAL vulnerabilities');
    }
}
async function checkedSigningVersion(provider, version) {
    const secret = await provider.getSessionSecretVersion(version);
    requireThat(secret?.state === 'ENABLED' && !secret.destroyTime && [`projects/${PROJECT}/secrets/SESSION_SECRET/versions/${version}`,
        `projects/1012884798546/secrets/SESSION_SECRET/versions/${version}`].includes(secret.name), 'Active signing-secret metadata differs');
    return secret;
}

export async function observeProviderReaderBoundary(provider, pins, now = Date.now()) {
    const state = await checked(provider, pins);
    exactTraffic(state.service, sessionRevisionName(pins.closed.candidate.deployment));
    requireThat(same(state.service, await provider.getService()), 'Serving state changed during reader observation');
    return { schemaVersion: 1, operation: 'provider-reader-boundary', observedAt: new Date(now).toISOString(),
        pinsSha256: fingerprint(pins), service: state.service,
        closedRevisionSha256: fingerprint(revisionConfiguration(state.candidate)),
        rollbackRevisionSha256: fingerprint(revisionConfiguration(state.rollback)) };
}
function validateBoundary(boundary, pins, state, now) {
    keys(boundary, ['schemaVersion', 'operation', 'observedAt', 'pinsSha256', 'service', 'closedRevisionSha256', 'rollbackRevisionSha256'], 'Reader boundary');
    requireThat(boundary.schemaVersion === 1 && boundary.operation === 'provider-reader-boundary'
        && boundary.pinsSha256 === fingerprint(pins), 'Reader boundary belongs to a different release');
    exactTraffic(boundary.service, sessionRevisionName(pins.closed.candidate.deployment));
    requireThat(Number.isFinite(Date.parse(boundary.observedAt)) && now - Date.parse(boundary.observedAt) >= READER_DRAIN_MS,
        'Old public requests must drain for the reviewed 300-second request deadline before enabling account creation');
    requireThat(boundary.closedRevisionSha256 === fingerprint(revisionConfiguration(state.candidate))
        && boundary.rollbackRevisionSha256 === fingerprint(revisionConfiguration(state.rollback)), 'Reader revisions changed after observation');
}
function unchangedTemplateService(service) {
    const result = serviceConfiguration(service);
    for (const key of ['template', 'latestReadyRevision', 'latestCreatedRevision']) delete result[key];
    return result;
}
function unchangedTrafficService(service) {
    const result = serviceConfiguration(service);
    // Untagged zero-traffic revisions can retire; this pointer follows the serving revision.
    delete result.latestReadyRevision;
    return result;
}
function expectedServingPointer(service, before, target) {
    return [before.latestReadyRevision, `${SERVICE}/revisions/${target}`].includes(service.latestReadyRevision);
}
function validatePreparedReceipt(receipt, pins, kind) {
    keys(receipt, ['schemaVersion', 'operation', 'plan', 'planSha256', 'after', 'revisionSha256'], 'Preparation receipt');
    requireThat(receipt.schemaVersion === 1 && receipt.operation === 'provider-active-prepared'
        && receipt.planSha256 === fingerprint(receipt.plan) && SHA.test(receipt.revisionSha256)
        && receipt.plan.kind === kind && same(receipt.plan.pins, pins),
        'Preparation receipt does not bind the exact reviewed plan');
    validatePreparationPlan(receipt.plan);
    validateService(receipt.after);
    requireThat(receipt.after.generation === String(BigInt(receipt.plan.before.generation) + 1n)
        && receipt.after.etag !== receipt.plan.before.etag
        && same(receipt.after.template, receipt.plan.request.template)
        && expectedServingPointer(receipt.after, receipt.plan.before, receipt.plan.request.template.revision)
        && receipt.after.latestCreatedRevision === `${SERVICE}/revisions/${receipt.plan.request.template.revision}`
        && same(trafficShape(receipt.after.traffic), trafficShape(receipt.plan.before.traffic))
        && same(unchangedTemplateService(receipt.after), unchangedTemplateService(receipt.plan.before)),
        'Preparation receipt does not prove an exact zero-traffic template deployment');
}
function validatePreparationPlan(plan) {
    keys(plan, ['schemaVersion', 'operation', 'kind', 'createdAt', 'pins', 'boundary', 'fallbackReceipt', 'before', 'revisionSha256', 'request'], 'Active preparation plan');
    validateProviderActivationPins(plan.pins);
    requireThat(plan.schemaVersion === 1 && plan.operation === 'prepare-provider-active' && ['fallback', 'candidate'].includes(plan.kind),
        'Unknown active preparation operation');
    keys(plan.request, ['name', 'etag', 'template'], 'Active template patch');
    requireThat(plan.request.name === SERVICE && plan.request.etag === plan.before.etag
        && plan.request.template.revision === (plan.kind === 'fallback' ? activeRollbackRevisionName(plan.pins) : activeRevisionName(plan.pins)),
        'Active template patch exceeds the reviewed authority');
    requireThat(plan.kind === 'fallback' ? plan.fallbackReceipt === null : plan.fallbackReceipt !== null,
        'Prepare the usable active-policy fallback before the active candidate');
    exactTraffic(plan.before, sessionRevisionName(plan.pins.closed.candidate.deployment));
    const boundary = plan.boundary;
    keys(boundary, ['schemaVersion', 'operation', 'observedAt', 'pinsSha256', 'service', 'closedRevisionSha256', 'rollbackRevisionSha256'], 'Reader boundary');
    exactTraffic(boundary.service, sessionRevisionName(plan.pins.closed.candidate.deployment));
    requireThat(boundary.schemaVersion === 1 && boundary.operation === 'provider-reader-boundary'
        && boundary.pinsSha256 === fingerprint(plan.pins) && Number.isFinite(Date.parse(boundary.observedAt))
        && Number.isFinite(Date.parse(plan.createdAt)) && Date.parse(plan.createdAt) - Date.parse(boundary.observedAt) >= READER_DRAIN_MS
        && boundary.closedRevisionSha256 === plan.revisionSha256.closed && boundary.rollbackRevisionSha256 === plan.revisionSha256.rollback,
        'Preparation receipt lost its exact old-reader drain binding');
    if (plan.kind === 'fallback') requireThat(same(plan.before, boundary.service), 'Fallback preparation changed the drained service');
    else {
        validatePreparedReceipt(plan.fallbackReceipt, plan.pins, 'fallback');
        requireThat(same(plan.fallbackReceipt.plan.boundary, boundary) && same(plan.before, plan.fallbackReceipt.after),
            'Candidate preparation lost its verified fallback receipt');
    }
}

export async function planProviderActiveRevision(provider, pins, boundary, kind, fallbackReceipt = null, now = Date.now()) {
    requireThat(['fallback', 'candidate'].includes(kind), 'Choose fallback or candidate explicitly');
    const state = await checked(provider, pins);
    exactTraffic(state.service, sessionRevisionName(pins.closed.candidate.deployment));
    validateBoundary(boundary, pins, state, now);
    if (kind === 'fallback') {
        requireThat(fallbackReceipt === null && same(state.service, boundary.service), 'Serving state changed since the reader drain observation');
    } else {
        validatePreparedReceipt(fallbackReceipt, pins, 'fallback');
        requireThat(same(fallbackReceipt.plan.boundary, boundary) && same(fallbackReceipt.plan.before, boundary.service)
            && same(state.service, fallbackReceipt.after), 'Fallback receipt or drained service state changed');
        const fallback = await provider.getRevision(activeRollbackRevisionName(pins));
        validateActiveRevision(fallback, state.candidate, pins, true);
        requireThat(fingerprint(revisionConfiguration(fallback)) === fallbackReceipt.revisionSha256, 'Prepared fallback revision drifted');
    }
    const name = kind === 'fallback' ? activeRollbackRevisionName(pins) : activeRevisionName(pins);
    const [existing, secret] = await Promise.all([provider.getActiveRevisionIfExists(name),
        checkedSigningVersion(provider, revisionPins(pins, kind === 'fallback').sessionSecretVersion)]);
    requireThat(existing === null, 'Active revision already exists; inspect its receipt instead of redeploying');
    requireThat(same(state.service, await provider.getService()), 'Service changed during active preparation');
    return { schemaVersion: 1, operation: 'prepare-provider-active', kind, createdAt: new Date(now).toISOString(), pins: structuredClone(pins),
        boundary: structuredClone(boundary), fallbackReceipt: structuredClone(fallbackReceipt), before: state.service,
        revisionSha256: { closed: fingerprint(revisionConfiguration(state.candidate)), rollback: fingerprint(revisionConfiguration(state.rollback)), secret: fingerprint(secret) },
        request: { name: SERVICE, etag: state.service.etag, template: activeRevisionTemplate(state.candidate, pins, kind === 'fallback') } };
}
function freshPlan(plan, confirmation, now) {
    requireThat(SHA.test(confirmation) && fingerprint(plan) === confirmation, 'Plan SHA256 confirmation differs');
    const age = now - Date.parse(plan.createdAt);
    requireThat(Number.isFinite(age) && age >= 0 && age <= MAX_PLAN_AGE, 'Plan is stale or future-dated');
    return age;
}
export async function applyProviderActiveRevision(provider, plan, confirmation, now = Date.now()) {
    const started = performance.now();
    const age = freshPlan(plan, confirmation, now);
    validatePreparationPlan(plan);
    const fresh = await planProviderActiveRevision(provider, plan.pins, plan.boundary, plan.kind, plan.fallbackReceipt, Date.parse(plan.createdAt));
    requireThat(same(plan, fresh), 'Active preparation plan drifted');
    await provider.assertAutomationPaused();
    requireThat(age + performance.now() - started <= MAX_PLAN_AGE, 'Plan expired during preflight');
    try {
        await provider.patchActiveTemplate(plan.request, plan, Date.now() + MAX_PLAN_AGE - age - (performance.now() - started));
        const after = await provider.waitForActiveTemplate(plan);
        const revision = await provider.getRevision(plan.request.template.revision);
        const state = await checked(provider, plan.pins);
        validateActiveRevision(revision, state.candidate, plan.pins, plan.kind === 'fallback');
        const receipt = { schemaVersion: 1, operation: 'provider-active-prepared', plan, planSha256: fingerprint(plan), after,
            revisionSha256: fingerprint(revisionConfiguration(revision)) };
        validatePreparedReceipt(receipt, plan.pins, plan.kind);
        requireThat(same(state.service, after), 'Service changed after active preparation');
        return receipt;
    } catch (error) { throw new Error(`Active template mutation attempted; inspect live state before any retry. ${error.message}`); }
}

export async function planProviderActiveTraffic(provider, receipt, operation, now = Date.now()) {
    const pins = receipt?.plan?.pins;
    validatePreparedReceipt(receipt, pins, 'candidate');
    validatePreparedReceipt(receipt.plan.fallbackReceipt, pins, 'fallback');
    requireThat(['activate', 'close-active'].includes(operation), 'Choose activate or close-active explicitly');
    const state = await checked(provider, pins, operation === 'activate');
    const [active, fallback, signing, fallbackSigning] = await Promise.all([provider.getRevision(activeRevisionName(pins)), provider.getRevision(activeRollbackRevisionName(pins)),
        operation === 'activate' ? checkedSigningVersion(provider, revisionPins(pins).sessionSecretVersion) : null,
        checkedSigningVersion(provider, revisionPins(pins, true).sessionSecretVersion)]);
    validateActiveRevision(active, state.candidate, pins);
    validateActiveRevision(fallback, state.candidate, pins, true);
    requireThat(fingerprint(revisionConfiguration(active)) === receipt.revisionSha256
        && fingerprint(revisionConfiguration(fallback)) === receipt.plan.fallbackReceipt.revisionSha256, 'Prepared active revisions drifted');
    exactTraffic(state.service, operation === 'activate' ? sessionRevisionName(pins.closed.candidate.deployment) : activeRevisionName(pins));
    requireThat(same(state.service.template, receipt.after.template)
        && same(unchangedTrafficService(state.service), unchangedTrafficService(receipt.after))
        && expectedServingPointer(state.service, receipt.after, activeRevisionName(pins)), 'Active service configuration drifted');
    if (operation === 'activate') requireThat(same(state.service, receipt.after), 'Service changed after active preparation');
    else requireThat(state.service.latestReadyRevision === `${SERVICE}/revisions/${activeRevisionName(pins)}`,
        'Active serving pointer does not match the exact serving revision');
    const target = operation === 'activate' ? activeRevisionName(pins) : activeRollbackRevisionName(pins);
    return { schemaVersion: 1, operation, createdAt: new Date(now).toISOString(), receipt, before: state.service,
        revisionSha256: { active: fingerprint(revisionConfiguration(active)), fallback: fingerprint(revisionConfiguration(fallback)),
            closed: fingerprint(revisionConfiguration(state.candidate)), rollback: fingerprint(revisionConfiguration(state.rollback)),
            signing: fingerprint(signing), fallbackSigning: fingerprint(fallbackSigning) },
        request: { name: SERVICE, etag: state.service.etag, traffic: [{ type: REVISION_TYPE, revision: target, percent: 100 }] } };
}
export async function applyProviderActiveTraffic(provider, plan, confirmation, now = Date.now()) {
    const started = performance.now();
    const age = freshPlan(plan, confirmation, now);
    keys(plan, ['schemaVersion', 'operation', 'createdAt', 'receipt', 'before', 'revisionSha256', 'request'], 'Active traffic plan');
    requireThat(plan.schemaVersion === 1, 'Unknown active traffic schema');
    const fresh = await planProviderActiveTraffic(provider, plan.receipt, plan.operation, Date.parse(plan.createdAt));
    requireThat(same(plan, fresh), 'Active traffic plan drifted');
    await provider.assertAutomationPaused();
    requireThat(age + performance.now() - started <= MAX_PLAN_AGE, 'Plan expired during preflight');
    try {
        await provider.patchActiveTraffic(plan.request, plan, Date.now() + MAX_PLAN_AGE - age - (performance.now() - started));
        const after = await provider.waitForActiveTraffic(plan);
        exactTraffic(after, plan.request.traffic[0].revision);
        requireThat(after.generation === String(BigInt(plan.before.generation) + 1n) && after.etag !== plan.before.etag
            && same(unchangedTrafficService(after), unchangedTrafficService(plan.before))
            && after.latestReadyRevision === `${SERVICE}/revisions/${plan.request.traffic[0].revision}`, 'Unexpected service state after active traffic change');
        const pins = plan.receipt.plan.pins;
        const state = await checked(provider, pins, plan.operation === 'activate');
        const [active, fallback] = await Promise.all([provider.getRevision(activeRevisionName(pins)), provider.getRevision(activeRollbackRevisionName(pins))]);
        validateActiveRevision(active, state.candidate, pins);
        validateActiveRevision(fallback, state.candidate, pins, true);
        requireThat(same(state.service, after) && fingerprint(revisionConfiguration(active)) === plan.revisionSha256.active
            && fingerprint(revisionConfiguration(fallback)) === plan.revisionSha256.fallback, 'Revision or service drift after traffic change');
        return { operation: plan.operation, revision: plan.request.traffic[0].revision, percent: 100, tags: [],
            generation: after.generation, freshSignInRequired: plan.operation === 'close-active' };
    } catch (error) { throw new Error(`Active traffic mutation attempted; inspect live state before any retry or rollback. ${error.message}`); }
}

export function createProviderActivationCloudProvider(token, fetcher = fetch) {
    const reads = createSessionCloudProvider(token, fetcher);
    const request = createCloudRequest(token, fetcher);
    const run = (path, method, body, missing) => request('https://run.googleapis.com/v2/', path, method, body, missing);
    const provider = {
        ...reads,
        async assertSourceQualified(pins) {
            const packageName = `projects/${PROJECT}/locations/${REGION}/repositories/cloud-run-source-deploy/packages/cloud-run-source-deploy`;
            const [build, newest, tag, discoveries, vulnerabilities] = await Promise.all([
                reads.getDeployment(pins.sourceBuildId),
                listSourceBuilds(pins),
                request('https://artifactregistry.googleapis.com/v1/', `${packageName}/tags/${pins.sourceCommit}`),
                occurrences('DISCOVERY', pins), occurrences('VULNERABILITY', pins),
            ]);
            validateProviderActivationSource({ build, newest, tag, discoveries, vulnerabilities }, pins);
        },
        getActiveRevisionIfExists(name) {
            requireThat(/^mickeyf-org-(?:session-active|auth-rollback)-[0-9a-f]{32}$/u.test(name), 'Invalid active revision name');
            return run(`${SERVICE}/revisions/${name}`, 'GET', undefined, true);
        },
        getSessionSecretVersion(version) {
            requireThat(/^[1-9][0-9]*$/u.test(version), 'Invalid signing version');
            return request('https://secretmanager.googleapis.com/v1/', `projects/${PROJECT}/secrets/SESSION_SECRET/versions/${version}`);
        },
        async patchActiveTemplate(body, plan, expiresAt) {
            validatePreparationPlan(plan);
            requireThat(same(body, plan.request), 'Template patch differs from its exact plan');
            const fresh = await planProviderActiveRevision(provider, plan.pins, plan.boundary, plan.kind, plan.fallbackReceipt, Date.parse(plan.createdAt));
            requireThat(same(fresh, plan), 'Active template adapter detected plan drift');
            await provider.assertAutomationPaused();
            requireThat(Number.isFinite(expiresAt) && Date.now() <= expiresAt, 'Plan expired before template write');
            await patch('template', body);
        },
        async patchActiveTraffic(body, plan, expiresAt) {
            const fresh = await planProviderActiveTraffic(provider, plan.receipt, plan.operation, Date.parse(plan.createdAt));
            requireThat(same(fresh, plan) && same(body, plan.request), 'Active traffic adapter detected plan drift');
            await provider.assertAutomationPaused();
            requireThat(Number.isFinite(expiresAt) && Date.now() <= expiresAt, 'Plan expired before traffic write');
            await patch('traffic', body);
        },
        waitForActiveTemplate: plan => wait(plan, true),
        waitForActiveTraffic: plan => wait(plan, false),
    };
    async function listSourceBuilds(pins) {
        const builds = [], tokens = new Set();
        let pageToken = '';
        for (let page = 0; page < 20; page++) {
            const result = await request('https://cloudbuild.googleapis.com/v1/',
                `projects/${PROJECT}/locations/global/builds?pageSize=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`);
            requireThat(Object.keys(result).every(key => ['builds', 'nextPageToken'].includes(key))
                && (result.builds === undefined || Array.isArray(result.builds)), 'Malformed source build listing');
            builds.push(...result.builds ?? []);
            if (!result.nextPageToken) {
                requireThat(builds.length <= 2000 && new Set(builds.map(item => item?.id)).size === builds.length
                    && builds.every(item => item && typeof item === 'object' && !Array.isArray(item)
                        && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(item.id ?? '')
                        && Number.isFinite(Date.parse(item.createTime))), 'Global source build listing is duplicated or malformed');
                // The REST API does not support gcloud's client-side trigger filter or sort options.
                return { builds: builds.filter(item => item.buildTriggerId === pins.sourceTriggerId) };
            }
            requireThat(typeof result.nextPageToken === 'string' && result.nextPageToken.length <= 8192 && !tokens.has(result.nextPageToken),
                'Invalid source build pagination token');
            pageToken = result.nextPageToken; tokens.add(pageToken);
        }
        throw new Error('Source build pagination limit exceeded; newest build cannot be proved');
    }
    async function occurrences(kind, pins) {
        const filter = encodeURIComponent(`kind="${kind}" AND resourceUrl="https://${IMAGE}@${pins.imageDigest}"`);
        const values = [], tokens = new Set();
        let pageToken = '';
        for (let page = 0; page < 100; page++) {
            const response = await request('https://containeranalysis.googleapis.com/v1/',
                `projects/${PROJECT}/locations/${REGION}/occurrences?filter=${filter}&pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`);
            requireThat(Object.keys(response).every(key => ['occurrences', 'nextPageToken'].includes(key))
                && (response.occurrences === undefined || Array.isArray(response.occurrences)), 'Malformed Artifact Analysis page');
            values.push(...response.occurrences ?? []);
            if (!response.nextPageToken) return values;
            requireThat(typeof response.nextPageToken === 'string' && response.nextPageToken.length <= 8192 && !tokens.has(response.nextPageToken),
                'Invalid Artifact Analysis pagination token');
            pageToken = response.nextPageToken; tokens.add(pageToken);
        }
        throw new Error('Artifact Analysis pagination limit exceeded');
    }
    async function patch(mask, body) {
        const operation = await run(`${SERVICE}?updateMask=${mask}`, 'PATCH', body);
        requireThat(new RegExp(`^projects/(?:${PROJECT}|1012884798546)/locations/${REGION}/operations/[^/]+$`).test(operation.name)
            && !operation.error, 'Active deployment operation was rejected or malformed');
    }
    async function wait(plan, template) {
        const deadline = Date.now() + 60_000;
        while (Date.now() < deadline) {
            const service = await provider.getService();
            requireThat([plan.before.generation, String(BigInt(plan.before.generation) + 1n)].includes(service.generation), 'Concurrent service generation change');
            requireThat(template ? same(unchangedTemplateService(service), unchangedTemplateService(plan.before))
                && same(trafficShape(service.traffic), trafficShape(plan.before.traffic))
                : same(unchangedTrafficService(service), unchangedTrafficService(plan.before))
                    && expectedServingPointer(service, plan.before, plan.request.traffic[0].revision), 'Service drift during active reconciliation');
            requireThat(service.terminalCondition?.state !== 'CONDITION_FAILED', 'Active reconciliation failed');
            if (service.generation !== plan.before.generation && !service.reconciling && service.observedGeneration === service.generation) return service;
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        throw new Error('Active reconciliation did not settle within 60 seconds');
    }
    return provider;
}
