import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { assertActiveGuardedTransaction } from '../db/queryTimeoutConnection';
import { isAccountId } from './deletionJournal';
import { advanceChildDailyUsage, type ChildDailyUsagePolicy, type ChildDailyUsageResult,
    type ChildDailyUsageState } from './childDailyUsage';
import { CHILD_DAILY_USAGE_NOTICE_VERSION } from './childDailyUsageNotice';

type Connection = Pick<PoolConnection, 'query'>;
type Stored = Readonly<{ policy: ChildDailyUsagePolicy; state: ChildDailyUsageState; noticeVersion: string }>;
const timeout = 10_000;

/** Use the database's UTC clock, never a timestamp supplied by a browser. */
async function databaseNow(connection: Connection): Promise<number> {
    const [rows] = await connection.query<RowDataPacket[]>({ sql: `SELECT
        DATE_FORMAT(UTC_TIMESTAMP(3),'%Y-%m-%dT%H:%i:%s.%fZ') AS nowUtc`, timeout });
    if (!Array.isArray(rows) || rows.length !== 1 || typeof rows[0].nowUtc !== 'string'
        || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/u.test(rows[0].nowUtc)) throw new Error('Usage clock unavailable.');
    const now = Date.parse(rows[0].nowUtc);
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('Usage clock unavailable.');
    return now;
}

function integer(value: unknown): number {
    if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(value)) throw new Error('Usage state unavailable.');
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) throw new Error('Usage state unavailable.');
    return parsed;
}

async function lockedState(connection: Connection, childId: string): Promise<Stored | null> {
    const [rows] = await connection.query<RowDataPacket[]>({ sql: `SELECT time_zone AS timeZone,
        CAST(daily_limit_ms AS CHAR) AS dailyLimitMs, usage_day AS usageDay,
        CAST(used_ms AS CHAR) AS usedMs, CAST(accounted_at_ms AS CHAR) AS accountedAtMs,
        CAST(active_until_ms AS CHAR) AS activeUntilMs, notice_version AS noticeVersion FROM parent_child_daily_usage
        WHERE child_uuid=? LIMIT 2 FOR UPDATE`, timeout }, [childId]);
    if (!Array.isArray(rows) || rows.length > 1) throw new Error('Usage state unavailable.');
    if (rows.length === 0) return null;
    const row = rows[0];
    if (typeof row.timeZone !== 'string' || typeof row.usageDay !== 'string' || typeof row.noticeVersion !== 'string') throw new Error('Usage state unavailable.');
    return { policy: { timeZone: row.timeZone, dailyLimitMs: integer(row.dailyLimitMs) },
        state: { day: row.usageDay, usedMs: integer(row.usedMs), accountedAtMs: integer(row.accountedAtMs),
            activeUntilMs: row.activeUntilMs === null ? null : integer(row.activeUntilMs) }, noticeVersion: row.noticeVersion };
}

async function save(connection: Connection, childId: string, policy: ChildDailyUsagePolicy,
    state: ChildDailyUsageState, insert: boolean): Promise<void> {
    const values = [policy.timeZone, policy.dailyLimitMs, state.day, state.usedMs,
        state.accountedAtMs, state.activeUntilMs, childId];
    const sql = insert
        ? `INSERT INTO parent_child_daily_usage
            (time_zone,daily_limit_ms,usage_day,used_ms,accounted_at_ms,active_until_ms,child_uuid,notice_version,consented_at)
            VALUES (?,?,?,?,?,?,?,?,UTC_TIMESTAMP(6))`
        : `UPDATE parent_child_daily_usage SET time_zone=?,daily_limit_ms=?,usage_day=?,used_ms=?,
            accounted_at_ms=?,active_until_ms=? WHERE child_uuid=?`;
    const [result] = await connection.query<ResultSetHeader>({ sql, timeout }, insert ? [...values, CHILD_DAILY_USAGE_NOTICE_VERSION] : values);
    if (result.affectedRows !== 1) throw new Error('Usage state was not saved.');
}

/** The caller owns the verified child lock, relationship and live-session checks. */
export async function readChildDailyUsage(connection: Connection, childId: string,
    heartbeat: boolean): Promise<(ChildDailyUsageResult & { policy: ChildDailyUsagePolicy }) | null> {
    assertActiveGuardedTransaction(connection);
    if (!isAccountId(childId) || typeof heartbeat !== 'boolean') throw new TypeError('Invalid usage request.');
    const saved = await lockedState(connection, childId);
    if (!saved || saved.noticeVersion !== CHILD_DAILY_USAGE_NOTICE_VERSION) return null;
    const result = advanceChildDailyUsage(saved.state, saved.policy, await databaseNow(connection), heartbeat);
    await save(connection, childId, saved.policy, result.state, false);
    return { ...result, policy: saved.policy };
}

/** A changed time zone preserves today's already-counted use; it cannot reset the allowance. */
export async function configureChildDailyUsage(connection: Connection, childId: string,
    policy: ChildDailyUsagePolicy): Promise<ChildDailyUsageResult> {
    assertActiveGuardedTransaction(connection);
    if (!isAccountId(childId)) throw new TypeError('Invalid child.');
    const now = await databaseNow(connection), saved = await lockedState(connection, childId);
    const initial = advanceChildDailyUsage(null, policy, now, false); // Validates both policy fields.
    let result = initial;
    if (saved) {
        const settled = advanceChildDailyUsage(saved.state, saved.policy, now, false);
        const preserved: ChildDailyUsageState = { ...settled.state, day: initial.state.day };
        result = advanceChildDailyUsage(preserved, policy, now, false);
    }
    await save(connection, childId, policy, result.state, !saved);
    if (saved) {
        const [updated] = await connection.query<ResultSetHeader>({ sql: `UPDATE parent_child_daily_usage
            SET notice_version=?,consented_at=UTC_TIMESTAMP(6) WHERE child_uuid=?`, timeout },
        [CHILD_DAILY_USAGE_NOTICE_VERSION, childId]);
        if (updated.affectedRows !== 1) throw new Error('Usage consent was not saved.');
    }
    return result;
}

/** Turning the control off removes both its setting and its current total. */
export async function clearChildDailyUsage(connection: Connection, childId: string): Promise<void> {
    assertActiveGuardedTransaction(connection);
    if (!isAccountId(childId)) throw new TypeError('Invalid child.');
    await connection.query<ResultSetHeader>({ sql: 'DELETE FROM parent_child_daily_usage WHERE child_uuid=?', timeout }, [childId]);
}

/** Draft maintenance: discard stale totals, preserving the parent's setting. Not scheduled by default. */
export async function cleanupChildDailyUsage(database: Pick<Pool, 'query'>): Promise<{ cleared: number; mayHaveMore: boolean }> {
    const [result] = await database.query<ResultSetHeader>({ sql: `UPDATE parent_child_daily_usage
        SET used_ms=0, active_until_ms=NULL
        WHERE accounted_at_ms < (TIMESTAMPDIFF(MICROSECOND, '1970-01-01 00:00:00', UTC_TIMESTAMP(3)) DIV 1000) - 172800000
        AND (used_ms <> 0 OR active_until_ms IS NOT NULL)
        ORDER BY accounted_at_ms, child_uuid LIMIT 500`, timeout });
    if (!Number.isInteger(result.affectedRows) || result.affectedRows < 0 || result.affectedRows > 500) {
        throw new Error('Usage cleanup was not confirmed.');
    }
    return { cleared: result.affectedRows, mayHaveMore: result.affectedRows === 500 };
}
