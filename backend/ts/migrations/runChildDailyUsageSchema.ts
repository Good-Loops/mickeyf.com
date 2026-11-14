import { assertMutationAuthorized } from '../config/migrationConfig';
import { assertChildSchemaCleanSource, childSchemaCommandSettings, createChildSchemaConnection,
    readChildSchemaPrerequisites } from './runChildSignedFormSchema';
import { applyDailyUsageSchema, planDailyUsageSchema, verifyDailyUsageSchema, DailyUsageSchemaError,
    type DailyUsageSchemaPlan } from './childDailyUsageSchemaOperation';

const failure = 'Daily usage schema command blocked; private database details were not logged.';
async function readPlan(): Promise<DailyUsageSchemaPlan> {
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const chunk of process.stdin) {
        const data = Buffer.from(chunk); bytes += data.length;
        if (bytes > 262_144) throw new Error(failure);
        chunks.push(data);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as DailyUsageSchemaPlan;
}
export async function runChildDailyUsageSchema(args = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<void> {
    if (!((args[0] === 'verify' && args.length === 1) || (['plan', 'apply'].includes(args[0])
        && args.length === 3 && args[1] === '--pins' && args[2]))) throw new Error(failure);
    const loaded = childSchemaCommandSettings(env);
    const assertSource = () => assertChildSchemaCleanSource(loaded.source.sourceCommit, undefined, env);
    assertSource();
    if (args[0] === 'apply') assertMutationAuthorized(loaded.config, env);
    const plan = args[0] === 'apply' ? await readPlan() : undefined;
    const session = createChildSchemaConnection(loaded.config);
    const deps = { ...loaded, connection: session.connection, assertSource,
        observeSafety: async (approved?: DailyUsageSchemaPlan) => readChildSchemaPrerequisites(args[2], approved, env) };
    try {
        const result = plan ? await applyDailyUsageSchema(deps, plan, { allow: env.MIGRATION_ALLOW_APPLY === '1',
            planSha256: env.MIGRATION_APPROVED_PLAN_SHA256 ?? '', serverUuid: env.MIGRATION_CONFIRM_SERVER_UUID ?? '' })
            : args[0] === 'verify' ? await verifyDailyUsageSchema(deps) : await planDailyUsageSchema(deps);
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } finally { await session.close(); }
}
if (require.main === module) runChildDailyUsageSchema().catch(error => {
    console.error(error instanceof DailyUsageSchemaError ? `${error.state}: ${error.message}` : failure);
    process.exitCode = 1;
});
