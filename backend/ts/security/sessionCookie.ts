import { CookieOptions, Response } from 'express';

// Firebase Hosting forwards only __session. Native transport retains its original cookie name.
export const WEB_SESSION_COOKIE = '__session';
export const NATIVE_SESSION_COOKIE = 'session';
export const SESSION_COOKIE_NAMES = [WEB_SESSION_COOKIE, NATIVE_SESSION_COOKIE] as const;
export type SessionCookieName = typeof SESSION_COOKIE_NAMES[number];

export function sessionCookieOptions(isProduction: boolean, name: SessionCookieName = NATIVE_SESSION_COOKIE): CookieOptions {
    return {
        httpOnly: true,
        secure: isProduction,
        sameSite: isProduction && name === NATIVE_SESSION_COOKIE ? 'none' : 'lax',
        signed: true,
        priority: 'high',
        path: '/',
    };
}

export function clearAuthenticationCookies(res: Response, isProduction: boolean): void {
    for (const name of SESSION_COOKIE_NAMES) res.clearCookie(name, sessionCookieOptions(isProduction, name));
}
