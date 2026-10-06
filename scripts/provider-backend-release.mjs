// Separate explicit entrypoint: session-only CLI plans cannot authorize provider mutations.
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { fingerprint, readJson, accessToken, createSessionCloudProvider } from './frozen-backend-traffic.mjs';
import { captureProviderBaseline, planProviderTraffic, applyProviderTraffic, validateProviderTrafficPins } from './session-backend-traffic.mjs';
import { planProviderRollbackDeployment, applyProviderRollbackDeployment, createProviderRollbackDeploymentProvider } from './session-backend-rollback.mjs';

export async function main(args) {
    const [mode, ...rest] = args;
    if (mode === '--help') {
        console.log('Read-only: baseline [--previous-configuration <public-config.json>] --output <new.json>; plan-rollback --pins <reviewed.json> --output <new.json>; plan-traffic --operation promote|rollback --pins <reviewed.json> --output <new.json>\nWrite: apply-rollback OR apply-traffic --plan <reviewed-plan.json> --confirm-plan <sha256> --confirm-provider-rollback-creation OR --confirm-provider-promotion OR --confirm-provider-rollback');
        return;
    }
    const options = {};
    for (let index = 0; index < rest.length; index++) {
        const key = rest[index];
        if (!key.startsWith('--') || Object.hasOwn(options, key)) throw new Error('Invalid or duplicate option');
        options[key] = key.startsWith('--confirm-provider-') ? true : rest[++index];
        if (!options[key] || String(options[key]).startsWith('--')) throw new Error('Missing option value');
    }
    const exact = names => {
        if (Object.keys(options).sort().join() !== names.sort().join()) throw new Error('Unexpected or missing arguments');
    };
    const save = async value => {
        await writeFile(options['--output'], JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
        console.log(JSON.stringify({ writes: false, planSha256: fingerprint(value), output: options['--output'] }));
    };
    if (mode === 'baseline') {
        exact(['--output', ...Object.hasOwn(options, '--previous-configuration') ? ['--previous-configuration'] : []]);
        const previous = options['--previous-configuration'] ? await readJson(options['--previous-configuration']) : undefined;
        await save(await captureProviderBaseline(createSessionCloudProvider(accessToken()), previous));
    } else if (mode === 'plan-rollback' || mode === 'plan-traffic') {
        exact(['--pins', '--output', ...mode === 'plan-traffic' ? ['--operation'] : []]);
        const pins = validateProviderTrafficPins(await readJson(options['--pins']));
        if (mode === 'plan-traffic' && !['promote', 'rollback'].includes(options['--operation'])) throw new Error('Choose promote or rollback');
        const provider = createProviderRollbackDeploymentProvider(accessToken());
        await save(mode === 'plan-rollback' ? await planProviderRollbackDeployment(provider, pins)
            : await planProviderTraffic(createSessionCloudProvider(accessToken()), pins, options['--operation']));
    } else if (mode === 'apply-rollback' || mode === 'apply-traffic') {
        const plan = await readJson(options['--plan']);
        const suffix = mode === 'apply-rollback' ? 'rollback-creation' : plan.operation === 'promote' ? 'promotion'
            : plan.operation === 'rollback' ? 'rollback' : undefined;
        if (!suffix) throw new Error('Unknown provider operation');
        exact(['--plan', '--confirm-plan', `--confirm-provider-${suffix}`]);
        if (plan.schemaVersion !== 2 || fingerprint(plan) !== options['--confirm-plan']) throw new Error('Provider plan/confirmation differs');
        validateProviderTrafficPins(plan.pins);
        console.log(JSON.stringify(mode === 'apply-rollback'
            ? await applyProviderRollbackDeployment(createProviderRollbackDeploymentProvider(accessToken()), plan, options['--confirm-plan'])
            : await applyProviderTraffic(createSessionCloudProvider(accessToken()), plan, options['--confirm-plan'])));
    } else throw new Error('Choose an explicit provider operation; no default mutation');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main(process.argv.slice(2)).catch(error => { console.error(`Provider release refused: ${error.message}`); process.exitCode = 1; });
}
