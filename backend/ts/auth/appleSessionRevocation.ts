import { createHash } from 'node:crypto';
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { assertAccountId, isAccountId } from '../accounts/deletionJournal';
import { withUserSubmissionLock } from '../leaderboards/userSubmissionLock';
import type { VerifiedAppleNotification } from './appleNotificationVerifier';

export type AppleSessionProof = Readonly<{ clientId: string; subject: string; issuedAt: number }>;
type RevocationDatabase = Pick<Pool, 'query' | 'getConnection'>;
type QueryConnection = Pick<PoolConnection, 'query'>;
type ConnectionContext = { connection: PoolConnection; reusable: boolean };

export const APPLE_SESSION_PROOF_MAX_AGE_SECONDS = 300;
export const APPLE_SESSION_PROOF_FUTURE_TOLERANCE_SECONDS = 30;
export const APPLE_REVOCATION_RETENTION_SECONDS = 330;
const QUERY_TIMEOUT_MS = 10_000;
const MAX_WATERMARKS = 10_000;
const CLEANUP_BATCH = 100;
const CAPACITY_LOCK = "CONCAT('mickeyf:apple-revocations:', LEFT(SHA2(DATABASE(), 256), 16))";
const EPOCH_SQL = "TIMESTAMPDIFF(SECOND, '1970-01-01', UTC_TIMESTAMP())";
const EXPIRY_SQL = "TIMESTAMPADD(SECOND, ?, '1970-01-01 00:00:00')";

export class AppleSessionRevocationUnavailableError extends Error {
    constructor() {
        super('Apple session revocation could not be confirmed.');
        this.name = 'AppleSessionRevocationUnavailableError';
    }
}

function isIdentifier(value: unknown): value is string {
    return typeof value === 'string' && /^[\x21-\x7e]{1,255}$/u.test(value);
}

