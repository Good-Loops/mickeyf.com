import { Request, Response } from 'express';
import { clearAuthenticationCookies, SESSION_COOKIE_NAMES } from '../security/sessionCookie';
import { isUnexpiredParentBinding } from '../auth/providerAuthContext';
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
        } else if (SESSION_COOKIE_NAMES.some(name => isUnexpiredParentBinding(req.signedCookies?.[name]))) {
            // Anonymous logout is not adult verification and must not reopen a restricted registration.
            return res.json({ loggedOut: true });
        }
        // Clear only after acknowledged revocation; invalid/expired credentials are already unusable.
        clearAuthenticationCookies(res, isProduction);
        return res.json({ loggedOut: true });
    };
}
