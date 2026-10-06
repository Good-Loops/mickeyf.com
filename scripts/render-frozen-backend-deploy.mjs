import { createHash } from 'node:crypto';
import { providerReleaseEnvironment, providerConfigurationSha256 } from './provider-release-config.mjs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Changing either pin requires reviewing the canonical policy diff, not just
// refreshing hashes. Canonical source policy remains main-only.
export const CANONICAL_SHA256 = 'd925e4cc4ea5e25c7d204317d4a905f045cc860615f3dce437aa295fa491d30f';
export const CANDIDATE_SHA256 = 'dccd0bcf976c77abb3e9fa6d39c1ae855ff127fbf4ec67efd3480e20a4afcda4';
export const DEPLOY_IMAGE = 'gcr.io/google.com/cloudsdktool/cloud-sdk:alpine@sha256:de1a989b158694a614852e7b53673097da3bdb394b8186d6102386b7a10d73c7';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const project = 'noted-reef-387021';
const deployIdentity = `projects/${project}/serviceAccounts/mickeyf-backend-deploy@${project}.iam.gserviceaccount.com`;
const normalize = (text) => text.replace(/\r\n?/gu, '\n');
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

export const ACCOUNT_DELETION_JOURNAL_BUCKET = 'ludolume-deletion-journal-1012884798546';
export const ORIGINAL_ACCOUNT_IDENTITY_EPOCH = '2026-09-12 00:15:39.954172';
export const APPROVED_GOOGLE_WEB_CLIENT_ID = '1012884798546-u18tb6962p05mdpfe6nov8uhe0pbeak8.apps.googleusercontent.com';

export function validateSessionSecretVersion(value) {
    if (typeof value !== 'string' || value !== value.trim() || !/^[1-9][0-9]*$/u.test(value)) {
        throw new Error('sessionSecretVersion must be an explicit positive decimal version string, not an alias.');
    }
    return value;
}

export function frozenDeploymentApproval(pins) {
    return `freeze-zero-traffic:${pins.sourceCommit}:${pins.sourceBuildId}:${pins.imageDigest}`
        + `:session-secret:${validateSessionSecretVersion(pins.sessionSecretVersion)}`;
}

export function sessionDeploymentApproval(pins) {
    const reviewed = validateSessionPins(pins);
    return `session-zero-traffic:${reviewed.sourceCommit}:${reviewed.sourceBuildId}:${reviewed.imageDigest}`
        + `:previous-session-secret:${reviewed.previousSessionSecretVersion}:session-secret:${reviewed.sessionSecretVersion}`;
}

// Omission is default-off; an explicit false requests a reviewed disable/rollback.
export function accountDeletionEnvironment(settings) {
    if (settings === undefined) return { ACCOUNT_DELETION_ENABLED: 'false' };
    const keys = settings?.enabled === true ? ['enabled', 'journalBucket', 'identityEpoch'] : ['enabled'];
    if (!settings || Array.isArray(settings) || typeof settings.enabled !== 'boolean'
        || Object.keys(settings).sort().join() !== keys.sort().join()
        || settings.enabled && (settings.journalBucket !== ACCOUNT_DELETION_JOURNAL_BUCKET
            || settings.identityEpoch !== ORIGINAL_ACCOUNT_IDENTITY_EPOCH)) {
        throw new Error('Deletion configuration requires an explicit boolean and exactly the approved journal/identity pins when enabled.');
    }
    return settings.enabled ? {
        ACCOUNT_DELETION_ENABLED: 'true',
        ACCOUNT_DELETION_JOURNAL_BUCKET: settings.journalBucket,
        ACCOUNT_IDENTITY_EPOCH: settings.identityEpoch,
    } : { ACCOUNT_DELETION_ENABLED: 'false' };
}

function accountDeletionApproval(pins) {
    if (pins.accountDeletion === undefined) return 'DISABLED';
    return `${pins.accountDeletion.enabled ? 'enable' : 'disable'}-account-deletion:${pins.sourceCommit}:${pins.sourceBuildId}:${pins.imageDigest}`;
}

/** Public activation means complete signup/login, never a link-only release. */
export function googleSignInEnvironment(settings, accountDeletion) {
    const disabled = { PROVIDER_AUTH_ENABLED: 'false', PROVIDER_GOOGLE_SIGNUP_ENABLED: 'false' };
    if (settings === undefined) return disabled;
    const keys = settings?.enabled === true ? ['enabled', 'clientId'] : ['enabled'];
    if (!settings || Array.isArray(settings) || typeof settings.enabled !== 'boolean'
        || Object.keys(settings).sort().join() !== keys.sort().join()
        || settings.enabled && settings.clientId !== APPROVED_GOOGLE_WEB_CLIENT_ID) {
        throw new Error('Google sign-in requires an explicit boolean and exactly the approved web client when enabled.');
    }
    if (!settings.enabled) return disabled;
    if (accountDeletionEnvironment(accountDeletion).ACCOUNT_DELETION_ENABLED !== 'true') {
        throw new Error('Public Google signup requires the reviewed enabled account-deletion configuration.');
    }
    return { PROVIDER_AUTH_ENABLED: 'true', PROVIDER_GOOGLE_SIGNUP_ENABLED: 'true', GOOGLE_WEB_CLIENT_ID: settings.clientId };
}

