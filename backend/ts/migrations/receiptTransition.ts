import { createHash } from 'node:crypto';
import type { ReceiptMigrationConfirmation } from '../config/receiptMigrationConfig';
import { PRODUCTION_CLOUD_SQL_TARGET } from '../security/cloudSqlRuntimeRoleRemover';
import { tableExists, type MigrationConnection } from './leaderboardSchema';
import type { MigrationDefinition } from './migrationManifest';
import {
    applyMigrations,
    planMigrations,
    type MigrationPlan,
    type MigrationRunnerSettings,
} from './migrationRunner';

export type ReceiptMigrationIdentity = Readonly<{
    databaseName: string;
    currentUser: string;
    serverUuid: string;
    serverVersion: string;
    versionComment: string;
}>;
type DataDigest = Readonly<{ count: number; sha256: string }>;
type PreservedData = Readonly<{ personalBests: DataDigest; receipts: DataDigest }>;
export type ReceiptTransitionPlan = Readonly<{
    formatVersion: 1;
    state: 'blocked' | 'ready' | 'recoverable' | 'applied';
    database: ReceiptMigrationIdentity;
    schema: MigrationPlan;
    migrations: readonly Readonly<{ version: string; checksumSha256: string }>[];
    preservedData: PreservedData | null;
    blockers: readonly string[];
    sha256: string;
}>;

const TRANSITION_EFFECTS = ['detach-best-source', 'retain-receipts'] as const;
const RECEIPTS_VERSION = '0005_retain_submission_receipts';
const PAGE_SIZE = 500;

async function rows<T>(
    connection: MigrationConnection, sql: string, values: unknown[] = []
): Promise<T[]> {
    const [result] = await connection.query(sql, values);
    if (!Array.isArray(result)) throw new Error('Receipt migration query returned unexpected rows');
    return result as T[];
}

type BestDigestRow = {
    gameId: string; rulesVersion: string; userId: string; score: string;
    completionTimeMs: string | null; recordedAt: string;
};
type ReceiptDigestRow = {
    receiptId: string; gameId: string; rulesVersion: string; userId: string;
    runId: string; score: string; completionTimeMs: string | null;
    fingerprint: string; improved: string; submittedAt: string;
};

async function personalBestDigest(connection: MigrationConnection): Promise<DataDigest> {
    const hash = createHash('sha256');
    let count = 0;
    let cursor: BestDigestRow | undefined;
    while (true) {
        const page: BestDigestRow[] = await rows(connection, `
            SELECT game_id AS gameId, CAST(rules_version AS CHAR) AS rulesVersion,
                CAST(user_id AS CHAR) AS userId, CAST(score AS CHAR) AS score,
                CAST(completion_time_ms AS CHAR) AS completionTimeMs,
                DATE_FORMAT(recorded_at, '%Y-%m-%d %H:%i:%s.%f') AS recordedAt
            FROM game_personal_bests
            ${cursor ? 'WHERE (game_id, rules_version, user_id) > (?, ?, ?)' : ''}
            ORDER BY game_id, rules_version, user_id LIMIT ${PAGE_SIZE}
        `, cursor ? [cursor.gameId, cursor.rulesVersion, cursor.userId] : []);
        for (const row of page) {
            hash.update(JSON.stringify([
                row.gameId, row.rulesVersion, row.userId, row.score,
                row.completionTimeMs, row.recordedAt,
            ]) + '\n');
        }
        count += page.length;
        if (page.length < PAGE_SIZE) break;
        cursor = page.at(-1);
    }
    return Object.freeze({ count, sha256: hash.digest('hex') });
}

async function receiptDigest(connection: MigrationConnection): Promise<DataDigest> {
    const renamed = await tableExists(connection, 'game_submission_receipts');
    // Only these reviewed identifiers enter SQL; nothing comes from user input.
    const table = renamed ? 'game_submission_receipts' : 'game_runs';
    const improvedColumn = renamed ? 'improved_personal_best' : 'personal_best';
    const hash = createHash('sha256');
    let count = 0;
    let lastId = '0';
    while (true) {
        const page: ReceiptDigestRow[] = await rows(connection, `
            SELECT CAST(game_run_id AS CHAR) AS receiptId, game_id AS gameId,
                CAST(rules_version AS CHAR) AS rulesVersion, CAST(user_id AS CHAR) AS userId,
                run_id AS runId, CAST(score AS CHAR) AS score,
                CAST(completion_time_ms AS CHAR) AS completionTimeMs,
                HEX(payload_fingerprint) AS fingerprint, CAST(${improvedColumn} AS CHAR) AS improved,
                DATE_FORMAT(submitted_at, '%Y-%m-%d %H:%i:%s.%f') AS submittedAt
            FROM ${table} WHERE game_run_id > CAST(? AS UNSIGNED)
            ORDER BY game_run_id LIMIT ${PAGE_SIZE}
        `, [lastId]);
        for (const row of page) {
            hash.update(JSON.stringify([
                row.receiptId, row.gameId, row.rulesVersion, row.userId,
                row.runId, row.score, row.completionTimeMs, row.fingerprint,
                row.improved, row.submittedAt,
            ]) + '\n');
        }
        count += page.length;
        if (page.length < PAGE_SIZE) break;
        lastId = page.at(-1)!.receiptId;
    }
    return Object.freeze({ count, sha256: hash.digest('hex') });
}

