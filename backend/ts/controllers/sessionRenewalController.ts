import type { Request, Response } from 'express';
import type { Pool } from 'mysql2/promise';
import { renewAccountSession } from '../auth/accountSessionRepository';
import { authenticateRequest } from '../security/requestAuthentication';
import { deriveRenewedSessionId, issueRenewedSessionToken } from '../security/sessionPolicy';
import { isJsonMutationRequest } from '../security/mutationRequest';
import { NATIVE_SESSION_COOKIE, WEB_SESSION_COOKIE, SESSION_COOKIE_NAMES, sessionCookieOptions } from '../security/sessionCookie';

type RenewalDependencies = {
    database: Pick<Pool, 'getConnection'>;
    sessionSecret: string;
    isProduction: boolean;
    allowedOrigins: readonly string[];
};

/** Explicit cookie-bearing POST: read-only verification must never silently extend access. */
export function createSessionRenewalController({ database, sessionSecret, isProduction, allowedOrigins }: RenewalDependencies) {
    return async function renewSession(req: Request, res: Response) {
        const origin = req.headers.origin;
        if (typeof origin !== 'string' || origin === 'null' || !allowedOrigins.includes(origin)
            || req.headers.authorization !== undefined || !isJsonMutationRequest(req)
            || SESSION_COOKIE_NAMES.some(name => req.cookies?.[name] !== undefined)) {
            return res.status(403).json({ error: 'INVALID_REQUEST' });
        }
        if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length !== 0) {
            return res.status(400).json({ error: 'INVALID_REQUEST' });
        }
        const authentication = authenticateRequest(req, sessionSecret);
        if (!authentication.authenticated) return res.json({ loggedIn: false });

        const { userId, accountId, sessionId } = authentication.identity;
        try {
            const account = await renewAccountSession(database, userId, accountId, sessionId,
                previousId => deriveRenewedSessionId(previousId, sessionSecret));
            // Never clear cookies on an invalid/delayed request: another tab may have logged in.
            if (!account) return res.json({ loggedIn: false });
            if (account.renewal) {
                const token = issueRenewedSessionToken({ userId, accountId, userName: account.userName },
                    sessionSecret, account.renewal);
                const maxAge = account.renewal.expiresAt * 1000 - Date.now();
                if (maxAge <= 0) return res.json({ loggedIn: false });
                const name = origin === 'capacitor://localhost' ? NATIVE_SESSION_COOKIE : WEB_SESSION_COOKIE;
                res.cookie(name, token, { ...sessionCookieOptions(isProduction, name), maxAge });
            }
            return res.json({ loggedIn: true, user_name: account.userName });
        } catch {
            return res.status(503).json({ error: 'SESSION_RENEWAL_UNAVAILABLE' });
        }
    };
}
