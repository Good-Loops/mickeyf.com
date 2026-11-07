import { createPrivateKey, createPublicKey, timingSafeEqual, type KeyObject } from 'node:crypto';
import mysql from 'mysql2/promise';
import { loadMigrationConfig, loadMigrationAccountConfirmation, assertDatabaseConfirmation, assertMutationAuthorized } from '../config/migrationConfig';
import { assertChildSchemaCleanSource } from '../migrations/runChildSignedFormSchema';
import { PRODUCTION_CLOUD_SQL_TARGET } from '../security/cloudSqlRuntimeRoleRemover';
import { CHILD_RETENTION_BUCKET } from '../config/childInactivityDeployment';
import { advanceRetirementGuardForOperator, prepareRetirementGuardForOperator, inspectExplicitRetirementForOperator, previewRetirementsForOperator,
    resumeConditionalRetirementForOperator, retireJournalRecordForOperator } from './retirementOperator';
import type { PreparedRetirementCheckpoint, RetirementBatchPermit } from './retirementBatchPermit';
import { createProductionRecoveryCheckpointSetup } from './productionRecoveryCheckpointSetup';
import { assertKnownRecoveryWritersLocked } from './retentionReconciliation';
import { applyRecoveryCheckpointSetup, planRecoveryCheckpointSetup, type RecoveryCheckpointSetupPlan } from './recoveryCheckpointSetup';

type Env = Readonly<Record<string, string | undefined>>;
type Identity = Readonly<{ name: string; generation: string; contentSha256: string }>;
type Body = Readonly<{ kind?: 'explicit' | 'conditional'; offset?: number; lineage?: string; selected?: Identity | Identity[];
    permit?: RetirementBatchPermit; prepared?: PreparedRetirementCheckpoint; plan?: RecoveryCheckpointSetupPlan }>;
const FAILURE = 'Retirement operation unavailable or unconfirmed. Keep recovery held and reconcile before retrying.';

/** Values are consumed privately; callers must never print this result. */
export function loadRetirementSecrets(env: Env): Readonly<{ guardKey: Buffer;
    activityKey: Buffer; warningKey: Buffer; publicKey: KeyObject; privateKey?: KeyObject }> {
    const bundle = env.CHILD_INACTIVITY_KEYS, activity = env.CHILD_ACTIVITY_CONTINUITY_KEY;
    if (!bundle || !/^[a-f0-9]{64}:[a-f0-9]{64}:[a-f0-9]{64}$/u.test(bundle)
        || !activity || !/^[a-f0-9]{64}$/u.test(activity) || !env.RETIREMENT_PUBLIC_KEY_PEM) throw new Error(FAILURE);
    const [guardKey, warningKey, receiptKey] = bundle.split(':').map(item => Buffer.from(item, 'hex'));
    const activityKey = Buffer.from(activity, 'hex'), keys = [guardKey, warningKey, receiptKey, activityKey];
    if (keys.some(key => key.every(value => value === 0)) || keys.some((key, index) => keys.slice(index + 1)
        .some(other => timingSafeEqual(key, other)))) throw new Error(FAILURE);
    const publicKey = createPublicKey(env.RETIREMENT_PUBLIC_KEY_PEM);
    if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error(FAILURE);
    const privateKey = env.RETIREMENT_PRIVATE_KEY_PEM ? createPrivateKey(env.RETIREMENT_PRIVATE_KEY_PEM) : undefined;
    if (privateKey && (privateKey.asymmetricKeyType !== 'ed25519' || !createPublicKey(privateKey).export({ type: 'spki', format: 'der' })
        .equals(publicKey.export({ type: 'spki', format: 'der' })))) throw new Error(FAILURE);
    receiptKey.fill(0);
    return { guardKey, activityKey, warningKey, publicKey, privateKey };
}

export function loadRetirementTarget(env: Env) {
    const config = loadMigrationConfig(env), currentUser = loadMigrationAccountConfirmation(env);
    assertDatabaseConfirmation(config, env.MIGRATION_CONFIRM_DATABASE);
    if (config.database !== 'cms' || config.user !== 'ludolume_release_ops'
        || currentUser !== 'ludolume_release_ops@cloudsqlproxy~%'
        || env.MIGRATION_CONFIRM_TARGET !== `${config.host}:${config.port}/${config.database}`
        || env.MIGRATION_CONFIRM_SERVER_UUID !== PRODUCTION_CLOUD_SQL_TARGET.serverUuid
        || env.MIGRATION_CONFIRM_CLOUD_SQL_PROJECT !== PRODUCTION_CLOUD_SQL_TARGET.project
        || env.MIGRATION_CONFIRM_CLOUD_SQL_INSTANCE !== PRODUCTION_CLOUD_SQL_TARGET.instance
        || env.MIGRATION_CONFIRM_CLOUD_SQL_CONNECTION_NAME !== PRODUCTION_CLOUD_SQL_TARGET.connectionName
        || !/^[a-f0-9]{40}$/u.test(env.RETIREMENT_SOURCE_COMMIT ?? '')) throw new Error(FAILURE);
    return { config, sourceCommit: env.RETIREMENT_SOURCE_COMMIT!, pins: { database: 'cms', currentUser,
        serverUuid: PRODUCTION_CLOUD_SQL_TARGET.serverUuid } };
}

