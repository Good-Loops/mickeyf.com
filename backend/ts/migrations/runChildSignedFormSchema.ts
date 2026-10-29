import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import mysql, { type Connection } from 'mysql2/promise';
import { loadMigrationConfig, loadMigrationAccountConfirmation, assertDatabaseConfirmation,
    assertMutationAuthorized } from '../config/migrationConfig';
import { PRODUCTION_CLOUD_SQL_TARGET } from '../security/cloudSqlRuntimeRoleRemover';
import type { MigrationConnection } from './leaderboardSchema';
import { CHILD_SIGNED_FORM_SQL_SHA256, ChildSignedFormOperationError,
    planChildSignedFormOperation, applyChildSignedFormOperation, verifyChildSignedFormOperation,
    type ChildSignedFormOperationDependencies, type ChildSignedFormPlan, type ChildReleaseSafety } from './childSignedFormOperation';

const BACKEND = path.resolve(__dirname, '../..');
const ROOT = path.resolve(BACKEND, '..');
const PRIVATE_FAILURE = 'Child signed-form schema command blocked; private process and database details were not logged.';
type Environment = Readonly<Record<string, string | undefined>>;

export function assertChildSchemaCleanSource(expected: string, run = spawnSync, env: Environment = process.env): void {
    if (!/^[a-f0-9]{40}$/u.test(expected)) throw new Error(PRIVATE_FAILURE);
    for (const [args, accepted] of [
        [['rev-parse', '--verify', 'HEAD'], expected],
        [['status', '--porcelain=v1', '--untracked-files=normal'], ''],
    ] as const) {
        const result = run('git', [...args], { cwd: ROOT, shell: false, windowsHide: true,
            env: childSchemaPrerequisiteEnvironment(env), encoding: 'utf8', timeout: 10_000, maxBuffer: 65_536 });
        if (result.error || result.status !== 0 || result.stdout.trim() !== accepted) throw new Error(PRIVATE_FAILURE);
    }
}

export function childSchemaCommandSettings(env: Environment) {
    const config = loadMigrationConfig(env);
    assertDatabaseConfirmation(config, env.MIGRATION_CONFIRM_DATABASE);
    const target = { project: PRODUCTION_CLOUD_SQL_TARGET.project, instance: PRODUCTION_CLOUD_SQL_TARGET.instance,
        database: 'cms', serverUuid: PRODUCTION_CLOUD_SQL_TARGET.serverUuid };
    if (config.database !== target.database
        || env.MIGRATION_CONFIRM_TARGET !== `${config.host}:${config.port}/${config.database}`
        || env.MIGRATION_CONFIRM_SERVER_UUID !== target.serverUuid
        || env.MIGRATION_CONFIRM_CLOUD_SQL_PROJECT !== target.project
        || env.MIGRATION_CONFIRM_CLOUD_SQL_INSTANCE !== target.instance
        || env.MIGRATION_CONFIRM_CLOUD_SQL_CONNECTION_NAME !== PRODUCTION_CLOUD_SQL_TARGET.connectionName
        || !/^8\.0\.31(?:[-.]|$)/u.test(env.MIGRATION_CONFIRM_SERVER_VERSION ?? '')
        || !env.MIGRATION_CONFIRM_VERSION_COMMENT || env.MIGRATION_CONFIRM_VERSION_COMMENT.length > 255) throw new Error(PRIVATE_FAILURE);
    const currentUser = loadMigrationAccountConfirmation(env);
    if (currentUser.slice(0, currentUser.lastIndexOf('@')) !== config.user || config.user === 'cms_mickeyf') throw new Error(PRIVATE_FAILURE);
    const sourceCommit = env.CHILD_SIGNED_FORM_SOURCE_COMMIT ?? '';
    if (!/^[a-f0-9]{40}$/u.test(sourceCommit)) throw new Error(PRIVATE_FAILURE);
    return { config, source: { sourceCommit, sqlSha256: CHILD_SIGNED_FORM_SQL_SHA256 },
        settings: { target, expectedCurrentUser: currentUser, expectedServerVersion: env.MIGRATION_CONFIRM_SERVER_VERSION!,
            expectedVersionComment: env.MIGRATION_CONFIRM_VERSION_COMMENT } };
}