async function inspectPreservedData(connection: MigrationConnection): Promise<PreservedData> {
    return Object.freeze({
        personalBests: await personalBestDigest(connection),
        receipts: await receiptDigest(connection),
    });
}

async function verifyNoObsoleteDependencies(connection: MigrationConnection): Promise<void> {
    const identifierPattern = '(^|[^a-z0-9_])(game_runs|source_game_run_id)([^a-z0-9_]|$)';
    for (const [table, schemaColumn, definitionColumn] of [
        ['VIEWS', 'TABLE_SCHEMA', 'VIEW_DEFINITION'],
        ['ROUTINES', 'ROUTINE_SCHEMA', 'ROUTINE_DEFINITION'],
        ['EVENTS', 'EVENT_SCHEMA', 'EVENT_DEFINITION'],
        ['TRIGGERS', 'TRIGGER_SCHEMA', 'ACTION_STATEMENT'],
    ] as const) {
        const matches = await rows<{ dependencyCount: number }>(connection, `
            SELECT COUNT(*) AS dependencyCount FROM information_schema.${table}
            WHERE ${schemaColumn} = DATABASE()
              AND (${definitionColumn} IS NULL OR LOWER(${definitionColumn}) REGEXP ?)
        `, [identifierPattern]);
        if (Number(matches[0]?.dependencyCount) !== 0) {
            throw new Error(`Receipt transition has obsolete dependencies or unreadable ${table.toLowerCase()}`);
        }
    }
    const foreignKeys = await rows<{ dependencyCount: number }>(connection, `
        SELECT COUNT(*) AS dependencyCount FROM information_schema.KEY_COLUMN_USAGE
        WHERE REFERENCED_TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME = 'game_runs'
          AND NOT (TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'game_personal_bests'
            AND CONSTRAINT_NAME = 'fk_game_personal_bests_source_game_run')
    `);
    if (Number(foreignKeys[0]?.dependencyCount) !== 0) {
        throw new Error('Receipt transition has unreviewed references to game_runs');
    }
}

async function buildPlan(
    connection: MigrationConnection,
    migrations: readonly MigrationDefinition[],
    schema: MigrationPlan,
    identity: ReceiptMigrationIdentity
): Promise<ReceiptTransitionPlan> {
    const transitions = migrations.filter(({ effect }) =>
        TRANSITION_EFFECTS.some((expected) => expected === effect)
    );
    if (transitions.length !== 2 || transitions[1].version !== RECEIPTS_VERSION) {
        throw new Error('The reviewed receipt transition migration pair is missing');
    }
    const blockers: string[] = [];
    const legacyComplete = migrations.filter(({ effect }) =>
        effect === 'create-table' || effect === 'drop-column'
    ).every(({ version }) => schema.applied.includes(version));
    if (!legacyComplete) blockers.push('all historical migrations must be recorded first');
    if (legacyComplete) await verifyNoObsoleteDependencies(connection);
    if (identity.databaseName === 'cms' && identity.serverUuid !== PRODUCTION_CLOUD_SQL_TARGET.serverUuid) {
        blockers.push('production database name requires the independently pinned Cloud SQL UUID');
    }
    const state = blockers.length > 0 ? 'blocked'
        : schema.applied.includes(RECEIPTS_VERSION) ? 'applied'
            : schema.recoverable.length > 0 ? 'recoverable' : 'ready';
    const payload = {
        formatVersion: 1 as const,
        state,
        database: identity,
        schema,
        migrations: transitions.map(({ version, checksum }) =>
            Object.freeze({ version, checksumSha256: checksum.toString('hex') })
        ),
        preservedData: legacyComplete ? await inspectPreservedData(connection) : null,
        blockers: Object.freeze(blockers),
    } as const;
    const sha256 = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    return Object.freeze({ ...payload, sha256 });
}

export async function planReceiptTransition(
    connection: MigrationConnection,
    migrations: readonly MigrationDefinition[],
    settings: MigrationRunnerSettings,
    identity: ReceiptMigrationIdentity
): Promise<ReceiptTransitionPlan> {
    return buildPlan(connection, migrations,
        await planMigrations(connection, migrations, settings), identity);
}

