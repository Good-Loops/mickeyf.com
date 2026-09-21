import { json, Router, type Request, type Response } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import type { Pool } from 'mysql2/promise';
import { createProviderAccount, findProviderAccount, linkProviderAccount,
    persistProviderCredential, readProviderAccountMethods, type ProviderCredentialWriter } from '../accounts/providerAccountRepository';
import type { AppleTokenLifecycle } from '../config/appleTokenConfig';
import { deleteProviderAccount } from '../accounts/accountDeletionRepository';
import type { AccountDeletionJournal } from '../accounts/deletionJournal';
import { readLiveSession } from '../auth/accountSessionRepository';
import { createProviderAuthContextReader } from '../auth/providerAuthContext';
import { createProviderAuthFlow, type ProviderAuthClient, type ProviderCompletionResult,
    type ProviderAuthFlowDependencies } from '../auth/providerAuthFlow';
import { consumeProviderAttempt, createProviderAttempt } from '../auth/providerAttemptRepository';
import { establishProviderSession } from '../auth/providerSession';
import { asyncHandler } from '../middleware/errorHandling';
import { authenticateRequest } from '../security/requestAuthentication';
import { clearAuthenticationCookies, NATIVE_SESSION_COOKIE, WEB_SESSION_COOKIE, SESSION_COOKIE_NAMES,
    sessionCookieOptions } from '../security/sessionCookie';
import { isRecord } from '../security/userRequestValidation';

export const PROVIDER_BEGIN_IP_LIMIT = 30;
export const PROVIDER_COMPLETE_IP_LIMIT = 50;
export const PROVIDER_LINK_ACCOUNT_LIMIT = 5;

type ProviderFailureReason = Extract<ProviderCompletionResult, { ok: false }>['reason'];
const failureStatuses: Readonly<Record<ProviderFailureReason, number>> = {
    UNAVAILABLE: 503, INVALID_REQUEST: 400, INVALID_CONTEXT: 403, BUSY: 503,
    INVALID_ATTEMPT: 400, INVALID_PROVIDER_TOKEN: 401, NOT_LINKED: 403,
    INVALID_PASSWORD: 403, LINK_CONFLICT: 409, ACCOUNT_GONE: 401,
    DUPLICATE_USER: 409, ALREADY_LINKED: 409, INVALID_USERNAME: 400, INVALID_EMAIL: 400,
    ACCOUNT_DELETION_UNAVAILABLE: 503, ACCOUNT_DELETION_PENDING: 503,
};

/** One composition seam keeps HTTP tests independent of external providers and SQL. */
export type ProviderAuthRouterServices = Readonly<{
    readContext: ReturnType<typeof createProviderAuthContextReader>;
    flow: ReturnType<typeof createProviderAuthFlow>;
    establishSession: typeof establishProviderSession;
    readAccountMethods: typeof readProviderAccountMethods;
}>;

export type ProviderAuthRouterOptions = Readonly<{
    database: Pick<Pool, 'query' | 'getConnection'>;
    sessionSecret: string;
    isProduction: boolean;
    allowedOrigins: readonly string[];
    clients: Readonly<Record<string, ProviderAuthClient>>;
    enabled?: boolean;
    signupEnabled?: boolean;
    accountDeletionEnabled?: boolean;
    deletionJournal?: AccountDeletionJournal;
    appleTokenRepository?: AppleTokenLifecycle['repository'];
    services?: ProviderAuthRouterServices;
}>;

function createServices(options: ProviderAuthRouterOptions): ProviderAuthRouterServices {
    const { database, sessionSecret, allowedOrigins, clients } = options;
    const credentialWriter = (refreshToken?: string): ProviderCredentialWriter | undefined => {
        if (refreshToken === undefined) return undefined;
        if (!options.appleTokenRepository) throw new Error('Apple token storage is unavailable.');
        const repository = options.appleTokenRepository;
        return async (connection, account) => repository.save(connection, repository.prepare(refreshToken, account.accountId));
    };
    return {
        readContext: createProviderAuthContextReader({ database, sessionSecret, allowedOrigins }),
        flow: createProviderAuthFlow({ enabled: true, clients, signupEnabled: options.signupEnabled,
            deletionEnabled: options.accountDeletionEnabled === true && options.deletionJournal !== undefined,
            attempts: {
                create: attempt => createProviderAttempt(database, attempt),
                consume: (state, binding, client, action) => consumeProviderAttempt(database, state, binding, client, action),
            },
            accounts: {
                find: identity => findProviderAccount(database, identity),
                link: (target, password, identity, session, token) => linkProviderAccount(database, target, password, identity, session,
                    credentialWriter(token)),
                create: (identity, userName, token) => createProviderAccount(database, identity, userName, credentialWriter(token)),
                ...(options.appleTokenRepository ? {
                    saveAppleToken: (account, identity, token) => persistProviderCredential(database, account, identity, credentialWriter(token)!),
                } satisfies Pick<ProviderAuthFlowDependencies['accounts'], 'saveAppleToken'> : {}),
                ...(options.deletionJournal ? {
                    delete: (target, identity, session, token) => {
                        const writer = credentialWriter(token);
                        return deleteProviderAccount(database, target.userId, identity, options.deletionJournal!, session,
                            writer ? (connection, accountId) => writer(connection, { userId: target.userId, accountId }) : undefined);
                    },
                } satisfies Pick<ProviderAuthFlowDependencies['accounts'], 'delete'> : {}),
            },
        }),
        establishSession: establishProviderSession,
        readAccountMethods: readProviderAccountMethods,
    };
}

