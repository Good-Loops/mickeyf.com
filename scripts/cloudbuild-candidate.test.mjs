import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const configPath = fileURLToPath(new URL('../cloudbuild.candidate.yaml', import.meta.url));
const genericDeployConfigPath = fileURLToPath(
    new URL('../cloudbuild.generic-only.deploy.json', import.meta.url)
);
const dockerfilePath = fileURLToPath(new URL('../Dockerfile', import.meta.url));
const pinnedCloudSdk =
    'gcr.io/google.com/cloudsdktool/cloud-sdk:alpine@sha256:'
    + 'de1a989b158694a614852e7b53673097da3bdb394b8186d6102386b7a10d73c7';
const genericDeployStepIds = Object.freeze([
    'Materialize reviewed source-validation script',
    'Validate exact feature candidate build and provenance',
    'Require successful Artifact Analysis scan',
    'Enforce Artifact Analysis severity policy',
    'Deploy deterministic zero-traffic candidate',
    'Verify runtime and unchanged traffic',
    'Materialize reviewed anonymous-smoke script',
    'Smoke test tagged candidate anonymously',
]);
const expectedConfig = [
    '# Isolated, image-only backend candidate build.',
    '# A separately reviewed manual trigger must supply a full Git COMMIT_SHA.',
    'steps:',
    "  - id: 'Require exact source commit'",
    "    name: 'gcr.io/cloud-builders/docker:latest@sha256:661e95acd923514f71f47ce7b390e06a8d31b15febecf772e506babf62960528'",
    "    entrypoint: 'sh'",
    '    args:',
    "      - '-ceu'",
    '      - |-',
    "        commit='$COMMIT_SHA'",
    '        test "$${#commit}" -eq 40',
    '        case "$$commit" in',
    "          *[!0-9a-f]*) printf 'COMMIT_SHA must be 40 lowercase hexadecimal characters.\\n' >&2; exit 1 ;;",
    '        esac',
    '',
    "  - id: 'Build backend candidate image'",
    "    name: 'gcr.io/cloud-builders/docker:latest@sha256:661e95acd923514f71f47ce7b390e06a8d31b15febecf772e506babf62960528'",
    '    args:',
    "      - 'build'",
    "      - '-t'",
    "      - 'us-central1-docker.pkg.dev/${_GCP_PROJECT_ID}/${_REPO_NAME}/${_REPO_NAME}:$COMMIT_SHA'",
    "      - '.'",
    "    dir: '.'",
    '',
    'images:',
    "  - 'us-central1-docker.pkg.dev/${_GCP_PROJECT_ID}/${_REPO_NAME}/${_REPO_NAME}:$COMMIT_SHA'",
    '',
    'substitutions:',
    "  _GCP_PROJECT_ID: 'noted-reef-387021'",
    "  _REPO_NAME: 'cloud-run-source-deploy'",
    '',
    "serviceAccount: 'projects/noted-reef-387021/serviceAccounts/cloud-build@noted-reef-387021.iam.gserviceaccount.com'",
    '',
    'options:',
    "  logging: 'CLOUD_LOGGING_ONLY'",
    "  requestedVerifyOption: 'VERIFIED'",
    '',
].join('\n');

const expectedAlpineOpenSslPatch = [
    'RUN apk update \\',
    '    && apk add --no-cache --upgrade \\',
    '        libcrypto3=3.5.8-r0 \\',
    '        libssl3=3.5.8-r0 \\',
    "    && apk info --exists 'libcrypto3=3.5.8-r0' > /dev/null \\",
    "    && apk info --exists 'libssl3=3.5.8-r0' > /dev/null \\",
    '    && rm -rf /var/cache/apk/*',
].join('\n');

async function readNormalizedFile(path) {
    const contents = await readFile(path, 'utf8');

    return contents.replace(/\r\n?/gu, '\n');
}

async function readCandidateConfig() {
    return readNormalizedFile(configPath);
}

function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}

function decodeMaterializedScript(step) {
    assert.equal(step.entrypoint, 'python3');
    assert.equal(step.args.length, 5);
    const script = gunzipSync(Buffer.from(step.args[4], 'base64')).toString('utf8');
    assert.equal(sha256(script), step.args[3]);
    return script;
}

