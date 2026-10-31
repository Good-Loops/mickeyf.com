import { randomUUID, timingSafeEqual } from 'node:crypto';
import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';
import { assertMutationAuthorized, loadMigrationAccountConfirmation, loadMigrationConfig } from '../config/migrationConfig';
import { assertChildSchemaCleanSource } from '../migrations/runChildSignedFormSchema';
import { isAccountId } from './deletionJournal';
import { createChildInactivitySqlStore } from './childInactivitySqlStore';
import { createGcsRetentionJournal } from './gcsRetentionJournal';
import { reconcileDeletedRetentionIntent, reconcileRestoredDeletedIntent } from './retentionReconciliation';
import { activateRetentionGuard } from './retentionGuardActivation';
import type { RetentionIntent } from './childInactivityWorkflow';

const FAILURE = 'Retention reconciliation unavailable or unconfirmed. Keep restoration on hold.';
type Environment = Readonly<Record<string, string | undefined>>;
type Journal = ReturnType<typeof createGcsRetentionJournal>;
type Pins = Readonly<{ database: string; serverUuid: string; currentUser: string; originalServerUuid: string }>;

function decodeKey(value: string | undefined): Buffer {
    if (!value || value.length > 172 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) throw new Error(FAILURE);
    const key = Buffer.from(value, 'base64');
    if (key.length < 32 || key.length > 128 || key.toString('base64') !== value) throw new Error(FAILURE);
    return key;
}
async function readInput(input: AsyncIterable<string | Uint8Array>): Promise<Record<string, unknown>> {
    const parts: Buffer[] = []; let length = 0;
    for await (const chunk of input) {
        const part = Buffer.from(chunk); length += part.length;
        if (length > 16_384) throw new Error(FAILURE); parts.push(part);
    }
    const result: unknown = JSON.parse(Buffer.concat(parts).toString('utf8'));
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error(FAILURE);
    return result as Record<string, unknown>;
}

/** Fixed command grammar; never logs raw connection or authorization failures. */
export async function executeRetentionReconciliation(command: string, input: Record<string, unknown>,
    pins: Pins, journal: Journal, database: Pick<Pool, 'query' | 'getConnection'>, auditKey: Buffer): Promise<unknown> {
    if (!/^[A-Za-z0-9_]{1,64}$/u.test(pins.database) || !isAccountId(pins.serverUuid)
        || !isAccountId(pins.originalServerUuid) || !pins.currentUser) throw new Error(FAILURE);
    const [rows] = await database.query<RowDataPacket[]>({ sql: `SELECT DATABASE() AS db,CURRENT_USER() AS user,
        @@GLOBAL.server_uuid AS serverUuid,DATE_FORMAT(UTC_TIMESTAMP(6),'%Y-%m-%dT%H:%i:%s.%fZ') AS nowUtc`, timeout: 10_000 });
    if (!Array.isArray(rows) || rows.length !== 1 || rows[0].db !== pins.database
        || rows[0].user !== pins.currentUser || rows[0].serverUuid !== pins.serverUuid) throw new Error(FAILURE);
    if (command === 'inventory' && Object.keys(input).length === 0) {
        const guard = await journal.readRestoreGuard(); const intents = await journal.readIntents();
        const records = [];
        for (const intent of intents) records.push({ intent, resolution: await journal.readResolution(intent) });
        return { guard, records };
    }
    if (command === 'initialize-hold' && Object.keys(input).join(',') === 'confirmation'
        && input.confirmation === 'INITIALIZE RETENTION HOLD') {
        const now = typeof rows[0].nowUtc === 'string' ? Date.parse(rows[0].nowUtc) : NaN;
        if (pins.serverUuid !== pins.originalServerUuid || !Number.isFinite(now) || (await journal.readIntents()).length !== 0) throw new Error(FAILURE);
        const guard = { state: 'hold' as const, database: pins.database, serverUuid: pins.serverUuid,
            epoch: randomUUID(), expiresAt: new Date(now + 364 * 24 * 60 * 60_000).toISOString() };
        const generation = await journal.writeRestoreGuard(guard, '0');
        return { state: 'hold', generation };
    }
    if (command === 'hold' && Object.keys(input).join(',') === 'confirmation'
        && input.confirmation === 'HOLD RETENTION FOR RESTORE') {
        const current = await journal.readRestoreGuard();
        if (current.database !== pins.database || current.serverUuid !== pins.serverUuid
            || pins.serverUuid !== pins.originalServerUuid) throw new Error(FAILURE);
        const generation = await journal.writeRestoreGuard({ state: 'hold', database: current.database,
            serverUuid: current.serverUuid, epoch: current.epoch, expiresAt: current.expiresAt }, current.generation);
        return { state: 'hold', generation };
    }
    if (command === 'activate' && Object.keys(input).join(',') === 'confirmation'
        && input.confirmation === 'ALL WRITERS FENCED AND INTENTS RECONCILED') {
        const connection = await database.getConnection();
        try {
            const generation = await activateRetentionGuard(connection, journal, { ...pins, confirmation: input.confirmation });
            return { state: 'active', generation };
        } finally { connection.release(); }
    }
    if ((command !== 'confirm-deleted' && command !== 'apply-restored')
        || Object.keys(input).sort().join(',') !== 'confirmation,intent' || !input.intent
        || typeof input.intent !== 'object' || Array.isArray(input.intent) || typeof input.confirmation !== 'string') throw new Error(FAILURE);
    const intent = input.intent as RetentionIntent;
    if (command === 'confirm-deleted') {
        if (pins.serverUuid !== pins.originalServerUuid) throw new Error(FAILURE);
        const connection = await database.getConnection();
        try {
            const confirmed = await reconcileDeletedRetentionIntent(connection, journal, intent,
                { database: pins.database, serverUuid: pins.serverUuid, currentUser: pins.currentUser,
                    confirmation: input.confirmation }, auditKey);
            if (!confirmed) throw new Error(FAILURE);
        } finally { connection.release(); }
    } else {
        if (pins.serverUuid === pins.originalServerUuid) throw new Error(FAILURE);
        const store = createChildInactivitySqlStore(database, async () => ({ channel: 'in-app', targetVerified: false,
            currentTargetDigest: null, activityComplete: false }));
        const applied = await reconcileRestoredDeletedIntent(store, journal, intent,
            { ...pins, confirmation: input.confirmation });
        if (!applied) throw new Error(FAILURE);
    }
    return { operation: command, confirmed: true };
}