function fail(res: Response, reason: ProviderFailureReason) {
    return res.status(failureStatuses[reason]).json({ error: reason });
}

/** Account-method discovery is always available; mutations require explicit opt-in. */
export function createProviderAuthRouter(options: ProviderAuthRouterOptions): Router {
    const router = Router();
    const { database, sessionSecret, isProduction } = options;
    const deletionAvailable = options.enabled === true && options.accountDeletionEnabled === true && options.deletionJournal !== undefined;
    const googleDeletionEnabled = deletionAvailable
        && Object.prototype.hasOwnProperty.call(options.clients, 'google-web') && options.clients['google-web'].provider === 'google';
    const appleDeletionEnabled = deletionAvailable
        && Object.prototype.hasOwnProperty.call(options.clients, 'apple-ios') && options.clients['apple-ios'].provider === 'apple'
        && options.clients['apple-ios'].deletionEnabled === true
        && options.clients['apple-ios'].appleTokens !== undefined && options.appleTokenRepository !== undefined;
    const canDeleteWith = (clientKey: unknown) => clientKey === 'google-web' ? googleDeletionEnabled
        : clientKey === 'apple-ios' && appleDeletionEnabled;
    const limiterOptions = {
        windowMs: 15 * 60 * 1000, standardHeaders: 'draft-8' as const,
        legacyHeaders: false, message: { error: 'RATE_LIMITED' }, passOnStoreError: false,
    };
    const linkPasswordLimiter = rateLimit({
        ...limiterOptions, limit: PROVIDER_LINK_ACCOUNT_LIMIT,
        skip: req => !isRecord(req.body) || (req.body.action !== 'link' && req.body.action !== 'delete'),
        keyGenerator(req: Request) {
            const authentication = authenticateRequest(req, sessionSecret);
            return authentication.authenticated
                ? `account:${authentication.identity.accountId}`
                : `ip:${ipKeyGenerator(req.ip ?? 'unknown')}`;
        },
    });

    router.get('/account', rateLimit({ ...limiterOptions, limit: 60 }), asyncHandler(async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        if (req.headers.authorization !== undefined || SESSION_COOKIE_NAMES.some(name => req.cookies?.[name] !== undefined)
            || SESSION_COOKIE_NAMES.filter(name => req.signedCookies?.[name] !== undefined).length !== 1) {
            return res.status(401).json({ error: 'UNAUTHENTICATED' });
        }
        const authentication = authenticateRequest(req, sessionSecret);
        if (!authentication.authenticated) return res.status(401).json({ error: 'UNAUTHENTICATED' });
        try {
            const { userId, accountId, sessionId, userName } = authentication.identity;
            const account = await readLiveSession(database, userId, accountId, sessionId);
            if (!account || account.userName !== userName) return res.status(401).json({ error: 'UNAUTHENTICATED' });
            const methods = await (options.services?.readAccountMethods ?? readProviderAccountMethods)(database, accountId,
                { allowMissingProviderTable: options.enabled !== true });
            if (!methods) return res.status(401).json({ error: 'UNAUTHENTICATED' });
            return res.json({ hasPassword: methods.hasPassword, googleLinked: methods.googleLinked,
                googleDeletionEnabled: googleDeletionEnabled && methods.googleLinked,
                appleLinked: methods.appleLinked, appleDeletionEnabled: appleDeletionEnabled && methods.appleLinked });
        } catch { return fail(res, 'UNAVAILABLE'); }
    }));

    if (!options.enabled) return router;
    if (Object.keys(options.clients).length === 0) throw new TypeError('Enabled provider routes require configured clients.');
    const services = options.services ?? createServices(options);

    router.post('/begin', rateLimit({ ...limiterOptions, limit: PROVIDER_BEGIN_IP_LIMIT }),
        json({ limit: '32kb', strict: true }), asyncHandler(async (req, res) => {
            if (isRecord(req.body) && req.body.action === 'signup' && !options.signupEnabled) return fail(res, 'UNAVAILABLE');
            if (isRecord(req.body) && req.body.action === 'delete' && !canDeleteWith(req.body.clientKey)) return fail(res, 'ACCOUNT_DELETION_UNAVAILABLE');
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
            if (req.body.action === 'signup' && !options.signupEnabled) return fail(res, 'UNAVAILABLE');
            if (req.body.action === 'delete' && !canDeleteWith(req.body.clientKey)) return fail(res, 'ACCOUNT_DELETION_UNAVAILABLE');
            const hasRememberMe = Object.prototype.hasOwnProperty.call(req.body, 'rememberMe');
            if (hasRememberMe && ((req.body.action !== 'login' && req.body.action !== 'signup') || typeof req.body.rememberMe !== 'boolean')) {
                return fail(res, 'INVALID_REQUEST');
            }
            const { rememberMe = false, ...input } = req.body;
            try {
                const context = await services.readContext(req, 'complete');
                const result = await services.flow.complete(context, input);
                if (!result.ok) return fail(res, result.reason);
                if (result.type === 'signup-required') return res.json({ signupRequired: true,
                    challenge: { state: result.state, nonce: result.nonce, expiresInSeconds: result.expiresInSeconds } });
                if (result.type === 'linked') return res.json({ success: true, linked: true });
                if (result.type === 'deleted') {
                    clearAuthenticationCookies(res, isProduction);
                    return res.json({ success: true, deleted: true });
                }
                if (!await services.establishSession(database, req, res, result.account, rememberMe === true,
                    sessionSecret, isProduction)) return fail(res, 'ACCOUNT_GONE');
                return res.json({ success: true, user_name: result.account.userName });
            } catch { return fail(res, 'UNAVAILABLE'); }
        }));
    return router;
}
