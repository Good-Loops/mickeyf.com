import bcrypt from 'bcryptjs';
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { VerifiedProviderIdentity } from '../auth/providerIdentity';
import { readLiveSession } from '../auth/accountSessionRepository';
import { withUserSubmissionLock } from '../leaderboards/userSubmissionLock';
import { isSessionId, type SessionProof } from '../security/sessionPolicy';
import { validateLoginRequest } from '../security/userRequestValidation';
import { assertAccountId } from './deletionJournal';

export type ProviderAccount = Readonly<{ userId: number; userName: string; accountId: string }>;
export type AccountLinkTarget = Readonly<{ userId: number; accountId: string }>;
export type ProviderLinkResult = 'linked' | 'already-linked' | 'link-conflict' | 'invalid-password' | 'not-found';

const QUERY_TIMEOUT_MS = 10_000;

export class ProviderAccountUnavailableError extends Error {
    constructor() {
        super('The provider account operation could not be confirmed.');
        this.name = 'ProviderAccountUnavailableError';
    }
}

function identitySubject(identity: VerifiedProviderIdentity): Buffer {
    if (!identity || !['google', 'apple'].includes(identity.provider)
        || typeof identity.subject !== 'string' || !/^[\x21-\x7e]{1,255}$/.test(identity.subject)) {
        throw new TypeError('A verified provider identity is required.');
    }
    // Byte-exact comparison: neither collation rules nor email normalization identify an OAuth account.
    return Buffer.from(identity.subject, 'ascii');
}

/** Only a verified token may reach this lookup; absence never creates or email-matches an account. */
export async function findProviderAccount(
    database: Pick<Pool, 'query'>, identity: VerifiedProviderIdentity,
): Promise<ProviderAccount | null> {
    const subject = identitySubject(identity);
    try {
        const [rows] = await database.query<RowDataPacket[]>({
            sql: `SELECT u.user_id AS userId, u.user_name AS userName, u.account_uuid AS accountId
                FROM account_provider_identities AS p
                INNER JOIN users AS u ON u.account_uuid = p.account_uuid
                WHERE p.provider = ? AND p.subject = ? LIMIT 2`,
            timeout: QUERY_TIMEOUT_MS,
        }, [identity.provider, subject]);
        if (!Array.isArray(rows) || rows.length > 1) throw new ProviderAccountUnavailableError();
        const account = rows[0];
        if (!account) return null;
        if (!Number.isSafeInteger(account.userId) || account.userId <= 0
            || typeof account.userName !== 'string' || account.userName.length === 0) {
            throw new ProviderAccountUnavailableError();
        }
        assertAccountId(account.accountId);
        return Object.freeze({ userId: account.userId, userName: account.userName, accountId: account.accountId });
    } catch {
        // Driver errors can include identity subjects, statements and connection details.
        throw new ProviderAccountUnavailableError();
    }
}

async function insertLink(
    connection: PoolConnection, target: AccountLinkTarget, identity: VerifiedProviderIdentity, subject: Buffer,
): Promise<'linked' | 'already-linked' | 'link-conflict'> {
    try {
        const [inserted] = await connection.query<ResultSetHeader>({
            sql: `INSERT INTO account_provider_identities (provider, subject, account_uuid, linked_at)
                VALUES (?, ?, ?, UTC_TIMESTAMP(6))`, timeout: QUERY_TIMEOUT_MS,
        }, [identity.provider, subject, target.accountId]);
        if (inserted.affectedRows !== 1) throw new ProviderAccountUnavailableError();
        return 'linked';
    } catch (error) {
        // Unique constraints choose one winner across processes; never upsert/reassign a link.
        if (!error || typeof error !== 'object' || !('errno' in error) || error.errno !== 1062) throw error;
        const [existing] = await connection.query<RowDataPacket[]>({
            sql: `SELECT account_uuid AS accountId, subject FROM account_provider_identities
                WHERE provider = ? AND (subject = ? OR account_uuid = ?) LIMIT 3 FOR UPDATE`,
            timeout: QUERY_TIMEOUT_MS,
        }, [identity.provider, subject, target.accountId]);
        if (!Array.isArray(existing) || existing.length === 0 || existing.length > 2) {
            throw new ProviderAccountUnavailableError();
        }
        return existing.length === 1 && existing[0].accountId === target.accountId
            && Buffer.isBuffer(existing[0].subject) && existing[0].subject.equals(subject)
            ? 'already-linked' : 'link-conflict';
    }
}

/**
 * Provider verification may outlive the caller's session. Recheck its proof and
 * password under the shared deletion/submission lock before creating a link.
 */
export async function linkProviderAccount(
    database: Pick<Pool, 'getConnection'>,
    target: AccountLinkTarget,
    password: string,
    identity: VerifiedProviderIdentity,
    expectedSession: SessionProof,
): Promise<ProviderLinkResult> {
    const subject = identitySubject(identity);
    if (!target || !Number.isSafeInteger(target.userId) || target.userId <= 0) {
        throw new TypeError('An authenticated account target is required.');
    }
    assertAccountId(target.accountId);
    if (!expectedSession || !isSessionId(expectedSession.sessionId)) {
        throw new TypeError('An authenticated session proof is required.');
    }
    assertAccountId(expectedSession.accountId);
    if (expectedSession.accountId !== target.accountId) return 'not-found';
    const accountTarget = { ...target };
    const sessionId = expectedSession.sessionId;
    // Reuse legacy-login password bounds without changing its normalization or accepted accounts.
    if (!validateLoginRequest({ user_name: 'link', user_password: password }).valid) return 'invalid-password';
    try {
        return await withUserSubmissionLock(database, accountTarget.userId, async ({ connection, invalidateConnection }) => {
            let phase: 'begin' | 'active' | 'commit' = 'begin';
            try {
                await connection.beginTransaction();
                phase = 'active';
                const [accounts] = await connection.query<RowDataPacket[]>({
                    sql: `SELECT user_password AS passwordHash, account_uuid AS accountId
                        FROM users WHERE user_id = ? LIMIT 1 FOR UPDATE`, timeout: QUERY_TIMEOUT_MS,
                }, [accountTarget.userId]);
                let result: ProviderLinkResult = 'not-found';
                const account = accounts[0];
                if (account && account.accountId === accountTarget.accountId) {
                    if (typeof account.passwordHash !== 'string') throw new ProviderAccountUnavailableError();
                    if (!await bcrypt.compare(password, account.passwordHash)) result = 'invalid-password';
                    else if (await readLiveSession(connection, accountTarget.userId, accountTarget.accountId, sessionId)) {
                        result = await insertLink(connection, accountTarget, identity, subject);
                    }
                }
                phase = 'commit';
                await connection.commit();
                return result;
            } catch (error) {
                if (phase !== 'active') invalidateConnection();
                try { await connection.rollback(); }
                catch { invalidateConnection(); }
                throw error;
            }
        });
    } catch {
        // A failed commit/lock release might follow a durable INSERT: retry, never claim success early.
        throw new ProviderAccountUnavailableError();
    }
}
