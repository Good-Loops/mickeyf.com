import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { performance } from 'node:perf_hooks';
import type { AppleTokenClient } from '../auth/appleTokenClient';
import type { StoredAppleToken } from './appleTokenRepository';
import { isAccountId } from './deletionJournal';

export const APPLE_REVOCATION_BATCH_SIZE = 20;
export const APPLE_IMMEDIATE_REVOCATION_TIMEOUT_MS = 10_000;
const QUERY_TIMEOUT_MS = 10_000;
const REVOCATION_LOCK = "CONCAT('mickeyf:apple-revocation:', LEFT(SHA2(DATABASE(), 256), 16))";
const PENDING = 'revocation_requested_at IS NOT NULL';
const EXPIRED = `${PENDING} AND retention_deadline <= UTC_TIMESTAMP(6)`;
const DUE = `${PENDING} AND next_attempt_at <= UTC_TIMESTAMP(6) AND retention_deadline > UTC_TIMESTAMP(6)`;
const MAX_ATTEMPT_COUNT = 4_294_967_295;

type Dependencies = Readonly<{
    database: Pick<Pool, 'getConnection'>;
    vault: { decrypt(row: StoredAppleToken): string };
    appleTokens: Pick<AppleTokenClient, 'revoke'>;
    clientId: string;
    immediateTimeoutMs?: number;
}>;
type PendingToken = RowDataPacket & StoredAppleToken & { attempt_count: number };
export type AppleRevocationSummary = Readonly<{
    status: 'completed' | 'backlog' | 'busy';
    selected: number; revoked: number; retried: number; expired: number;
}>;

/** Safe for callers to report: never retains row identifiers, tokens or driver errors. */
export class AppleTokenRevocationError extends Error {
    constructor(readonly code: 'INVALID_CONFIGURATION' | 'DATABASE' | 'INVALID_RESULT' | 'TIMEOUT') {
        super(`Apple revocation could not be confirmed: ${code}.`);
        this.name = 'AppleTokenRevocationError';
    }
}

function affectedRows(result: ResultSetHeader, maximum: number): number {
    if (!Number.isSafeInteger(result?.affectedRows) || result.affectedRows < 0 || result.affectedRows > maximum) {
        throw new AppleTokenRevocationError('INVALID_RESULT');
    }
    return result.affectedRows;
}

function destroyConnection(connection: PoolConnection): void {
    try { connection.destroy(); } catch { /* Do not expose teardown errors. */ }
    try {
        // A timed-out driver command may still own the socket and named lock.
        (connection as unknown as { connection?: { stream?: { destroy(): void } } }).connection?.stream?.destroy();
    } catch { /* The caller already receives a sanitized failure. */ }
}

