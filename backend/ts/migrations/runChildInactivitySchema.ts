import { assertMutationAuthorized } from '../config/migrationConfig';
import { assertChildSchemaCleanSource, childSchemaCommandSettings, createChildSchemaConnection,
    readChildSchemaPrerequisites } from './runChildSignedFormSchema';
import { applyInactivitySchema, planInactivitySchema, InactivitySchemaError, type InactivitySchemaPlan } from './childInactivitySchemaOperation';

const failure = 'Inactivity schema command blocked; private database details were not logged.';
async function readPlan(): Promise<InactivitySchemaPlan> {
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const chunk of process.stdin) {
        const data = Buffer.from(chunk); bytes += data.length;
        if (bytes > 262_144) throw new Error(failure);
        chunks.push(data);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as InactivitySchemaPlan;
}

export async function runChildInactivitySchema(args = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<void> {
    if (args.length !== 3 || !['plan', 'apply'].includes(args[0]) || args[1] !== '--pins' || !args[2]) throw new Error(failure);
    const loaded = childSchemaCommandSettings(env);
    const assertSource = () => assertChildSchemaCleanSource(loaded.source.sourceCommit, undefined, env);
    assertSource();
    if (args[0] === 'apply') assertMutationAuthorized(loaded.config, env);
    const plan = args[0] === 'apply' ? await readPlan() : undefined;
    const session = createChildSchemaConnection(loaded.config);
    const deps = { ...loaded, connection: session.connection, assertSource,
        observeSafety: async (approved?: InactivitySchemaPlan) => readChildSchemaPrerequisites(args[2], approved, env) };
    try {
        if (plan) {
            await applyInactivitySchema(deps, plan, { allow: env.MIGRATION_ALLOW_APPLY === '1',
                planSha256: env.MIGRATION_APPROVED_PLAN_SHA256 ?? '', serverUuid: env.MIGRATION_CONFIRM_SERVER_UUID ?? '' });
            process.stdout.write('{"created":true}\n');
        } else process.stdout.write(`${JSON.stringify(await planInactivitySchema(deps), null, 2)}\n`);
    } finally { await session.close(); }
}
if (require.main === module) runChildInactivitySchema().catch(error => {
    console.error(error instanceof InactivitySchemaError ? `${error.state}: ${error.message}` : failure);
    process.exitCode = 1;
});
