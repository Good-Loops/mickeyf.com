import { CookieOptions } from 'express';

export function sessionCookieOptions(isProduction: boolean): CookieOptions {
    return {
        httpOnly: true,
        secure: isProduction,
        sameSite: isProduction ? 'none' : 'lax',
        signed: true,
        priority: 'high',
        path: '/',
    };
}
