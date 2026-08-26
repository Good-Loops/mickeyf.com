import { createHash } from 'node:crypto';
import {
    Pool,
    ResultSetHeader,
    RowDataPacket,
} from 'mysql2/promise';
import { getGameDefinition } from './gameCatalog';
import {
    calculateThreeBossesScore,
    isCanonicalV4RunId,
    isValidThreeBossesCompletionTimeMs,
    LEADERBOARD_CONTRACT_VERSION,
    LEADERBOARD_PAGE_SIZE,
} from './leaderboardContract';

type ThreeBossesReadDatabase = Pick<Pool, 'query'>;
type ThreeBossesWriteDatabase = Pick<Pool, 'getConnection'>;

export type ThreeBossesLeaderboardRow = Readonly<{
    userName: string;
    score: number;
    completionTimeMs: number;
}>;

export type ThreeBossesRunResult = Readonly<{
    kind: 'accepted';
    replayed: boolean;
    personalBest: boolean;
    runId: string;
    score: number;
    completionTimeMs: number;
}> | Readonly<{
    kind: 'idempotency-conflict';
}> | Readonly<{
    kind: 'rate-limited';
}> | Readonly<{
    kind: 'user-not-found';
}>;

type ExistingRunRow = RowDataPacket & {
    rulesVersion: number;
    score: number;
    completionTimeMs: number;
    payloadFingerprint: Buffer;
    personalBest: number;
};

type PersonalBestRow = RowDataPacket & {
    completionTimeMs: number;
};

const THREE_BOSSES = getGameDefinition('three-bosses');
const DATABASE_QUERY_TIMEOUT_MS = 10_000;
export const THREE_BOSSES_USER_RUN_LIMIT = 10 as const;

export class ThreeBossesRunRollbackError extends Error {
    constructor(
        readonly transactionError: unknown,
        readonly rollbackError: unknown
    ) {
        super('The Three Bosses run transaction and its rollback both failed.');
        this.name = 'ThreeBossesRunRollbackError';
    }
}

export function createThreeBossesPayloadFingerprint(
    userId: number,
    runId: string,
    completionTimeMs: number
): Buffer {
    if (!Number.isSafeInteger(userId) || userId <= 0) {
        throw new TypeError('Three Bosses fingerprints require a valid user ID.');
    }
    if (!isCanonicalV4RunId(runId)) {
        throw new TypeError('Three Bosses fingerprints require a canonical v4 run ID.');
    }
    if (!isValidThreeBossesCompletionTimeMs(completionTimeMs)) {
        throw new TypeError('Three Bosses fingerprints require a valid completion time.');
    }

    return createHash('sha256')
        .update(
            `${LEADERBOARD_CONTRACT_VERSION}\n${THREE_BOSSES.gameId}\n`
            + `${userId}\n${runId}\n${THREE_BOSSES.rulesVersion}\n`
            + `${completionTimeMs}\n`,
            'utf8'
        )
        .digest();
}

export async function readThreeBossesLeaderboard(
    database: ThreeBossesReadDatabase
): Promise<ThreeBossesLeaderboardRow[]> {
    const [rows] = await database.query<Array<RowDataPacket & ThreeBossesLeaderboardRow>>(
        {
            sql: `SELECT
                    users.user_name AS userName,
                    game_personal_bests.score AS score,
                    game_personal_bests.completion_time_ms AS completionTimeMs
                FROM game_personal_bests
                INNER JOIN users
                    ON users.user_id = game_personal_bests.user_id
                WHERE game_personal_bests.game_id = ?
                  AND game_personal_bests.rules_version = ?
                  AND game_personal_bests.completion_time_ms IS NOT NULL
                ORDER BY
                    game_personal_bests.completion_time_ms ASC,
                    game_personal_bests.recorded_at ASC,
                    game_personal_bests.user_id ASC
                LIMIT ${LEADERBOARD_PAGE_SIZE}`,
            timeout: DATABASE_QUERY_TIMEOUT_MS,
        },
        [THREE_BOSSES.gameId, THREE_BOSSES.rulesVersion]
    );

    return rows.map(({ userName, score, completionTimeMs }) => ({
        userName,
        score,
        completionTimeMs,
    }));
}

function replayResult(
    row: ExistingRunRow,
    fingerprint: Buffer,
    runId: string,
    completionTimeMs: number,
    score: number
): ThreeBossesRunResult {
    const exactReplay = Buffer.isBuffer(row.payloadFingerprint)
        && row.payloadFingerprint.length === fingerprint.length
        && row.payloadFingerprint.equals(fingerprint)
        && row.rulesVersion === THREE_BOSSES.rulesVersion
        && row.completionTimeMs === completionTimeMs
        && row.score === score;

    if (!exactReplay) return { kind: 'idempotency-conflict' };
    if (row.personalBest !== 0 && row.personalBest !== 1) {
        throw new Error('Stored Three Bosses run has an invalid personal-best outcome.');
    }

    return {
        kind: 'accepted',
        replayed: true,
        personalBest: row.personalBest === 1,
        runId,
        score: row.score,
        completionTimeMs: row.completionTimeMs,
    };
}

/**
 * Accepts one immutable run through a user-serialized transaction. Replays are
 * resolved before the shared accepted-run count so they never consume a slot.
 */
