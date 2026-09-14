import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Changing either pin requires reviewing the canonical policy diff, not just
// refreshing hashes. Stage A/B themselves remain main-only and untouched.
export const CANONICAL_SHA256 = '0cad4ab7730c6eef3f6365b365095964385bb942bafa8a883e09c75df3414c41';
export const CANDIDATE_SHA256 = 'dccd0bcf976c77abb3e9fa6d39c1ae855ff127fbf4ec67efd3480e20a4afcda4';
export const DEPLOY_IMAGE = 'gcr.io/google.com/cloudsdktool/cloud-sdk:alpine@sha256:de1a989b158694a614852e7b53673097da3bdb394b8186d6102386b7a10d73c7';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const project = 'noted-reef-387021';
const deployIdentity = `projects/${project}/serviceAccounts/mickeyf-backend-deploy@${project}.iam.gserviceaccount.com`;
const normalize = (text) => text.replace(/\r\n?/gu, '\n');
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

export function validateFrozenPins(value) {
    const keys = ['sourceBuildId', 'sourceCommit', 'imageDigest', 'sourceTriggerId', 'sourceTriggerName', 'sourceRef', 'deploymentTriggerName'];
    if (!value || Object.keys(value).sort().join() !== keys.sort().join()
        || keys.some((key) => typeof value[key] !== 'string')) {
        throw new Error('Supply exactly the seven reviewed source/deployment pins.');
    }
    if (!uuid.test(value.sourceBuildId) || !uuid.test(value.sourceTriggerId)
        || !/^[0-9a-f]{40}$/u.test(value.sourceCommit) || !/^sha256:[0-9a-f]{64}$/u.test(value.imageDigest)
        || !/^[a-z][a-z0-9-]{0,62}$/u.test(value.sourceTriggerName)
        || !/^frozen-backend-[a-z0-9-]{1,47}$/u.test(value.deploymentTriggerName)
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
        if (line === '    args:' && current && !current.args) { current.args = []; continue; }
        const argument = line.match(/^      - (.+)$/u);
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
    if (!uuid.test(buildId) || !uuid.test(deploymentTriggerId)
        || !/^freeze-zero-traffic:[0-9a-f]{40}:[0-9a-f-]{36}:sha256:[0-9a-f]{64}$/u.test(approval)) {
        throw new Error('Resolved steps require the exact deployment build, trigger and approval.');
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

const preflightInvocation = (phase) => `python3 /workspace/frozen-preflight.py /workspace/frozen-pins.json "\${BUILD_ID}" "\${_DEPLOY_TRIGGER_ID}" "\${_APPROVAL}" ${phase}`;

export function renderFrozenBackendDeployConfig({ canonical, candidate, preflight, pins: requestedPins }) {
    canonical = normalize(canonical);
    candidate = normalize(candidate);
    preflight = normalize(preflight);
    if (sha256(canonical) !== CANONICAL_SHA256 || sha256(candidate) !== CANDIDATE_SHA256) {
        throw new Error('Reviewed canonical/image-only configuration hash changed; review before updating the renderer.');
    }
    const pins = validateFrozenPins(requestedPins);
    const payload = Buffer.from(preflight).toString('base64');
    const chunks = payload.match(/.{1,8000}/gu);
    // Base64 avoids Cloud Build treating Python dollar signs as substitutions.
    const materializer = [
        'import base64, hashlib, os, sys',
        'payload = base64.b64decode("".join(sys.argv[3:]), validate=True)',
        'if hashlib.sha256(payload).hexdigest() != sys.argv[1]: raise SystemExit("preflight digest mismatch")',
        'for path, data in (("/workspace/frozen-preflight.py", payload), ("/workspace/frozen-pins.json", sys.argv[2].encode())):',
        '    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)',
        '    with os.fdopen(fd, "wb") as handle: handle.write(data)',
    ].join('\n');
    const initial = yamlStep('Materialize reviewed frozen preflight', ['-c', materializer, sha256(preflight), JSON.stringify(pins), ...chunks])
        + yamlStep('Validate exact frozen candidate and operational exclusion', ['-ceu', preflightInvocation('initial')], { entrypoint: 'bash' });

    const discovery = frozenState(stepBlock(canonical, 'Require successful Artifact Analysis scan'));
    const severity = frozenState(stepBlock(canonical, 'Enforce Artifact Analysis severity policy'));
    let deploy = frozenState(stepBlock(canonical, 'Deploy deterministic zero-traffic candidate'));
    deploy = replaceExactly(deploy, "readonly TRIGGER_ID='ef5a2981-95be-4f4d-af91-f997fde73356'", `readonly TRIGGER_ID='${pins.sourceTriggerId}'`);
    deploy = replaceExactly(deploy, 'P4_VEGA_SCORE_SUBMISSIONS_ENABLED=true,THREE_BOSSES_RUN_SUBMISSIONS_ENABLED=true',
        'P4_VEGA_SCORE_SUBMISSIONS_ENABLED=false,THREE_BOSSES_RUN_SUBMISSIONS_ENABLED=false');
    deploy = replaceExactly(deploy, "        if [[ \"$$revision_preexisted\" == 'false' ]]; then", `        ${preflightInvocation('before-deploy')}\n\n        if [[ "$$revision_preexisted" == 'false' ]]; then`);
    // Never mistake an auth/transport error for a absent deterministic revision.
    deploy = replaceExactly(deploy,
        '        revision_preexisted=false\n        deployed_here=false\n        if gcloud run revisions describe "$$REVISION_NAME" --project="$$PROJECT_ID" \\\n          --region="$$RUN_REGION" --platform=managed --format=json > "$$REVISION_JSON" 2>/dev/null; then\n          revision_preexisted=true\n        fi',
        '        revision_preexisted=false\n        deployed_here=false\n        gcloud run revisions list --service="$$SERVICE_NAME" --project="$$PROJECT_ID" \\\n          --region="$$RUN_REGION" --platform=managed --format=json > /workspace/frozen-revisions.json\n        python3 - /workspace/frozen-revisions.json "$$REVISION_NAME" <<\'PY\'\n        import json, sys\n        with open(sys.argv[1], encoding="utf-8") as handle:\n            revisions = json.load(handle)\n        if not isinstance(revisions, list) or any(item.get("metadata", {}).get("name") == sys.argv[2] for item in revisions):\n            raise SystemExit("Frozen revision already exists or inventory is malformed; inspect it instead of redeploying")\n        PY');

    let verify = frozenState(stepBlock(canonical, 'Verify runtime and unchanged traffic'));
    verify = replaceExactly(verify, "readonly TRIGGER_ID='ef5a2981-95be-4f4d-af91-f997fde73356'", `readonly TRIGGER_ID='${pins.sourceTriggerId}'`);
    verify = replaceExactly(verify, '        readonly NOTIFICATION_JSON=\'/workspace/slack-notification.json\'\n', '');
    verify = replaceExactly(verify, '"P4_VEGA_SCORE_SUBMISSIONS_ENABLED": "true"', '"P4_VEGA_SCORE_SUBMISSIONS_ENABLED": "false"');
    verify = replaceExactly(verify, '"THREE_BOSSES_RUN_SUBMISSIONS_ENABLED": "true"', '"THREE_BOSSES_RUN_SUBMISSIONS_ENABLED": "false"');
    const notificationStart = verify.indexOf('        duplicate="$$(python3');
    if (notificationStart < 0) throw new Error('Canonical duplicate/notifier boundary changed.');
    verify = verify.slice(0, notificationStart) + `        ${preflightInvocation('after-deploy')}\n`;

    let smoke = frozenState(stepBlock(canonical, 'Smoke test tagged candidate anonymously'));
    smoke = replaceExactly(smoke, '"submissionState": "enabled"', '"submissionState": "disabled"');
    smoke = replaceExactly(smoke, '"/api/leaderboards/three-bosses/run-tickets", 401, {', '"/api/leaderboards/three-bosses/run-tickets", 403, {');
    smoke = replaceExactly(smoke, '"/api/leaderboards/three-bosses/runs", 401, {', '"/api/leaderboards/three-bosses/runs", 403, {');
    smoke = replaceExactly(smoke, '"error": "UNAUTHORIZED",', '"error": "SUBMISSION_DISABLED",', 2);
    smoke = replaceExactly(smoke, '"/api/users", 401, {"type": "submit_score", "p4_score": 10}', '"/api/users", 503, {"type": "submit_score", "p4_score": 10}');
    smoke = replaceExactly(smoke, '{"error": "UNAUTHORIZED"}', '{"error": "SUBMISSIONS_FROZEN"}');
    smoke = smoke.replaceAll('enabled Three Bosses', 'frozen Three Bosses').replaceAll('enabled p4-Vega', 'frozen p4-Vega');

    const steps = parseReviewedSteps(initial + discovery + severity + deploy + verify + smoke);
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
            approval: `freeze-zero-traffic:${parsedPins.sourceCommit}:${parsedPins.sourceBuildId}:${parsedPins.imageDigest}`,
        });
        process.stdout.write(frozenDeploymentStepsSha256(steps) + '\n');
    } else process.stdout.write(renderFrozenBackendDeploy(input));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
    main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
