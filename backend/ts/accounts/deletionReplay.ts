import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { DeletionReplaySettings } from '../config/deletionReplayConfig';
import { withUserSubmissionLock } from '../leaderboards/userSubmissionLock';
import { assertAccountIdentityEpoch, verifyAccountIdentitySchema } from '../migrations/accountIdentitySchema';
import type { MigrationConnection } from '../migrations/leaderboardSchema';
import { verifyOptionalProviderIdentitySchema } from '../migrations/providerIdentitySchema';
import { verifyOptionalProviderAttemptSchema } from '../migrations/providerAttemptSchema';
import { verifyOptionalAccountSessionSchema } from '../migrations/accountSessionSchema';
import { AccountDeletionRollbackError, deleteOwnedAccountRows } from './accountDeletionRepository';
import { type DeletionJournalReader, parseDeletionIntent } from './deletionJournal';

type ReplayDatabase = Pick<Pool, 'getConnection'>;
type ReplayTarget = Readonly<{
    database: string; currentUser: string; serverUuid: string; identityEpoch: string;
    mode: 'active' | 'recovery'; sourceServerUuid?: string;
}>;
export type DeletionReplayPlan = Readonly<{
    formatVersion: 1; sha256: string; journalDigest: string; intentCount: number;
    accountCount: number; target: ReplayTarget;
}>;
export type DeletionReplayResult = Readonly<{
    status: 'reconciled'; deletedAccounts: number; absentAccounts: number;
    planSha256: string; journalDigest: string;
}>;

const QUERY_TIMEOUT_MS = 10_000;
const RECOVERY_TABLES = ['game_personal_bests', 'game_submission_receipts', 'users'];

class ReplayBudget {
    private readonly startedAt = performance.now();
    constructor(private readonly maximumMs: number) {}
    remaining(): number {
        const remaining = Math.floor(this.maximumMs - (performance.now() - this.startedAt));
        if (remaining <= 0) throw new Error('Deletion replay time budget exhausted; no cutover is authorized');
        return Math.min(QUERY_TIMEOUT_MS, remaining);
    }
}

function timedConnection(connection: PoolConnection, budget: ReplayBudget): MigrationConnection {
    return { query: (sql, values) => connection.query({ sql, timeout: budget.remaining() }, values) };
}

async function inspectTarget(
    connection: PoolConnection, settings: DeletionReplaySettings, budget: ReplayBudget
): Promise<ReplayTarget> {
    const timed = timedConnection(connection, budget);
    await timed.query("SET SESSION time_zone = '+00:00'");
    const [result] = await timed.query(`SELECT DATABASE() AS databaseName,
        CURRENT_USER() AS currentUser, @@GLOBAL.server_uuid AS serverUuid`);
    const rows = result as Array<{ databaseName: string; currentUser: string; serverUuid: string }>;
    if (!Array.isArray(rows) || rows.length !== 1
        || rows[0].databaseName !== settings.database
        || rows[0].currentUser !== settings.expectedCurrentUser
        || rows[0].serverUuid !== settings.expectedServerUuid) {
        throw new Error('Deletion replay target does not match its independent pins');
    }
    if (settings.mode === 'recovery' && (!settings.sourceServerUuid
        || settings.sourceServerUuid === rows[0].serverUuid)) {
        throw new Error('Recovery replay requires a distinct isolated target');
    }
    await assertAccountIdentityEpoch(timed, settings.expectedIdentityEpoch);
    return Object.freeze({
        database: rows[0].databaseName, currentUser: rows[0].currentUser,
        serverUuid: rows[0].serverUuid, identityEpoch: settings.expectedIdentityEpoch,
        mode: settings.mode, sourceServerUuid: settings.sourceServerUuid,
    });
}

async function verifyTargetSchema(
    database: ReplayDatabase, settings: DeletionReplaySettings, budget: ReplayBudget
): Promise<ReplayTarget> {
    const connection = await database.getConnection();
    let reusable = true;
    try {
        const target = await inspectTarget(connection, settings, budget);
        const timed = timedConnection(connection, budget);
        await verifyAccountIdentitySchema(timed);
        await verifyOptionalProviderIdentitySchema(timed);
        await verifyOptionalProviderAttemptSchema(timed);
        await verifyOptionalAccountSessionSchema(timed);
        const [rows] = await timed.query(`SELECT TABLE_NAME AS tableName, ENGINE AS engine
            FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME IN ('users', 'game_personal_bests', 'game_submission_receipts', 'game_runs')`);
        const tables = rows as Array<{ tableName: string; engine: string }>;
        if (!Array.isArray(tables) || tables.some(row => row.engine !== 'InnoDB')
            || tables.map(row => row.tableName).sort().join(',') !== RECOVERY_TABLES.join(',')) {
            throw new Error('Deletion replay requires the current transactional account schema');
        }
        return target;
    } catch (error) {
        reusable = false;
        connection.destroy();
        throw error;
    } finally { if (reusable) connection.release(); }
}

async function validatedJournal(reader: DeletionJournalReader, maximum: number) {
    const snapshot = await reader.readDeletionIntents();
    if (!snapshot || !/^[a-f0-9]{64}$/u.test(snapshot.digest)
        || !Array.isArray(snapshot.intents) || snapshot.intents.length > maximum) {
        throw new Error('Deletion replay journal snapshot is invalid or exceeds its review limit');
    }
    // Parse the complete set before touching data, including records after the first valid intent.
    const intents = snapshot.intents.map(parseDeletionIntent).sort((left, right) =>
        left.accountId.localeCompare(right.accountId) || left.requestedAt.localeCompare(right.requestedAt));
    return { intents, digest: snapshot.digest };
}

