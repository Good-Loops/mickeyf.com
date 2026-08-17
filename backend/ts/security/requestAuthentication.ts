/**
 * Shared request authentication for endpoints that accept the login JWT.
 *
 * The login flow stores the JWT in a signed `session` cookie and also returns it
 * for legacy Bearer-token callers. Cookie-parser verifies the outer cookie
 * signature before placing the token in `req.signedCookies`; this module then
 * verifies the JWT signature and validates the identity claims before exposing
 * them to application code.
 */
import { Request } from 'express';
import jwt from 'jsonwebtoken';

export type AuthenticatedIdentity = {
    userId: number;
    userName: string;
};

export type RequestAuthenticationResult =
    | { authenticated: true; identity: AuthenticatedIdentity }
    | {
          authenticated: false;
          reason: 'MISSING_CREDENTIALS' | 'INVALID_CREDENTIALS' | 'AUTH_CONFIGURATION_ERROR';
      };

type AuthenticationRequest = Pick<Request, 'headers' | 'signedCookies'>;

/**
 * Returns the preferred signed-cookie token, with Bearer JWT as a fallback.
 * Malformed Authorization headers are treated as missing credentials.
 */
export function getRequestToken(req: AuthenticationRequest): string | null {
    const signedCookieToken = req.signedCookies?.session;
    if (typeof signedCookieToken === 'string' && signedCookieToken.length > 0) {
        return signedCookieToken;
    }

    const authorization = req.headers.authorization;
    if (typeof authorization !== 'string') {
        return null;
    }

    const bearerMatch = /^Bearer ([^\s]+)$/.exec(authorization);
    return bearerMatch?.[1] ?? null;
}

/** Verifies a JWT and returns only the identity claims trusted by the backend. */
export function verifyRequestToken(
    token: string,
    secret: string | undefined = process.env.SESSION_SECRET
): RequestAuthenticationResult {
    if (!secret) {
        return { authenticated: false, reason: 'AUTH_CONFIGURATION_ERROR' };
    }

    try {
        const decoded = jwt.verify(token, secret, { algorithms: ['HS256'] });

        if (
            typeof decoded !== 'object'
            || decoded === null
            || !Number.isSafeInteger(decoded.user_id)
            || (decoded.user_id as number) <= 0
            || typeof decoded.user_name !== 'string'
            || decoded.user_name.length === 0
        ) {
            return { authenticated: false, reason: 'INVALID_CREDENTIALS' };
        }

        return {
            authenticated: true,
            identity: {
                userId: decoded.user_id as number,
                userName: decoded.user_name,
            },
        };
    } catch {
        return { authenticated: false, reason: 'INVALID_CREDENTIALS' };
    }
}

/** Authenticates a request without exposing the raw token to callers. */
export function authenticateRequest(
    req: AuthenticationRequest,
    secret: string | undefined = process.env.SESSION_SECRET
): RequestAuthenticationResult {
    const token = getRequestToken(req);
    if (!token) {
        return { authenticated: false, reason: 'MISSING_CREDENTIALS' };
    }

    return verifyRequestToken(token, secret);
}
