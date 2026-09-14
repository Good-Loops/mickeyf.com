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
export type ProviderAccountCreationResult =
    | Readonly<{ created: true; account: ProviderAccount }>
    | Readonly<{ created: false; reason: 'DUPLICATE_USER' | 'ALREADY_LINKED' | 'INVALID_USERNAME' | 'INVALID_EMAIL' }>;
export type ProviderAccountMethods = Readonly<{ hasPassword: boolean; googleLinked: boolean }>;

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

/** Called after HTTP session authentication; never returns password hashes, emails or provider subjects. */
export async function readProviderAccountMethods(
    database: Pick<Pool, 'query'>, accountId: string,
    { allowMissingProviderTable = false }: { allowMissingProviderTable?: boolean } = {},
): Promise<ProviderAccountMethods | null> {
    assertAccountId(accountId);
    try {
        const [rows] = await database.query<RowDataPacket[]>({
            sql: `SELECT u.user_password IS NOT NULL AS hasPassword
                FROM users AS u WHERE u.account_uuid = ? LIMIT 2`, timeout: QUERY_TIMEOUT_MS,
        }, [accountId]);
        if (!Array.isArray(rows) || rows.length > 1) throw new ProviderAccountUnavailableError();
        const row = rows[0];
        if (!row) return null;
        if (![0, 1].includes(row.hasPassword)) throw new ProviderAccountUnavailableError();
        const hasPassword = row.hasPassword === 1;
        try {
            const [providers] = await database.query<RowDataPacket[]>({
                sql: `SELECT EXISTS(SELECT 1 FROM account_provider_identities
                    WHERE account_uuid = ? AND provider = 'google') AS googleLinked`, timeout: QUERY_TIMEOUT_MS,
            }, [accountId]);
            if (!Array.isArray(providers) || providers.length !== 1 || ![0, 1].includes(providers[0].googleLinked)) {
                throw new ProviderAccountUnavailableError();
            }
            return Object.freeze({ hasPassword, googleLinked: providers[0].googleLinked === 1 });
        } catch (error) {
            // This fixed query references only the provider table. Its exact
            // absence is safe only for a verified password account with provider
            // mutations disabled; permission/outage/schema errors are not absence.
            if (allowMissingProviderTable && hasPassword && error !== null && typeof error === 'object'
                && 'errno' in error && error.errno === 1146 && 'code' in error && error.code === 'ER_NO_SUCH_TABLE') {
                return Object.freeze({ hasPassword: true, googleLinked: false });
            }
            throw error;
        }
    } catch { throw new ProviderAccountUnavailableError(); }
}

/** A new passwordless account and its verified identity become visible only together, after commit. */
export async function createProviderAccount(
    database: Pick<Pool, 'getConnection'>, identity: VerifiedProviderIdentity, userName: string,
): Promise<ProviderAccountCreationResult> {
    const subject = identitySubject(identity);
    if (identity.provider !== 'google') throw new TypeError('Passwordless signup requires a verified Google identity.');
    // Match password-signup normalization and bounds without creating a placeholder password.
    if (typeof userName !== 'string' || userName.trim().length === 0 || userName.trim().length > 64
        || /[\u0000-\u001f\u007f]/u.test(userName.trim())) return { created: false, reason: 'INVALID_USERNAME' };
    if (typeof identity.email !== 'string' || identity.email.trim().length > 254
        || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(identity.email.trim())
        || /[\u0000-\u001f\u007f]/u.test(identity.email.trim())) return { created: false, reason: 'INVALID_EMAIL' };
    const name = userName.trim();
    const email = identity.email.trim().toLowerCase();
    const verifiedIdentity = { ...identity };
    try {
        const connection = await database.getConnection();
        let reusable = true;
        let phase: 'begin' | 'active' | 'commit' = 'begin';
        try {
            await connection.beginTransaction();
            phase = 'active';
            let result: ProviderAccountCreationResult;
            if (await findProviderAccount(connection, verifiedIdentity)) result = { created: false, reason: 'ALREADY_LINKED' };
            else {
                let insertingIdentity = false;
                try {
                    const [inserted] = await connection.query<ResultSetHeader>({
                        sql: 'INSERT INTO users (user_name, email, user_password) VALUES (?, ?, NULL)',
                        timeout: QUERY_TIMEOUT_MS,
                    }, [name, email]);
                    if (inserted.affectedRows !== 1 || !Number.isSafeInteger(inserted.insertId)
                        || inserted.insertId <= 0) throw new ProviderAccountUnavailableError();
                    const [accounts] = await connection.query<RowDataPacket[]>({
                        sql: `SELECT user_id AS userId, user_name AS userName, account_uuid AS accountId
                            FROM users WHERE user_id = ? LIMIT 2`, timeout: QUERY_TIMEOUT_MS,
                    }, [inserted.insertId]);
                    if (!Array.isArray(accounts) || accounts.length !== 1 || accounts[0].userId !== inserted.insertId
                        || accounts[0].userName !== name) throw new ProviderAccountUnavailableError();
                    assertAccountId(accounts[0].accountId);
                    const account = Object.freeze({ userId: inserted.insertId, userName: name, accountId: accounts[0].accountId as string });
                    insertingIdentity = true;
                    const [linked] = await connection.query<ResultSetHeader>({
                        sql: `INSERT INTO account_provider_identities (provider, subject, account_uuid, linked_at)
                            VALUES (?, ?, ?, UTC_TIMESTAMP(6))`, timeout: QUERY_TIMEOUT_MS,
                    }, ['google', subject, account.accountId]);
                    if (linked.affectedRows !== 1) throw new ProviderAccountUnavailableError();
                    result = { created: true, account };
                } catch (error) {
                    if (!error || typeof error !== 'object' || !('errno' in error) || error.errno !== 1062) throw error;
                    result = { created: false, reason: insertingIdentity ? 'ALREADY_LINKED' : 'DUPLICATE_USER' };
                }
            }
            // A losing identity insert must roll back its newly inserted user, never leave an orphan.
            if (!result.created) {
                try { await connection.rollback(); } catch (error) { reusable = false; throw error; }
                return result;
            }
            phase = 'commit';
            await connection.commit();
            return result;
        } catch (error) {
            if (phase !== 'active') reusable = false;
            try { await connection.rollback(); } catch { reusable = false; }
            throw error;
        } finally {
            if (reusable) connection.release();
            else connection.destroy();
        }
    } catch {
        // A lost commit response may follow a durable account. Never imply success or retry it as a login.
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
                    if (account.passwordHash === null) result = 'invalid-password';
                    else if (typeof account.passwordHash !== 'string') throw new ProviderAccountUnavailableError();
                    else if (!await bcrypt.compare(password, account.passwordHash)) result = 'invalid-password';
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
