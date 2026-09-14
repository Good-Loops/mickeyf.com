/**
 * Version-one multi-game leaderboard handlers.
 *
 * Public DTOs are projected explicitly so internal catalog and persistence
 * fields cannot leak through incidental object serialization.
 */
import { Request, Response } from 'express';
import { Pool } from 'mysql2/promise';
import {
    GameLeaderboardResponse,
    LEADERBOARD_CONTRACT_VERSION,
    calculateThreeBossesRank,
    calculateThreeBossesScore,
    LeaderboardApiError,
    LeaderboardCatalogGame,
    LeaderboardCatalogResponse,
    ThreeBossesRunSubmissionResponse,
    ThreeBossesRunTicketResponse,
} from '../leaderboards/leaderboardContract';
import {
    GAME_IDS,
    getGameDefinition,
    isGameId,
    P4_VEGA_RULES_VERSION,
    THREE_BOSSES_RULES_VERSION,
} from '../leaderboards/gameCatalog';
import { readP4VegaLeaderboard } from '../leaderboards/p4VegaScoreRepository';
import {
    readThreeBossesLeaderboard,
    submitThreeBossesRun,
} from '../leaderboards/threeBossesRunRepository';
import {
    validateThreeBossesRunSubmission,
    validateThreeBossesRunTicketRequest,
} from '../leaderboards/threeBossesRunRequest';
import {
    issueThreeBossesRunTicket,
    verifyThreeBossesRunTicket,
} from '../leaderboards/threeBossesRunTicket';
import { authorizeThreeBossesMutation } from '../security/threeBossesMutationAuthorization';
import { readActiveAccount } from '../security/activeAccount';

type LeaderboardControllerDependencies = {
    database: Pick<Pool, 'getConnection' | 'query'>;
    sessionSecret: string;
    allowedMutationOrigins: readonly string[];
    threeBossesRunSubmissionsEnabled: boolean;
};
type GameLeaderboardResponseBody = GameLeaderboardResponse
    | LeaderboardApiError<'UNKNOWN_GAME' | 'SERVER_ERROR'>;
type ThreeBossesRunSubmissionResponseBody = ThreeBossesRunSubmissionResponse
    | LeaderboardApiError<
          | 'SUBMISSION_DISABLED'
          | 'UNSUPPORTED_CONTRACT_VERSION'
          | 'UNSUPPORTED_RULES_VERSION'
          | 'INVALID_RUN'
          | 'UNAUTHORIZED'
          | 'IDEMPOTENCY_CONFLICT'
          | 'RATE_LIMITED'
          | 'SERVER_ERROR'
      >;
type ThreeBossesRunTicketResponseBody = ThreeBossesRunTicketResponse
    | LeaderboardApiError<
          | 'SUBMISSION_DISABLED'
          | 'UNSUPPORTED_CONTRACT_VERSION'
          | 'UNSUPPORTED_RULES_VERSION'
          | 'INVALID_RUN'
          | 'UNAUTHORIZED'
          | 'RATE_LIMITED'
          | 'SERVER_ERROR'
      >;

function publicCatalogGame(
    gameId: (typeof GAME_IDS)[number],
    threeBossesRunSubmissionsEnabled: boolean
): LeaderboardCatalogGame {
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
        submissionState: gameId === 'three-bosses'
            ? threeBossesRunSubmissionsEnabled ? 'enabled' : 'disabled'
            : game.submissionState,
    };
}

export function leaderboardCatalogResponse(
    threeBossesRunSubmissionsEnabled = false
): LeaderboardCatalogResponse {
    return {
        success: true,
        contractVersion: LEADERBOARD_CONTRACT_VERSION,
        games: GAME_IDS.map((gameId) => publicCatalogGame(
            gameId,
            threeBossesRunSubmissionsEnabled
        )),
    };
}

