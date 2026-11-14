/**
 * Shared request authentication for endpoints that accept the login JWT.
 *
 * The login flow stores the JWT only in a signed HttpOnly cookie; the JSON
 * response does not expose it. Cookie-parser verifies the outer cookie signature
 * before placing the token in `req.signedCookies`; this module then verifies the
 * JWT signature and validates the identity claims before exposing them to
 * application code. Bearer verification remains as a compatibility path for
 * callers that already possess a valid token. These claims are not sufficient
 * authorization: consumers must also verify the live database session.
 */
import { Request } from 'express';
import jwt from 'jsonwebtoken';
import { isAccountId } from '../accounts/deletionJournal';
import { WEB_SESSION_COOKIE } from './sessionCookie';
import { SESSION_PURPOSE, SESSION_VERSION, PERSISTENT_SESSION_SECONDS, sessionSigningKey, isSessionId, type SessionAccount, type SessionProof } from './sessionPolicy';

export type AuthenticatedIdentity = SessionAccount & SessionProof & Readonly<{ authenticationMethod?: 'apple' }>;

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
    // A presented but invalid first-party cookie must not fall back to another identity.
    const webCookie: unknown = req.signedCookies?.[WEB_SESSION_COOKIE];
    if (webCookie !== undefined) return typeof webCookie === 'string' && webCookie.length > 0 ? webCookie : null;
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
        if (typeof token !== 'string' || token.length > 8192) {
            return { authenticated: false, reason: 'INVALID_CREDENTIALS' };
        }
        const decoded = jwt.verify(token, sessionSigningKey(secret), { algorithms: ['HS256'] });

        if (
            typeof decoded !== 'object'
            || decoded === null
            || decoded.purpose !== SESSION_PURPOSE || decoded.version !== SESSION_VERSION
            || !isAccountId(decoded.account_uuid)
            || !isSessionId(decoded.jti)
            || !Number.isSafeInteger(decoded.iat) || !Number.isSafeInteger(decoded.exp)
            || decoded.iat! > Math.floor(Date.now() / 1000) + 30
            || decoded.exp! <= decoded.iat!
            || decoded.exp! - decoded.iat! > PERSISTENT_SESSION_SECONDS
            || !Number.isSafeInteger(decoded.user_id)
            || (decoded.user_id as number) <= 0
            || typeof decoded.user_name !== 'string'
            || decoded.user_name.length === 0
            || (decoded.authenticationMethod !== undefined && decoded.authenticationMethod !== 'apple')
        ) {
            return { authenticated: false, reason: 'INVALID_CREDENTIALS' };
        }

        return {
            authenticated: true,
            identity: {
                userId: decoded.user_id as number,
                userName: decoded.user_name,
                accountId: decoded.account_uuid,
                sessionId: decoded.jti,
                ...(decoded.authenticationMethod === 'apple' ? { authenticationMethod: 'apple' as const } : {}),
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
