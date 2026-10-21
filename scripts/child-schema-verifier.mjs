// Fixed read-only child-schema verification. No SQL text, credentials, or raw child output is logged.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { PROJECT, REGION, SERVICE, REVISION_TYPE, fingerprint, createCloudRequest, createSessionCloudProvider,
    sessionRevisionName, validateService, revisionConfiguration, trafficShape, accessToken, readJson } from './frozen-backend-traffic.mjs';
import { PROVIDER_FIXED_ENV, providerReleaseEnvironment } from './provider-release-config.mjs';
import { validateProviderTrafficPins, checkedProviderCandidate, validateProviderRollback, rollbackRevisionName } from './session-backend-traffic.mjs';

export const CHILD_SIGNED_FORM_SQL_SHA256 = createHash('sha256').update(readFileSync(
    new URL('../backend/migrations/pending/0028_extend_child_signed_parent_forms.sql', import.meta.url))).digest('hex');
const BACKEND = fileURLToPath(new URL('../backend/', import.meta.url));
const SHA = /^[0-9a-f]{64}$/u;
const SOURCE = /^[0-9a-f]{40}$/u;
const requireThat = (condition, message) => { if (!condition) throw new Error(message); };
const same = (a, b) => fingerprint(a) === fingerprint(b);
const TARGET = Object.freeze({ project: PROJECT, instance: 'cms-mickeyf', database: 'cms',
    serverUuid: PROVIDER_FIXED_ENV.APPLE_MAINTENANCE_EXPECTED_SERVER_UUID });
function keys(value, expected, label) {
    requireThat(value && typeof value === 'object' && !Array.isArray(value)
        && same(Object.keys(value).sort(), [...expected].sort()), `${label}: unexpected fields`);
}

export function validateChildSchemaReceipt(receipt, sourceCommit, now) {
    keys(receipt, ['schemaVersion', 'operation', 'verifiedAt', 'sourceCommit', 'sqlSha256', 'target',
        'capability', 'runtimeGrantProfile', 'schemaSha256', 'grantsSha256'], 'Child schema receipt');
    keys(receipt.target, ['project', 'instance', 'database', 'serverUuid'], 'Child schema target');
    const verified = Date.parse(receipt.verifiedAt);
    requireThat(SOURCE.test(sourceCommit) && receipt.schemaVersion === 1 && receipt.operation === 'verify-child-signed-form-schema'
        && receipt.sourceCommit === sourceCommit && receipt.sqlSha256 === CHILD_SIGNED_FORM_SQL_SHA256
        && same(receipt.target, TARGET) && receipt.capability === 'nullable-parent-request-us-br'
        && receipt.runtimeGrantProfile === 'google-apple-parent-signed'
        && SHA.test(receipt.schemaSha256) && SHA.test(receipt.grantsSha256)
        && Number.isFinite(verified) && new Date(verified).toISOString() === receipt.verifiedAt,
    'Child schema receipt identity, SQL, capability or metadata differs');
    if (now !== undefined) requireThat(Number.isFinite(now) && now - verified <= 300_000 && verified - now <= 5000,
        'Child schema receipt is stale or future-dated; reverify live metadata');
    return receipt;
}

const PRIVATE_VERIFY_KEYS = ['MIGRATION_DB_HOST', 'MIGRATION_DB_PORT', 'MIGRATION_DB_USER', 'MIGRATION_DB_PASS',
    'MIGRATION_DB_NAME', 'MIGRATION_CONFIRM_DATABASE', 'MIGRATION_CONFIRM_TARGET', 'MIGRATION_CONFIRM_ACCOUNT',
    'MIGRATION_CONFIRM_SERVER_UUID', 'MIGRATION_CONFIRM_CLOUD_SQL_PROJECT', 'MIGRATION_CONFIRM_CLOUD_SQL_INSTANCE',
    'MIGRATION_CONFIRM_CLOUD_SQL_CONNECTION_NAME', 'MIGRATION_CONFIRM_SERVER_VERSION', 'MIGRATION_CONFIRM_VERSION_COMMENT'];