export function createLeaderboardController({
    database,
    sessionSecret,
    allowedMutationOrigins,
    threeBossesRunSubmissionsEnabled,
}: LeaderboardControllerDependencies) {
    const mutationPolicy = {
        submissionsEnabled: threeBossesRunSubmissionsEnabled,
        sessionSecret,
        allowedMutationOrigins,
    };

    function getCatalog(_req: Request, res: Response<LeaderboardCatalogResponse>) {
        return res.json(leaderboardCatalogResponse(
            threeBossesRunSubmissionsEnabled
        ));
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
            const rows = await readThreeBossesLeaderboard(database);
            return res.json({
                success: true,
                contractVersion: LEADERBOARD_CONTRACT_VERSION,
                gameId,
                rulesVersion: THREE_BOSSES_RULES_VERSION,
                entries: rows.map(({
                    userName,
                    completionTimeMs,
                }, index) => ({
                    position: index + 1,
                    userName,
                    score: calculateThreeBossesScore(completionTimeMs),
                    completionTimeMs,
                    rank: calculateThreeBossesRank(completionTimeMs),
                })),
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

    async function submitThreeBossesRunHandler(
        req: Request,
        res: Response<ThreeBossesRunSubmissionResponseBody>
    ) {
        const authorization = authorizeThreeBossesMutation(req, mutationPolicy);
        if (!authorization.authorized) {
            return res.status(authorization.status).json({
                success: false,
                contractVersion: LEADERBOARD_CONTRACT_VERSION,
                error: authorization.error,
            });
        }

        const validation = validateThreeBossesRunSubmission(req.body);
        if (!validation.valid) {
            return res.status(400).json({
                success: false,
                contractVersion: LEADERBOARD_CONTRACT_VERSION,
                error: validation.error,
            });
        }

        if (!verifyThreeBossesRunTicket(
            sessionSecret,
            authorization.identity,
            validation.input
        )) {
            return res.status(400).json({
                success: false,
                contractVersion: LEADERBOARD_CONTRACT_VERSION,
                error: 'INVALID_RUN',
            });
        }

        const result = await submitThreeBossesRun(
            database,
            authorization.identity.userId,
            validation.input.runId,
            validation.input.completionTimeMs,
            authorization.identity
        );
        if (result.kind === 'user-not-found') {
            return res.status(401).json({
                success: false,
                contractVersion: LEADERBOARD_CONTRACT_VERSION,
                error: 'UNAUTHORIZED',
            });
        }
        if (result.kind === 'idempotency-conflict') {
            return res.status(409).json({
                success: false,
                contractVersion: LEADERBOARD_CONTRACT_VERSION,
                error: 'IDEMPOTENCY_CONFLICT',
            });
        }
        if (result.kind === 'rate-limited') {
            return res.status(429).json({
                success: false,
                contractVersion: LEADERBOARD_CONTRACT_VERSION,
                error: 'RATE_LIMITED',
            });
        }

        return res.status(result.replayed ? 200 : 201).json({
            success: true,
            contractVersion: LEADERBOARD_CONTRACT_VERSION,
            gameId: 'three-bosses',
            rulesVersion: THREE_BOSSES_RULES_VERSION,
            runId: result.runId,
            replayed: result.replayed,
            personalBest: result.personalBest,
            result: {
                score: calculateThreeBossesScore(result.completionTimeMs),
                completionTimeMs: result.completionTimeMs,
                rank: calculateThreeBossesRank(result.completionTimeMs),
            },
        });
    }

    async function issueThreeBossesRunTicketHandler(
        req: Request,
        res: Response<ThreeBossesRunTicketResponseBody>
    ) {
        const authorization = authorizeThreeBossesMutation(req, mutationPolicy);
        if (!authorization.authorized) {
            return res.status(authorization.status).json({
                success: false,
                contractVersion: LEADERBOARD_CONTRACT_VERSION,
                error: authorization.error,
            });
        }

        const validation = validateThreeBossesRunTicketRequest(req.body);
        if (!validation.valid) {
            return res.status(400).json({
                success: false,
                contractVersion: LEADERBOARD_CONTRACT_VERSION,
                error: validation.error,
            });
        }

        if (!await readActiveAccount(database, authorization.identity)) {
            return res.status(401).json({
                success: false,
                contractVersion: LEADERBOARD_CONTRACT_VERSION,
                error: 'UNAUTHORIZED',
            });
        }
        const ticket = issueThreeBossesRunTicket(
            sessionSecret,
            authorization.identity,
            validation.input
        );
        return res.status(201).json({
            success: true,
            contractVersion: LEADERBOARD_CONTRACT_VERSION,
            gameId: 'three-bosses',
            rulesVersion: THREE_BOSSES_RULES_VERSION,
            runId: validation.input.runId,
            runTicket: ticket.runTicket,
            expiresAt: ticket.expiresAt,
        });
    }

    return {
        getCatalog,
        getGameLeaderboard,
        issueThreeBossesRunTicket: issueThreeBossesRunTicketHandler,
        submitThreeBossesRun: submitThreeBossesRunHandler,
    };
}