export function childSchemaPrerequisiteEnvironment(env: Environment): NodeJS.ProcessEnv {
    // The cloud reader never needs SQL credentials or Node preload hooks.
    const allowed = new Set(['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL',
        'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'CLOUDSDK_CONFIG', 'CLOUDSDK_PYTHON', 'CLOUDSDK_PYTHON_SITEPACKAGES']);
    return Object.fromEntries(Object.entries(env).filter(([key, value]) => allowed.has(key.toUpperCase()) && typeof value === 'string'));
}

export function readChildSchemaPrerequisites(pinsPath: string, approvedPlan?: ChildSignedFormPlan,
    env: Environment = process.env, run = spawnSync): ChildReleaseSafety {
    const pins = path.resolve(pinsPath);
    const file = lstatSync(pins);
    if (!file.isFile() || file.size > 131_072 || file.size === 0) throw new Error(PRIVATE_FAILURE);
    // Pins are the sole permitted input path. The reader validates their exact provider-traffic shape.
    JSON.parse(readFileSync(pins, 'utf8'));
    const args = [path.join(ROOT, 'scripts/child-schema-verifier.mjs'), 'prerequisites', pins];
    if (approvedPlan) args.push('--recheck-approved-plan', approvedPlan.sha256);
    const result = run(process.execPath, args, { cwd: ROOT, shell: false, windowsHide: true,
        env: childSchemaPrerequisiteEnvironment(env), input: approvedPlan ? JSON.stringify(approvedPlan) : undefined,
        encoding: 'utf8', timeout: approvedPlan ? 120_000 : 480_000, maxBuffer: 131_072 });
    if (result.error || result.status !== 0 || typeof result.stdout !== 'string' || result.stdout.length > 65_536) throw new Error(PRIVATE_FAILURE);
    try { return JSON.parse(result.stdout) as ChildReleaseSafety; } catch { throw new Error(PRIVATE_FAILURE); }
}

/** A dedicated session is discarded physically on timeout; no queued cleanup or later DDL may run. */
export function createChildSchemaConnection(config: ReturnType<typeof loadMigrationConfig>, connect = mysql.createConnection) {
    let raw: Connection | undefined, discarded = false, deadline = Infinity;
    const discard = () => {
        discarded = true;
        try { raw?.destroy(); } finally {
            (raw as unknown as { connection?: { stream?: { destroy(): void } } } | undefined)?.connection?.stream?.destroy();
        }
    };
    const connection: MigrationConnection = { destroy: discard, async query(sql, values) {
        if (discarded || performance.now() >= deadline) { discard(); throw new Error(PRIVATE_FAILURE); }
        if (!raw) {
            deadline = performance.now() + config.operationTimeoutMs;
            raw = await connect({ host: config.host, port: config.port, user: config.user,
                password: config.password, database: config.database, connectTimeout: Math.min(10_000, config.operationTimeoutMs),
                // Strict schema checks need numeric metadata; unsafe BIGINT values must remain exact strings.
                multipleStatements: false, supportBigNumbers: true, bigNumberStrings: false });
        }
        const remaining = Math.floor(deadline - performance.now());
        if (discarded || remaining <= 0) { discard(); throw new Error(PRIVATE_FAILURE); }
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            return await Promise.race([raw.query({ sql, timeout: remaining }, values), new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => { discard(); reject(new Error(PRIVATE_FAILURE)); }, remaining);
            })]) as [unknown, unknown];
        } catch (error) { discard(); throw error; }
        finally { if (timer) clearTimeout(timer); }
    } };
    return { connection, async close() {
        if (!raw || discarded) return;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([raw.end(), new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => { discard(); reject(new Error(PRIVATE_FAILURE)); }, 1_000);
        })]); } finally { if (timer) clearTimeout(timer); }
    } };
}

async function readApprovedPlan(): Promise<ChildSignedFormPlan> {
    let bytes = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
        const buffer = Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > 262_144) throw new Error(PRIVATE_FAILURE);
        chunks.push(buffer);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as ChildSignedFormPlan;
}

export async function runChildSignedFormSchema(args = process.argv.slice(2), env: Environment = process.env): Promise<void> {
    const command = args[0];
    if (!((command === 'verify' && args.length === 1)
        || ((command === 'plan' || command === 'apply') && args.length === 3 && args[1] === '--pins' && args[2]))) throw new Error(PRIVATE_FAILURE);
    const loaded = childSchemaCommandSettings(env);
    const assertSource = () => assertChildSchemaCleanSource(loaded.source.sourceCommit);
    assertSource();
    if (command === 'apply') assertMutationAuthorized(loaded.config, env);
    const approvedPlan = command === 'apply' ? await readApprovedPlan() : undefined;
    const session = createChildSchemaConnection(loaded.config);
    const deps: ChildSignedFormOperationDependencies = { ...loaded, connection: session.connection, assertSource,
        operationTimeoutMs: loaded.config.operationTimeoutMs,
        advisoryLockTimeoutSeconds: loaded.config.advisoryLockTimeoutSeconds,
        lockWaitTimeoutSeconds: loaded.config.lockWaitTimeoutSeconds,
        observeReleaseSafety: async plan => readChildSchemaPrerequisites(args[2], plan, env) };
    try {
        const result = command === 'plan' ? await planChildSignedFormOperation(deps)
            : command === 'verify' ? await verifyChildSignedFormOperation(deps)
                : await applyChildSignedFormOperation(deps, approvedPlan!, {
                    approvedPlanSha256: env.MIGRATION_APPROVED_PLAN_SHA256 ?? '',
                    confirmedServerUuid: env.MIGRATION_CONFIRM_SERVER_UUID ?? '', allowApply: env.MIGRATION_ALLOW_APPLY === '1' });
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } finally { await session.close(); }
}

if (require.main === module) runChildSignedFormSchema().catch(error => {
    console.error(error instanceof ChildSignedFormOperationError ? `${error.code}: ${error.message}` : PRIVATE_FAILURE);
    process.exitCode = 1;
});