export async function runRetentionReconciliation(args = process.argv.slice(2), env: Environment = process.env,
    input: AsyncIterable<string | Uint8Array> = process.stdin): Promise<void> {
    if (args.length !== 1 || !['inventory', 'initialize-hold', 'hold', 'activate', 'confirm-deleted', 'apply-restored'].includes(args[0])) throw new Error(FAILURE);
    const body = await readInput(input);
    const config = loadMigrationConfig(env); assertMutationAuthorized(config, env);
    const currentUser = loadMigrationAccountConfirmation(env);
    const serverUuid = env.MIGRATION_CONFIRM_SERVER_UUID ?? '', originalServerUuid = env.RETENTION_ORIGINAL_SERVER_UUID ?? '';
    if (!isAccountId(serverUuid) || !isAccountId(originalServerUuid)
        || currentUser.slice(0, currentUser.lastIndexOf('@')) !== config.user || config.user === 'cms_mickeyf') throw new Error(FAILURE);
    const source = env.RETENTION_RECONCILIATION_SOURCE_COMMIT ?? '';
    assertChildSchemaCleanSource(source, undefined, env);
    const key = decodeKey(env.RETENTION_JOURNAL_KEY_BASE64), auditKey = decodeKey(env.RETENTION_AUDIT_KEY_BASE64);
    if (key.length === auditKey.length && timingSafeEqual(key, auditKey)) throw new Error(FAILURE);
    const bucket = env.RETENTION_JOURNAL_BUCKET ?? '', expectedBucket = env.RETENTION_CONFIRM_BUCKET ?? '';
    const journal = createGcsRetentionJournal({ bucket, expectedBucket, key, verifyActivityContinuity: async () => false });
    const pool = mysql.createPool({ host: config.host, port: config.port, user: config.user, password: config.password,
        database: config.database, connectTimeout: Math.min(10_000, config.operationTimeoutMs),
        multipleStatements: false, connectionLimit: 4, dateStrings: true, timezone: 'Z' });
    try {
        const result = await executeRetentionReconciliation(args[0], body,
            { database: config.database, serverUuid, originalServerUuid, currentUser }, journal, pool, auditKey);
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } finally { await pool.end(); }
}

if (require.main === module) runRetentionReconciliation().catch(() => { console.error(FAILURE); process.exitCode = 1; });