test('candidate configuration remains an exact image-only build contract', async () => {
    assert.equal(await readCandidateConfig(), expectedConfig);
});

test('candidate configuration contains no production rollout capabilities', async () => {
    const config = await readCandidateConfig();
    const forbiddenCapabilities = [
        /availableSecrets/iu,
        /cloud[ _-]?sql/iu,
        /cloudsql/iu,
        /gcloud/iu,
        /mickeyf-backend-deploy/iu,
        /mickeyf-runtime/iu,
        /pubsub/iu,
        /secretEnv/iu,
        /secretManager/iu,
        /traffic/iu,
    ];

    for (const forbiddenCapability of forbiddenCapabilities) {
        assert.doesNotMatch(config, forbiddenCapability);
    }
});

test('candidate image patches only the reviewed Alpine OpenSSL packages', async () => {
    const dockerfile = await readNormalizedFile(dockerfilePath);
    const patchOccurrences = dockerfile.split(expectedAlpineOpenSslPatch).length - 1;
    const patchIndex = dockerfile.indexOf(expectedAlpineOpenSslPatch);
    const sharedBaseIndex = dockerfile.indexOf(' AS node-runtime-base');
    const nextStageIndex = dockerfile.indexOf('FROM node-runtime-base AS npm-base');

    assert.equal(patchOccurrences, 1);
    assert.ok(sharedBaseIndex >= 0);
    assert.ok(patchIndex > sharedBaseIndex);
    assert.ok(nextStageIndex > patchIndex);
    assert.match(dockerfile, /^FROM node-runtime-base AS runtime$/mu);

    const dockerfileWithoutReviewedPatch = dockerfile.replace(expectedAlpineOpenSslPatch, '');

    assert.doesNotMatch(dockerfileWithoutReviewedPatch, /\bapk\s+(?:add|fix|update|upgrade)\b/iu);
});

test('generic-only deployment configuration is the exact reviewed source-less contract', async () => {
    const serialized = await readNormalizedFile(genericDeployConfigPath);
    assert.equal(
        sha256(serialized),
        '8afde577fbefe781ed0a0c428f04dad40a5b8f8d147f22f01ccbae86bb9a5bf4'
    );

    const config = JSON.parse(serialized);
    assert.deepEqual(Object.keys(config), ['steps', 'timeout', 'options']);
    assert.equal(config.timeout, '1800s');
    assert.deepEqual(config.options, { logging: 'CLOUD_LOGGING_ONLY' });
    assert.deepEqual(config.steps.map(({ id }) => id), genericDeployStepIds);
    assert.equal(config.steps.length, 8);

    for (const step of config.steps) {
        assert.equal(step.name, pinnedCloudSdk);
        assert.equal(step.env, undefined);
        assert.equal(step.secretEnv, undefined);
        assert.equal(step.volumes, undefined);
        assert.equal(step.waitFor, undefined);
    }
});

test('generic-only deployment pins the exact approved source and signed provenance', async () => {
    const config = JSON.parse(await readNormalizedFile(genericDeployConfigPath));
    const sourceValidation = decodeMaterializedScript(config.steps[0]);

    assert.equal(
        sha256(sourceValidation),
        '59882832d081aa05d5fb2d2d67e0443353e86121d94a923cec1437c5bcf8fec6'
    );
    assert.match(
        sourceValidation,
        /readonly SOURCE_BUILD_ID='d5aee625-983b-4daf-a90d-0db9898341e8'/u
    );
    assert.match(
        sourceValidation,
        /readonly SOURCE_COMMIT='e91d3b1177932614c22fbed059a42a05fcb10793'/u
    );
    assert.match(
        sourceValidation,
        /readonly SOURCE_DIGEST='sha256:3bba5ca29a474c6b75d92f48f93a9efc6cfa3fe32d3a4ddb7b82f2a610baaa48'/u
    );
    assert.match(
        sourceValidation,
        /readonly SOURCE_TRIGGER_ID='648fadca-3cd1-4b57-9d35-0f62a1468443'/u
    );
    assert.match(sourceValidation, /approvalRequired/u);
    assert.match(sourceValidation, /requestedVerifyOption/u);
    assert.match(sourceValidation, /inTotoSlsaProvenanceV1/u);
    assert.match(sourceValidation, /cryptoKeys\/google-hosted-worker/u);
    assert.match(sourceValidation, /f"mickeyf-org-freeze-\{compact_id\}"/u);
    assert.match(sourceValidation, /finished < now - timedelta\(hours=2\)/u);
    assert.doesNotMatch(sourceValidation, /9a6066b4-4f34-422b-ba33-83d6b0e9a9eb/u);
    assert.doesNotMatch(sourceValidation, /5abdc5bb1ee0a0fb947e7bb1024cec8e68438f64/u);
    assert.doesNotMatch(
        sourceValidation,
        /sha256:895c37a932be08721d5977c07577fc7503ae84eed75eb429bccb306fcb061aeb/u
    );
});

