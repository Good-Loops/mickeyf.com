// Deliberately separate from the enabled main-branch deployment path.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { accountDeletionEnvironment, googleSignInEnvironment, validateSessionSecretVersion,
    frozenDeploymentApproval } from './render-frozen-backend-deploy.mjs';

export const PROJECT = 'noted-reef-387021';
export const REGION = 'us-central1';
export const SERVICE = `projects/${PROJECT}/locations/${REGION}/services/mickeyf-org`;
export const IMAGE = `${REGION}-docker.pkg.dev/${PROJECT}/cloud-run-source-deploy/cloud-run-source-deploy`;
export const REVISION_TYPE = 'TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION';
const DEPLOY_SA = `projects/${PROJECT}/serviceAccounts/mickeyf-backend-deploy@${PROJECT}.iam.gserviceaccount.com`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const ACTIVE_BUILD_FILTER = 'status="PENDING" OR status="QUEUED" OR status="WORKING"';
const MAX_PLAN_AGE = 5 * 60_000;
const fail = message => { throw new Error(message); };
const requireThat = (condition, message) => { if (!condition) fail(message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sorted = value => Array.isArray(value) ? value.map(sorted) : object(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
export const fingerprint = value => createHash('sha256').update(JSON.stringify(sorted(value))).digest('hex');
const same = (a, b) => fingerprint(a) === fingerprint(b);
function keys(value, expected, label) {
    requireThat(object(value) && same(Object.keys(value).sort(), [...expected].sort()), `${label}: unexpected fields`);
}

export function validatePins(pins) {
    const { accountDeletion, googleSignIn, ...sourcePins } = pins ?? {};
    keys(sourcePins, ['sourceBuildId', 'sourceCommit', 'imageDigest', 'deploymentBuildId',
        'deploymentTriggerId', 'deploymentStepsSha256', 'sessionSecretVersion'], 'Pins');
    requireThat(Object.values(sourcePins).every(value => typeof value === 'string'), 'All source pins must be strings');
    validateSessionSecretVersion(pins.sessionSecretVersion);
    accountDeletionEnvironment(accountDeletion);
    googleSignInEnvironment(googleSignIn, accountDeletion);
    for (const key of ['sourceBuildId', 'deploymentBuildId', 'deploymentTriggerId']) {
        requireThat(UUID.test(pins[key]), `Invalid ${key}`);
    }
    requireThat(/^[0-9a-f]{40}$/.test(pins.sourceCommit), 'Invalid source commit');
    requireThat(/^sha256:[0-9a-f]{64}$/.test(pins.imageDigest), 'Invalid image digest');
    requireThat(SHA.test(pins.deploymentStepsSha256), 'Invalid reviewed deployment steps digest');
    return pins;
}
export const revisionName = pins => `mickeyf-org-freeze-${pins.sourceBuildId.replaceAll('-', '')}`;

// Hash the reviewed CONFIG, not timing/status fields added by Cloud Build.
export function deploymentStepsFingerprint(steps) {
    requireThat(Array.isArray(steps) && steps.length > 0, 'Missing deployment steps');
    const outputFields = new Set(['status', 'timing', 'pullTiming', 'exitCode']);
    return fingerprint(steps.map(step => Object.fromEntries(
        Object.entries(step).filter(([key]) => !outputFields.has(key)))));
}
export function validateDeployment(build, pins) {
    requireThat(build.id === pins.deploymentBuildId && build.projectId === PROJECT
        && build.buildTriggerId === pins.deploymentTriggerId
        && [DEPLOY_SA, DEPLOY_SA.replace(`projects/${PROJECT}/`, 'projects/-/')].includes(build.serviceAccount)
        && build.status === 'SUCCESS' && build.approval?.config?.approvalRequired === true
        && build.approval?.state === 'APPROVED'
        && build.approval?.result?.decision === 'APPROVED', 'Frozen deployment is not approved and successful');
    requireThat(['source', 'images', 'artifacts', 'availableSecrets', 'secrets', 'dependencies'].every(key =>
        build[key] === undefined || (object(build[key]) || Array.isArray(build[key])) && Object.keys(build[key]).length === 0),
    'Frozen deployment must be source-less and have no extra execution inputs');
    const options = build.options;
    requireThat(object(options) && options.logging === 'CLOUD_LOGGING_ONLY'
        && Object.keys(options).every(key => ['logging', 'substitutionOption', 'dynamicSubstitutions', 'pool'].includes(key))
        && (options.substitutionOption === undefined || options.substitutionOption === 'ALLOW_LOOSE')
        && (options.dynamicSubstitutions === undefined || options.dynamicSubstitutions === true)
        && (options.pool === undefined || same(options.pool, {})) && build.timeout === '2400s',
    'Unreviewed deployment execution options');
    requireThat(build.substitutions?._DEPLOY_TRIGGER_ID === pins.deploymentTriggerId
        && build.substitutions?._APPROVAL === frozenDeploymentApproval(pins),
    'Deployment substitution approval differs from the pinned source, image or session-secret version');
    requireThat(deploymentStepsFingerprint(build.steps) === pins.deploymentStepsSha256
        && build.steps.every(step => step.status === 'SUCCESS' && (step.exitCode ?? 0) === 0
            && !step.allowFailure && !step.allowExitCodes?.length), 'Deployment steps differ from the offline reviewed config');
}

export function validateFrozenRevision(revision, pins) {
    const sessionSecretVersion = validateSessionSecretVersion(pins.sessionSecretVersion);
    requireThat(revision.name === `${SERVICE}/revisions/${revisionName(pins)}`
        && revision.service === 'mickeyf-org' && revision.uid && !revision.deleteTime && !revision.reconciling
        && revision.conditions?.some(c => c.type === 'Ready' && c.state === 'CONDITION_SUCCEEDED'), 'Frozen revision is not Ready');
    requireThat(revision.labels?.['source-build-id'] === pins.sourceBuildId
        && revision.labels?.['source-commit'] === pins.sourceCommit, 'Revision source identity differs');
    requireThat(revision.serviceAccount === `mickeyf-runtime@${PROJECT}.iam.gserviceaccount.com`
        && revision.maxInstanceRequestConcurrency === 80 && revision.timeout === '300s'
        && revision.scaling?.maxInstanceCount === 10 && !revision.vpcAccess
        && !revision.serviceMesh && !revision.encryptionKey, 'Frozen runtime configuration differs');
    requireThat(revision.containers?.length === 1, 'Exactly one container required');
    const container = revision.containers[0];
    requireThat(container.image === `${IMAGE}@${pins.imageDigest}`
        && !container.command?.length && !container.args?.length
        && container.ports?.length === 1 && container.ports[0].containerPort === 8080
        && container.ports[0].name !== 'h2c' && !container.livenessProbe
        && ['1', '1000m'].includes(container.resources?.limits?.cpu)
        && container.resources?.limits?.memory === '512Mi'
        && container.resources?.startupCpuBoost === true, 'Frozen container configuration differs');
    const expectedPlain = {
        NODE_ENV: 'production', CLOUD_SQL_CONNECTION_NAME: `${PROJECT}:${REGION}:cms-mickeyf`,
        DB_USER: 'cms_mickeyf', DB_NAME: 'cms',
        P4_VEGA_SCORE_SUBMISSIONS_ENABLED: 'false', THREE_BOSSES_RUN_SUBMISSIONS_ENABLED: 'false',
        ...accountDeletionEnvironment(pins.accountDeletion),
        ...googleSignInEnvironment(pins.googleSignIn, pins.accountDeletion),
    };
    const expectedCount = Object.keys(expectedPlain).length + 2;
    requireThat(container.env?.length === expectedCount && new Set(container.env.map(e => e.name)).size === expectedCount, 'Unexpected environment variables');
    for (const [name, value] of Object.entries(expectedPlain)) {
        requireThat(same(container.env.find(e => e.name === name), { name, value }), `Frozen environment differs: ${name}`);
    }
    for (const [name, version] of [['DB_PASS', '1'], ['SESSION_SECRET', sessionSecretVersion]]) {
        const env = container.env.find(e => e.name === name);
        const reference = env?.valueSource?.secretKeyRef;
        requireThat(env && !('value' in env) && reference?.version === version
            && [name, `projects/${PROJECT}/secrets/${name}`, `projects/1012884798546/secrets/${name}`].includes(reference?.secret),
        `Secret reference differs: ${name}`);
    }
    requireThat(same(container.startupProbe, {
        timeoutSeconds: 240, periodSeconds: 240, failureThreshold: 1, tcpSocket: { port: 8080 },
    }), 'Startup probe differs');
    const volume = revision.volumes?.[0];
    requireThat(revision.volumes?.length === 1 && volume.name
        && same(volume.cloudSqlInstance, { instances: [`${PROJECT}:${REGION}:cms-mickeyf`] })
        && same(container.volumeMounts, [{ name: volume.name, mountPath: '/cloudsql' }]), 'Cloud SQL attachment differs');
    return revision;
}

function trafficShape(items, statuses = false) {
    requireThat(Array.isArray(items) && items.length > 0, 'Missing explicit traffic');
    const tags = new Set();
    const result = items.map(item => {
        requireThat(object(item) && Object.keys(item).every(k => ['type', 'revision', 'percent', 'tag', ...(statuses ? ['uri'] : [])].includes(k))
            && item.type === REVISION_TYPE && /^mickeyf-org-[a-z0-9-]+$/.test(item.revision)
            && Number.isInteger(item.percent ?? 0) && (item.percent ?? 0) >= 0 && (item.percent ?? 0) <= 100,
        'Traffic is malformed, unresolved, or uses LATEST');
        if (item.tag) {
            requireThat(/^[a-z][a-z0-9-]{0,62}$/.test(item.tag) && !tags.has(item.tag), 'Duplicate or invalid traffic tag');
            tags.add(item.tag);
        }
        return { type: item.type, revision: item.revision, percent: item.percent ?? 0, tag: item.tag ?? '' };
    });
    requireThat(result.reduce((sum, item) => sum + item.percent, 0) === 100, 'Traffic does not total 100 percent');
    return result.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
export function validateService(service) {
    requireThat(service.name === SERVICE && service.uid && !service.deleteTime && !service.reconciling
        && service.terminalCondition?.type === 'Ready' && service.terminalCondition?.state === 'CONDITION_SUCCEEDED'
        && typeof service.generation === 'string' && /^[1-9][0-9]*$/.test(service.generation)
        && service.observedGeneration === service.generation && typeof service.etag === 'string' && service.etag
        && object(service.template) && service.latestReadyRevision && service.latestCreatedRevision, 'Service is not stable and Ready');
    requireThat(same(trafficShape(service.traffic), trafficShape(service.trafficStatuses, true)), 'Traffic has not resolved');
}

// Output-only fields can settle after a traffic PATCH; all configuration must stay unchanged.
function serviceConfiguration(service) {
    const volatile = new Set(['generation', 'observedGeneration', 'etag', 'updateTime', 'lastModifier', 'traffic',
        'trafficStatuses', 'conditions', 'terminalCondition', 'reconciling', 'urls']);
    return Object.fromEntries(Object.entries(service).filter(([key]) => !volatile.has(key)));
}
function revisionConfiguration(revision) {
    return Object.fromEntries(Object.entries(revision).filter(([key]) =>
        !['scalingStatus', 'conditions', 'observedGeneration', 'etag', 'updateTime', 'reconciling'].includes(key)));
}

function checkPreviousDeletionState(containers, pins) {
    requireThat(containers?.length === 1, 'Active deletion state requires one container');
    const names = ['ACCOUNT_DELETION_ENABLED', 'ACCOUNT_DELETION_JOURNAL_BUCKET', 'ACCOUNT_IDENTITY_EPOCH'];
    const entries = (containers[0].env ?? []).filter(item => names.includes(item.name));
    requireThat(new Set(entries.map(item => item.name)).size === entries.length
        && entries.every(item => same(Object.keys(item).sort(), ['name', 'value'])), 'Active deletion settings are not unique literal values');
    const previous = Object.fromEntries(entries.map(item => [item.name, item.value]));
    requireThat(['false', 'true'].includes(previous.ACCOUNT_DELETION_ENABLED ?? 'false'), 'Unknown active deletion state');
    if (previous.ACCOUNT_DELETION_ENABLED !== 'true') return;
    accountDeletionEnvironment({ enabled: true, journalBucket: previous.ACCOUNT_DELETION_JOURNAL_BUCKET,
        identityEpoch: previous.ACCOUNT_IDENTITY_EPOCH });
    requireThat(pins.accountDeletion !== undefined, 'Default-off would disable active deletion; explicitly review enable or disable in the traffic pins');
}

function checkPreviousGoogleState(containers, pins) {
    requireThat(containers?.length === 1, 'Active Google state requires one container');
    const names = ['PROVIDER_AUTH_ENABLED', 'PROVIDER_GOOGLE_SIGNUP_ENABLED', 'GOOGLE_WEB_CLIENT_ID'];
    const entries = (containers[0].env ?? []).filter(item => /^(?:PROVIDER_|GOOGLE_|APPLE_)/u.test(item.name));
    requireThat(entries.every(item => names.includes(item.name)
        && same(Object.keys(item).sort(), ['name', 'value']))
        && new Set(entries.map(item => item.name)).size === entries.length,
    'Active provider settings are unsupported, duplicated or not literal values');
    const previous = Object.fromEntries(entries.map(item => [item.name, item.value]));
    const enabled = previous.PROVIDER_AUTH_ENABLED ?? 'false';
    const signup = previous.PROVIDER_GOOGLE_SIGNUP_ENABLED ?? 'false';
    requireThat(['false', 'true'].includes(enabled) && ['false', 'true'].includes(signup), 'Unknown active Google state');
    if (enabled === 'false') {
        requireThat(signup === 'false' && previous.GOOGLE_WEB_CLIENT_ID === undefined, 'Inactive Google settings are inconsistent');
        return;
    }
    requireThat(signup === 'true', 'Active Google configuration is not the reviewed full signup/login contract');
    const deletion = Object.fromEntries((containers[0].env ?? []).map(item => [item.name, item.value]));
    requireThat(deletion.ACCOUNT_DELETION_ENABLED === 'true', 'Active Google signup requires account deletion');
    googleSignInEnvironment({ enabled: true, clientId: previous.GOOGLE_WEB_CLIENT_ID }, {
        enabled: true, journalBucket: deletion.ACCOUNT_DELETION_JOURNAL_BUCKET, identityEpoch: deletion.ACCOUNT_IDENTITY_EPOCH,
    });
    requireThat(pins.googleSignIn !== undefined,
        'Default-off would disable active Google sign-in; explicitly review enable or disable in the traffic pins');
}

async function checkedState(provider, pins) {
    validatePins(pins);
    await provider.assertAutomationPaused();
    const [service, revision, build] = await Promise.all([
        provider.getService(), provider.getRevision(revisionName(pins)), provider.getDeployment(pins.deploymentBuildId),
    ]);
    validateService(service);
    validateFrozenRevision(revision, pins);
    validateDeployment(build, pins);
    checkPreviousDeletionState(service.template.containers, pins);
    checkPreviousGoogleState(service.template.containers, pins);
    const active = new Set(service.traffic.filter(item => item.tag || item.percent > 0).map(item => item.revision));
    for (const name of active) {
        const previous = name === revisionName(pins) ? revision : await provider.getRevision(name);
        requireThat(previous.name === `${SERVICE}/revisions/${name}` && !previous.deleteTime, 'Active revision inventory differs');
        checkPreviousDeletionState(previous.containers, pins);
        checkPreviousGoogleState(previous.containers, pins);
    }
    return { service, revision };
}
export async function planFrozenTraffic(provider, pins, now = Date.now()) {
    const { service, revision } = await checkedState(provider, pins);
    return {
        schemaVersion: 1, createdAt: new Date(now).toISOString(), pins: structuredClone(pins),
        before: { etag: service.etag, generation: service.generation, sha256: fingerprint(service),
            configurationSha256: fingerprint(serviceConfiguration(service)), traffic: service.traffic },
        targetRevisionSha256: fingerprint(revisionConfiguration(revision)),
        desiredTraffic: [{ type: REVISION_TYPE, revision: revisionName(pins), percent: 100 }],
        removeTags: service.traffic.filter(t => t.tag).map(t => t.tag).sort(),
    };
}
export async function applyFrozenTraffic(provider, plan, confirmation, now = Date.now()) {
    const started = performance.now();
    requireThat(SHA.test(confirmation) && fingerprint(plan) === confirmation, 'Plan SHA256 confirmation differs');
    keys(plan, ['schemaVersion', 'createdAt', 'pins', 'before', 'targetRevisionSha256', 'desiredTraffic', 'removeTags'], 'Plan');
    const age = now - Date.parse(plan.createdAt);
    requireThat(plan.schemaVersion === 1 && Number.isFinite(age) && age >= 0 && age <= MAX_PLAN_AGE, 'Plan is stale or future-dated');
    const fresh = await planFrozenTraffic(provider, plan.pins, Date.parse(plan.createdAt));
    requireThat(same(plan, fresh), 'Plan drift detected; generate and review a new plan');
    await provider.assertAutomationPaused();
    requireThat(age + performance.now() - started <= MAX_PLAN_AGE, 'Plan expired during preflight; generate a new plan');
    // This is the ONLY mutation. Never recompute authority or retry after a conflict/ambiguous response.
    try {
        await provider.patchTraffic({ name: SERVICE, etag: plan.before.etag, traffic: plan.desiredTraffic });
        const result = await provider.waitForService(plan);
        validateService(result);
        requireThat(BigInt(result.generation) === BigInt(plan.before.generation) + 1n
            && result.etag !== plan.before.etag
            && fingerprint(serviceConfiguration(result)) === plan.before.configurationSha256
            && same(trafficShape(result.traffic), trafficShape(plan.desiredTraffic)), 'Unexpected state after traffic change');
        const revision = validateFrozenRevision(await provider.getRevision(revisionName(plan.pins)), plan.pins);
        requireThat(fingerprint(revisionConfiguration(revision)) === plan.targetRevisionSha256, 'Target revision changed after traffic mutation');
        await provider.assertAutomationPaused();
        return { revision: revisionName(plan.pins), percent: 100, tags: [], submissions: 'frozen', generation: result.generation };
    } catch (error) {
        fail(`Traffic mutation attempted; do not retry or migrate until live state is inspected. ${error.message}`);
    }
}

export function createCloudProvider(token, fetcher = fetch) {
    requireThat(typeof token === 'string' && token.length >= 20 && token.length <= 8192 && !/\s/.test(token), 'Access token unavailable');
    async function request(base, path, method = 'GET', body) {
        const response = await fetcher(`${base}${path}`, {
            method, redirect: 'error', signal: AbortSignal.timeout(30_000),
            headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
            ...(body ? { body: JSON.stringify(body) } : {}),
        });
        requireThat(response.ok, `Cloud API ${method} returned HTTP ${response.status}`);
        const reader = response.body.getReader();
        const chunks = [];
        let size = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > 16 * 1024 * 1024) { await reader.cancel(); fail('Cloud API response too large'); }
            chunks.push(Buffer.from(value));
        }
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        requireThat(object(value), 'Cloud API returned non-object JSON');
        return value;
    }
    const run = (path, method, body) => request('https://run.googleapis.com/v2/', path, method, body);
    const builds = path => request('https://cloudbuild.googleapis.com/v1/', path);
    async function listAll(path, field) {
        const values = [];
        let pageToken = '';
        const seen = new Set();
        for (let page = 0; page < 20; page++) {
            const separator = path.includes('?') ? '&' : '?';
            const result = await builds(`${path}${separator}pageSize=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`);
            requireThat(result[field] === undefined || Array.isArray(result[field]), 'Malformed Cloud Build list');
            values.push(...(result[field] ?? []));
            if (!result.nextPageToken) return values;
            requireThat(typeof result.nextPageToken === 'string' && !seen.has(result.nextPageToken), 'Invalid pagination token');
            pageToken = result.nextPageToken;
            seen.add(pageToken);
        }
        fail('Cloud Build pagination limit exceeded');
    }
    return {
        getService: () => run(SERVICE),
        getRevision: name => {
            // Reading existing service revisions is needed to reject silent deletion downgrades.
            requireThat(/^mickeyf-org-[a-z0-9-]+$/.test(name), 'Invalid revision name');
            return run(`${SERVICE}/revisions/${name}`);
        },
        getDeployment: id => { requireThat(UUID.test(id), 'Invalid deployment ID'); return builds(`projects/${PROJECT}/locations/global/builds/${id}`); },
        async assertAutomationPaused() {
            // These are the project's supported build regions. Any future region requires review here.
            const triggers = [];
            for (const region of ['global', REGION]) {
                const parent = `projects/${PROJECT}/locations/${region}`;
                triggers.push(...await listAll(`${parent}/triggers`, 'triggers'));
                const active = await listAll(`${parent}/builds?filter=${encodeURIComponent(ACTIVE_BUILD_FILTER)}`, 'builds');
                requireThat(active.length === 0, 'Cloud Build is still active; drain it before traffic changes');
            }
            requireThat(['ef5a2981-95be-4f4d-af91-f997fde73356', 'd71109da-8350-4f2f-a3be-2053bb6ccd45']
                .every(id => triggers.some(t => t.id === id)), 'Canonical trigger inventory incomplete');
            requireThat(triggers.every(t => t.disabled === true), 'All project build triggers must be paused for this cutover');
        },
        async patchTraffic(body) {
            keys(body, ['name', 'etag', 'traffic'], 'Traffic patch');
            requireThat(body.name === SERVICE && body.etag && body.traffic.length === 1
                && body.traffic[0].percent === 100 && body.traffic[0].type === REVISION_TYPE
                && /^mickeyf-org-freeze-[0-9a-f]{32}$/.test(body.traffic[0].revision)
                && Object.keys(body.traffic[0]).length === 3, 'Patch exceeds frozen traffic-only authority');
            const operation = await run(`${SERVICE}?updateMask=traffic`, 'PATCH', body);
            requireThat(new RegExp(`^projects/(?:${PROJECT}|1012884798546)/locations/${REGION}/operations/[^/]+$`).test(operation.name)
                && !operation.error, 'Traffic operation was rejected or malformed');
        },
        async waitForService(plan) {
            const deadline = Date.now() + 60_000;
            while (Date.now() < deadline) {
                const service = await run(SERVICE);
                const generation = service.generation;
                requireThat(generation === plan.before.generation
                    || generation === String(BigInt(plan.before.generation) + 1n), 'Concurrent generation change');
                requireThat(fingerprint(serviceConfiguration(service)) === plan.before.configurationSha256,
                    'Service configuration drifted during traffic reconciliation');
                if (generation !== plan.before.generation && !service.reconciling
                    && service.observedGeneration === generation) return service;
                if (service.terminalCondition?.state === 'CONDITION_FAILED') fail('Traffic reconciliation failed');
                await new Promise(resolve => setTimeout(resolve, 1_000));
            }
            fail('Traffic reconciliation did not settle within the bounded wait');
        },
    };
}

function accessToken() {
    try {
        // Fixed command only; no user data is passed through a shell.
        return process.platform === 'win32'
            ? execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'gcloud.cmd auth print-access-token'], { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
            : execFileSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    } catch { fail('Could not obtain a short-lived gcloud access token'); }
}
async function readJson(path) {
    const raw = await readFile(path, 'utf8');
    requireThat(raw.length <= 1024 * 1024, 'Input JSON exceeds size limit');
    return JSON.parse(raw);
}
export async function main(args) {
    const [mode, ...rest] = args;
    if (mode === '--help') {
        console.log('Read-only: node scripts/frozen-backend-traffic.mjs plan --pins <reviewed.json> --output <new-plan.json>\nApproved traffic-only write: ... apply --plan <plan.json> --confirm-plan <sha256> --confirm-freeze-all-traffic');
        return;
    }
    const options = {};
    for (let i = 0; i < rest.length; i++) {
        const key = rest[i];
        requireThat(key.startsWith('--') && !(key in options), 'Invalid or duplicate option');
        options[key] = key === '--confirm-freeze-all-traffic' ? true : rest[++i];
        requireThat(options[key] && !String(options[key]).startsWith('--'), 'Missing option value');
    }
    if (mode === 'plan') {
        keys(options, ['--pins', '--output'], 'Plan arguments');
        const pins = validatePins(await readJson(options['--pins']));
        const plan = await planFrozenTraffic(createCloudProvider(accessToken()), pins);
        await writeFile(options['--output'], `${JSON.stringify(plan, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
        console.log(JSON.stringify({ planSha256: fingerprint(plan), revision: revisionName(pins), removeTags: plan.removeTags, writes: false }));
    } else if (mode === 'apply') {
        keys(options, ['--plan', '--confirm-plan', '--confirm-freeze-all-traffic'], 'Apply arguments');
        const plan = await readJson(options['--plan']);
        requireThat(SHA.test(options['--confirm-plan']) && fingerprint(plan) === options['--confirm-plan'], 'Plan confirmation differs');
        validatePins(plan.pins);
        console.log(JSON.stringify(await applyFrozenTraffic(createCloudProvider(accessToken()), plan, options['--confirm-plan'])));
    } else fail('Choose plan or apply; use --help. No default mutation is permitted.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main(process.argv.slice(2)).catch(error => { console.error(`Frozen traffic refused: ${error.message}`); process.exitCode = 1; });
}