export async function submitThreeBossesRun(
    database: ThreeBossesWriteDatabase,
    userId: number,
    runId: string,
    completionTimeMs: number
): Promise<ThreeBossesRunResult> {
    const fingerprint = createThreeBossesPayloadFingerprint(
        userId,
        runId,
        completionTimeMs
    );
    const score = calculateThreeBossesScore(completionTimeMs);
    const connection = await database.getConnection();
    let transactionStarted = false;
    let connectionReusable = true;

    try {
        await connection.beginTransaction();
        transactionStarted = true;

        // This locked user row is the per-user serialization boundary for
        // replay checks, rate admission, ledger inserts, and personal bests.
        const [users] = await connection.query<RowDataPacket[]>(
            {
                sql: `SELECT user_id
                    FROM users
                    WHERE user_id = ?
                    LIMIT 1
                    FOR UPDATE`,
                timeout: DATABASE_QUERY_TIMEOUT_MS,
            },
            [userId]
        );
        if (users.length === 0) {
            await connection.commit();
            transactionStarted = false;
            return { kind: 'user-not-found' };
        }

        const [existingRuns] = await connection.query<ExistingRunRow[]>(
            {
                sql: `SELECT
                        rules_version AS rulesVersion,
                        score,
                        completion_time_ms AS completionTimeMs,
                        payload_fingerprint AS payloadFingerprint,
                        personal_best AS personalBest
                    FROM game_runs
                    WHERE game_id = ?
                      AND user_id = ?
                      AND run_id = ?
                    LIMIT 1`,
                timeout: DATABASE_QUERY_TIMEOUT_MS,
            },
            [THREE_BOSSES.gameId, userId, runId]
        );
        if (existingRuns.length > 0) {
            const result = replayResult(
                existingRuns[0],
                fingerprint,
                runId,
                completionTimeMs,
                score
            );
            await connection.commit();
            transactionStarted = false;
            return result;
        }

        const [runCounts] = await connection.query<Array<RowDataPacket & {
            acceptedRunCount: number;
        }>>(
            {
                sql: `SELECT COUNT(*) AS acceptedRunCount
                    FROM game_runs
                    WHERE game_id = ?
                      AND user_id = ?
                      AND submitted_at > UTC_TIMESTAMP(6) - INTERVAL 15 MINUTE`,
                timeout: DATABASE_QUERY_TIMEOUT_MS,
            },
            [THREE_BOSSES.gameId, userId]
        );
        if (Number(runCounts[0]?.acceptedRunCount) >= THREE_BOSSES_USER_RUN_LIMIT) {
            await connection.commit();
            transactionStarted = false;
            return { kind: 'rate-limited' };
        }

        const [personalBests] = await connection.query<PersonalBestRow[]>(
            {
                sql: `SELECT completion_time_ms AS completionTimeMs
                    FROM game_personal_bests
                    WHERE game_id = ?
                      AND rules_version = ?
                      AND user_id = ?
                    FOR UPDATE`,
                timeout: DATABASE_QUERY_TIMEOUT_MS,
            },
            [THREE_BOSSES.gameId, THREE_BOSSES.rulesVersion, userId]
        );
        const currentBest = personalBests[0];
        if (
            currentBest
            && !isValidThreeBossesCompletionTimeMs(currentBest.completionTimeMs)
        ) {
            throw new Error('Stored Three Bosses personal best has an invalid completion time.');
        }
        const personalBest = !currentBest
            || completionTimeMs < currentBest.completionTimeMs;

        const [insertResult] = await connection.query<ResultSetHeader>(
            {
                sql: `INSERT INTO game_runs (
                        game_id,
                        rules_version,
                        user_id,
                        run_id,
                        score,
                        completion_time_ms,
                        payload_fingerprint,
                        personal_best,
                        submitted_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6))`,
                timeout: DATABASE_QUERY_TIMEOUT_MS,
            },
            [
                THREE_BOSSES.gameId,
                THREE_BOSSES.rulesVersion,
                userId,
                runId,
                score,
                completionTimeMs,
                fingerprint,
                personalBest ? 1 : 0,
            ]
        );

        if (personalBest) {
            if (currentBest) {
                await connection.query<ResultSetHeader>(
                    {
                        sql: `UPDATE game_personal_bests
                            SET score = ?,
                                completion_time_ms = ?,
                                recorded_at = UTC_TIMESTAMP(6),
                                source_game_run_id = ?
                            WHERE game_id = ?
                              AND rules_version = ?
                              AND user_id = ?`,
                        timeout: DATABASE_QUERY_TIMEOUT_MS,
                    },
                    [
                        score,
                        completionTimeMs,
                        insertResult.insertId,
                        THREE_BOSSES.gameId,
                        THREE_BOSSES.rulesVersion,
                        userId,
                    ]
                );
            } else {
                await connection.query<ResultSetHeader>(
                    {
                        sql: `INSERT INTO game_personal_bests (
                                game_id,
                                rules_version,
                                user_id,
                                score,
                                completion_time_ms,
                                recorded_at,
                                source_game_run_id
                            ) VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(6), ?)`,
                        timeout: DATABASE_QUERY_TIMEOUT_MS,
                    },
                    [
                        THREE_BOSSES.gameId,
                        THREE_BOSSES.rulesVersion,
                        userId,
                        score,
                        completionTimeMs,
                        insertResult.insertId,
                    ]
                );
            }
        }

        await connection.commit();
        transactionStarted = false;
        return {
            kind: 'accepted',
            replayed: false,
            personalBest,
            runId,
            score,
            completionTimeMs,
        };
    } catch (error) {
        if (transactionStarted) {
            try {
                await connection.rollback();
            } catch (rollbackError) {
                connectionReusable = false;
                connection.destroy();
                throw new ThreeBossesRunRollbackError(error, rollbackError);
            }
        }
        throw error;
    } finally {
        if (connectionReusable) connection.release();
    }
}
