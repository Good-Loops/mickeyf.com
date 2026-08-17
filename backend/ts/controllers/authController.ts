/**
 * Authentication controller: HTTP handlers for auth verification.
 *
 * Responsibility:
 * - Implements request/response contracts for auth-related endpoints handled by this module.
 * - Verifies presented authentication tokens and returns an auth status snapshot.
 *
 * Non-responsibilities:
 * - Route mounting and URL design (owned by routers).
 * - Token issuance policy and persistence concerns (handled elsewhere).
 *
 * Side effects:
 * - None beyond reading request headers/cookies and producing a JSON response.
 *
 * Security boundary:
 * - Treats inbound credentials/tokens as untrusted input and verifies signatures before trusting claims.
 */
import { Request, Response } from 'express';
import { authenticateRequest } from '../security/requestAuthentication';

/**
 * Auth verification handler.
 *
 * Request contract:
 * - Reads: `req.signedCookies.session` (preferred) and `req.headers.authorization` (Bearer fallback).
 *
 * Response contract:
 * - Status: implicit 200 (no explicit status set in this handler).
 * - Body: `{ loggedIn: boolean, user_name?: string | null }`.
 *
 * Side effects:
 * - Performs JWT signature verification using the validated startup secret supplied by the router.
 *
 * Failure modes:
 * - Missing/invalid token yields `{ loggedIn: false }`.
 */
export function createAuthController(sessionSecret: string) {
    return function authController(req: Request, res: Response) {
        const authentication = authenticateRequest(req, sessionSecret);
        if (!authentication.authenticated) {
            return res.json({ loggedIn: false });
        }

        return res.json({
            loggedIn: true,
            user_name: authentication.identity.userName,
        });
    };
}