const OS_KEYS = new Set(['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL']);
export function childSchemaVerificationEnvironment(input, sourceCommit) {
    requireThat(SOURCE.test(sourceCommit), 'Child schema source commit is invalid');
    const environment = {};
    for (const [key, value] of Object.entries(input)) if (OS_KEYS.has(key.toUpperCase()) && typeof value === 'string') environment[key] = value;
    for (const key of PRIVATE_VERIFY_KEYS) {
        const value = input[key];
        requireThat(typeof value === 'string' && value.trim() && value.length <= 16_384 && !value.includes('\0'),
            'Live child schema metadata verifier is not configured; activation is closed');
        environment[key] = value;
    }
    requireThat(environment.MIGRATION_DB_HOST === '127.0.0.1' && /^[1-9][0-9]{0,4}$/u.test(environment.MIGRATION_DB_PORT)
        && Number(environment.MIGRATION_DB_PORT) <= 65535 && environment.MIGRATION_DB_NAME === TARGET.database
        && environment.MIGRATION_CONFIRM_DATABASE === TARGET.database
        && environment.MIGRATION_CONFIRM_TARGET === `127.0.0.1:${environment.MIGRATION_DB_PORT}/${TARGET.database}`
        && environment.MIGRATION_CONFIRM_SERVER_UUID === TARGET.serverUuid
        && environment.MIGRATION_CONFIRM_CLOUD_SQL_PROJECT === TARGET.project
        && environment.MIGRATION_CONFIRM_CLOUD_SQL_INSTANCE === TARGET.instance
        && environment.MIGRATION_CONFIRM_CLOUD_SQL_CONNECTION_NAME === `${PROJECT}:${REGION}:${TARGET.instance}`,
    'Child schema verification target confirmations differ');
    environment.MIGRATION_OPERATION_TIMEOUT_MS = '30000';
    environment.CHILD_SIGNED_FORM_SOURCE_COMMIT = sourceCommit;
    return environment;
}

const runVerification = (file, args, options) => new Promise(resolve => {
    execFile(file, args, options, (error, stdout) => resolve({ error, status: error ? 1 : 0, stdout }));
});
export function createChildSchemaVerifier({ run = runVerification, environment = () => process.env, now = Date.now } = {}) {
    return async expected => {
        const env = childSchemaVerificationEnvironment(environment(), expected?.sourceCommit);
        validateChildSchemaReceipt(expected, expected.sourceCommit, now());
        let result;
        try {
            result = await run(process.execPath, ['-r', 'ts-node/register', 'ts/migrations/runChildSignedFormSchema.ts', 'verify'], {
                cwd: BACKEND, shell: false, env, timeout: 60_000, maxBuffer: 32_768,
                encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
            });
        } catch { throw new Error('Live child schema verification failed; private process output was not logged'); }
        requireThat(result && !result.error && result.status === 0 && typeof result.stdout === 'string'
            && result.stdout.length <= 16_384, 'Live child schema verification failed; private process output was not logged');
        let observed;
        try { observed = JSON.parse(result.stdout); }
        catch { throw new Error('Live child schema receipt could not be decoded; private process output was not logged'); }
        validateChildSchemaReceipt(observed, expected.sourceCommit, now());
        requireThat(same({ ...observed, verifiedAt: expected.verifiedAt }, expected), 'Live child schema or runtime grants changed after review');
        return observed;
    };
}

const TRIGGERS = ['9fbd63bf-d129-4877-bb26-26d38e1ca468', '181b8f84-2303-4c2b-a03e-92dae4b1938c',
    '1c9c6502-f53f-4e04-ac9e-06bf49668acf', '648fadca-3cd1-4b57-9d35-0f62a1468443',
    'd71109da-8350-4f2f-a3be-2053bb6ccd45', 'ef5a2981-95be-4f4d-af91-f997fde73356'].sort();
const DRAIN_MS = 300_000;
const PROOF_FIELDS = ['schemaVersion', 'operation', 'observedAt', 'sourceCommit', 'sqlSha256', 'target',
    'pinsSha256', 'serviceSha256', 'candidateSha256', 'fallbackSha256', 'readerSince', 'readerVerifiedAt',
    'readerDurationMs', 'automationSha256', 'backup', 'pitr', 'cloudSqlSha256', 'stableSha256'];
const stableProof = proof => Object.fromEntries(Object.entries(proof).filter(([key]) => !['observedAt', 'pitr', 'stableSha256'].includes(key)));
const instant = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.[0-9]{1,9})?Z$/u.test(value) ? Date.parse(value) : NaN;
function cloudTimestamp(value, roundUp = false) {
    const time = instant(value);
    requireThat(Number.isFinite(time), 'Cloud recovery timestamp is missing or invalid');
    const submillisecond = /\.[0-9]{3}([0-9]+)Z$/u.exec(value)?.[1];
    return new Date(time + (roundUp && submillisecond && /[1-9]/u.test(submillisecond) ? 1 : 0)).toISOString();
}

