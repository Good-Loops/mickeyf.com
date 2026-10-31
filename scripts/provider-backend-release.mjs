// Separate explicit entrypoint: session-only CLI plans cannot authorize provider mutations.
import { open, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { fingerprint, readJson, accessToken, createSessionCloudProvider } from './frozen-backend-traffic.mjs';
import { captureProviderBaseline, planProviderTraffic, applyProviderTraffic, validateProviderTrafficPins } from './session-backend-traffic.mjs';
import { planProviderRollbackDeployment, applyProviderRollbackDeployment, createProviderRollbackDeploymentProvider } from './session-backend-rollback.mjs';
import { observeProviderReaderBoundary, planProviderActiveRevision, applyProviderActiveRevision,
    planProviderActiveTraffic, applyProviderActiveTraffic, createProviderActivationCloudProvider } from './provider-backend-activation.mjs';

export async function main(args) {
    const [mode, ...rest] = args;
    if (mode === '--help') {
        console.log('Read-only: baseline [--previous-configuration <public-config.json>] --output <new.json>; plan-rollback --pins <reviewed.json> --output <new.json>; plan-traffic --operation promote|rollback --pins <reviewed.json> --output <new.json>\nActivation: observe-reader-boundary --pins <activation-pins.json> --output <new.json>; plan-active-revision --pins <activation-pins.json> --boundary <observation.json> --kind fallback|candidate [--fallback-receipt <receipt.json>] --output <new.json>; plan-active-traffic --receipt <active-receipt.json> --operation activate|close-active --output <new.json>\nWrite: apply-rollback OR apply-traffic OR apply-active-revision OR apply-active-traffic --plan <reviewed-plan.json> --confirm-plan <sha256> plus its explicit --confirm-provider-... flag. Active template writes also require --output <new-receipt.json>.');
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
    if (mode === 'observe-reader-boundary') {
        exact(['--pins', '--output']);
        await save(await observeProviderReaderBoundary(createProviderActivationCloudProvider(accessToken()), await readJson(options['--pins'])));
    } else if (mode === 'plan-active-revision') {
        if (!['fallback', 'candidate'].includes(options['--kind'])) throw new Error('Choose fallback or candidate');
        exact(['--pins', '--boundary', '--kind', '--output', ...(options['--kind'] === 'candidate' ? ['--fallback-receipt'] : [])]);
        await save(await planProviderActiveRevision(createProviderActivationCloudProvider(accessToken()), await readJson(options['--pins']),
            await readJson(options['--boundary']), options['--kind'], options['--fallback-receipt'] ? await readJson(options['--fallback-receipt']) : null));
    } else if (mode === 'plan-active-traffic') {
        exact(['--receipt', '--operation', '--output']);
        if (!['activate', 'close-active'].includes(options['--operation'])) throw new Error('Choose activate or close-active');
        await save(await planProviderActiveTraffic(createProviderActivationCloudProvider(accessToken()), await readJson(options['--receipt']), options['--operation']));
    } else if (mode === 'apply-active-revision') {
        exact(['--plan', '--confirm-plan', '--confirm-provider-active-revision', '--output']);
        const plan = await readJson(options['--plan']);
        if (fingerprint(plan) !== options['--confirm-plan']) throw new Error('Plan SHA256 confirmation differs');
        // Reserve the receipt before a mutation so a reused path cannot discard a successful result.
        const output = await open(options['--output'], 'wx', 0o600);
        try {
            await output.writeFile(JSON.stringify({ status: 'reserved', planSha256: fingerprint(plan), plan }) + '\n');
            const receipt = await applyProviderActiveRevision(createProviderActivationCloudProvider(accessToken()), plan, options['--confirm-plan']);
            const bytes = Buffer.from(JSON.stringify(receipt, null, 2) + '\n');
            await output.truncate(0);
            await output.write(bytes, 0, bytes.length, 0);
            await output.sync();
            console.log(JSON.stringify({ revision: receipt.plan.request.template.revision, percent: 0, tags: [], output: options['--output'] }));
        } finally { await output.close(); }
    } else if (mode === 'apply-active-traffic') {
        const plan = await readJson(options['--plan']);
        const suffix = plan.operation === 'activate' ? 'activation' : plan.operation === 'close-active' ? 'close-active' : undefined;
        if (!suffix) throw new Error('Unknown active traffic operation');
        exact(['--plan', '--confirm-plan', `--confirm-provider-${suffix}`]);
        console.log(JSON.stringify(await applyProviderActiveTraffic(createProviderActivationCloudProvider(accessToken()), plan, options['--confirm-plan'])));
    } else if (mode === 'baseline') {
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
