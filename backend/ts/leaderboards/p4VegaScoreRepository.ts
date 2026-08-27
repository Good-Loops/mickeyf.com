/**
 * p4-Vega persistence in the generic personal-best store.
 *
 * The legacy HTTP controller adapts these operations to its historical
 * request and response contract.
 */
import {
    Pool,
    ResultSetHeader,
    RowDataPacket,
} from 'mysql2/promise';
import { isValidP4VegaScore } from '../security/p4VegaScorePolicy';
import { getGameDefinition } from './gameCatalog';
import { LEADERBOARD_PAGE_SIZE } from './leaderboardContract';
import { withUserSubmissionLock } from './userSubmissionLock';

type P4VegaScoreDatabase = Pick<Pool, 'getConnection'>;
type P4VegaLeaderboardDatabase = Pick<Pool, 'query'>;

type P4VegaBestRow = RowDataPacket & {
    userId: number;
    score: number | null;
};

export type P4VegaLeaderboardRow = Readonly<{
    userName: string;
    score: number;
}>;

const P4_VEGA = getGameDefinition('p4-vega');
const DATABASE_QUERY_TIMEOUT_MS = 10_000;

export class P4VegaScoreRollbackError extends Error {
    constructor(
        readonly transactionError: unknown,
        readonly rollbackError: unknown
    ) {
        super('The p4-Vega score transaction and its rollback both failed.');
        this.name = 'P4VegaScoreRollbackError';
    }
}

/**
 * Reads the current p4-Vega leaderboard from the versioned personal-best
 * store. The legacy controller owns adaptation to its historical snake-case
 * response shape.
 */
export async function readP4VegaLeaderboard(
    database: P4VegaLeaderboardDatabase
): Promise<P4VegaLeaderboardRow[]> {
    const [rows] = await database.query<Array<RowDataPacket & P4VegaLeaderboardRow>>(
        {
            sql: `SELECT
                    users.user_name AS userName,
                    game_personal_bests.score AS score
                FROM game_personal_bests
                INNER JOIN users
                    ON users.user_id = game_personal_bests.user_id
                WHERE game_personal_bests.game_id = ?
                  AND game_personal_bests.rules_version = ?
                ORDER BY
                    game_personal_bests.score DESC,
                    game_personal_bests.recorded_at ASC,
                    game_personal_bests.user_id ASC
                LIMIT ${LEADERBOARD_PAGE_SIZE}`,
            timeout: DATABASE_QUERY_TIMEOUT_MS,
        },
        [P4_VEGA.gameId, P4_VEGA.rulesVersion]
    );

    return rows.map(({ userName, score }) => ({ userName, score }));
}

/**
 * Stores a strict p4-Vega personal-best improvement in generic storage.
 *
 * An application-scoped user lock serializes submissions before the current
 * generic best is compared. This preserves the established missing-user result
 * without requiring write privilege on the `users` table.
 */
export async function submitP4VegaScore(
    database: P4VegaScoreDatabase,
    userId: number,
    score: number
): Promise<boolean> {
    if (!Number.isSafeInteger(userId) || userId <= 0) {
        throw new TypeError('p4-Vega score writes require a valid user ID.');
    }
    if (!isValidP4VegaScore(score)) {
        throw new TypeError('p4-Vega score writes require a valid score.');
    }

    return withUserSubmissionLock(
        database,
        userId,
        async ({ connection, invalidateConnection }) => {
            let transactionStarted = false;
            try {
                await connection.beginTransaction();
                transactionStarted = true;

                const [bestRows] = await connection.query<P4VegaBestRow[]>(
                    {
                        sql: `SELECT
                                users.user_id AS userId,
                                game_personal_bests.score AS score
                            FROM users
                            LEFT JOIN game_personal_bests
                                ON game_personal_bests.game_id = ?
                               AND game_personal_bests.rules_version = ?
                               AND game_personal_bests.user_id = users.user_id
                            WHERE users.user_id = ?`,
                        timeout: DATABASE_QUERY_TIMEOUT_MS,
                    },
                    [P4_VEGA.gameId, P4_VEGA.rulesVersion, userId]
                );
                const currentBest = bestRows[0];
                const personalBest = currentBest !== undefined && (
                    currentBest.score === null || score > currentBest.score
                );

                if (personalBest) {
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
                                ) VALUES (?, ?, ?, ?, NULL, UTC_TIMESTAMP(6), NULL) AS incoming
                                ON DUPLICATE KEY UPDATE
                                    recorded_at = IF(
                                        incoming.score > game_personal_bests.score,
                                        incoming.recorded_at,
                                        game_personal_bests.recorded_at
                                    ),
                                    score = GREATEST(
                                        game_personal_bests.score,
                                        incoming.score
                                    )`,
                            timeout: DATABASE_QUERY_TIMEOUT_MS,
                        },
                        [
                            P4_VEGA.gameId,
                            P4_VEGA.rulesVersion,
                            userId,
                            score,
                        ]
                    );
                }

                await connection.commit();
                transactionStarted = false;
                return personalBest;
            } catch (error) {
                if (transactionStarted) {
                    try {
                        await connection.rollback();
                    } catch (rollbackError) {
                        invalidateConnection();
                        throw new P4VegaScoreRollbackError(error, rollbackError);
                    }
                }
                throw error;
            }
        }
    );
}
