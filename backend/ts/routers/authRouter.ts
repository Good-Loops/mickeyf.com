/**
 * Auth router: mounts authentication endpoints and composes middleware + controller handlers.
 *
 * Responsibility:
 * - Defines the auth route surface (paths + HTTP methods) and binds them to controller handlers.
 * - Establishes per-route middleware ordering guarantees where applicable.
 *
 * Non-responsibilities:
 * - Implementing auth business logic and request processing (owned by controllers/services).
 * - Application-wide middleware configuration (owned by app bootstrap).
 *
 * Invariants:
 * - Route path + method pairs form a stable external contract.
 */
import { Router } from 'express';
import { createAuthController } from '../controllers/authController';
import { createSessionRenewalController } from '../controllers/sessionRenewalController';
import { Pool } from 'mysql2/promise';
import { createAccountDeletionController } from '../controllers/accountDeletionController';
import type { AccountDeletionJournal } from '../accounts/deletionJournal';
import { asyncHandler } from '../middleware/errorHandling';
import { createAccountDeletionRateLimiters, createSessionRenewalRateLimiter } from '../security/requestRateLimits';

import { createLogoutHandler } from './authRouter.handlers';

export { authRoutesContract } from './authRouter.contract';

export function createAuthRouter(
    database: Pick<Pool, 'query' | 'getConnection'>,
    sessionSecret: string,
    isProduction: boolean,
    allowedMutationOrigins: readonly string[],
    { accountDeletionEnabled = false, deletionJournal }: {
        accountDeletionEnabled?: boolean;
        deletionJournal?: AccountDeletionJournal;
    } = {}
): Router {
    /**
     * Configured Express router for authentication routes.
     *
     * Ownership:
     * - Exports a fully-mounted router; mounting location (base path) is owned by the app bootstrap.
     *
     * Side effects:
     * - None beyond Express route registration.
     */
    const router: Router = Router();

    /** GET /verify-token — validates auth context for the current request. */
    router.get('/verify-token', asyncHandler(createAuthController(database, sessionSecret)));

    router.post('/renew', createSessionRenewalRateLimiter(), asyncHandler(createSessionRenewalController({
        database, sessionSecret, isProduction, allowedOrigins: allowedMutationOrigins,
    })));

    router.post('/delete-account', ...createAccountDeletionRateLimiters(sessionSecret),
        asyncHandler(createAccountDeletionController({
            database, sessionSecret, isProduction, allowedMutationOrigins,
            accountDeletionEnabled,
            deletionJournal,
        })));

    /** POST /logout — revokes this device's session before clearing its cookies. */
    router.post('/logout', asyncHandler(createLogoutHandler(database, sessionSecret, isProduction, allowedMutationOrigins)));

    return router;
}
