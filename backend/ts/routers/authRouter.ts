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

import { createLogoutHandler } from './authRouter.handlers';

export { authRoutesContract } from './authRouter.contract';

export function createAuthRouter(sessionSecret: string, isProduction: boolean): Router {
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
    router.get('/verify-token', createAuthController(sessionSecret));

    /** POST /logout — clears the session cookie, ending the authenticated session. */
    router.post('/logout', createLogoutHandler(isProduction));

    return router;
}