async function prepareReplay(
    database: ReplayDatabase, reader: DeletionJournalReader, settings: DeletionReplaySettings, budget: ReplayBudget
) {
    if (!Number.isSafeInteger(settings.maxIntents) || settings.maxIntents < 1 || settings.maxIntents > 10000
        || !Number.isSafeInteger(settings.maxDurationMs) || settings.maxDurationMs < 1 || settings.maxDurationMs > 300000) {
        throw new Error('Invalid deletion replay bounds');
    }
    const target = await verifyTargetSchema(database, settings, budget);
    const snapshot = await validatedJournal(reader, settings.maxIntents);
    budget.remaining();
    const accountIds = [...new Set(snapshot.intents.map(intent => intent.accountId))];
    const sha256 = createHash('sha256').update(JSON.stringify({
        formatVersion: 1, target, journalDigest: snapshot.digest, intents: snapshot.intents,
        maxIntents: settings.maxIntents, maxDurationMs: settings.maxDurationMs,
    }), 'utf8').digest('hex');
    const plan: DeletionReplayPlan = Object.freeze({
        formatVersion: 1, sha256, target, journalDigest: snapshot.digest,
        intentCount: snapshot.intents.length, accountCount: accountIds.length,
    });
    return { plan, accountIds };
}

export async function planDeletionReplay(
    database: ReplayDatabase, reader: DeletionJournalReader, settings: DeletionReplaySettings
): Promise<DeletionReplayPlan> {
    return (await prepareReplay(database, reader, settings, new ReplayBudget(settings.maxDurationMs))).plan;
}

async function findUserId(
    database: ReplayDatabase, accountId: string, settings: DeletionReplaySettings, budget: ReplayBudget
): Promise<number | undefined> {
    const connection = await database.getConnection();
    let reusable = true;
    try {
        await inspectTarget(connection, settings, budget);
        const [rows] = await connection.query<Array<RowDataPacket & { userId: number }>>({
            sql: 'SELECT user_id AS userId FROM users WHERE account_uuid = ? LIMIT 2',
            timeout: budget.remaining(),
        }, [accountId]);
        if (rows.length > 1 || (rows[0] && (!Number.isSafeInteger(rows[0].userId) || rows[0].userId < 1))) {
            throw new Error('Deletion replay found an ambiguous account identity');
        }
        return rows[0]?.userId;
    } catch (error) {
        reusable = false;
        connection.destroy();
        throw error;
    } finally { if (reusable) connection.release(); }
}

async function replayOneAccount(
    database: ReplayDatabase, accountId: string, settings: DeletionReplaySettings, budget: ReplayBudget
): Promise<boolean> {
    const userId = await findUserId(database, accountId, settings, budget);
    if (userId === undefined) return false;
    return withUserSubmissionLock(database, userId, async ({ connection, invalidateConnection }) => {
        try { await inspectTarget(connection, settings, budget); }
        catch (error) {
            invalidateConnection();
            throw error;
        }
        let phase: 'begin' | 'active' | 'commit' = 'begin';
        try {
            await connection.query({ sql: 'START TRANSACTION', timeout: budget.remaining() });
            phase = 'active';
            const [rows] = await connection.query<Array<RowDataPacket & { accountId: string }>>({
                sql: 'SELECT account_uuid AS accountId FROM users WHERE user_id = ? LIMIT 1 FOR UPDATE',
                timeout: budget.remaining(),
            }, [userId]);
            // Numeric IDs can be reused after restores. Never delete by that ID without rechecking UUID.
            if (rows[0] && rows[0].accountId !== accountId) {
                throw new Error('Account identity changed while acquiring the deletion replay lock');
            }
            if (rows[0]) await deleteOwnedAccountRows(connection, userId);
            phase = 'commit';
            await connection.query({ sql: 'COMMIT', timeout: budget.remaining() });
            return rows.length === 1;
        } catch (error) {
            if (phase !== 'active') invalidateConnection();
            try { await connection.query({ sql: 'ROLLBACK', timeout: QUERY_TIMEOUT_MS }); }
            catch (rollbackError) {
                invalidateConnection();
                throw new AccountDeletionRollbackError(error, rollbackError);
            }
            throw error;
        }
    });
}

/** Per-account commits are repeatable. A failed run never authorizes restored traffic. */
export async function applyDeletionReplay(
    database: ReplayDatabase, reader: DeletionJournalReader, settings: DeletionReplaySettings,
    approvedPlanSha256: string
): Promise<DeletionReplayResult> {
    const budget = new ReplayBudget(settings.maxDurationMs);
    const { plan, accountIds } = await prepareReplay(database, reader, settings, budget);
    if (!/^[0-9a-f]{64}$/u.test(approvedPlanSha256) || plan.sha256 !== approvedPlanSha256) {
        throw new Error('Deletion replay plan changed; review a fresh plan before applying');
    }
    let deletedAccounts = 0;
    for (const accountId of accountIds) {
        budget.remaining();
        if (await replayOneAccount(database, accountId, settings, budget)) deletedAccounts++;
    }
    const after = await prepareReplay(database, reader, settings, budget);
    if (after.plan.sha256 !== plan.sha256) {
        throw new Error('Deletion journal or target changed during replay; no cutover is authorized');
    }
    return Object.freeze({
        status: 'reconciled', deletedAccounts, absentAccounts: accountIds.length - deletedAccounts,
        planSha256: plan.sha256, journalDigest: plan.journalDigest,
    });
}
