/** Dedicated router for additive multi-game leaderboards. */
import { json, Router } from 'express';
import { Pool } from 'mysql2/promise';
import { createLeaderboardController } from '../controllers/leaderboardController';
import { asyncHandler } from '../middleware/errorHandling';
import { leaderboardRequestErrorHandler } from './leaderboardRouter.handlers';
import { createThreeBossesSubmissionIpRateLimiter } from '../security/requestRateLimits';

export { leaderboardRoutesContract } from './leaderboardRouter.contract';

export type LeaderboardRouterOptions = Readonly<{
    sessionSecret: string;
    allowedMutationOrigins: readonly string[];
    threeBossesRunSubmissionsEnabled: boolean;
}>;

export function createLeaderboardRouter(
    database: Pick<Pool, 'getConnection' | 'query'>,
    options: LeaderboardRouterOptions
): Router {
    const router = Router();
    const controller = createLeaderboardController({ database, ...options });

    router.get('/', controller.getCatalog);
    if (options.threeBossesRunSubmissionsEnabled) {
        router.post(
            '/three-bosses/runs',
            createThreeBossesSubmissionIpRateLimiter(),
            json({ limit: '32kb', strict: true }),
            asyncHandler(controller.submitThreeBossesRun)
        );
    } else {
        // Keep disabled responses independent of auth, persistence, and the
        // opt-in route's dedicated limiter.
        router.post(
            '/three-bosses/runs',
            asyncHandler(controller.submitThreeBossesRun)
        );
    }
    router.get('/:gameId', asyncHandler(controller.getGameLeaderboard));
    router.use(leaderboardRequestErrorHandler);

    return router;
}
