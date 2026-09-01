/**
 * Cross-game serialization for one authenticated user's score submissions.
 *
 * MySQL named locks keep this coordination outside domain tables and avoid
 * granting the runtime account any write privilege on `users`. The lock is
 * acquired before a transaction starts and released only after that operation
 * commits or rolls back.
 */
import {
    Pool,
    PoolConnection,
    RowDataPacket,
} from 'mysql2/promise';

type UserSubmissionLockDatabase = Pick<Pool, 'getConnection'>;

type LockResultRow = RowDataPacket & {
    lockResult: number | null;
};

export type UserSubmissionLockContext = Readonly<{
    connection: PoolConnection;
    invalidateConnection(): void;
}>;

const DATABASE_QUERY_TIMEOUT_MS = 10_000;
const LOCK_WAIT_TIMEOUT_SECONDS = 5;
const LOCK_NAME_EXPRESSION =
    "CONCAT('mickeyf:leaderboard-user:', LEFT(SHA2(DATABASE(), 256), 16), ':', ?)";

export class UserSubmissionLockError extends Error {
    constructor(
        message: string,
        readonly lockError?: unknown
    ) {
        super(message);
        this.name = 'UserSubmissionLockError';
    }
}

function lockResult(rows: LockResultRow[]): number | null {
    const value = rows[0]?.lockResult;
    return value === null || value === undefined ? null : Number(value);
}

/**
 * Runs one operation while holding the application-wide lock for `userId`.
 * The callback may invalidate the connection after an uncertain transaction
 * failure; destroying that session also releases its named lock.
 */
export async function withUserSubmissionLock<T>(
    database: UserSubmissionLockDatabase,
    userId: number,
    operation: (context: UserSubmissionLockContext) => Promise<T>
): Promise<T> {
    if (!Number.isSafeInteger(userId) || userId <= 0) {
        throw new TypeError('User submission locks require a valid user ID.');
    }

    const connection = await database.getConnection();
    let connectionReusable = true;

    try {
        let acquiredRows: LockResultRow[];
        try {
            [acquiredRows] = await connection.query<LockResultRow[]>(
                {
                    sql: `SELECT GET_LOCK(
                            ${LOCK_NAME_EXPRESSION},
                            ?
                        ) AS lockResult`,
                    timeout: DATABASE_QUERY_TIMEOUT_MS,
                },
                [userId, LOCK_WAIT_TIMEOUT_SECONDS]
            );
        } catch (error) {
            connectionReusable = false;
            connection.destroy();
            throw new UserSubmissionLockError(
                'The user submission lock acquisition was indeterminate.',
                error
            );
        }

        const acquired = lockResult(acquiredRows);
        if (acquired === 0) {
            throw new UserSubmissionLockError(
                'Timed out waiting for the user submission lock.'
            );
        }
        if (acquired !== 1) {
            connectionReusable = false;
            connection.destroy();
            throw new UserSubmissionLockError(
                'The user submission lock acquisition returned an invalid state.'
            );
        }

        let operationFailed = false;
        try {
            return await operation({
                connection,
                invalidateConnection() {
                    connectionReusable = false;
                },
            });
        } catch (error) {
            operationFailed = true;
            throw error;
        } finally {
            if (!connectionReusable) {
                connection.destroy();
            } else {
                try {
                    const [releasedRows] = await connection.query<LockResultRow[]>(
                        {
                            sql: `SELECT RELEASE_LOCK(
                                    ${LOCK_NAME_EXPRESSION}
                                ) AS lockResult`,
                            timeout: DATABASE_QUERY_TIMEOUT_MS,
                        },
                        [userId]
                    );
                    if (lockResult(releasedRows) !== 1) {
                        throw new UserSubmissionLockError(
                            'The user submission lock was not released cleanly.'
                        );
                    }
                } catch (error) {
                    connectionReusable = false;
                    connection.destroy();
                    if (!operationFailed) {
                        throw error instanceof UserSubmissionLockError
                            ? error
                            : new UserSubmissionLockError(
                                'The user submission lock release was indeterminate.',
                                error
                            );
                    }
                }
            }
        }
    } finally {
        if (connectionReusable) connection.release();
    }
}