test('generic-only deployment is frozen, zero-traffic, scan-zero, and mutation-bounded', async () => {
    const config = JSON.parse(await readNormalizedFile(genericDeployConfigPath));
    const sourceValidation = decodeMaterializedScript(config.steps[0]);
    const anonymousSmoke = decodeMaterializedScript(config.steps[6]);
    const executableText = [
        sourceValidation,
        anonymousSmoke,
        ...config.steps.flatMap(({ args }) => args ?? []),
    ].join('\n');

    assert.equal(executableText.split('gcloud run deploy').length - 1, 1);
    assert.match(executableText, /--image="\$TARGET_IMAGE"/u);
    assert.match(executableText, /--no-traffic --tag="\$CANDIDATE_TAG"/u);
    assert.match(
        executableText,
        /P4_VEGA_SCORE_SUBMISSIONS_ENABLED=false,THREE_BOSSES_RUN_SUBMISSIONS_ENABLED=false/u
    );
    assert.match(executableText, /DB_PASS=DB_PASS:1,SESSION_SECRET=SESSION_SECRET:2/u);
    assert.match(executableText, /artifact-analysis-zero-occurrence-v1/u);
    assert.match(executableText, /if any\(counts\.values\(\)\)/u);
    assert.match(executableText, /positive production traffic allocations changed/u);
    assert.match(executableText, /new revision received production traffic/u);
    assert.match(executableText, /legacy and generic p4-Vega leaderboard reads diverge/u);

    const forbiddenMutations = [
        /gcloud\s+run\s+services\s+(?:replace|update|update-traffic)/iu,
        /gcloud\s+sql\b/iu,
        /gcloud\s+iam\b/iu,
        /gcloud\s+builds\s+triggers\s+(?:create|delete|update)/iu,
        /(?:add|remove)-iam-policy-binding/iu,
        /\b(?:GRANT|REVOKE)\b/u,
        /\bALTER\s+TABLE\b/iu,
        /\bDROP\s+COLUMN\b/iu,
        /runtime-grants/iu,
        /migrations:apply/iu,
        /SLACK_WEBHOOK/iu,
    ];
    for (const forbiddenMutation of forbiddenMutations) {
        assert.doesNotMatch(executableText, forbiddenMutation);
    }
});

test('generic-only deployment retains the reviewed non-mutating smoke contract', async () => {
    const config = JSON.parse(await readNormalizedFile(genericDeployConfigPath));
    const anonymousSmoke = decodeMaterializedScript(config.steps[6]);

    assert.equal(
        sha256(anonymousSmoke),
        'b47e52775c0f68e8b6e093de4725a4de1f246915c09d349662c908f26ea82365'
    );
    assert.match(anonymousSmoke, /request\("\/api\/leaderboards\/p4-vega", 200\)/u);
    assert.match(anonymousSmoke, /"\/api\/users", 503/u);
    assert.match(anonymousSmoke, /"error": "SUBMISSION_DISABLED"/u);
    assert.match(anonymousSmoke, /\{"error": "SUBMISSIONS_FROZEN"\}/u);
    assert.match(anonymousSmoke, /legacy and generic p4-Vega leaderboard reads diverge/u);
    assert.doesNotMatch(anonymousSmoke, /Authorization/iu);
});
