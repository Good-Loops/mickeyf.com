/**
 * Transitional p4-Vega persistence while the legacy score column is retired.
 *
 * An improving score is written to both stores in one transaction. Reads stay
 * on the legacy column until the explicit backfill and reconciliation gates
 * have completed, so a worse submission must not opportunistically create a
 * misleading historical personal-best row.
 */
import {
    Pool,
    ResultSetHeader,
} from 'mysql2/promise';
import { isValidP4VegaScore } from '../security/p4VegaScorePolicy';
import { getGameDefinition } from './gameCatalog';

type P4VegaScoreDatabase = Pick<Pool, 'getConnection'>;

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
