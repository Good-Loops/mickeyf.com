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
 * - Reads the current account without changing cookies.
 *
 * Security boundary:
 * - Treats inbound credentials/tokens as untrusted input and verifies signatures before trusting claims.
 */
import { Request, Response } from 'express';
import { Pool } from 'mysql2/promise';
import { readActiveAccount } from '../security/activeAccount';
import { authenticateRequest } from '../security/requestAuthentication';

/**
 * Auth verification handler.
 *
 * Request contract:
 * - Reads: signed web/native cookies (preferred), then Bearer credentials; verifies live session storage.
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
export function createAuthController(
    database: Pick<Pool, 'query'>, sessionSecret: string
) {
    return async function authController(req: Request, res: Response) {
        const authentication = authenticateRequest(req, sessionSecret);
        if (!authentication.authenticated) {
            return res.json({ loggedIn: false });
        }

        const account = await readActiveAccount(database, authentication.identity);
        if (!account) {
            // A delayed GET must not clear a newer login's cookie. Deletion/logout
            // own cookie changes; a stale token is still rejected on every use.
            return res.json({ loggedIn: false });
        }
        return res.json({
            loggedIn: true,
            user_name: account.userName,
        });
    };
}
