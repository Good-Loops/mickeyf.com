// Offline rendering only. A source-less approved Cloud Build performs the separate zero-traffic deployment.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { renderProviderBackendDeployConfig, providerDeploymentApproval, resolveProviderDeploymentSteps,
    frozenDeploymentStepsSha256 } from './render-frozen-backend-deploy.mjs';

export async function main(args) {
    const hashOnly = args[0] === '--steps-sha256';
    if (args.length !== (hashOnly ? 4 : 1)) throw new Error('Usage: <reviewed-pins.json> OR --steps-sha256 <reviewed-pins.json> <deployment-build-id> <deployment-trigger-id>; offline only.');
    const [canonical, candidate, preflight, raw] = await Promise.all([
        readFile(new URL('../cloudbuild.deploy.yaml', import.meta.url), 'utf8'),
        readFile(new URL('../cloudbuild.candidate.yaml', import.meta.url), 'utf8'),
        readFile(new URL('./render-frozen-backend-deploy.preflight.py', import.meta.url), 'utf8'),
        readFile(args[hashOnly ? 1 : 0], 'utf8'),
    ]);
    const pins = JSON.parse(raw);
    const config = renderProviderBackendDeployConfig({ canonical, candidate, preflight, pins });
    if (hashOnly) console.log(frozenDeploymentStepsSha256(resolveProviderDeploymentSteps(config.steps, {
        buildId: args[2], deploymentTriggerId: args[3], approval: providerDeploymentApproval(pins),
    })));
    else console.log(JSON.stringify(config, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
