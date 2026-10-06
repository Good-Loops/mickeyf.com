// Offline, zero-traffic session candidate. Production promotion is a separate operation.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { frozenDeploymentStepsSha256, renderSessionBackendDeployConfig,
    resolveSessionDeploymentSteps, sessionDeploymentApproval } from './render-frozen-backend-deploy.mjs';

async function main() {
    const hashOnly = process.argv[2] === '--steps-sha256';
    if (process.argv.length !== (hashOnly ? 6 : 3)) {
        throw new Error('Usage: node scripts/render-session-backend-deploy.mjs <reviewed-pins.json> OR --steps-sha256 <reviewed-pins.json> <deployment-build-id> <deployment-trigger-id>. Both modes are offline.');
    }
    const [canonical, candidate, preflight, rawPins] = await Promise.all([
        readFile(new URL('../cloudbuild.deploy.yaml', import.meta.url), 'utf8'),
        readFile(new URL('../cloudbuild.candidate.yaml', import.meta.url), 'utf8'),
        readFile(new URL('./render-frozen-backend-deploy.preflight.py', import.meta.url), 'utf8'),
        readFile(process.argv[hashOnly ? 3 : 2], 'utf8'),
    ]);
    const pins = JSON.parse(rawPins);
    const config = renderSessionBackendDeployConfig({ canonical, candidate, preflight, pins });
    if (hashOnly) {
        const steps = resolveSessionDeploymentSteps(config.steps, {
            buildId: process.argv[4], deploymentTriggerId: process.argv[5], approval: sessionDeploymentApproval(pins),
        });
        process.stdout.write(frozenDeploymentStepsSha256(steps) + '\n');
    } else process.stdout.write(JSON.stringify(config, null, 2) + '\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
    main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
