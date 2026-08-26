import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const configPath = fileURLToPath(new URL('../cloudbuild.candidate.yaml', import.meta.url));
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

async function readCandidateConfig() {
    const config = await readFile(configPath, 'utf8');

    return config.replace(/\r\n?/gu, '\n');
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
