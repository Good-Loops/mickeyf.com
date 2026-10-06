import { Request, Response } from 'express';
import { clearAuthenticationCookies } from '../security/sessionCookie';
import { hasAllowedMutationOrigin } from '../security/mutationRequest';
import { authenticateRequest } from '../security/requestAuthentication';
import { revokeAccountSession } from '../auth/accountSessionRepository';
import type { Pool } from 'mysql2/promise';

export function createLogoutHandler(database: Pick<Pool, 'getConnection'>, sessionSecret: string,
    isProduction: boolean, allowedOrigins: readonly string[]) {
    return async function handleLogout(req: Request, res: Response) {
        if (!hasAllowedMutationOrigin(req, allowedOrigins)) return res.status(403).json({ error: 'INVALID_REQUEST' });
        const authentication = authenticateRequest(req, sessionSecret);
        if (authentication.authenticated) {
            const { userId, accountId, sessionId } = authentication.identity;
            try { await revokeAccountSession(database, userId, accountId, sessionId); }
            catch { return res.status(503).json({ error: 'LOGOUT_UNAVAILABLE' }); }
        }
        // Clear only after acknowledged revocation; invalid/expired credentials are already unusable.
        clearAuthenticationCookies(res, isProduction);
        return res.json({ loggedOut: true });
    };
}