function googleSignInApproval(pins) {
    if (pins.googleSignIn === undefined) return 'DISABLED';
    return `${pins.googleSignIn.enabled ? 'enable' : 'disable'}-google-sign-in:${pins.sourceCommit}:${pins.sourceBuildId}:${pins.imageDigest}`;
}

export function validateProviderPins(value) {
    const { providerRelease, previousProviderRelease, ...session } = value ?? {};
    if (session.accountDeletion !== undefined || session.googleSignIn !== undefined) {
        throw new Error('Provider release owns the complete account/provider environment; do not combine legacy options.');
    }
    providerReleaseEnvironment(providerRelease);
    if (previousProviderRelease !== undefined) providerReleaseEnvironment(previousProviderRelease);
    return { ...validateSessionPins({ ...session, accountDeletion: { enabled: true,
        journalBucket: ACCOUNT_DELETION_JOURNAL_BUCKET, identityEpoch: ORIGINAL_ACCOUNT_IDENTITY_EPOCH } }), providerRelease,
        ...(previousProviderRelease === undefined ? {} : { previousProviderRelease }) };
}

export function providerDeploymentApproval(pins) {
    const reviewed = validateProviderPins(pins);
    return `provider-zero-traffic:${reviewed.sourceCommit}:${reviewed.sourceBuildId}:${reviewed.imageDigest}`
        + `:previous-session-secret:${reviewed.previousSessionSecretVersion}:session-secret:${reviewed.sessionSecretVersion}`
        + `:configuration:${providerConfigurationSha256({ current: reviewed.providerRelease, previous: reviewed.previousProviderRelease ?? null })}`;
}

export function validateFrozenPins(value) {
    return validateBackendPins(value, false);
}

export function validateSessionPins(value) {
    const { previousSessionSecretVersion, ...common } = value ?? {};
    const pins = validateBackendPins(common, true);
    validateSessionSecretVersion(previousSessionSecretVersion);
    if (BigInt(pins.sessionSecretVersion) <= BigInt(previousSessionSecretVersion)) {
        throw new Error('Session cutover requires a newer signing-secret version than the reviewed serving version.');
    }
    return { ...pins, previousSessionSecretVersion };
}

function validateBackendPins(value, sessionCutover) {
    const keys = ['sourceBuildId', 'sourceCommit', 'imageDigest', 'sourceTriggerId', 'sourceTriggerName', 'sourceRef', 'deploymentTriggerName', 'sessionSecretVersion'];
    if (!value || Object.keys(value).filter(key => !['accountDeletion', 'googleSignIn'].includes(key)).sort().join() !== keys.sort().join()
        || keys.some((key) => typeof value[key] !== 'string')) {
        throw new Error('Supply the eight reviewed source/deployment pins, including sessionSecretVersion, and optional accountDeletion/googleSignIn configurations only.');
    }
    validateSessionSecretVersion(value.sessionSecretVersion);
    accountDeletionEnvironment(value.accountDeletion);
    googleSignInEnvironment(value.googleSignIn, value.accountDeletion);
    if (!uuid.test(value.sourceBuildId) || !uuid.test(value.sourceTriggerId)
        || !/^[0-9a-f]{40}$/u.test(value.sourceCommit) || !/^sha256:[0-9a-f]{64}$/u.test(value.imageDigest)
        || !/^[a-z][a-z0-9-]{0,62}$/u.test(value.sourceTriggerName)
        || !(sessionCutover ? /^session-backend-[a-z0-9-]{1,46}$/u : /^frozen-backend-[a-z0-9-]{1,47}$/u).test(value.deploymentTriggerName)
        || !/^refs\/heads\/(?:feature|improvement|fix)\/[a-z0-9][a-z0-9/_-]{0,100}$/u.test(value.sourceRef)
        || value.sourceRef.includes('..') || value.sourceRef.endsWith('/')) {
        throw new Error('Malformed exact candidate pins; placeholders are not deployable.');
    }
    if (['ef5a2981-95be-4f4d-af91-f997fde73356', 'd71109da-8350-4f2f-a3be-2053bb6ccd45'].includes(value.sourceTriggerId)) {
        throw new Error('Canonical Stage A/B cannot be used for a feature candidate.');
    }
    return {
        ...value,
        canonicalDeployTriggerId: 'd71109da-8350-4f2f-a3be-2053bb6ccd45',
        canonicalDeployTriggerName: 'mickeyf-backend-stage-b-deploy',
    };
}

