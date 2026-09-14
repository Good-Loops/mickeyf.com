import { performance } from 'node:perf_hooks';
import type { Pool, PoolConnection } from 'mysql2/promise';
import type { DeletionAuditSettings } from '../config/deletionAuditConfig';
import { assertAccountIdentityEpoch } from '../migrations/accountIdentitySchema';
import type { MigrationConnection } from '../migrations/leaderboardSchema';
import { type DeletionJournalReader, parseDeletionIntent } from './deletionJournal';

export type DeletionAuditResult = Readonly<{
    status: 'clear' | 'pending';
    intentCount: number;
    accountCount: number;
    checkedAccounts: number;
    pendingAccounts: number;
    oldestPendingSeconds: number;
}>;

export class DeletionAuditError extends Error {
    constructor() {
        super('Account deletion audit could not be confirmed');
        this.name = 'DeletionAuditError';
    }
}

/** Read-only observation, not a replay plan or proof that a restore is safe. */
export async function auditPendingDeletions(
    database: Pick<Pool, 'getConnection'>,
    reader: DeletionJournalReader,
    settings: DeletionAuditSettings,
): Promise<DeletionAuditResult> {
    if (!Number.isSafeInteger(settings.maxIntents) || settings.maxIntents < 1 || settings.maxIntents > 10_000
        || !Number.isSafeInteger(settings.maxDurationMs) || settings.maxDurationMs < 1 || settings.maxDurationMs > 300_000
        || !Number.isSafeInteger(settings.graceMs) || settings.graceMs < 1 || settings.graceMs > 86_400_000) {
        throw new DeletionAuditError();
    }
    const startedAt = performance.now();
    let connection: PoolConnection | undefined;
    let expired = false;
    let failed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const remaining = () => {
        const milliseconds = Math.floor(settings.maxDurationMs - (performance.now() - startedAt));
        if (expired || milliseconds <= 0) throw new DeletionAuditError();
        return Math.min(10_000, milliseconds);
    };

    const inspect = async (): Promise<DeletionAuditResult> => {
        const acquired = await database.getConnection();
        if (expired) { acquired.release(); throw new DeletionAuditError(); }
        connection = acquired;
        const timed: MigrationConnection = {
            async query(sql, values) {
                const result = await acquired.query({ sql, timeout: remaining() }, values);
                remaining();
                return result;
            },
        };
        await timed.query("SET SESSION time_zone = '+00:00'");
        const [targetRows] = await timed.query(`SELECT DATABASE() AS databaseName,
            CURRENT_USER() AS currentUser, @@GLOBAL.server_uuid AS serverUuid,
            UNIX_TIMESTAMP(UTC_TIMESTAMP(3)) * 1000 AS nowMs`);
        const target = Array.isArray(targetRows) && targetRows.length === 1 ? targetRows[0] : undefined;
        const nowMs = Number(target?.nowMs);
        if (!target || target.databaseName !== settings.database || target.currentUser !== settings.expectedCurrentUser
            || target.serverUuid !== settings.expectedServerUuid || !Number.isSafeInteger(nowMs) || nowMs <= 0) {
            throw new DeletionAuditError();
        }
        await assertAccountIdentityEpoch(timed, settings.expectedIdentityEpoch);
        const snapshot = await reader.readDeletionIntents();
        remaining();
        if (!snapshot || !/^[a-f0-9]{64}$/u.test(snapshot.digest)
            || !Array.isArray(snapshot.intents) || snapshot.intents.length > settings.maxIntents) {
            throw new DeletionAuditError();
        }
        const requestedAtByAccount = new Map<string, number>();
        // Parse every record before querying accounts; retries must not renew the grace period.
        for (const value of snapshot.intents) {
            const intent = parseDeletionIntent(value);
            const requestedAt = Date.parse(intent.requestedAt);
            requestedAtByAccount.set(intent.accountId,
                Math.min(requestedAtByAccount.get(intent.accountId) ?? requestedAt, requestedAt));
        }
        const eligible = [...requestedAtByAccount.keys()].filter(accountId =>
            nowMs - requestedAtByAccount.get(accountId)! >= settings.graceMs);
        let pendingAccounts = 0;
        let oldestPendingSeconds = 0;
        for (let offset = 0; offset < eligible.length; offset += 200) {
            const batch = eligible.slice(offset, offset + 200);
            const [rows] = await timed.query(`SELECT account_uuid AS accountId FROM users
                WHERE account_uuid IN (${batch.map(() => '?').join(',')}) LIMIT 201`, batch);
            if (!Array.isArray(rows) || rows.length > batch.length) throw new DeletionAuditError();
            const found = new Set<string>();
            for (const row of rows) {
                if (!row || !batch.includes(row.accountId) || found.has(row.accountId)) throw new DeletionAuditError();
                found.add(row.accountId);
                oldestPendingSeconds = Math.max(oldestPendingSeconds,
                    Math.floor((nowMs - requestedAtByAccount.get(row.accountId)!) / 1000));
            }
            pendingAccounts += found.size;
        }
        remaining();
        return Object.freeze({
            status: pendingAccounts > 0 ? 'pending' : 'clear',
            intentCount: snapshot.intents.length, accountCount: requestedAtByAccount.size,
            checkedAccounts: eligible.length, pendingAccounts, oldestPendingSeconds,
        });
    };

    try {
        const deadline = new Promise<never>((_, reject) => {
            timer = setTimeout(() => { expired = true; reject(new DeletionAuditError()); }, settings.maxDurationMs);
        });
        return await Promise.race([inspect(), deadline]);
    } catch {
        failed = true;
        // Driver/SDK errors may contain account data or credentials; callers only receive this safe error.
        throw new DeletionAuditError();
    } finally {
        if (timer !== undefined) clearTimeout(timer);
        if (connection) {
            if (expired || failed) connection.destroy();
            else connection.release();
        }
    }
}