export function validateChildMigrationPrerequisiteProof(proof, pins, now = Date.now(), fresh = true) {
    keys(proof, PROOF_FIELDS, 'Child prerequisite proof');
    keys(proof.target, ['project', 'instance', 'database', 'serverUuid'], 'Child prerequisite target');
    keys(proof.backup, ['id', 'endTime', 'sha256'], 'Child prerequisite backup');
    keys(proof.pitr, ['earliestRecoveryTime', 'latestRecoveryTime'], 'Child prerequisite PITR');
    const observed = instant(proof.observedAt), since = instant(proof.readerSince), verified = instant(proof.readerVerifiedAt);
    const earliest = instant(proof.pitr.earliestRecoveryTime), latest = instant(proof.pitr.latestRecoveryTime);
    const backup = instant(proof.backup.endTime);
    requireThat(proof.schemaVersion === 1 && proof.operation === 'child-schema-prerequisites'
        && proof.sourceCommit === pins.candidate.deployment.sourceCommit && proof.sqlSha256 === CHILD_SIGNED_FORM_SQL_SHA256
        && same(proof.target, TARGET) && proof.pinsSha256 === fingerprint(pins)
        && ['serviceSha256', 'candidateSha256', 'fallbackSha256', 'automationSha256', 'cloudSqlSha256', 'stableSha256']
            .every(key => SHA.test(proof[key])) && SHA.test(proof.backup.sha256) && /^[1-9][0-9]*$/u.test(proof.backup.id)
        && Number.isFinite(observed) && Number.isFinite(since) && Number.isFinite(verified)
        && since <= verified && verified <= observed && verified - since >= DRAIN_MS
        && Number.isSafeInteger(proof.readerDurationMs) && proof.readerDurationMs >= DRAIN_MS && proof.readerDurationMs <= 420_000
        && proof.stableSha256 === fingerprint(stableProof(proof)), 'Child prerequisite identity, drain or fingerprint differs');
    requireThat(Number.isFinite(backup) && backup <= observed && observed - backup <= 7_200_000
        && Number.isFinite(earliest) && Number.isFinite(latest) && earliest <= backup && backup <= latest
        && earliest <= latest && latest <= observed + 5000 && observed - latest <= 900_000,
    'Child prerequisite backup or PITR checkpoint is invalid or stale');
    if (fresh) requireThat(Number.isFinite(now) && now - observed <= 30_000 && observed - now <= 5000,
        'Child prerequisite observation is stale or future-dated');
    return proof;
}