function replaceExactly(text, from, to, count = 1) {
    const observed = text.split(from).length - 1;
    if (observed !== count) throw new Error(`Canonical policy sentinel changed: ${JSON.stringify(from)} (${observed} != ${count}).`);
    return text.split(from).join(to);
}

function stepBlock(canonical, id) {
    const start = canonical.indexOf(`  - id: '${id}'\n`);
    if (start < 0) throw new Error(`Missing canonical step: ${id}`);
    const next = canonical.indexOf('\n  - id:', start + 1);
    const end = next < 0 ? canonical.indexOf('\navailableSecrets:', start) : next;
    return canonical.slice(start, end).replace(/\n  # Cloud Build caps[\s\S]*$/u, '').trimEnd() + '\n';
}

function frozenState(block) {
    // Only deterministic state derivations change; the scan policy is retained.
    return block.replaceAll('f"c-{compact}"', 'f"f-{compact}"')
        .replaceAll('f"mickeyf-org-build-{compact}"', 'f"mickeyf-org-freeze-{compact}"')
        .replaceAll('f"build-{compact}"', 'f"freeze-{compact}"');
}

function sessionState(block) {
    return block.replaceAll('f"c-{compact}"', 'f"s-{compact}"')
        .replaceAll('f"mickeyf-org-build-{compact}"', 'f"mickeyf-org-session-{compact}"')
        .replaceAll('f"build-{compact}"', 'f"session-{compact}"');
}

function yamlStep(id, args, { entrypoint = 'python3', timeout = '600s' } = {}) {
    return `  - id: ${JSON.stringify(id)}\n    name: '${DEPLOY_IMAGE}'\n    entrypoint: '${entrypoint}'\n    args:\n`
        + args.map((arg) => `      - ${JSON.stringify(arg)}\n`).join('')
        + `    timeout: '${timeout}'\n`;
}

// Deliberately not a general YAML parser: accept only the hash-reviewed step
// subset. This gives the traffic tool declared-step JSON without a dependency.
function parseReviewedSteps(text) {
    const lines = text.trimEnd().split('\n');
    const steps = [];
    const scalar = (value) => {
        if (value.startsWith('"')) return JSON.parse(value);
        if (/^'[^']*'$/u.test(value)) return value.slice(1, -1);
        throw new Error(`Unsupported reviewed YAML scalar: ${value}`);
    };
    let current;
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (!line.trim()) continue;
        const step = line.match(/^  - id: (.+)$/u);
        if (step) { current = { id: scalar(step[1]) }; steps.push(current); continue; }
        const field = line.match(/^    (name|entrypoint|timeout): (.+)$/u);
        if (field && current) { current[field[1]] = scalar(field[2]); continue; }
        if (line === '    env:' && current && !current.env) { current.env = []; continue; }
        if (line === '    args:' && current && !current.args) { current.args = []; continue; }
        const argument = line.match(/^      - (.+)$/u);
        if (argument && current?.env && !current.args) { current.env.push(scalar(argument[1])); continue; }
        if (argument && current?.args) {
            if (['|', '|2'].includes(argument[1])) {
                const content = [];
                while (index + 1 < lines.length && (!lines[index + 1].trim() || lines[index + 1].startsWith('        '))) {
                    index += 1;
                    content.push(lines[index].slice(8));
                }
                current.args.push(content.join('\n').replace(/\n*$/u, '\n'));
            } else current.args.push(scalar(argument[1]));
            continue;
        }
        throw new Error(`Unsupported reviewed YAML structure: ${line}`);
    }
    if (steps.some((step) => !step.name || !step.entrypoint || !Array.isArray(step.args))) throw new Error('Incomplete reviewed step.');
    return steps;
}

function canonicalJson(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
}

export const frozenDeploymentStepsSha256 = (steps) => sha256(canonicalJson(steps));

export function resolveFrozenDeploymentSteps(steps, { buildId, deploymentTriggerId, approval }) {
    return resolveDeploymentSteps(steps, { buildId, deploymentTriggerId, approval }, false);
}

export function resolveSessionDeploymentSteps(steps, { buildId, deploymentTriggerId, approval }) {
    return resolveDeploymentSteps(steps, { buildId, deploymentTriggerId, approval }, true);
}

export function resolveProviderDeploymentSteps(steps, options) {
    return resolveDeploymentSteps(steps, options, true, true);
}

