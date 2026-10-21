import { createHash } from 'node:crypto';
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { isAccountId } from '../accounts/deletionJournal';
import { appleSubjectHash, assertFreshAppleSession, APPLE_SESSION_PROOF_MAX_AGE_SECONDS,
    APPLE_SESSION_PROOF_FUTURE_TOLERANCE_SECONDS, type AppleSessionProof } from './appleSessionRevocation';
import { withUserSubmissionLock, type UserSubmissionLockContext } from '../leaderboards/userSubmissionLock';
import { isSessionId, PERSISTENT_SESSION_SECONDS,
    SESSION_RENEWAL_GRACE_SECONDS, SESSION_RENEWAL_INTERVAL_SECONDS } from '../security/sessionPolicy';

type AccountTarget = Readonly<{ userId: number; accountId: string }>;
type SessionDatabase = Pick<Pool, 'getConnection'>;
type SessionReader = Pick<Pool, 'query'> | Pick<PoolConnection, 'query'>;
const QUERY_TIMEOUT_MS = 10_000;
const SESSION_LIMIT = 10;
const EXPIRY_SQL = "TIMESTAMPADD(SECOND, ?, '1970-01-01 00:00:00')";
class AppleSessionProofRejected extends Error {}

export class AccountSessionUnavailableError extends Error {
    constructor() {
        super('The account session operation could not be confirmed.');
        this.name = 'AccountSessionUnavailableError';
    }
}

function sessionHash(target: AccountTarget, sessionId: string): Buffer {
    if (!target || !Number.isSafeInteger(target.userId) || target.userId <= 0
        || target.userId > 2_147_483_647 || !isAccountId(target.accountId)
        || !isSessionId(sessionId)) {
        throw new TypeError('A valid account and session identifier are required.');
    }
    return createHash('sha256').update(sessionId, 'ascii').digest();
}

