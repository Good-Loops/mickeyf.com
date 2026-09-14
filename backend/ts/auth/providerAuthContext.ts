import { createHash } from 'node:crypto';
import type { Request } from 'express';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { isAccountId } from '../accounts/deletionJournal';
import { ProviderAccountUnavailableError, type AccountLinkTarget } from '../accounts/providerAccountRepository';
import { isJsonMutationRequest } from '../security/mutationRequest';
import { verifyRequestToken } from '../security/requestAuthentication';

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
            || req.headers.authorization !== undefined || req.cookies?.session !== undefined) return null;
        const binding: unknown = req.signedCookies?.[PROVIDER_BINDING_COOKIE];
        if (typeof binding !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(binding)) return null;
        const token: unknown = req.signedCookies?.session;
        let account: AccountLinkTarget | null = null;
        if (token !== undefined) {
            if (typeof token !== 'string' || token.length === 0 || token.length > 8192) return null;
            const authentication = verifyRequestToken(token, sessionSecret);
            if (!authentication.authenticated) return null;
            try {
                const [rows] = await database.query<RowDataPacket[]>({
                    sql: `SELECT user_id AS userId, user_name AS userName, account_uuid AS accountId
                        FROM users WHERE user_id = ? LIMIT 1`, timeout: 10_000,
                }, [authentication.identity.userId]);
                if (!Array.isArray(rows) || rows.length > 1) throw new ProviderAccountUnavailableError();
                if (rows.length === 0 || rows[0].userName !== authentication.identity.userName) return null;
                if (rows[0].userId !== authentication.identity.userId || !isAccountId(rows[0].accountId)) {
                    throw new ProviderAccountUnavailableError();
                }
                account = Object.freeze({ userId: rows[0].userId, accountId: rows[0].accountId });
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