function resolveDeploymentSteps(steps, { buildId, deploymentTriggerId, approval }, sessionCutover, providerCutover = false) {
    const approvalPattern = providerCutover
        ? /^provider-zero-traffic:[0-9a-f]{40}:[0-9a-f-]{36}:sha256:[0-9a-f]{64}:previous-session-secret:[1-9][0-9]*:session-secret:[1-9][0-9]*:configuration:[0-9a-f]{64}$/u
        : sessionCutover
        ? /^session-zero-traffic:[0-9a-f]{40}:[0-9a-f-]{36}:sha256:[0-9a-f]{64}:previous-session-secret:[1-9][0-9]*:session-secret:[1-9][0-9]*$/u
        : /^freeze-zero-traffic:[0-9a-f]{40}:[0-9a-f-]{36}:sha256:[0-9a-f]{64}:session-secret:[1-9][0-9]*$/u;
    if (!uuid.test(buildId) || !uuid.test(deploymentTriggerId)
        || typeof approval !== 'string' || approval !== approval.trim()
        || !approvalPattern.test(approval)) {
        throw new Error('Resolved steps require the exact deployment build, trigger and version-bound approval.');
    }
    const replacements = { '${BUILD_ID}': buildId, '${_DEPLOY_TRIGGER_ID}': deploymentTriggerId, '${_APPROVAL}': approval, '$$': '$' };
    const substitute = (value) => {
        if (Array.isArray(value)) return value.map(substitute);
        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item)]));
        if (typeof value !== 'string') return value;
        return value.replace(/\$\$|\$\{BUILD_ID\}|\$\{_DEPLOY_TRIGGER_ID\}|\$\{_APPROVAL\}/gu, (match) => replacements[match]);
    };
    return substitute(steps);
}

export function renderFrozenBackendDeployConfig({ canonical, candidate, preflight, pins: requestedPins }) {
    return renderBackendDeployConfig({ canonical, candidate, preflight, pins: requestedPins }, false);
}

export function renderSessionBackendDeployConfig({ canonical, candidate, preflight, pins: requestedPins }) {
    return renderBackendDeployConfig({ canonical, candidate, preflight, pins: requestedPins }, true);
}

export function renderProviderBackendDeployConfig(input) {
    return renderBackendDeployConfig(input, true, true);
}

