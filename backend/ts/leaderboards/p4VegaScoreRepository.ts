/**
 * p4-Vega persistence while the legacy score column is retired.
 *
 * An improving score is written to both stores in one transaction. Reads use
 * generic storage in code, but deployment remains gated on the explicit
 * backfill and reconciliation sequence. A worse submission must not
 * opportunistically create a misleading historical personal-best row.
 */
import {
    Pool,
    ResultSetHeader,
    RowDataPacket,
} from 'mysql2/promise';
import { isValidP4VegaScore } from '../security/p4VegaScorePolicy';
import { getGameDefinition } from './gameCatalog';
import { LEADERBOARD_PAGE_SIZE } from './leaderboardContract';

type P4VegaScoreDatabase = Pick<Pool, 'getConnection'>;
type P4VegaLeaderboardDatabase = Pick<Pool, 'query'>;

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
 * Stores a strict p4-Vega personal-best improvement in both transitional
 * stores. Returns the established legacy `personalBest` result.
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

    const connection = await database.getConnection();
    let transactionStarted = false;
    let connectionReusable = true;
    try {
        await connection.beginTransaction();
        transactionStarted = true;

        const [legacyResult] = await connection.query<ResultSetHeader>(
            {
                sql: `UPDATE users
                    SET p4_score = ?
                    WHERE user_id = ?
                    AND (p4_score IS NULL OR p4_score < ?)`,
                timeout: DATABASE_QUERY_TIMEOUT_MS,
            },
            [score, userId, score]
        );
        const personalBest = legacyResult.affectedRows === 1;

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
                connectionReusable = false;
                connection.destroy();
                throw new P4VegaScoreRollbackError(error, rollbackError);
            }
        }
        throw error;
    } finally {
        if (connectionReusable) {
            connection.release();
        }
    }
}
