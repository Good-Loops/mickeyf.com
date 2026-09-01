import { createHash } from 'node:crypto';
import { Request } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { LEADERBOARD_CONTRACT_VERSION } from '../leaderboards/leaderboardContract';
import { operationType } from './userRequestValidation';

const RATE_LIMIT_MESSAGE = Object.freeze({ error: 'RATE_LIMITED' });
const LEADERBOARD_RATE_LIMIT_MESSAGE = Object.freeze({
    success: false as const,
    contractVersion: LEADERBOARD_CONTRACT_VERSION,
    error: 'RATE_LIMITED' as const,
});
const LEADERBOARD_API_PATH = /^\/api\/leaderboards(?:\/|$)/i;
export const THREE_BOSSES_SUBMISSION_IP_LIMIT = 30 as const;

export function generalApiRateLimitMessage(
    req: Pick<Request, 'originalUrl'>
) {
    const [path] = req.originalUrl.split('?', 1);
    return LEADERBOARD_API_PATH.test(path)
        ? LEADERBOARD_RATE_LIMIT_MESSAGE
        : RATE_LIMIT_MESSAGE;
}

export function isAuthenticationOperation(req: Pick<Request, 'body'>): boolean {
    const operation = operationType(req.body);
    return operation === 'login' || operation === 'signup';
}

export function isLoginOperation(req: Pick<Request, 'body'>): boolean {
    return operationType(req.body) === 'login';
}

export function loginAccountRateLimitKey(req: Pick<Request, 'body' | 'ip'>): string {
    const body = req.body;
    if (
        typeof body === 'object'
        && body !== null
        && typeof body.user_name === 'string'
        && body.user_name.trim() !== ''
    ) {
        const digest = createHash('sha256')
            .update(body.user_name.trim().toLowerCase(), 'utf8')
            .digest('hex');
        return `account:${digest}`;
    }

    return `ip:${ipKeyGenerator(req.ip ?? 'unknown')}`;
}

export function createGeneralApiRateLimiter() {
    return rateLimit({
        windowMs: 15 * 60 * 1000,
        limit: 600,
        standardHeaders: 'draft-8',
        legacyHeaders: false,
        handler: (req, res, _next, options) => {
            res.status(options.statusCode).json(generalApiRateLimitMessage(req));
        },
        passOnStoreError: false,
    });
}

/** Per-instance abuse ceiling for the opt-in Three Bosses mutation route. */
export function createThreeBossesSubmissionIpRateLimiter() {
    return rateLimit({
        windowMs: 15 * 60 * 1000,
        limit: THREE_BOSSES_SUBMISSION_IP_LIMIT,
        standardHeaders: 'draft-8',
        legacyHeaders: false,
        message: LEADERBOARD_RATE_LIMIT_MESSAGE,
        passOnStoreError: false,
    });
}

export function createAuthenticationIpRateLimiter() {
    return rateLimit({
        windowMs: 15 * 60 * 1000,
        limit: 50,
        standardHeaders: 'draft-8',
        legacyHeaders: false,
        message: RATE_LIMIT_MESSAGE,
        passOnStoreError: false,
        skip: (req) => !isAuthenticationOperation(req),
    });
}

export function createLoginAccountRateLimiter() {
    return rateLimit({
        windowMs: 15 * 60 * 1000,
        limit: 20,
        standardHeaders: 'draft-8',
        legacyHeaders: false,
        message: RATE_LIMIT_MESSAGE,
        passOnStoreError: false,
        skip: (req) => !isLoginOperation(req),
        keyGenerator: loginAccountRateLimitKey,
    });
}
