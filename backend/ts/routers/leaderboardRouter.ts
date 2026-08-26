/** Dedicated public router for additive, read-only multi-game leaderboards. */
import { Router } from 'express';
import { Pool } from 'mysql2/promise';
import { createLeaderboardController } from '../controllers/leaderboardController';
import { asyncHandler } from '../middleware/errorHandling';
import { leaderboardRequestErrorHandler } from './leaderboardRouter.handlers';

export { leaderboardRoutesContract } from './leaderboardRouter.contract';

export function createLeaderboardRouter(
    database: Pick<Pool, 'query'>
): Router {
    const router = Router();
    const controller = createLeaderboardController(database);

    router.get('/', controller.getCatalog);
    router.get('/:gameId', asyncHandler(controller.getGameLeaderboard));
    router.use(leaderboardRequestErrorHandler);

    return router;
}