function approvedProof(plan, confirmation, pins, now) {
    keys(plan, ['schemaVersion', 'operation', 'createdAt', 'sourceCommit', 'sqlSha256', 'target', 'baseline', 'releaseSafety', 'sha256'], 'Approved child schema plan');
    keys(plan.target, ['project', 'instance', 'database', 'serverUuid'], 'Approved child schema target');
    keys(plan.baseline, ['identity', 'history', 'capability', 'schemaSha256', 'grantsSha256'], 'Approved child schema baseline');
    keys(plan.baseline.identity, ['databaseName', 'currentUser', 'serverUuid', 'serverVersion', 'versionComment'], 'Approved child schema identity');
    const { sha256, ...body } = plan ?? {};
    requireThat(SHA.test(confirmation) && sha256 === confirmation && fingerprint(body) === confirmation
        && plan.schemaVersion === 1 && plan.operation === 'extend-child-signed-form-schema'
        && plan.sourceCommit === pins.candidate.deployment.sourceCommit && plan.sqlSha256 === CHILD_SIGNED_FORM_SQL_SHA256
        && same(plan.target, TARGET) && plan.baseline.capability === 'legacy-us'
        && SHA.test(plan.baseline.schemaSha256) && SHA.test(plan.baseline.grantsSha256)
        && plan.baseline.identity.databaseName === TARGET.database && plan.baseline.identity.serverUuid === TARGET.serverUuid
        && typeof plan.baseline.identity.currentUser === 'string' && /^[^\s@'`\x00-\x1f\x7f]+@[^\s@'`\x00-\x1f\x7f]+$/u.test(plan.baseline.identity.currentUser)
        && plan.baseline.identity.currentUser !== 'cms_mickeyf@%' && /^8\.0\.31(?:[-.]|$)/u.test(plan.baseline.identity.serverVersion)
        && typeof plan.baseline.identity.versionComment === 'string' && plan.baseline.identity.versionComment.length > 0 && plan.baseline.identity.versionComment.length <= 255
        && Array.isArray(plan.baseline.history) && plan.baseline.history.length === 26
        && Number.isFinite(instant(plan.createdAt)) && now - instant(plan.createdAt) >= 0 && now - instant(plan.createdAt) <= 300_000,
    'Only the exact fresh operator-approved child schema plan can reuse its reader observation');
    for (const [index, migration] of plan.baseline.history.entries()) {
        keys(migration, ['version', 'checksumSha256'], 'Approved migration history');
        requireThat(typeof migration.version === 'string' && /^[0-9]{4}_[a-z0-9_]+$/u.test(migration.version)
            && migration.version.startsWith(`${String(index + 1).padStart(4, '0')}_`) && SHA.test(migration.checksumSha256),
        'Approved migration history is incomplete or malformed');
    }
    requireThat(instant(plan.createdAt) >= instant(plan.releaseSafety?.observedAt), 'Approved plan predates its authenticated reader observation');
    return validateChildMigrationPrerequisiteProof(plan.releaseSafety, pins, now, false);
}

/** Authenticated metadata GETs only. The default first observation waits a real monotonic 300 seconds. */
export function createChildMigrationPrerequisiteReader(token, fetcher = fetch, {
    now = Date.now, monotonic = () => performance.now(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
    const request = createCloudRequest(token, fetcher);
    const provider = createSessionCloudProvider(token, fetcher);
    async function list(base, path, field, allowed) {
        const values = [], tokens = new Set();
        let pageToken = '';
        for (let page = 0; page < 20; page++) {
            const result = await request(base, `${path}${path.includes('?') ? '&' : '?'}${pageToken ? `pageToken=${encodeURIComponent(pageToken)}` : ''}`);
            requireThat(Object.keys(result).every(key => [...allowed, field, 'nextPageToken'].includes(key))
                && (result[field] === undefined || Array.isArray(result[field])), 'Malformed child prerequisite metadata page');
            values.push(...result[field] ?? []);
            requireThat(values.length <= 2000, 'Child prerequisite metadata inventory exceeds its reviewed bound');
            if (!result.nextPageToken) return values;
            requireThat(typeof result.nextPageToken === 'string' && result.nextPageToken.length <= 8192 && !tokens.has(result.nextPageToken),
                'Invalid child prerequisite pagination token');
            tokens.add(result.nextPageToken); pageToken = result.nextPageToken;
        }
        throw new Error('Child prerequisite pagination limit exceeded');
    }
    async function automation() {
        const global = `projects/${PROJECT}/locations/global`, regional = `projects/${PROJECT}/locations/${REGION}`;
        const activeFilter = encodeURIComponent('status="PENDING" OR status="QUEUED" OR status="WORKING"');
        const [triggers, regionalTriggers, globalBuilds, regionalBuilds] = await Promise.all([
            list('https://cloudbuild.googleapis.com/v1/', `${global}/triggers?pageSize=100`, 'triggers', []),
            list('https://cloudbuild.googleapis.com/v1/', `${regional}/triggers?pageSize=100`, 'triggers', []),
            list('https://cloudbuild.googleapis.com/v1/', `${global}/builds?filter=${activeFilter}&pageSize=100`, 'builds', []),
            list('https://cloudbuild.googleapis.com/v1/', `${regional}/builds?filter=${activeFilter}&pageSize=100`, 'builds', []),
        ]);
        requireThat(same(triggers.map(item => item?.id).sort(), TRIGGERS) && triggers.every(item => item.disabled === true)
            && regionalTriggers.length === 0 && globalBuilds.length === 0 && regionalBuilds.length === 0,
        'The exact six global triggers must remain disabled with no regional triggers or ongoing builds');
        return fingerprint({ triggers: triggers.sort((a, b) => a.id.localeCompare(b.id)), regionalTriggers, globalBuilds, regionalBuilds });
    }
    function settled(service, pins) {
        validateService(service);
        const candidate = sessionRevisionName(pins.candidate.deployment), fallback = rollbackRevisionName(pins);
        requireThat(same(trafficShape(service.traffic), [{ type: REVISION_TYPE, revision: candidate, percent: 100, tag: '' }])
            && service.latestReadyRevision === `${SERVICE}/revisions/${candidate}`
            && [candidate, fallback].some(name => service.latestCreatedRevision === `${SERVICE}/revisions/${name}`),
        'Child schema changes require only the exact new closed compatible candidate serving without tags');
        return service;
    }
    async function snapshot(pins) {
        const [service, revisions, fallback, automationSha256, instance, backups, pitr, operations] = await Promise.all([
            provider.getService(), checkedProviderCandidate(provider, pins), provider.getRevision(rollbackRevisionName(pins)), automation(),
            request('https://sqladmin.googleapis.com/sql/v1beta4/', `projects/${PROJECT}/instances/${TARGET.instance}`),
            list('https://sqladmin.googleapis.com/sql/v1beta4/', `projects/${PROJECT}/instances/${TARGET.instance}/backupRuns?maxResults=100`, 'items', ['kind']),
            request('https://sqladmin.googleapis.com/sql/v1beta4/', `projects/${PROJECT}/instances/${TARGET.instance}/getLatestRecoveryTime`),
            list('https://sqladmin.googleapis.com/sql/v1beta4/', `projects/${PROJECT}/operations?instance=${TARGET.instance}&maxResults=100`, 'items', ['kind']),
        ]);
        settled(service, pins);
        validateProviderRollback(fallback, revisions.candidate, pins);
        const template = service.template, templateRevision = template.revision === rollbackRevisionName(pins) ? fallback : revisions.candidate;
        requireThat([sessionRevisionName(pins.candidate.deployment), rollbackRevisionName(pins)].includes(template.revision), 'Unreviewed closed service template');
        for (const key of ['containers', 'serviceAccount', 'maxInstanceRequestConcurrency', 'timeout', 'scaling', 'volumes',
            'executionEnvironment', 'sessionAffinity', 'vpcAccess', 'serviceMesh', 'encryptionKey']) {
            requireThat(same(template[key] ?? null, templateRevision[key] ?? null), 'Closed service template runtime differs from the reviewed revision');
        }
        const backupSettings = instance.settings?.backupConfiguration;
        requireThat(instance.name === TARGET.instance && instance.project === PROJECT && instance.region === REGION
            && instance.connectionName === `${PROJECT}:${REGION}:${TARGET.instance}` && /^MYSQL_8_0(?:_[0-9]+)?$/u.test(instance.databaseVersion)
            && instance.state === 'RUNNABLE' && instance.settings?.deletionProtectionEnabled === true
            && instance.settings?.availabilityType === 'REGIONAL' && backupSettings?.enabled === true
            && backupSettings.binaryLogEnabled === true && Number.isSafeInteger(backupSettings.transactionLogRetentionDays)
            && backupSettings.transactionLogRetentionDays >= 7 && ['CLOUD_STORAGE', 'SWITCHED_TO_CLOUD_STORAGE'].includes(backupSettings.transactionalLogStorageState),
        'Cloud SQL target, backup configuration or PITR protection differs');
        requireThat(operations.every(item => item?.targetId === TARGET.instance && item.targetProject === PROJECT && item.status === 'DONE'),
            'Cloud SQL has ongoing or unidentified operations');
        requireThat(new Set(backups.map(item => item?.id)).size === backups.length && backups.every(item => item?.instance === TARGET.instance
            && /^[1-9][0-9]*$/u.test(item.id) && !['ENQUEUED', 'RUNNING'].includes(item.status)), 'Backup inventory is ambiguous or still changing');
        const successful = backups.filter(item => item.status === 'SUCCESSFUL' && !item.error && Number.isFinite(instant(item.endTime)))
            .sort((a, b) => instant(b.endTime) - instant(a.endTime) || (BigInt(a.id) < BigInt(b.id) ? 1 : -1));
        requireThat(successful.length > 0, 'A successful release-window backup is required');
        const backup = successful[0];
        requireThat(same(service, await provider.getService()), 'Cloud Run changed during child prerequisite observation');
        const cloudSql = { name: instance.name, project: instance.project, region: instance.region, connectionName: instance.connectionName,
            databaseVersion: instance.databaseVersion, state: instance.state, createTime: instance.createTime ?? null,
            settings: { settingsVersion: instance.settings.settingsVersion, deletionProtectionEnabled: instance.settings.deletionProtectionEnabled,
                availabilityType: instance.settings.availabilityType, backupConfiguration: backupSettings, databaseFlags: instance.settings.databaseFlags ?? [] } };
        return { serviceSha256: fingerprint(service), candidateSha256: fingerprint(revisionConfiguration(revisions.candidate)),
            fallbackSha256: fingerprint(revisionConfiguration(fallback)), automationSha256, cloudSqlSha256: fingerprint(cloudSql),
            backup: { id: backup.id, endTime: cloudTimestamp(backup.endTime, true), sha256: fingerprint(backup) },
            pitr: { earliestRecoveryTime: cloudTimestamp(pitr.earliestRecoveryTime, true), latestRecoveryTime: cloudTimestamp(pitr.latestRecoveryTime) } };
    }
    return {
        async read(pins, { approvedPlan, confirmation } = {}) {
            validateProviderTrafficPins(pins);
            const config = pins.candidate.deployment.providerRelease;
            const environment = providerReleaseEnvironment(config);
            requireThat(config.phase === 'prepare-child' && environment.REGISTRATION_AUDIENCE === 'children-included'
                && ['REGISTRATION_CREATION_ENABLED', 'PROVIDER_GOOGLE_SIGNUP_ENABLED', 'PROVIDER_APPLE_SIGNUP_ENABLED', 'PARENT_REGISTRATION_CREATION_ENABLED']
                    .every(name => environment[name] === 'false'), 'Only the reviewed new creation-closed child binary is compatible with pending 0028');
            const approved = approvedPlan === undefined ? null : approvedProof(approvedPlan, confirmation, pins, now());
            requireThat(approvedPlan !== undefined || confirmation === undefined, 'A standalone drain confirmation is not accepted');
            const first = await snapshot(pins);
            let readerSince, readerVerifiedAt, readerDurationMs;
            if (approved) ({ readerSince, readerVerifiedAt, readerDurationMs } = approved);
            else {
                readerSince = new Date(now()).toISOString();
                const started = monotonic();
                while (monotonic() - started < DRAIN_MS) {
                    await sleep(Math.min(50_000, DRAIN_MS - (monotonic() - started)));
                    requireThat(monotonic() - started <= 420_000, 'Reader drain observation exceeded its time budget');
                    const service = settled(await provider.getService(), pins);
                    requireThat(fingerprint(service) === first.serviceSha256, 'Cloud Run changed during the actual reader drain; make a fresh plan');
                }
                readerDurationMs = Math.floor(monotonic() - started);
                readerVerifiedAt = new Date(now()).toISOString();
            }
            const last = await snapshot(pins);
            requireThat(same({ ...first, pitr: null }, { ...last, pitr: null }), 'Release prerequisites changed during observation');
            const proof = { schemaVersion: 1, operation: 'child-schema-prerequisites', observedAt: new Date(now()).toISOString(),
                sourceCommit: pins.candidate.deployment.sourceCommit, sqlSha256: CHILD_SIGNED_FORM_SQL_SHA256, target: { ...TARGET }, pinsSha256: fingerprint(pins),
                ...last, readerSince, readerVerifiedAt, readerDurationMs };
            proof.stableSha256 = fingerprint(stableProof(proof));
            validateChildMigrationPrerequisiteProof(proof, pins, now());
            if (approved) {
                requireThat(proof.stableSha256 === approved.stableSha256, 'Operator-approved prerequisite fingerprints changed; make a fresh plan and reader watch');
                const checkpoint = instant(approved.pitr.latestRecoveryTime);
                requireThat(instant(proof.pitr.earliestRecoveryTime) <= checkpoint && checkpoint <= instant(proof.pitr.latestRecoveryTime),
                    'The operator-approved pre-DDL recovery checkpoint is no longer recoverable');
            }
            return proof;
        },
    };
}

export async function main(args) {
    requireThat(args.length === 2 || args.length === 4 && args[2] === '--recheck-approved-plan', 'Use prerequisites <reviewed-pins.json> [--recheck-approved-plan <sha256>]');
    requireThat(args[0] === 'prerequisites', 'Only metadata-only prerequisite observation is supported');
    const pins = await readJson(args[1]);
    let options;
    if (args.length === 4) {
        requireThat(SHA.test(args[3]), 'Invalid approved plan SHA256');
        const raw = readFileSync(0, 'utf8');
        requireThat(raw.length <= 1_048_576, 'Approved plan exceeds size limit');
        let approvedPlan;
        try { approvedPlan = JSON.parse(raw); } catch { throw new Error('Approved plan JSON is invalid'); }
        options = { approvedPlan, confirmation: args[3] };
    }
    const proof = await createChildMigrationPrerequisiteReader(accessToken()).read(pins, options);
    console.log(JSON.stringify(proof));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    main(process.argv.slice(2)).catch(() => { console.error('Child schema prerequisite verification failed; private metadata was not logged'); process.exitCode = 1; });
}