async function transaction<T>(
    context: UserSubmissionLockContext, operation: () => Promise<T>, isolationLevel?: 'READ COMMITTED',
): Promise<T> {
    let phase: 'begin' | 'active' | 'commit' = 'begin';
    try {
        if (isolationLevel === 'READ COMMITTED') {
            // Only the next transaction changes; never change a pooled connection's session default.
            await context.connection.query({ sql: 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED', timeout: QUERY_TIMEOUT_MS });
        }
        await context.connection.query({ sql: 'START TRANSACTION', timeout: QUERY_TIMEOUT_MS });
        phase = 'active';
        const result = await operation();
        phase = 'commit';
        await context.connection.query({ sql: 'COMMIT', timeout: QUERY_TIMEOUT_MS });
        return result;
    } catch (error) {
        if (phase !== 'active') context.invalidateConnection();
        else {
            try { await context.connection.query({ sql: 'ROLLBACK', timeout: QUERY_TIMEOUT_MS }); }
            catch { context.invalidateConnection(); }
        }
        throw error;
    }
}

/** Password proof is rechecked under the deletion/submission lock before issuing a device session. */
export async function createAccountSession(
    database: SessionDatabase, target: AccountTarget, sessionId: string, expiresAt: number,
    expectedPasswordHash?: string,
    rememberMe = false,
    appleProof?: AppleSessionProof,
): Promise<boolean> {
    const hash = sessionHash(target, sessionId);
    const appleHash = appleProof === undefined ? undefined : appleSubjectHash(appleProof);
    const proof = appleProof === undefined ? undefined : Object.freeze({ ...appleProof });
    const now = Math.floor(Date.now() / 1000);
    if (typeof rememberMe !== 'boolean' || !Number.isSafeInteger(expiresAt)
        || expiresAt <= now || expiresAt > now + PERSISTENT_SESSION_SECONDS
        || (expectedPasswordHash !== undefined && (typeof expectedPasswordHash !== 'string'
            || expectedPasswordHash.length === 0 || expectedPasswordHash.length > 255))) {
        throw new TypeError('A session expiry within thirty days and a valid optional password hash are required.');
    }
    const account = { ...target };
    try {
        // The account lock protects proof/cap checks; range gap locks would also block unrelated logins.
        return await withUserSubmissionLock(database, account.userId, context => transaction(context, async () => {
            const { connection } = context;
            const [users] = await connection.query<RowDataPacket[]>({
                sql: `SELECT account_uuid AS accountId, user_password AS passwordHash FROM users
                    WHERE user_id = ? LIMIT 1 FOR UPDATE`, timeout: QUERY_TIMEOUT_MS,
            }, [account.userId]);
            if (!Array.isArray(users) || users.length > 1) throw new AccountSessionUnavailableError();
            if (!users[0] || users[0].accountId !== account.accountId) return false;
            if (expectedPasswordHash !== undefined && users[0].passwordHash !== expectedPasswordHash) return false;
            await connection.query({
                sql: `DELETE FROM account_sessions WHERE account_uuid = ?
                    AND expires_at <= UTC_TIMESTAMP(6)
                    ORDER BY expires_at LIMIT ${SESSION_LIMIT}`, timeout: QUERY_TIMEOUT_MS,
            }, [account.accountId]);
            const [sessions] = await connection.query<RowDataPacket[]>({
                sql: `SELECT session_hash FROM account_sessions WHERE account_uuid = ?
                    ORDER BY created_at, session_hash LIMIT ${SESSION_LIMIT + 1} FOR UPDATE`, timeout: QUERY_TIMEOUT_MS,
            }, [account.accountId]);
            if (!Array.isArray(sessions) || sessions.length > SESSION_LIMIT
                || sessions.some(row => !Buffer.isBuffer(row.session_hash) || row.session_hash.length !== 32)) {
                throw new AccountSessionUnavailableError();
            }
            if (sessions.length === SESSION_LIMIT) {
                const [removed] = await connection.query<ResultSetHeader>({
                    sql: 'DELETE FROM account_sessions WHERE account_uuid = ? AND session_hash = ?', timeout: QUERY_TIMEOUT_MS,
                }, [account.accountId, sessions[0].session_hash]);
                if (removed.affectedRows !== 1) throw new AccountSessionUnavailableError();
            }
            // Recheck after every lock/cap wait and roll back eviction on rejection.
            // Initial provider verification cannot rule out revocation during sign-in.
            if (proof && !await assertFreshAppleSession(connection, account.accountId, proof)) throw new AppleSessionProofRejected();
            // UTC arithmetic avoids depending on a pooled connection's session time zone.
            const [inserted] = await connection.query<ResultSetHeader>({
                sql: `INSERT INTO account_sessions (session_hash, account_uuid, created_at, expires_at,
                    remembered, renewed_at${proof ? ', apple_subject_hash, apple_authenticated_at' : ''})
                    SELECT ?, ?, UTC_TIMESTAMP(6), ${EXPIRY_SQL}, ?, UTC_TIMESTAMP(6)${proof ? ', ?, ?' : ''}
                    WHERE ${EXPIRY_SQL} > UTC_TIMESTAMP(6)
                    AND ${EXPIRY_SQL} <= UTC_TIMESTAMP(6) + INTERVAL 30 DAY${proof
                        ? ` AND ${EXPIRY_SQL} > UTC_TIMESTAMP(6) - INTERVAL ${APPLE_SESSION_PROOF_MAX_AGE_SECONDS} SECOND
                            AND ${EXPIRY_SQL} <= UTC_TIMESTAMP(6) + INTERVAL ${APPLE_SESSION_PROOF_FUTURE_TOLERANCE_SECONDS} SECOND` : ''}`,
                timeout: QUERY_TIMEOUT_MS,
            }, [hash, account.accountId, expiresAt, rememberMe ? 1 : 0,
                ...(proof ? [appleHash, proof.issuedAt] : []), expiresAt, expiresAt,
                ...(proof ? [proof.issuedAt, proof.issuedAt] : [])]);
            if (proof && inserted.affectedRows === 0) throw new AppleSessionProofRejected();
            if (inserted.affectedRows !== 1) throw new AccountSessionUnavailableError();
            return true;
        }, 'READ COMMITTED'));
    } catch (error) {
        if (error instanceof AppleSessionProofRejected) return false;
        // Never retain raw driver parameters, credentials, or an uncertain commit as a successful login.
        throw new AccountSessionUnavailableError();
    }
}

/** Read-only validation also accepts the locked connection used by account mutations. */
export async function readLiveSession(
    database: SessionReader, userId: number, accountId: string, sessionId: string,
): Promise<Readonly<{ userName: string }> | null> {
    const hash = sessionHash({ userId, accountId }, sessionId);
    try {
        const [rows] = await database.query<RowDataPacket[]>({
            sql: `SELECT u.user_name AS userName FROM account_sessions AS s
                INNER JOIN users AS u ON u.account_uuid = s.account_uuid
                WHERE u.user_id = ? AND u.account_uuid = ?
                AND (s.session_hash = ? OR (s.previous_session_hash = ? AND s.previous_valid_until > UTC_TIMESTAMP(6)))
                AND s.expires_at > UTC_TIMESTAMP(6) LIMIT 2`, timeout: QUERY_TIMEOUT_MS,
        }, [userId, accountId, hash, hash]);
        if (!Array.isArray(rows) || rows.length > 1
            || (rows[0] && (typeof rows[0].userName !== 'string' || rows[0].userName.length === 0))) {
            throw new AccountSessionUnavailableError();
        }
        return rows[0] ? Object.freeze({ userName: rows[0].userName }) : null;
    } catch { throw new AccountSessionUnavailableError(); }
}

/** Logout revokes only this device; deletion cascades all of the account's sessions. */
export async function revokeAccountSession(
    database: SessionDatabase, userId: number, accountId: string, sessionId: string,
): Promise<void> {
    const hash = sessionHash({ userId, accountId }, sessionId);
    try {
        await withUserSubmissionLock(database, userId, context => transaction(context, async () => {
            await context.connection.query({
                sql: `DELETE s FROM account_sessions AS s INNER JOIN users AS u ON u.account_uuid = s.account_uuid
                    WHERE u.user_id = ? AND u.account_uuid = ?
                    AND (s.session_hash = ? OR s.previous_session_hash = ?)`, timeout: QUERY_TIMEOUT_MS,
            }, [userId, accountId, hash, hash]);
        }));
    } catch { throw new AccountSessionUnavailableError(); }
}

type SessionRenewalResult = Readonly<{
    userName: string;
    renewal?: Readonly<{ sessionId: string; issuedAt: number; expiresAt: number }>;
}>;

type RenewableSession = Readonly<{
    userName: string; currentHash: Buffer; previousHash: Buffer | null; remembered: boolean;
    now: number; expiresAt: number; renewedAt: number | null;
}>;

function inspectRenewableSession(row: RowDataPacket): RenewableSession {
    const validEpoch = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
    const now = Number(row.now); const expiresAt = Number(row.expiresAt);
    const renewedAt = row.renewedAt === null ? null : Number(row.renewedAt);
    if (typeof row.userName !== 'string' || !row.userName
        || !Buffer.isBuffer(row.currentHash) || row.currentHash.length !== 32
        || (row.previousHash !== null && (!Buffer.isBuffer(row.previousHash) || row.previousHash.length !== 32))
        || (row.remembered !== 0 && row.remembered !== 1)
        || !validEpoch(now) || !validEpoch(expiresAt) || expiresAt <= now
        || (renewedAt !== null && (!validEpoch(renewedAt) || renewedAt > now))
        || (row.remembered === 1 && renewedAt === null)) {
        throw new AccountSessionUnavailableError();
    }
    return { userName: row.userName, currentHash: row.currentHash, previousHash: row.previousHash,
        remembered: row.remembered === 1, now, expiresAt, renewedAt };
}

/** Rotate one remembered device under the same lock as logout, deletion and score submission.
 * Deterministic replacement lets concurrent requests recover the identical cookie during a short grace period,
 * without storing a usable credential or turning an expired/revoked session into a new login.
 */
export async function renewAccountSession(
    database: SessionDatabase, userId: number, accountId: string, sessionId: string,
    deriveReplacement: (oldId: string) => string,
): Promise<SessionRenewalResult | null> {
    const hash = sessionHash({ userId, accountId }, sessionId);
    if (typeof deriveReplacement !== 'function') throw new TypeError('A session replacement function is required.');
    try {
        return await withUserSubmissionLock(database, userId, context => transaction(context, async () => {
            const [rows] = await context.connection.query<RowDataPacket[]>({
                sql: `SELECT u.user_name AS userName, s.session_hash AS currentHash,
                    s.previous_session_hash AS previousHash, s.remembered,
                    TIMESTAMPDIFF(SECOND, '1970-01-01', UTC_TIMESTAMP()) AS now,
                    TIMESTAMPDIFF(SECOND, '1970-01-01', s.expires_at) AS expiresAt,
                    TIMESTAMPDIFF(SECOND, '1970-01-01', s.renewed_at) AS renewedAt
                    FROM account_sessions AS s INNER JOIN users AS u ON u.account_uuid = s.account_uuid
                    WHERE u.user_id = ? AND u.account_uuid = ?
                    AND (s.session_hash = ? OR (s.previous_session_hash = ? AND s.previous_valid_until > UTC_TIMESTAMP(6)))
                    AND s.expires_at > UTC_TIMESTAMP(6) LIMIT 2 FOR UPDATE`,
                timeout: QUERY_TIMEOUT_MS,
            }, [userId, accountId, hash, hash]);
            if (!Array.isArray(rows) || rows.length > 1) throw new AccountSessionUnavailableError();
            if (!rows[0]) return null;
            const session = inspectRenewableSession(rows[0]);
            if (!session.remembered) return Object.freeze({ userName: session.userName });
            const current = session.currentHash.equals(hash);
            if (current && session.now - session.renewedAt! < SESSION_RENEWAL_INTERVAL_SECONDS) {
                return Object.freeze({ userName: session.userName });
            }
            const replacement = deriveReplacement(sessionId);
            const replacementHash = sessionHash({ userId, accountId }, replacement);
            if (replacementHash.equals(hash)) throw new AccountSessionUnavailableError();
            if (!current) {
                if (!session.previousHash?.equals(hash) || !replacementHash.equals(session.currentHash)) {
                    throw new AccountSessionUnavailableError();
                }
                return Object.freeze({ userName: session.userName, renewal: Object.freeze({
                    sessionId: replacement, issuedAt: session.renewedAt!, expiresAt: session.expiresAt,
                }) });
            }
            const expiresAt = session.now + PERSISTENT_SESSION_SECONDS;
            // Only a single predecessor survives this rotation; the original creation time stays intact.
            const [updated] = await context.connection.query<ResultSetHeader>({
                sql: `UPDATE account_sessions SET session_hash = ?, previous_session_hash = ?,
                    previous_valid_until = ${EXPIRY_SQL}, renewed_at = ${EXPIRY_SQL}, expires_at = ${EXPIRY_SQL}
                    WHERE account_uuid = ? AND session_hash = ? AND remembered = 1`, timeout: QUERY_TIMEOUT_MS,
            }, [replacementHash, hash, session.now + SESSION_RENEWAL_GRACE_SECONDS, session.now, expiresAt, accountId, hash]);
            if (updated.affectedRows !== 1) throw new AccountSessionUnavailableError();
            return Object.freeze({ userName: session.userName, renewal: Object.freeze({
                sessionId: replacement, issuedAt: session.now, expiresAt,
            }) });
        }));
    } catch { throw new AccountSessionUnavailableError(); }
}
