import bcrypt from 'bcryptjs';
import { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { withUserSubmissionLock } from '../leaderboards/userSubmissionLock';
import { assertAccountId, type AccountDeletionJournal } from './deletionJournal';
import { readLiveSession } from '../auth/accountSessionRepository';
import type { SessionProof } from '../security/sessionPolicy';

type AccountPasswordRow = RowDataPacket & { passwordHash: string; accountId: string };

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
    password: string,
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
    if (!await bcrypt.compare(password, accounts[0].passwordHash)) {
        return 'invalid-password';
    }
    assertAccountId(accounts[0].accountId);
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

                    const result = await deleteAuthenticatedAccount(connection, userId, password, async accountId => {
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
