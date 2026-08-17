import { Request, Response } from 'express';
import { sessionCookieOptions } from '../security/sessionCookie';

export function createLogoutHandler(isProduction: boolean) {
    return function handleLogout(_req: Request, res: Response) {
        res.clearCookie('session', sessionCookieOptions(isProduction));
        return res.json({ loggedOut: true });
    };
}