function isEpoch(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function readEpoch(value: unknown): number {
    const epoch = typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : value;
    if (!isEpoch(epoch)) throw new AppleSessionRevocationUnavailableError();
    return epoch;
}

/** Domain separation and unambiguous framing bind the subject to its configured Apple client. */
export function appleSubjectHash(proof: Pick<AppleSessionProof, 'clientId' | 'subject'>): Buffer {
    if (!proof || !isIdentifier(proof.clientId) || !isIdentifier(proof.subject)) {
        throw new TypeError('A verified Apple client and subject are required.');
    }
    return createHash('sha256').update(JSON.stringify(['apple-session', proof.clientId, proof.subject])).digest();
}

async function databaseNow(connection: QueryConnection): Promise<number> {
    const [rows] = await connection.query<RowDataPacket[]>({
        sql: `SELECT ${EPOCH_SQL} AS now`, timeout: QUERY_TIMEOUT_MS,
    });
    if (!Array.isArray(rows) || rows.length !== 1) throw new AppleSessionRevocationUnavailableError();
    return readEpoch(rows[0].now);
}

/** Caller holds the user lock and session-insertion transaction; stale proof cannot issue a session. */
export async function assertFreshAppleSession(
    connection: QueryConnection, accountId: string, proof: AppleSessionProof,
): Promise<boolean> {
    assertAccountId(accountId);
    const hash = appleSubjectHash(proof);
    if (!isEpoch(proof.issuedAt)) throw new TypeError('An original verified Apple issuance time is required.');
    try {
        const [identities] = await connection.query<RowDataPacket[]>({
            sql: `SELECT subject FROM account_provider_identities
                WHERE account_uuid = ? AND provider = 'apple' LIMIT 2 FOR SHARE`, timeout: QUERY_TIMEOUT_MS,
        }, [accountId]);
        if (!Array.isArray(identities) || identities.length > 1
            || (identities[0] && (!Buffer.isBuffer(identities[0].subject)
                || identities[0].subject.length < 1 || identities[0].subject.length > 255))) {
            throw new AppleSessionRevocationUnavailableError();
        }
        if (!identities[0] || !identities[0].subject.equals(Buffer.from(proof.subject, 'ascii'))) return false;
        const [watermarks] = await connection.query<RowDataPacket[]>({
            sql: 'SELECT revoked_at FROM apple_auth_revocations WHERE subject_hash = ? LIMIT 2 FOR SHARE',
            timeout: QUERY_TIMEOUT_MS,
        }, [hash]);
        if (!Array.isArray(watermarks) || watermarks.length > 1) throw new AppleSessionRevocationUnavailableError();
        const revokedAt = watermarks[0] ? readEpoch(watermarks[0].revoked_at) : null;
        // Read the clock after locking reads: waiting must not make a five-minute proof immortal.
        const now = await databaseNow(connection);
        return now - proof.issuedAt < APPLE_SESSION_PROOF_MAX_AGE_SECONDS
            && proof.issuedAt <= now + APPLE_SESSION_PROOF_FUTURE_TOLERANCE_SECONDS
            && (revokedAt === null || proof.issuedAt > revokedAt);
    } catch { throw new AppleSessionRevocationUnavailableError(); }
}

/** Bounded cleanup also lets the existing maintenance worker enforce expiry during quiet periods. */
export async function cleanupExpiredAppleRevocations(connection: QueryConnection): Promise<number> {
    try {
        const [result] = await connection.query<ResultSetHeader>({
            sql: `DELETE FROM apple_auth_revocations WHERE expires_at <= UTC_TIMESTAMP(6)
                ORDER BY expires_at LIMIT ${CLEANUP_BATCH}`, timeout: QUERY_TIMEOUT_MS,
        });
        if (!Number.isSafeInteger(result.affectedRows) || result.affectedRows < 0 || result.affectedRows > CLEANUP_BATCH) {
            throw new AppleSessionRevocationUnavailableError();
        }
        return result.affectedRows;
    } catch { throw new AppleSessionRevocationUnavailableError(); }
}

async function transaction<T>(context: ConnectionContext, operation: () => Promise<T>): Promise<T> {
    let phase: 'begin' | 'active' | 'commit' = 'begin';
    try {
        await context.connection.query({ sql: 'START TRANSACTION', timeout: QUERY_TIMEOUT_MS });
        phase = 'active';
        const result = await operation();
        phase = 'commit';
        await context.connection.query({ sql: 'COMMIT', timeout: QUERY_TIMEOUT_MS });
        return result;
    } catch (error) {
        if (phase !== 'active') context.reusable = false;
        else {
            try { await context.connection.query({ sql: 'ROLLBACK', timeout: QUERY_TIMEOUT_MS }); }
            catch { context.reusable = false; }
        }
        throw error;
    }
}

async function withCapacityLock(context: ConnectionContext, operation: () => Promise<void>): Promise<void> {
    let acquired: unknown;
    try {
        const [rows] = await context.connection.query<RowDataPacket[]>({
            sql: `SELECT GET_LOCK(${CAPACITY_LOCK}, 5) AS lockResult`, timeout: QUERY_TIMEOUT_MS,
        });
        if (!Array.isArray(rows) || rows.length !== 1) throw new AppleSessionRevocationUnavailableError();
        acquired = rows[0].lockResult;
    } catch (error) { context.reusable = false; throw error; }
    if (acquired === 0) throw new AppleSessionRevocationUnavailableError();
    if (acquired !== 1) { context.reusable = false; throw new AppleSessionRevocationUnavailableError(); }
    try { await operation(); }
    finally {
        if (context.reusable) {
            try {
                const [rows] = await context.connection.query<RowDataPacket[]>({
                    sql: `SELECT RELEASE_LOCK(${CAPACITY_LOCK}) AS lockResult`, timeout: QUERY_TIMEOUT_MS,
                });
                if (!Array.isArray(rows) || rows.length !== 1 || rows[0].lockResult !== 1) {
                    throw new AppleSessionRevocationUnavailableError();
                }
            } catch (error) { context.reusable = false; throw error; }
        }
    }
}

async function storeWatermark(database: RevocationDatabase, hash: Buffer, eventTime: number): Promise<void> {
    const context: ConnectionContext = { connection: await database.getConnection(), reusable: true };
    try {
        await withCapacityLock(context, () => transaction(context, async () => {
            const { connection } = context;
            await cleanupExpiredAppleRevocations(connection);
            const now = await databaseNow(connection);
            if (eventTime > now + APPLE_SESSION_PROOF_FUTURE_TOLERANCE_SECONDS) {
                throw new AppleSessionRevocationUnavailableError();
            }
            const expiry = eventTime + APPLE_REVOCATION_RETENTION_SECONDS;
            if (!Number.isSafeInteger(expiry)) throw new AppleSessionRevocationUnavailableError();
            if (expiry <= now) return;
            const [existing] = await connection.query<RowDataPacket[]>({
                sql: 'SELECT revoked_at FROM apple_auth_revocations WHERE subject_hash = ? LIMIT 2 FOR UPDATE',
                timeout: QUERY_TIMEOUT_MS,
            }, [hash]);
            if (!Array.isArray(existing) || existing.length > 1) throw new AppleSessionRevocationUnavailableError();
            if (existing[0]) readEpoch(existing[0].revoked_at);
            else {
                const [rows] = await connection.query<RowDataPacket[]>({
                    sql: `SELECT COUNT(*) AS watermarkCount FROM (
                        SELECT subject_hash FROM apple_auth_revocations LIMIT ${MAX_WATERMARKS}
                    ) AS bounded_watermarks`, timeout: QUERY_TIMEOUT_MS,
                });
                const rawCount: unknown = rows?.[0]?.watermarkCount;
                const count = typeof rawCount === 'string' && /^\d+$/u.test(rawCount) ? Number(rawCount) : rawCount;
                if (!Array.isArray(rows) || rows.length !== 1 || typeof count !== 'number' || !Number.isSafeInteger(count)
                    || count < 0 || count >= MAX_WATERMARKS) throw new AppleSessionRevocationUnavailableError();
            }
            // Replays never restart retention. This commits BEFORE acquiring any user lock.
            const [result] = await connection.query<ResultSetHeader>({
                sql: `INSERT INTO apple_auth_revocations (subject_hash, revoked_at, expires_at)
                    VALUES (?, ?, ${EXPIRY_SQL}) ON DUPLICATE KEY UPDATE
                    revoked_at = GREATEST(revoked_at, ?), expires_at = GREATEST(expires_at, ${EXPIRY_SQL})`,
                timeout: QUERY_TIMEOUT_MS,
            }, [hash, eventTime, expiry, eventTime, expiry]);
            if (![0, 1, 2].includes(result.affectedRows)) throw new AppleSessionRevocationUnavailableError();
        }));
    } finally {
        if (context.reusable) context.connection.release();
        else context.connection.destroy();
    }
}

async function revokeMatchingSessions(database: RevocationDatabase, hash: Buffer,
    subject: string, eventTime: number): Promise<void> {
    const subjectBytes = Buffer.from(subject, 'ascii');
    // Fresh autocommit lookup sees a link established while the watermark was being committed.
    const [accounts] = await database.query<RowDataPacket[]>({
        sql: `SELECT u.user_id AS userId, u.account_uuid AS accountId
            FROM account_provider_identities AS p INNER JOIN users AS u ON u.account_uuid = p.account_uuid
            WHERE p.provider = 'apple' AND p.subject = ? LIMIT 2`, timeout: QUERY_TIMEOUT_MS,
    }, [subjectBytes]);
    if (!Array.isArray(accounts) || accounts.length > 1 || (accounts[0]
        && (!Number.isSafeInteger(accounts[0].userId) || accounts[0].userId <= 0
            || accounts[0].userId > 2_147_483_647 || !isAccountId(accounts[0].accountId)))) {
        throw new AppleSessionRevocationUnavailableError();
    }
    if (!accounts[0]) return;
    const { userId, accountId } = accounts[0];
    await withUserSubmissionLock(database, userId, async lock => {
        const context: ConnectionContext = { connection: lock.connection, reusable: true };
        try {
            await transaction(context, async () => {
                const [current] = await context.connection.query<RowDataPacket[]>({
                    sql: `SELECT u.account_uuid AS accountId, p.subject FROM users AS u
                        INNER JOIN account_provider_identities AS p ON p.account_uuid = u.account_uuid
                        WHERE u.user_id = ? AND p.provider = 'apple' LIMIT 2 FOR UPDATE`, timeout: QUERY_TIMEOUT_MS,
                }, [userId]);
                if (!Array.isArray(current) || current.length > 1 || (current[0]
                    && (!isAccountId(current[0].accountId) || !Buffer.isBuffer(current[0].subject)))) {
                    throw new AppleSessionRevocationUnavailableError();
                }
                // Deletion/recreation cannot redirect a stale lookup to another incarnation.
                if (!current[0] || current[0].accountId !== accountId || !current[0].subject.equals(subjectBytes)) return;
                await context.connection.query({
                    sql: `DELETE FROM account_sessions WHERE account_uuid = ?
                        AND apple_subject_hash = ? AND apple_authenticated_at <= ?`, timeout: QUERY_TIMEOUT_MS,
                }, [accountId, hash, eventTime]);
            });
        } finally { if (!context.reusable) lock.invalidateConnection(); }
    });
}

/** Only verified Apple messages reach here. No raw JWS, tokens or notification history is retained. */
export async function applyAppleNotification(database: RevocationDatabase, notification: VerifiedAppleNotification): Promise<void> {
    const hash = appleSubjectHash({ clientId: notification?.audience, subject: notification?.subject });
    if (!notification || !isEpoch(notification.eventTime)
        || !['consent-revoked', 'account-deleted', 'email-enabled', 'email-disabled'].includes(notification.eventType)) {
        throw new TypeError('A verified Apple notification is required.');
    }
    if (notification.eventType === 'email-enabled' || notification.eventType === 'email-disabled') return;
    try {
        await storeWatermark(database, hash, notification.eventTime);
        // Even an old event must remove surviving pre-event sessions after its watermark TTL elapsed.
        await revokeMatchingSessions(database, hash, notification.subject, notification.eventTime);
    } catch { throw new AppleSessionRevocationUnavailableError(); }
}