function renderBackendDeployConfig({ canonical, candidate, preflight, pins: requestedPins }, sessionCutover, providerCutover = false) {
    canonical = normalize(canonical);
    candidate = normalize(candidate);
    preflight = normalize(preflight);
    if (sha256(canonical) !== CANONICAL_SHA256 || sha256(candidate) !== CANDIDATE_SHA256) {
        throw new Error('Reviewed canonical/image-only configuration hash changed; review before updating the renderer.');
    }
    const pins = providerCutover ? validateProviderPins(requestedPins) : sessionCutover ? validateSessionPins(requestedPins) : validateFrozenPins(requestedPins);
    const scope = sessionCutover ? 'session' : 'frozen';
    const candidateState = sessionCutover ? sessionState : frozenState;
    const preflightInvocation = (phase) => `python3 /workspace/${scope}-preflight.py /workspace/${scope}-pins.json "\${BUILD_ID}" "\${_DEPLOY_TRIGGER_ID}" "\${_APPROVAL}" ${phase}`;
    if (sessionCutover) preflight = replaceExactly(preflight, 'SESSION_CUTOVER = False', 'SESSION_CUTOVER = True');
    if (providerCutover) preflight = replaceExactly(preflight, 'PROVIDER_RELEASE = False', 'PROVIDER_RELEASE = True');
    const payload = Buffer.from(preflight).toString('base64');
    const chunks = payload.match(/.{1,8000}/gu);
    // Base64 avoids Cloud Build treating Python dollar signs as substitutions.
    const materializer = [
        'import base64, hashlib, os, sys',
        'payload = base64.b64decode("".join(sys.argv[3:]), validate=True)',
        'if hashlib.sha256(payload).hexdigest() != sys.argv[1]: raise SystemExit("preflight digest mismatch")',
        `for path, data in (("/workspace/${scope}-preflight.py", payload), ("/workspace/${scope}-pins.json", sys.argv[2].encode())):`,
        '    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)',
        '    with os.fdopen(fd, "wb") as handle: handle.write(data)',
    ].join('\n');
    let initial = yamlStep(`Materialize reviewed ${scope} preflight`, ['-c', materializer, sha256(preflight), JSON.stringify(pins), ...chunks])
        + yamlStep(`Validate exact ${scope} candidate and operational exclusion`, ['-ceu', preflightInvocation('initial')], { entrypoint: 'bash' });

    if (providerCutover) {
        // Policy/consent text is data, never a shell argument or Cloud Build substitution.
        // Chunk the entire materialization bundle so a worldwide policy cannot exceed the API argument limit.
        const bundle = Buffer.from(JSON.stringify({ preflight, pins })).toString('base64');
        const materialize = [
            'import base64, hashlib, json, os, sys',
            'payload = base64.b64decode("".join(sys.argv[2:]), validate=True)',
            'if hashlib.sha256(payload).hexdigest() != sys.argv[1]: raise SystemExit("bundle digest mismatch")',
            'bundle = json.loads(payload)',
            'for path, data in (("/workspace/session-preflight.py", bundle["preflight"]), ("/workspace/session-pins.json", json.dumps(bundle["pins"]))):',
            '    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)',
            '    with os.fdopen(fd, "w", encoding="utf-8") as handle: handle.write(data)',
        ].join('\n');
        const bytes = Buffer.from(bundle, 'base64');
        initial = yamlStep('Materialize reviewed provider preflight', ['-c', materialize,
            createHash('sha256').update(bytes).digest('hex'), ...bundle.match(/.{1,8000}/gu)])
            + yamlStep('Validate exact provider candidate and operational exclusion', ['-ceu', preflightInvocation('initial')], { entrypoint: 'bash' });
    }

    let discovery = candidateState(stepBlock(canonical, 'Require successful Artifact Analysis scan'));
    if (sessionCutover) {
        // Current regional scan responses include this optional timestamp.
        // Keep the frozen policy intact and validate the added field explicitly.
        discovery = replaceExactly(discovery,
            '"analysisError", "analysisStatusError"}',
            '"analysisError", "analysisStatusError", "lastVulnerabilityUpdateTime"}');
        discovery = replaceExactly(discovery,
            '        last_scan = parse_time(body.get("lastScanTime"), "lastScanTime")',
            '        last_scan = parse_time(body.get("lastScanTime"), "lastScanTime")\n'
            + '        if "lastVulnerabilityUpdateTime" in body:\n'
            + '            parse_time(body["lastVulnerabilityUpdateTime"], "lastVulnerabilityUpdateTime")');
    }
    const severity = candidateState(stepBlock(canonical, 'Enforce Artifact Analysis severity policy'));
    let deletion = stepBlock(canonical, 'Validate account-deletion deployment contract');
    const deletionEnvironment = accountDeletionEnvironment(pins.accountDeletion);
    const googleEnvironment = googleSignInEnvironment(pins.googleSignIn, pins.accountDeletion);
    for (const [name, value] of Object.entries({
        _ACCOUNT_DELETION_ENABLED: deletionEnvironment.ACCOUNT_DELETION_ENABLED,
        _ACCOUNT_DELETION_JOURNAL_BUCKET: deletionEnvironment.ACCOUNT_DELETION_JOURNAL_BUCKET ?? '',
        _ACCOUNT_IDENTITY_EPOCH: deletionEnvironment.ACCOUNT_IDENTITY_EPOCH ?? '',
        _ACCOUNT_DELETION_APPROVAL: accountDeletionApproval(pins),
        _PROVIDER_AUTH_ENABLED: googleEnvironment.PROVIDER_AUTH_ENABLED,
        _PROVIDER_GOOGLE_SIGNUP_ENABLED: googleEnvironment.PROVIDER_GOOGLE_SIGNUP_ENABLED,
        _GOOGLE_WEB_CLIENT_ID: googleEnvironment.GOOGLE_WEB_CLIENT_ID ?? '',
        _GOOGLE_SIGN_IN_APPROVAL: googleSignInApproval(pins),
    })) deletion = replaceExactly(deletion, `\${${name}}`, value);
    let deploy = candidateState(stepBlock(canonical, 'Deploy deterministic zero-traffic candidate'));
    deploy = replaceExactly(deploy, 'DB_PASS=DB_PASS:1,SESSION_SECRET=SESSION_SECRET:2',
        `DB_PASS=DB_PASS:1,SESSION_SECRET=SESSION_SECRET:${pins.sessionSecretVersion}`);
    deploy = replaceExactly(deploy, "readonly TRIGGER_ID='ef5a2981-95be-4f4d-af91-f997fde73356'", `readonly TRIGGER_ID='${pins.sourceTriggerId}'`);
    if (!sessionCutover) deploy = replaceExactly(deploy, 'P4_VEGA_SCORE_SUBMISSIONS_ENABLED=true,THREE_BOSSES_RUN_SUBMISSIONS_ENABLED=true',
        'P4_VEGA_SCORE_SUBMISSIONS_ENABLED=false,THREE_BOSSES_RUN_SUBMISSIONS_ENABLED=false');
    deploy = replaceExactly(deploy, "        if [[ \"$$revision_preexisted\" == 'false' ]]; then", `        ${preflightInvocation('before-deploy')}\n\n        if [[ "$$revision_preexisted" == 'false' ]]; then`);
    // Never mistake an auth/transport error for a absent deterministic revision.
    deploy = replaceExactly(deploy,
        '        revision_preexisted=false\n        deployed_here=false\n        if gcloud run revisions describe "$$REVISION_NAME" --project="$$PROJECT_ID" \\\n          --region="$$RUN_REGION" --platform=managed --format=json > "$$REVISION_JSON" 2>/dev/null; then\n          revision_preexisted=true\n        fi',
        '        revision_preexisted=false\n        deployed_here=false\n        gcloud run revisions list --service="$$SERVICE_NAME" --project="$$PROJECT_ID" \\\n          --region="$$RUN_REGION" --platform=managed --format=json > /workspace/frozen-revisions.json\n        python3 - /workspace/frozen-revisions.json "$$REVISION_NAME" <<\'PY\'\n        import json, sys\n        with open(sys.argv[1], encoding="utf-8") as handle:\n            revisions = json.load(handle)\n        if not isinstance(revisions, list) or any(item.get("metadata", {}).get("name") == sys.argv[2] for item in revisions):\n            raise SystemExit("Frozen revision already exists or inventory is malformed; inspect it instead of redeploying")\n        PY');

    let verify = candidateState(stepBlock(canonical, 'Verify runtime and unchanged traffic'));
    verify = replaceExactly(verify, '"SESSION_SECRET": "2"', `"SESSION_SECRET": "${pins.sessionSecretVersion}"`);
    verify = replaceExactly(verify, "readonly TRIGGER_ID='ef5a2981-95be-4f4d-af91-f997fde73356'", `readonly TRIGGER_ID='${pins.sourceTriggerId}'`);
    verify = replaceExactly(verify, '        readonly NOTIFICATION_JSON=\'/workspace/slack-notification.json\'\n', '');
    if (!sessionCutover) {
        verify = replaceExactly(verify, '"P4_VEGA_SCORE_SUBMISSIONS_ENABLED": "true"', '"P4_VEGA_SCORE_SUBMISSIONS_ENABLED": "false"');
        verify = replaceExactly(verify, '"THREE_BOSSES_RUN_SUBMISSIONS_ENABLED": "true"', '"THREE_BOSSES_RUN_SUBMISSIONS_ENABLED": "false"');
    }
    const notificationStart = verify.indexOf('        duplicate="$$(python3');
    if (notificationStart < 0) throw new Error('Canonical duplicate/notifier boundary changed.');
    verify = verify.slice(0, notificationStart) + `        ${preflightInvocation('after-deploy')}\n`;

    let smoke = candidateState(stepBlock(canonical, 'Smoke test tagged candidate anonymously'));
    if (!sessionCutover) {
        smoke = replaceExactly(smoke, '"submissionState": "enabled"', '"submissionState": "disabled"');
        smoke = replaceExactly(smoke, '"/api/leaderboards/three-bosses/run-tickets", 401, {', '"/api/leaderboards/three-bosses/run-tickets", 403, {');
        smoke = replaceExactly(smoke, '"/api/leaderboards/three-bosses/runs", 401, {', '"/api/leaderboards/three-bosses/runs", 403, {');
        smoke = replaceExactly(smoke, '"error": "UNAUTHORIZED",', '"error": "SUBMISSION_DISABLED",', 2);
        smoke = replaceExactly(smoke, '"/api/users", 401, {"type": "submit_score", "p4_score": 10}', '"/api/users", 503, {"type": "submit_score", "p4_score": 10}');
        smoke = replaceExactly(smoke, '{"error": "UNAUTHORIZED"}', '{"error": "SUBMISSIONS_FROZEN"}');
        smoke = smoke.replaceAll('enabled Three Bosses', 'frozen Three Bosses').replaceAll('enabled p4-Vega', 'frozen p4-Vega');
    } else {
        deploy = deploy.replaceAll('/workspace/frozen-revisions.json', '/workspace/session-revisions.json')
            .replaceAll('Frozen revision already exists', 'Session revision already exists');
        smoke = replaceExactly(smoke, '            attempt = 0',
            '            if path == "/auth/renew":\n                headers["Origin"] = "https://mickeyf.com"\n            attempt = 0');
        smoke = replaceExactly(smoke, '        catalog, catalog_headers = request("/api/leaderboards", 200)', [
            '        renewal, renewal_headers = request("/auth/renew", 200, {})',
            '        if (not isinstance(renewal, dict) or set(renewal) != {"loggedIn"}',
            '                or renewal["loggedIn"] is not False):',
            '            reject("anonymous renewable-session contract does not match")',
            '        if not no_store(renewal_headers) or renewal_headers.get_all("Set-Cookie"):',
            '            reject("anonymous renewable-session headers are unsafe")',
            '',
            '        catalog, catalog_headers = request("/api/leaderboards", 200)',
        ].join('\n'));
    }

    const steps = parseReviewedSteps(initial + discovery + severity + deletion + deploy + verify + smoke);
    if (providerCutover) {
        // The canonical deletion guard still validates the journal, identity epoch and old runtime first.
        // The provider-bound preflight authorizes the whole additional configuration, not just Google flags.
        const providerContract = [
            'def check_provider_baseline(container):',
            '    with open("/workspace/session-pins.json", encoding="utf-8") as handle: pins = json.load(handle)',
            '    previous = pins.get("previousProviderRelease")',
            '    expected = previous["environment"] if previous else {}',
            '    observed = [item for item in container.get("env", []) if item.get("name") not in {"NODE_ENV", "CLOUD_SQL_CONNECTION_NAME", "DB_USER", "DB_NAME", "P4_VEGA_SCORE_SUBMISSIONS_ENABLED", "THREE_BOSSES_RUN_SUBMISSIONS_ENABLED", "DB_PASS", "SESSION_SECRET"}]',
            '    if not previous:',
            '        if any(item != {"name": item.get("name"), "value": "false"} or item.get("name") not in {"ACCOUNT_DELETION_ENABLED", "PROVIDER_AUTH_ENABLED", "PROVIDER_GOOGLE_SIGNUP_ENABLED"} for item in observed): reject("unreviewed previous provider settings")',
            '        if len({item["name"] for item in observed}) != len(observed): reject("duplicate previous provider settings")',
            '    elif sorted(observed, key=lambda item:item.get("name", "")) != [{"name": name, "value": value} for name, value in sorted(expected.items())]:',
            '        reject("previous provider configuration differs from the reviewed transition")',
            '',
        ].join('\n');
        const contractSource = steps[4].args[1];
        const guardName = /def (check_google_[a-z_]+)\(container,/u.exec(contractSource)?.[1];
        if (!guardName) throw new Error('Canonical prior-provider guard changed');
        const start = contractSource.indexOf(`def ${guardName}(`);
        const end = contractSource.indexOf('\ndef ', start + 1);
        if (end < 0) throw new Error('Canonical provider guard boundary changed');
        steps[4].args[1] = contractSource.slice(0, start) + providerContract
            + `def ${guardName}(container, *args):\n    check_provider_baseline(container)\n` + contractSource.slice(end);
        steps[4].args[1] += [
            '', 'if __name__ == "__main__":',
            '    with open("/workspace/session-pins.json", encoding="utf-8") as handle: provider = json.load(handle)["providerRelease"]',
            '    with open("/workspace/account-deletion-contract.json", encoding="utf-8") as handle: contract = json.load(handle)',
            '    contract["environment"].update(provider["environment"])',
            '    with open("/workspace/account-deletion-contract.json", "w", encoding="utf-8") as handle: json.dump(contract, handle)',
            '    environment = dict(contract["environment"], NODE_ENV="production", CLOUD_SQL_CONNECTION_NAME="noted-reef-387021:us-central1:cms-mickeyf", DB_USER="cms_mickeyf", DB_NAME="cms", P4_VEGA_SCORE_SUBMISSIONS_ENABLED="true", THREE_BOSSES_RUN_SUBMISSIONS_ENABLED="true")',
            '    with open("/workspace/provider-environment.json", "x", encoding="utf-8") as handle: json.dump(environment, handle)',
        ].join('\n');
        steps[5].args[1] = replaceExactly(steps[5].args[1],
            '--set-env-vars="NODE_ENV=production,CLOUD_SQL_CONNECTION_NAME=$$CLOUD_SQL,DB_USER=cms_mickeyf,DB_NAME=cms,P4_VEGA_SCORE_SUBMISSIONS_ENABLED=true,THREE_BOSSES_RUN_SUBMISSIONS_ENABLED=true,$$DELETION_ENV"',
            '--env-vars-file=/workspace/provider-environment.json');
        // Do not interpolate arbitrary consent text into the shell, even into an unused variable.
        steps[5].args[1] = replaceExactly(steps[5].args[1],
            'print(",".join(f"{key}={value}" for key, value in sorted(contract["environment"].items())))',
            'print("provider-environment-file-verified")');
        const publicProbe = [
            'with open("/workspace/session-pins.json", encoding="utf-8") as handle: provider = json.load(handle)["providerRelease"]',
            'active = provider["phase"] == "active"',
            'settings = provider["environment"]',
            'expected_clients = []',
            'if active:',
            '    expected_clients = [',
            '        {"clientKey":"google-web","provider":"google","platform":"web","clientId":settings["GOOGLE_WEB_CLIENT_ID"],"signup":True},',
            '        {"clientKey":"google-ios","provider":"google","platform":"ios","clientId":settings["GOOGLE_WEB_CLIENT_ID"],"signup":True},',
            '        {"clientKey":"apple-ios","provider":"apple","platform":"ios","clientId":settings["APPLE_IOS_BUNDLE_ID"],"signup":True},',
            '        {"clientKey":"apple-web","provider":"apple","platform":"web","clientId":settings["APPLE_WEB_SERVICES_ID"],"redirectUri":settings["APPLE_WEB_REDIRECT_URI"],"signup":True},',
            '    ]',
            'providers, provider_headers = request("/auth/providers/config", 200)',
            'if (not isinstance(providers, dict) or set(providers) != {"clients"} or not isinstance(providers["clients"], list)',
            '        or sorted(providers["clients"], key=lambda client:client.get("clientKey", "")) != sorted(expected_clients, key=lambda client:client["clientKey"])):',
            '    reject("provider capability/configuration differs; runtime credential loading may be unavailable")',
            'registration, registration_headers = request("/auth/registration/config", 200)',
            'expected_registration = {"enabled":False}',
            'if active:',
            '    expected_registration = {"enabled":True,"policyVersion":settings["REGISTRATION_POLICY_VERSION"],"parentRegistrationAvailable":False,',
            '        "countries":[{"country":country,"parentRequiredBelow":rule["parentRequiredBelow"],"adultFrom":18}',
            '            for country,rule in sorted(json.loads(settings["REGISTRATION_COUNTRY_RULES"]).items())]}',
            'if registration != expected_registration: reject("registration policy differs from the reviewed release")',
            'for headers in (provider_headers, registration_headers):',
            '    if not no_store(headers) or headers.get_all("Set-Cookie"): reject("public auth configuration has unsafe headers")',
        ].join('\n');
        const smokeSource = replaceExactly(steps[7].args.slice(3).join(''),
            'print("Tagged candidate anonymous HTTP and database-read smoke tests passed.")',
            publicProbe + '\nprint("Tagged candidate anonymous HTTP and public capability checks passed; real provider acceptance is separate.")');
        steps[7].args[1] = replaceExactly(steps[7].args[1], 'printf \'%s%s\' "$$1" "$$2"', 'printf \'%s%s%s\' "$$1" "$$2" "$$3"');
        steps[7].args.splice(3, steps[7].args.length - 3, smokeSource.slice(0, 8000), smokeSource.slice(8000, 16000), smokeSource.slice(16000));
    }
    if (steps.some((step) => step.args.some((argument) => argument.length > 10_000))) throw new Error('Rendered Cloud Build argument exceeds 10,000 characters.');
    return { steps, serviceAccount: deployIdentity,
        substitutions: { _DEPLOY_TRIGGER_ID: 'INVALID', _APPROVAL: 'INVALID' },
        timeout: '2400s', options: { logging: 'CLOUD_LOGGING_ONLY' } };
}

export const renderFrozenBackendDeploy = (input) => JSON.stringify(renderFrozenBackendDeployConfig(input), null, 2) + '\n';

async function main() {
    const hashOnly = process.argv[2] === '--steps-sha256';
    if (process.argv.length !== (hashOnly ? 6 : 3)) throw new Error('Usage: node scripts/render-frozen-backend-deploy.mjs <reviewed-pins.json> (prints JSON) OR --steps-sha256 <reviewed-pins.json> <deployment-build-id> <deployment-trigger-id>. Both modes are offline.');
    const pinsPath = process.argv[hashOnly ? 3 : 2];
    const [canonical, candidate, preflight, pins] = await Promise.all([
        readFile(new URL('../cloudbuild.deploy.yaml', import.meta.url), 'utf8'),
        readFile(new URL('../cloudbuild.candidate.yaml', import.meta.url), 'utf8'),
        readFile(new URL('./render-frozen-backend-deploy.preflight.py', import.meta.url), 'utf8'),
        readFile(pinsPath, 'utf8'),
    ]);
    const parsedPins = JSON.parse(pins);
    const input = { canonical, candidate, preflight, pins: parsedPins };
    if (hashOnly) {
        const config = renderFrozenBackendDeployConfig(input);
        const steps = resolveFrozenDeploymentSteps(config.steps, {
            buildId: process.argv[4], deploymentTriggerId: process.argv[5],
            approval: frozenDeploymentApproval(parsedPins),
        });
        process.stdout.write(frozenDeploymentStepsSha256(steps) + '\n');
    } else process.stdout.write(renderFrozenBackendDeploy(input));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
    main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
