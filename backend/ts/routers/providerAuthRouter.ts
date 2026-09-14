import { json, Router, type Request, type Response } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import type { Pool } from 'mysql2/promise';
import { findProviderAccount, linkProviderAccount } from '../accounts/providerAccountRepository';
import { createProviderAuthContextReader } from '../auth/providerAuthContext';
import { createProviderAuthFlow, type ProviderAuthClient, type ProviderCompletionResult } from '../auth/providerAuthFlow';
import { consumeProviderAttempt, createProviderAttempt } from '../auth/providerAttemptRepository';
import { establishProviderSession } from '../auth/providerSession';
import { asyncHandler } from '../middleware/errorHandling';
import { authenticateRequest } from '../security/requestAuthentication';
import { NATIVE_SESSION_COOKIE, WEB_SESSION_COOKIE, sessionCookieOptions } from '../security/sessionCookie';
import { isRecord } from '../security/userRequestValidation';

export const PROVIDER_BEGIN_IP_LIMIT = 30;
export const PROVIDER_COMPLETE_IP_LIMIT = 50;
export const PROVIDER_LINK_ACCOUNT_LIMIT = 5;

type ProviderFailureReason = Extract<ProviderCompletionResult, { ok: false }>['reason'];
const failureStatuses: Readonly<Record<ProviderFailureReason, number>> = {
    UNAVAILABLE: 503, INVALID_REQUEST: 400, INVALID_CONTEXT: 403, BUSY: 503,
    INVALID_ATTEMPT: 400, INVALID_PROVIDER_TOKEN: 401, NOT_LINKED: 403,
    INVALID_PASSWORD: 403, LINK_CONFLICT: 409, ACCOUNT_GONE: 401,
};

/** One composition seam keeps HTTP tests independent of external providers and SQL. */
export type ProviderAuthRouterServices = Readonly<{
    readContext: ReturnType<typeof createProviderAuthContextReader>;
    flow: ReturnType<typeof createProviderAuthFlow>;
    establishSession: typeof establishProviderSession;
}>;

export type ProviderAuthRouterOptions = Readonly<{
    database: Pick<Pool, 'query' | 'getConnection'>;
    sessionSecret: string;
    isProduction: boolean;
    allowedOrigins: readonly string[];
    clients: Readonly<Record<string, ProviderAuthClient>>;
    enabled?: boolean;
    services?: ProviderAuthRouterServices;
}>;

function createServices(options: ProviderAuthRouterOptions): ProviderAuthRouterServices {
    const { database, sessionSecret, allowedOrigins, clients } = options;
    return {
        readContext: createProviderAuthContextReader({ database, sessionSecret, allowedOrigins }),
        flow: createProviderAuthFlow({ enabled: true, clients,
            attempts: {
                create: attempt => createProviderAttempt(database, attempt),
                consume: (state, binding, client, action) => consumeProviderAttempt(database, state, binding, client, action),
            },
            accounts: {
                find: identity => findProviderAccount(database, identity),
                link: (target, password, identity, session) => linkProviderAccount(database, target, password, identity, session),
            },
        }),
        establishSession: establishProviderSession,
    };
}

function fail(res: Response, reason: ProviderFailureReason) {
    return res.status(failureStatuses[reason]).json({ error: reason });
}

/** Adds no route, provider request, or database work unless explicitly enabled. */
export function createProviderAuthRouter(options: ProviderAuthRouterOptions): Router {
    const router = Router();
    if (!options.enabled) return router;
    if (Object.keys(options.clients).length === 0) throw new TypeError('Enabled provider routes require configured clients.');
    const { database, sessionSecret, isProduction } = options;
    const services = options.services ?? createServices(options);
    const limiterOptions = {
        windowMs: 15 * 60 * 1000, standardHeaders: 'draft-8' as const,
        legacyHeaders: false, message: { error: 'RATE_LIMITED' }, passOnStoreError: false,
    };
    const linkPasswordLimiter = rateLimit({
        ...limiterOptions, limit: PROVIDER_LINK_ACCOUNT_LIMIT,
        skip: req => !isRecord(req.body) || req.body.action !== 'link',
        keyGenerator(req: Request) {
            const authentication = authenticateRequest(req, sessionSecret);
            return authentication.authenticated
                ? `account:${authentication.identity.accountId}`
                : `ip:${ipKeyGenerator(req.ip ?? 'unknown')}`;
        },
    });

    router.post('/begin', rateLimit({ ...limiterOptions, limit: PROVIDER_BEGIN_IP_LIMIT }),
        json({ limit: '32kb', strict: true }), asyncHandler(async (req, res) => {
            try {
                const context = await services.readContext(req, 'begin');
                const result = await services.flow.begin(context, req.body);
                if (!result.ok) return fail(res, result.reason);
                const cookie = context?.anonymousCookie;
                if (cookie) {
                    if (cookie.name !== WEB_SESSION_COOKIE && cookie.name !== NATIVE_SESSION_COOKIE) {
                        return fail(res, 'UNAVAILABLE');
                    }
                    res.cookie(cookie.name, cookie.value, {
                        ...sessionCookieOptions(isProduction, cookie.name), maxAge: cookie.maxAge,
                    });
                }
                return res.json({ state: result.state, nonce: result.nonce, expiresInSeconds: result.expiresInSeconds });
            } catch { return fail(res, 'UNAVAILABLE'); }
        }));

    router.post('/complete', rateLimit({ ...limiterOptions, limit: PROVIDER_COMPLETE_IP_LIMIT }),
        json({ limit: '32kb', strict: true }), linkPasswordLimiter, asyncHandler(async (req, res) => {
            if (!isRecord(req.body)) return fail(res, 'INVALID_REQUEST');
            const hasRememberMe = Object.prototype.hasOwnProperty.call(req.body, 'rememberMe');
            if (hasRememberMe && (req.body.action !== 'login' || typeof req.body.rememberMe !== 'boolean')) {
                return fail(res, 'INVALID_REQUEST');
            }
            const { rememberMe = false, ...input } = req.body;
            try {
                const context = await services.readContext(req, 'complete');
                const result = await services.flow.complete(context, input);
                if (!result.ok) return fail(res, result.reason);
                if (result.type === 'linked') return res.json({ success: true, linked: true });
                if (!await services.establishSession(database, req, res, result.account, rememberMe === true,
                    sessionSecret, isProduction)) return fail(res, 'ACCOUNT_GONE');
                return res.json({ success: true, user_name: result.account.userName });
            } catch { return fail(res, 'UNAVAILABLE'); }
        }));
    return router;
}
