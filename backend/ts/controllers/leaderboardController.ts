/**
 * Read-only version-one multi-game leaderboard handlers.
 *
 * Public DTOs are projected explicitly so internal catalog and persistence
 * fields cannot leak through incidental object serialization.
 */
import { Request, Response } from 'express';
import { Pool } from 'mysql2/promise';
import {
    GameLeaderboardResponse,
    LEADERBOARD_CONTRACT_VERSION,
    LeaderboardApiError,
    LeaderboardCatalogGame,
    LeaderboardCatalogResponse,
} from '../leaderboards/leaderboardContract';
import {
    GAME_IDS,
    getGameDefinition,
    isGameId,
    P4_VEGA_RULES_VERSION,
    THREE_BOSSES_RULES_VERSION,
} from '../leaderboards/gameCatalog';
import { readP4VegaLeaderboard } from '../leaderboards/p4VegaScoreRepository';

type LeaderboardDatabase = Pick<Pool, 'query'>;
type GameLeaderboardResponseBody = GameLeaderboardResponse
    | LeaderboardApiError<'UNKNOWN_GAME' | 'SERVER_ERROR'>;

function publicCatalogGame(gameId: (typeof GAME_IDS)[number]): LeaderboardCatalogGame {
    const game = getGameDefinition(gameId);
    return {
        gameId: game.gameId,
        displayName: game.displayName,
        rulesVersion: game.rulesVersion,
        primaryMetric: game.primaryMetric,
        sortDirection: game.sortDirection,
        labels: {
            score: game.scoreLabel,
            completionTime: game.completionTimeLabel,
            rank: game.rankLabel,
        },
        rankState: game.rankState,
        submissionState: game.submissionState,
    };
}

export function leaderboardCatalogResponse(): LeaderboardCatalogResponse {
    return {
        success: true,
        contractVersion: LEADERBOARD_CONTRACT_VERSION,
        games: GAME_IDS.map(publicCatalogGame),
    };
}

export function createLeaderboardController(database: LeaderboardDatabase) {
    function getCatalog(_req: Request, res: Response<LeaderboardCatalogResponse>) {
        return res.json(leaderboardCatalogResponse());
    }

    async function getGameLeaderboard(
        req: Request,
        res: Response<GameLeaderboardResponseBody>
    ) {
        const { gameId } = req.params;
        if (!isGameId(gameId)) {
            return res.status(404).json({
                success: false,
                contractVersion: LEADERBOARD_CONTRACT_VERSION,
                error: 'UNKNOWN_GAME',
            });
        }

        if (gameId === 'three-bosses') {
            // Reads are available for navigation, but no Three Bosses run has
            // been accepted while its submission policy remains disabled.
            return res.json({
                success: true,
                contractVersion: LEADERBOARD_CONTRACT_VERSION,
                gameId,
                rulesVersion: THREE_BOSSES_RULES_VERSION,
                entries: [],
            });
        }

        const rows = await readP4VegaLeaderboard(database);
        return res.json({
            success: true,
            contractVersion: LEADERBOARD_CONTRACT_VERSION,
            gameId,
            rulesVersion: P4_VEGA_RULES_VERSION,
            entries: rows.map(({ userName, score }, index) => ({
                position: index + 1,
                userName,
                score,
            })),
        });
    }

    return { getCatalog, getGameLeaderboard };
}
