import { createHash } from 'node:crypto';
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { isAccountId } from '../accounts/deletionJournal';
import { withUserSubmissionLock, type UserSubmissionLockContext } from '../leaderboards/userSubmissionLock';
import { isSessionId, PERSISTENT_SESSION_SECONDS } from '../security/sessionPolicy';

type AccountTarget = Readonly<{ userId: number; accountId: string }>;
type SessionDatabase = Pick<Pool, 'getConnection'>;
type SessionReader = Pick<Pool, 'query'> | Pick<PoolConnection, 'query'>;
const QUERY_TIMEOUT_MS = 10_000;
const SESSION_LIMIT = 10;
const EXPIRY_SQL = "TIMESTAMPADD(SECOND, ?, '1970-01-01 00:00:00')";

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

async function transaction<T>(context: UserSubmissionLockContext, operation: () => Promise<T>): Promise<T> {
    let phase: 'begin' | 'active' | 'commit' = 'begin';
    try {
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
): Promise<boolean> {
    const hash = sessionHash(target, sessionId);
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + PERSISTENT_SESSION_SECONDS
        || (expectedPasswordHash !== undefined && (typeof expectedPasswordHash !== 'string'
            || expectedPasswordHash.length === 0 || expectedPasswordHash.length > 255))) {
        throw new TypeError('A session expiry within thirty days and a valid optional password hash are required.');
    }
    const account = { ...target };
    try {
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
                sql: `DELETE FROM account_sessions WHERE account_uuid = ? AND expires_at <= UTC_TIMESTAMP(6)
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
            // UTC arithmetic avoids depending on a pooled connection's session time zone.
            const [inserted] = await connection.query<ResultSetHeader>({
                sql: `INSERT INTO account_sessions (session_hash, account_uuid, created_at, expires_at)
                    SELECT ?, ?, UTC_TIMESTAMP(6), ${EXPIRY_SQL}
                    WHERE ${EXPIRY_SQL} > UTC_TIMESTAMP(6)
                    AND ${EXPIRY_SQL} <= UTC_TIMESTAMP(6) + INTERVAL 30 DAY`, timeout: QUERY_TIMEOUT_MS,
            }, [hash, account.accountId, expiresAt, expiresAt, expiresAt]);
            if (inserted.affectedRows !== 1) throw new AccountSessionUnavailableError();
            return true;
        }));
    } catch {
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
                WHERE u.user_id = ? AND u.account_uuid = ? AND s.session_hash = ?
                AND s.expires_at > UTC_TIMESTAMP(6) LIMIT 2`, timeout: QUERY_TIMEOUT_MS,
        }, [userId, accountId, hash]);
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
                    WHERE u.user_id = ? AND u.account_uuid = ? AND s.session_hash = ?`, timeout: QUERY_TIMEOUT_MS,
            }, [userId, accountId, hash]);
        }));
    } catch { throw new AccountSessionUnavailableError(); }
}
