import { Request } from 'express';
import { SESSION_COOKIE_NAMES } from './sessionCookie';

/** Cookie mutations require an exact trusted Origin; bearer-only clients may omit it. */
export function hasAllowedMutationOrigin(
    req: Pick<Request, 'headers' | 'signedCookies'>,
    allowedOrigins: readonly string[]
): boolean {
    const origin = req.headers.origin;
    if (origin !== undefined) {
        return typeof origin === 'string' && allowedOrigins.includes(origin);
    }
    return !SESSION_COOKIE_NAMES.some(name => req.signedCookies?.[name] !== undefined);
}

export function isJsonMutationRequest(req: Pick<Request, 'headers'>): boolean {
    const contentType = req.headers['content-type'];
    if (typeof contentType !== 'string') return false;
    const [mediaType] = contentType.split(';', 1);
    return mediaType.trim().toLowerCase() === 'application/json';
}