async function readBody(input: AsyncIterable<string | Uint8Array>): Promise<Body> {
    const chunks: Buffer[] = []; let size = 0;
    for await (const value of input) {
        const part = Buffer.from(value); size += part.length;
        if (size > 262_144) throw new Error(FAILURE); chunks.push(part);
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(FAILURE);
    return value as Body;
}

export async function runRetirementOperator(args = process.argv.slice(2), env: Env = process.env,
    input: AsyncIterable<string | Uint8Array> = process.stdin): Promise<void> {
    const command = args[0];
    if (args.length !== 1 || !['setup-plan', 'setup-apply', 'preview', 'prepare', 'advance', 'retire', 'inspect', 'resume'].includes(command)) throw new Error(FAILURE);
    const target = loadRetirementTarget(env), secrets = loadRetirementSecrets(env), body = await readBody(input);
    if (command !== 'setup-plan' && command !== 'setup-apply' && body.kind !== 'explicit' && body.kind !== 'conditional') throw new Error(FAILURE);
    if (command !== 'preview' && command !== 'inspect' && command !== 'setup-plan') assertMutationAuthorized(target.config, env);
    if ((command === 'prepare' || command === 'advance' || command === 'retire' || command === 'resume') && !secrets.privateKey) throw new Error(FAILURE);
    assertChildSchemaCleanSource(target.sourceCommit, undefined, env);
    const connection = await mysql.createConnection({ host: target.config.host, port: target.config.port,
        user: target.config.user, password: target.config.password, database: target.config.database,
        connectTimeout: Math.min(10_000, target.config.operationTimeoutMs), multipleStatements: false,
        supportBigNumbers: true, dateStrings: true, timezone: 'Z' });
    try {
        // All commands except read-only inspection require a writer fence.
        if (command !== 'inspect') await assertKnownRecoveryWritersLocked(connection);
        const context = { connection, pins: target.pins, bucket: CHILD_RETENTION_BUCKET, expectedBucket: CHILD_RETENTION_BUCKET,
            ...secrets }, confirmation = env.RETIREMENT_WRITERS_CONFIRMATION ?? '', externalCopiesConfirmation = env.RETIREMENT_COPIES_CONFIRMATION ?? '';
        let result: unknown;
        if (command === 'setup-plan' || command === 'setup-apply') {
            const setup = createProductionRecoveryCheckpointSetup({ connection, pins: target.pins, sourceCommit: target.sourceCommit,
                guardKey: secrets.guardKey, verifySource: () => assertChildSchemaCleanSource(target.sourceCommit, undefined, env) });
            if (command === 'setup-plan') result = await planRecoveryCheckpointSetup(setup);
            else {
                if (!body.plan) throw new Error(FAILURE);
                await applyRecoveryCheckpointSetup(setup, body.plan, { sha256: env.RETIREMENT_APPROVED_PLAN_SHA256 ?? '', writers: confirmation });
                result = { status: 'checkpoint-created', lineage: body.plan.lineage };
            }
        } else if (command === 'preview' && body.kind) result = await previewRetirementsForOperator(context, body.kind, confirmation, body.offset ?? 0);
        else if (command === 'prepare' || command === 'advance') {
            if (!body.kind || !body.lineage || !Array.isArray(body.selected) || !secrets.privateKey) throw new Error(FAILURE);
            const common = { kind: body.kind, lineage: body.lineage, selected: body.selected, confirmation, externalCopiesConfirmation };
            if (command === 'prepare') result = await prepareRetirementGuardForOperator({ ...context, privateKey: secrets.privateKey }, common);
            else {
                if (!body.prepared) throw new Error(FAILURE);
                result = await advanceRetirementGuardForOperator({ ...context, privateKey: secrets.privateKey }, { ...common, prepared: body.prepared });
            }
        } else {
            if (!body.permit || !body.selected || Array.isArray(body.selected)) throw new Error(FAILURE);
            if (command === 'inspect' && body.kind === 'explicit') result = await inspectExplicitRetirementForOperator(context, body.permit, body.selected);
            else if (command === 'resume' && body.kind === 'conditional' && secrets.privateKey) result = await resumeConditionalRetirementForOperator(
                { ...context, privateKey: secrets.privateKey }, { permit: body.permit, selected: body.selected, confirmation, externalCopiesConfirmation });
            else if (command === 'retire' && body.kind && secrets.privateKey) result = await retireJournalRecordForOperator(
                { ...context, privateKey: secrets.privateKey }, { kind: body.kind, permit: body.permit, selected: body.selected,
                    confirmation, externalCopiesConfirmation });
            else throw new Error(FAILURE);
        }
        process.stdout.write(`${JSON.stringify(result)}\n`);
    } finally {
        for (const key of [secrets.guardKey, secrets.activityKey, secrets.warningKey]) key.fill(0);
        await connection.end();
    }
}

if (require.main === module) runRetirementOperator().catch(() => { console.error(FAILURE); process.exitCode = 1; });
