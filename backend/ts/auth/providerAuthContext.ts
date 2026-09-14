import { createHash } from 'node:crypto';
import type { Request } from 'express';
import type { Pool } from 'mysql2/promise';
import { ProviderAccountUnavailableError, type AccountLinkTarget } from '../accounts/providerAccountRepository';
import { isJsonMutationRequest } from '../security/mutationRequest';
import { getRequestToken, verifyRequestToken } from '../security/requestAuthentication';
import { SESSION_COOKIE_NAMES } from '../security/sessionCookie';
import { readLiveSession } from './accountSessionRepository';

export const PROVIDER_BINDING_COOKIE = 'provider_auth_binding';
declare const trustedProviderContext: unique symbol;

/** Constructed from verified server cookies, never from a request body. */
export type ProviderAuthContext = Readonly<{
    bindingHash: Buffer;
    account: AccountLinkTarget | null;
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
    return async function readProviderAuthContext(req: ContextRequest): Promise<ProviderAuthContext | null> {
        const origin = req.headers.origin;
        // Unlike existing bearer-compatible mutations, even anonymous login must
        // prove its initiating Origin. Native transport supplies capacitor://localhost.
        if (req.method !== 'POST' || typeof origin !== 'string' || origin === 'null'
            || !origins.has(origin) || !isJsonMutationRequest(req)
            || req.headers.authorization !== undefined
            || SESSION_COOKIE_NAMES.some(name => req.cookies?.[name] !== undefined)) return null;
        const binding: unknown = req.signedCookies?.[PROVIDER_BINDING_COOKIE];
        if (typeof binding !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(binding)) return null;
        const token = getRequestToken(req);
        let account: AccountLinkTarget | null = null;
        if (SESSION_COOKIE_NAMES.some(name => req.signedCookies?.[name] !== undefined)) {
            if (typeof token !== 'string' || token.length === 0 || token.length > 8192) return null;
            const authentication = verifyRequestToken(token, sessionSecret);
            if (!authentication.authenticated) return null;
            try {
                const { userId, accountId, sessionId, userName } = authentication.identity;
                const current = await readLiveSession(database, userId, accountId, sessionId);
                if (!current || current.userName !== userName) return null;
                account = Object.freeze({ userId, accountId });
            } catch { throw new ProviderAccountUnavailableError(); }
        }
        // Length-framed fields avoid ambiguity and bind the CURRENT session and account.
        // The future HTTP adapter must rotate the binding cookie on login/logout, too.
        const bindingHash = createHash('sha256').update(JSON.stringify([
            'provider-auth-v1', origin, binding, token ?? null, account,
        ])).digest();
        return Object.freeze({ bindingHash, account }) as ProviderAuthContext;
    };
}