/** Constructing this worker starts no SQL, timer or network work. */
export function createAppleTokenRevocationWorker({ database, vault, appleTokens, clientId,
    immediateTimeoutMs = APPLE_IMMEDIATE_REVOCATION_TIMEOUT_MS }: Dependencies) {
    if (typeof clientId !== 'string' || clientId.length > 255 || !/^[A-Za-z0-9]/u.test(clientId)
        || /[^A-Za-z0-9.-]/u.test(clientId)
        || !Number.isSafeInteger(immediateTimeoutMs) || immediateTimeoutMs < 1
        || immediateTimeoutMs > APPLE_IMMEDIATE_REVOCATION_TIMEOUT_MS) {
        throw new AppleTokenRevocationError('INVALID_CONFIGURATION');
    }

    async function purgeExpired(connection: PoolConnection, batchSize: number, accountId?: string): Promise<number> {
        const [result] = await connection.query<ResultSetHeader>({
            sql: `DELETE FROM apple_provider_tokens WHERE ${EXPIRED}${accountId ? ' AND account_uuid = ?' : ''}
                ORDER BY retention_deadline, token_id LIMIT ${batchSize}`, timeout: QUERY_TIMEOUT_MS,
        }, accountId ? [accountId] : []);
        return affectedRows(result, batchSize);
    }

    async function drainLocked(connection: PoolConnection, batchSize: number,
        assertActive: () => void, accountId?: string): Promise<AppleRevocationSummary> {
        const scope = accountId ? ' AND account_uuid = ?' : '';
        const scopeValues = accountId ? [accountId] : [];
        // This dedicated session commits each queue change before the external call.
        await connection.query({ sql: 'SET SESSION autocommit = 1', timeout: QUERY_TIMEOUT_MS });
        const counts = { selected: 0, revoked: 0, retried: 0, expired: await purgeExpired(connection, batchSize, accountId) };
        const [rows] = await connection.query<PendingToken[]>({
            sql: `SELECT token_id, account_uuid, client_id, encrypted_token, attempt_count FROM apple_provider_tokens
                WHERE ${DUE}${scope} ORDER BY next_attempt_at, token_id LIMIT ${batchSize}`, timeout: QUERY_TIMEOUT_MS,
        }, scopeValues);
        if (!Array.isArray(rows) || rows.length > batchSize) throw new AppleTokenRevocationError('INVALID_RESULT');
        counts.selected = rows.length;
        for (const row of rows) {
            if (!isAccountId(row.token_id) || (accountId && row.account_uuid !== accountId)
                || !Number.isSafeInteger(row.attempt_count)
                || row.attempt_count < 0 || row.attempt_count > MAX_ATTEMPT_COUNT) {
                throw new AppleTokenRevocationError('INVALID_RESULT');
            }
            const delaySeconds = Math.min(3_600, 60 * 2 ** Math.min(row.attempt_count, 6));
            // Claim before I/O: a crash still leaves a delayed retry. Recheck expiry
            // after earlier serial calls, and never write the retention deadline.
            const [claim] = await connection.query<ResultSetHeader>({
                sql: `UPDATE apple_provider_tokens SET attempt_count = LEAST(attempt_count + 1, ${MAX_ATTEMPT_COUNT}),
                    next_attempt_at = LEAST(retention_deadline, TIMESTAMPADD(SECOND, ?, UTC_TIMESTAMP(6)))
                    WHERE token_id = ? AND ${DUE}${scope}`, timeout: QUERY_TIMEOUT_MS,
            }, [delaySeconds, row.token_id, ...scopeValues]);
            if (affectedRows(claim, 1) === 0) continue;
            try {
                assertActive();
                if (row.client_id !== clientId) throw new AppleTokenRevocationError('INVALID_RESULT');
                const token = vault.decrypt(row);
                assertActive();
                await appleTokens.revoke(token);
                assertActive();
            } catch {
                assertActive();
                // Even invalid_grant is uncertain: retain for bounded retries, not
                // silent deletion. Expiry purging does not depend on Apple or keys.
                counts.retried++;
                continue;
            }
            const [deleted] = await connection.query<ResultSetHeader>({
                sql: `DELETE FROM apple_provider_tokens WHERE token_id = ? AND ${PENDING}${scope}`, timeout: QUERY_TIMEOUT_MS,
            }, [row.token_id, ...scopeValues]);
            affectedRows(deleted, 1);
            counts.revoked++;
        }
        counts.expired += await purgeExpired(connection, batchSize, accountId);
        const [remaining] = await connection.query<RowDataPacket[]>({
            sql: `SELECT 1 AS pending FROM apple_provider_tokens WHERE ((${EXPIRED}) OR (${DUE}))${scope} LIMIT 1`,
            timeout: QUERY_TIMEOUT_MS,
        }, scopeValues);
        if (!Array.isArray(remaining) || remaining.length > 1) throw new AppleTokenRevocationError('INVALID_RESULT');
        return Object.freeze({ status: remaining.length ? 'backlog' : 'completed', ...counts });
    }

    async function drainBatch(batchSize: number, accountId?: string): Promise<AppleRevocationSummary> {
        let connection: PoolConnection | undefined;
        let reusable = false;
        let stopped = false;
        let destroyed = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = accountId ? performance.now() + immediateTimeoutMs : Infinity;
        const destroy = () => {
            if (connection && !destroyed) { destroyed = true; destroyConnection(connection); }
        };
        const assertActive = () => {
            if (stopped || performance.now() >= deadline) {
                stopped = true;
                destroy();
                throw new AppleTokenRevocationError('TIMEOUT');
            }
        };
        const operation = async () => {
            connection = await database.getConnection();
            assertActive();
            // Guard every SQL boundary, including continuation after a timed-out query.
            const guarded = new Proxy(connection, {
                get(target, property) {
                    const value = Reflect.get(target, property);
                    if (property !== 'query') return typeof value === 'function' ? value.bind(target) : value;
                    return (...args: unknown[]) => { assertActive(); return Reflect.apply(value, target, args); };
                },
            });
            const [lock] = await guarded.query<RowDataPacket[]>({
                sql: `SELECT GET_LOCK(${REVOCATION_LOCK}, 0) AS acquired`, timeout: QUERY_TIMEOUT_MS,
            });
            assertActive();
            if (!Array.isArray(lock) || lock.length !== 1 || ![0, 1].includes(lock[0].acquired)) {
                throw new AppleTokenRevocationError('INVALID_RESULT');
            }
            if (lock[0].acquired === 0) {
                reusable = true;
                return Object.freeze({ status: 'busy', selected: 0, revoked: 0, retried: 0, expired: 0 });
            }
            const result = await drainLocked(guarded, batchSize, assertActive, accountId);
            const [unlock] = await guarded.query<RowDataPacket[]>({
                sql: `SELECT RELEASE_LOCK(${REVOCATION_LOCK}) AS released`, timeout: QUERY_TIMEOUT_MS,
            });
            assertActive();
            if (!Array.isArray(unlock) || unlock.length !== 1 || unlock[0].released !== 1) {
                throw new AppleTokenRevocationError('INVALID_RESULT');
            }
            reusable = true;
            return result;
        };
        try {
            if (!accountId) return await operation();
            return await Promise.race([operation(), new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => {
                    stopped = true;
                    destroy();
                    reject(new AppleTokenRevocationError('TIMEOUT'));
                }, immediateTimeoutMs);
            })]);
        } catch (error) {
            throw error instanceof AppleTokenRevocationError ? error : new AppleTokenRevocationError('DATABASE');
        } finally {
            stopped = true;
            if (timer) clearTimeout(timer);
            if (connection) {
                if (!reusable) destroy();
                else {
                    try { connection.release(); }
                    catch { destroy(); throw new AppleTokenRevocationError('DATABASE'); }
                }
            }
        }
    }

    function drain({ batchSize = APPLE_REVOCATION_BATCH_SIZE }: { batchSize?: number } = {}): Promise<AppleRevocationSummary> {
        if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > APPLE_REVOCATION_BATCH_SIZE) {
            return Promise.reject(new AppleTokenRevocationError('INVALID_CONFIGURATION'));
        }
        return drainBatch(batchSize);
    }

    /** Only call after the account deletion has committed and released its locks. */
    function revokeForAccount(accountId: string): Promise<AppleRevocationSummary> {
        if (!isAccountId(accountId)) return Promise.reject(new AppleTokenRevocationError('INVALID_CONFIGURATION'));
        return drainBatch(1, accountId);
    }

    return Object.freeze({ drain, revokeForAccount });
}