async function inspectionCount(
    connection: MigrationConnection, sql: string, label: string
): Promise<number> {
    try {
        const result = await rows<{ inspectionCount: unknown }>(connection, sql);
        const value = result[0]?.inspectionCount;
        if (result.length !== 1
            || !((typeof value === 'number' || typeof value === 'string') && /^\d+$/.test(String(value)))
            || !Number.isSafeInteger(Number(value))) {
            throw new Error('Missing or malformed inspection count');
        }
        return Number(value);
    } catch {
        // Do not expose database diagnostics or mistake unavailable metadata for zero.
        throw new Error(`Receipt transition cannot verify ${label}`);
    }
}

async function assertNoLostLockInstrumentation(connection: MigrationConnection): Promise<void> {
    for (const counter of ['Performance_schema_metadata_lock_lost', 'Performance_schema_thread_instances_lost']) {
        const lost = await inspectionCount(connection, `
            SELECT VARIABLE_VALUE AS inspectionCount FROM performance_schema.global_status
            WHERE VARIABLE_NAME = '${counter}'
        `, counter);
        if (lost !== 0) throw new Error(`Receipt transition requires ${counter}=0`);
    }
}

async function assertLockInspectionAvailable(connection: MigrationConnection): Promise<void> {
    const enabled = await inspectionCount(connection,
        'SELECT @@performance_schema AS inspectionCount', 'performance_schema availability');
    if (enabled !== 1) throw new Error('Receipt transition requires performance_schema enabled');
    await inspectionCount(connection,
        'SELECT COUNT(*) AS inspectionCount FROM information_schema.INNODB_BUFFER_POOL_STATS',
        'effective PROCESS privilege');
    for (const [table, name] of [
        ['setup_instruments', 'wait/lock/metadata/sql/mdl'],
        ['setup_consumers', 'global_instrumentation'],
    ]) {
        const enabledCount = await inspectionCount(connection, `
            SELECT COUNT(*) AS inspectionCount FROM performance_schema.${table}
            WHERE NAME = '${name}' AND ENABLED = 'YES'
        `, name);
        if (enabledCount !== 1) throw new Error(`Receipt transition requires ${name} enabled`);
    }
    await assertNoLostLockInstrumentation(connection);
}

export async function assertReceiptMigrationQuiescent(connection: MigrationConnection): Promise<void> {
    await assertLockInspectionAvailable(connection);
    const transactions = await inspectionCount(connection,
        'SELECT COUNT(*) AS inspectionCount FROM information_schema.INNODB_TRX', 'active transactions');
    if (transactions !== 0) {
        throw new Error('Receipt transition requires zero active InnoDB transactions');
    }
    const pending = await inspectionCount(connection, `
        SELECT COUNT(*) AS inspectionCount FROM performance_schema.metadata_locks
        WHERE OBJECT_SCHEMA = DATABASE()
          AND OBJECT_NAME IN ('game_runs', 'game_submission_receipts', 'game_personal_bests', 'schema_migrations')
          AND LOCK_STATUS = 'PENDING'
    `, 'pending metadata locks');
    if (pending !== 0) {
        throw new Error('Receipt transition requires zero pending metadata locks');
    }
    // Capacity loss during the activity reads would make those empty results unreliable.
    await assertNoLostLockInstrumentation(connection);
}

export async function applyReceiptTransition(
    connection: MigrationConnection,
    migrations: readonly MigrationDefinition[],
    settings: MigrationRunnerSettings,
    identity: ReceiptMigrationIdentity,
    confirmation: ReceiptMigrationConfirmation
): Promise<ReceiptTransitionPlan> {
    if (identity.serverUuid !== confirmation.confirmedServerUuid) {
        throw new Error('Connected server UUID does not match the receipt transition confirmation');
    }
    let approvedData: PreservedData | null = null;
    let result: ReceiptTransitionPlan | undefined;
    await applyMigrations(connection, migrations, settings, {
        allowedEffectKinds: TRANSITION_EFFECTS,
        beforeApply: async (schema) => {
            await assertReceiptMigrationQuiescent(connection);
            const plan = await buildPlan(connection, migrations, schema, identity);
            if (plan.sha256 !== confirmation.approvedPlanSha256) {
                throw new Error('MIGRATION_CONFIRM_RECEIPT_PLAN_SHA256 does not match the current plan');
            }
            if (plan.state !== 'ready' && plan.state !== 'recoverable') {
                throw new Error(`Receipt transition is blocked in state ${plan.state}`);
            }
            approvedData = plan.preservedData;
        },
        afterApply: async (schema) => {
            result = await buildPlan(connection, migrations, schema, identity);
            if (result.state !== 'applied' || JSON.stringify(result.preservedData) !== JSON.stringify(approvedData)) {
                throw new Error('Receipt transition preservation verification failed; keep submissions disabled');
            }
        },
    });
    if (!result) throw new Error('Receipt transition did not produce a verified result');
    return result;
}
