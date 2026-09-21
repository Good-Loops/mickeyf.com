import type { Request, Response } from 'express';
import type { Pool } from 'mysql2/promise';
import type { ProviderAccount } from '../accounts/providerAccountRepository';
import { clearAuthenticationCookies, NATIVE_SESSION_COOKIE, sessionCookieOptions, WEB_SESSION_COOKIE } from '../security/sessionCookie';
import { issueSessionToken, type SessionAuthenticationMethod } from '../security/sessionPolicy';
import { createAccountSession } from './accountSessionRepository';
import type { AppleSessionProof } from './appleSessionRevocation';

/** Called only after provider verification and an existing provider/account lookup.
 * Reuses password login's session issuer, storage, expiry and renewal policy.
 */
export async function establishProviderSession(
    database: Pick<Pool, 'getConnection'>, req: Pick<Request, 'headers'>, res: Response,
    account: ProviderAccount, rememberMe: boolean, sessionSecret: string, isProduction: boolean,
    authenticationMethod?: SessionAuthenticationMethod,
    appleProof?: AppleSessionProof,
): Promise<boolean> {
    if ((authenticationMethod === 'apple') !== (appleProof !== undefined)) {
        throw new TypeError('Apple sessions require verified original authentication proof.');
    }
    const issued = issueSessionToken(account, sessionSecret, rememberMe, Date.now(), authenticationMethod);
    const created = await createAccountSession(database, account, issued.sessionId,
        issued.expiresAt, undefined, rememberMe, appleProof);
    if (!created) return false;
    // A failed or uncertain commit must never send a usable authentication cookie.
    const name = req.headers.origin === 'capacitor://localhost' ? NATIVE_SESSION_COOKIE : WEB_SESSION_COOKIE;
    clearAuthenticationCookies(res, isProduction);
    res.cookie(name, issued.token, { ...sessionCookieOptions(isProduction, name), maxAge: issued.maxAge });
    return true;
}
