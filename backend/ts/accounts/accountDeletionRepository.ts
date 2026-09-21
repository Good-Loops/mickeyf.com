import bcrypt from 'bcryptjs';
import { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { withUserSubmissionLock } from '../leaderboards/userSubmissionLock';
import { assertAccountId, type AccountDeletionJournal } from './deletionJournal';
import { readLiveSession } from '../auth/accountSessionRepository';
import type { VerifiedProviderIdentity } from '../auth/providerIdentity';
import { isSessionId, type SessionProof } from '../security/sessionPolicy';

type AccountPasswordRow = RowDataPacket & { passwordHash: string | null; accountId: string };
type AccountReauthentication = (connection: PoolConnection, account: AccountPasswordRow)
    => Promise<'authenticated' | 'not-found' | 'invalid-password'>;

export type AccountDeletionResult = 'deleted' | 'not-found' | 'invalid-password';

const DATABASE_QUERY_TIMEOUT_MS = 10_000;

export class AccountDeletionPendingError extends Error {
    constructor(readonly cause: unknown) {
        super('The deletion request was recorded but database completion is unconfirmed.');
        this.name = 'AccountDeletionPendingError';
    }
}

export class AccountDeletionRollbackError extends Error {
    constructor(
        readonly transactionError: unknown,
        readonly rollbackError: unknown
    ) {
        super('The account deletion transaction and its rollback both failed.');
        this.name = 'AccountDeletionRollbackError';
    }
}

async function deleteAuthenticatedAccount(
    connection: PoolConnection,
    userId: number,
    reauthenticate: AccountReauthentication,
    recordDeletion: (accountId: string) => Promise<void>
): Promise<AccountDeletionResult> {
    const [accounts] = await connection.query<AccountPasswordRow[]>(
        {
            sql: `SELECT user_password AS passwordHash, account_uuid AS accountId
                FROM users WHERE user_id = ? LIMIT 1 FOR UPDATE`,
            timeout: DATABASE_QUERY_TIMEOUT_MS,
        },
        [userId]
    );
    if (!accounts[0]) return 'not-found';
    assertAccountId(accounts[0].accountId);
    const authentication = await reauthenticate(connection, accounts[0]);
    if (authentication !== 'authenticated') return authentication;
    // This intent must survive SQL rollback. Never delete if persistence of
    // the independently stored intent has not been acknowledged.
    await recordDeletion(accounts[0].accountId);
    await deleteOwnedAccountRows(connection, userId);
    return 'deleted';
}

/** Caller must hold the account row lock inside a transaction. */
export async function deleteOwnedAccountRows(connection: PoolConnection, userId: number): Promise<void> {
    // Both child tables restrict parent deletion. Explicit, scoped deletes
    // remove every game's data without weakening those foreign keys.
    for (const sql of [
        'DELETE FROM game_personal_bests WHERE user_id = ?',
        'DELETE FROM game_submission_receipts WHERE user_id = ?',
    ]) {
        await connection.query<ResultSetHeader>(
            { sql, timeout: DATABASE_QUERY_TIMEOUT_MS },
            [userId]
        );
    }
    const [deleted] = await connection.query<ResultSetHeader>(
        {
            sql: 'DELETE FROM users WHERE user_id = ?',
            timeout: DATABASE_QUERY_TIMEOUT_MS,
        },
        [userId]
    );
    if (deleted.affectedRows !== 1) {
        throw new Error('Account deletion did not remove exactly one account.');
    }
}

/**
 * Serializes deletion with score submissions, retries, and receipt cleanup.
 * HTTP callers must supply the authenticated session; trusted internal/recovery
 * callers may omit it when they already own account-incarnation verification.
 */
export async function deleteAccount(
    database: Pick<Pool, 'getConnection'>,
    userId: number,
    password: string,
    journal: AccountDeletionJournal,
    expectedSession?: SessionProof,
): Promise<AccountDeletionResult> {
    if (typeof password !== 'string') {
        throw new TypeError('Account deletion requires a password string.');
    }
    return deleteReauthenticatedAccount(database, userId, journal, expectedSession, async (_connection, account) =>
        typeof account.passwordHash === 'string' && await bcrypt.compare(password, account.passwordHash)
            ? 'authenticated' : 'invalid-password');
}

/** Fresh provider verification is bound to the exact linked subject, incarnation and live device session. */
export async function deleteProviderAccount(
    database: Pick<Pool, 'getConnection'>,
    userId: number,
    identity: VerifiedProviderIdentity,
    journal: AccountDeletionJournal,
    expectedSession: SessionProof,
): Promise<AccountDeletionResult> {
    if (!expectedSession || !isSessionId(expectedSession.sessionId)) {
        throw new TypeError('Provider account deletion requires an authenticated session proof.');
    }
    assertAccountId(expectedSession.accountId);
    if (!identity || !['google', 'apple'].includes(identity.provider) || typeof identity.subject !== 'string'
        || !/^[\x21-\x7e]{1,255}$/.test(identity.subject)) return 'invalid-password';
    const subject = Buffer.from(identity.subject, 'ascii');
    const provider = identity.provider;
    const proof = { ...expectedSession };
    return deleteReauthenticatedAccount(database, userId, journal, proof, async (connection, account) => {
        if (account.accountId !== proof.accountId) return 'not-found';
        const [links] = await connection.query<RowDataPacket[]>({
            sql: `SELECT subject FROM account_provider_identities
                WHERE account_uuid = ? AND provider = ? LIMIT 2 FOR SHARE`,
            timeout: DATABASE_QUERY_TIMEOUT_MS,
        }, [proof.accountId, provider]);
        if (!Array.isArray(links) || links.length > 1) throw new Error('Provider account linkage could not be verified.');
        if (!links[0] || !Buffer.isBuffer(links[0].subject) || !links[0].subject.equals(subject)) return 'invalid-password';
        // Verification or the row-lock wait may outlive expiry. Check again immediately before journaling.
        return await readLiveSession(connection, userId, proof.accountId, proof.sessionId) ? 'authenticated' : 'not-found';
    });
}

async function deleteReauthenticatedAccount(
    database: Pick<Pool, 'getConnection'>,
    userId: number,
    journal: AccountDeletionJournal,
    expectedSession: SessionProof | undefined,
    reauthenticate: AccountReauthentication,
): Promise<AccountDeletionResult> {
    if (!journal || typeof journal.recordAccountDeletion !== 'function') {
        throw new TypeError('Account deletion requires an independent journal.');
    }
    let recorded = false;
    try {
        return await withUserSubmissionLock(
            database,
            userId,
            async ({ connection, invalidateConnection }) => {
                let phase: 'begin' | 'active' | 'commit' = 'begin';
                try {
                    await connection.beginTransaction();
                    phase = 'active';

                    if (expectedSession !== undefined && !await readLiveSession(
                        connection, userId, expectedSession.accountId, expectedSession.sessionId
                    )) {
                        phase = 'commit';
                        await connection.commit();
                        return 'not-found';
                    }

                    const result = await deleteAuthenticatedAccount(connection, userId, reauthenticate, async accountId => {
                        await journal.recordAccountDeletion(accountId);
                        recorded = true;
                    });
                    phase = 'commit';
                    await connection.commit();
                    return result;
                } catch (error) {
                    // A failed begin/commit may have reached MySQL without its
                    // acknowledgement reaching us. Never reuse that session or
                    // report deletion as successful on an uncertain commit.
                    if (phase !== 'active') invalidateConnection();
                    try {
                        await connection.rollback();
                    } catch (rollbackError) {
                        invalidateConnection();
                        throw new AccountDeletionRollbackError(error, rollbackError);
                    }
                    throw error;
                }
            }
        );
    } catch (error) {
        if (recorded) throw new AccountDeletionPendingError(error);
        throw error;
    }
}
