import { createHash, randomBytes } from 'node:crypto';
import type { Request } from 'express';
import type { Pool } from 'mysql2/promise';
import { ProviderAccountUnavailableError, type AccountLinkTarget } from '../accounts/providerAccountRepository';
import { isJsonMutationRequest } from '../security/mutationRequest';
import { verifyRequestToken } from '../security/requestAuthentication';
import { NATIVE_SESSION_COOKIE, SESSION_COOKIE_NAMES, WEB_SESSION_COOKIE, type SessionCookieName } from '../security/sessionCookie';
import { isSessionId, type SessionProof } from '../security/sessionPolicy';
import { readLiveSession } from './accountSessionRepository';

const BINDING_PREFIX = 'provider:v1';
const BINDING_LIFETIME_MS = 5 * 60 * 1000;
declare const trustedProviderContext: unique symbol;

/** Constructed from verified server cookies, never from a request body. */
export type ProviderAuthContext = Readonly<{
    bindingHash: Buffer;
    account: AccountLinkTarget | null;
    session: SessionProof | null;
    bindingExpiresAt: number | null;
    anonymousCookie: Readonly<{ name: SessionCookieName; value: string; maxAge: number }> | null;
    [trustedProviderContext]: true;
}>;

type ContextRequest = Pick<Request, 'method' | 'headers' | 'signedCookies'> & Partial<Pick<Request, 'cookies'>>;

export function createProviderAuthContextReader({ database, sessionSecret, allowedOrigins }: {
    database: Pick<Pool, 'query'>;
    sessionSecret: string;
    allowedOrigins: readonly string[];
}) {
    if (!sessionSecret) throw new TypeError('Provider authentication requires session configuration.');
    const origins = new Set(allowedOrigins);
    return async function readProviderAuthContext(
        req: ContextRequest, mode: 'begin' | 'complete' = 'complete',
    ): Promise<ProviderAuthContext | null> {
        const origin = req.headers.origin;
        // Unlike existing bearer-compatible mutations, even anonymous login must
        // prove its initiating Origin. Native transport supplies capacitor://localhost.
        if (req.method !== 'POST' || typeof origin !== 'string' || origin === 'null'
            || !origins.has(origin) || !isJsonMutationRequest(req)
            || req.headers.authorization !== undefined
            || SESSION_COOKIE_NAMES.some(name => req.cookies?.[name] !== undefined)) return null;
        const name = origin === 'capacitor://localhost' ? NATIVE_SESSION_COOKIE : WEB_SESSION_COOKIE;
        if (SESSION_COOKIE_NAMES.some(other => other !== name && req.signedCookies?.[other] !== undefined)) return null;
        let token: unknown = req.signedCookies?.[name];
        let account: AccountLinkTarget | null = null;
        let session: SessionProof | null = null;
        let bindingExpiresAt: number | null = null;
        let anonymousCookie: ProviderAuthContext['anonymousCookie'] = null;
        const now = Date.now();
        if (typeof token === 'string' && token.startsWith(`${BINDING_PREFIX}:`)) {
            // Only cookie-parser's authenticated signedCookies reach here. This
            // purpose-separated value is NOT a JWT and cannot authenticate a user.
            const parts = token.split(':');
            const issuedAt = Number(parts[2]);
            if (parts.length !== 4 || !/^\d{13}$/.test(parts[2]) || !isSessionId(parts[3])
                || !Number.isSafeInteger(issuedAt) || issuedAt > now) return null;
            bindingExpiresAt = issuedAt + BINDING_LIFETIME_MS;
            if (mode === 'complete' && bindingExpiresAt <= now) return null;
        } else if (token !== undefined) {
            if (typeof token !== 'string' || token.length === 0 || token.length > 8192) return null;
            const authentication = verifyRequestToken(token, sessionSecret);
            if (!authentication.authenticated) return null;
            try {
                const { userId, accountId, sessionId, userName } = authentication.identity;
                const current = await readLiveSession(database, userId, accountId, sessionId);
                if (!current || current.userName !== userName) return null;
                account = Object.freeze({ userId, accountId });
                session = Object.freeze({ accountId, sessionId });
            } catch { throw new ProviderAccountUnavailableError(); }
        }
        if (account === null && mode === 'begin') {
            const binding = `${BINDING_PREFIX}:${now}:${randomBytes(32).toString('base64url')}`;
            token = binding;
            bindingExpiresAt = now + BINDING_LIFETIME_MS;
            anonymousCookie = Object.freeze({ name, value: binding, maxAge: BINDING_LIFETIME_MS });
        }
        if (token === undefined) return null;
        // Length-framed fields avoid ambiguity and bind the CURRENT session and account.
        // Sharing the canonical cookie makes normal login/logout replace/clear it,
        // including through Firebase Hosting, which strips other cookie names.
        const bindingHash = createHash('sha256').update(JSON.stringify([
            'provider-auth-v2', origin, token, account,
        ])).digest();
        return Object.freeze({ bindingHash, account, session, bindingExpiresAt, anonymousCookie }) as ProviderAuthContext;
    };
}
