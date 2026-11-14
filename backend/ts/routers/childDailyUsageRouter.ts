import { json, Router, type Application } from 'express';
import { createHash } from 'node:crypto';
import { rateLimit } from 'express-rate-limit';
import type { Pool } from 'mysql2/promise';
import type { createProviderAuthContextReader } from '../auth/providerAuthContext';
import { clearChildDailyUsageLimit, getChildDailyUsageLimit, heartbeatChildDailyUsage, setChildDailyUsageLimit } from '../accounts/childDailyUsageService';
import { MAX_CHILD_DAILY_LIMIT_MS } from '../accounts/childDailyUsage';
import { isAccountId } from '../accounts/deletionJournal';
import { CHILD_DAILY_USAGE_NOTICE_VERSION } from '../accounts/childDailyUsageNotice';

/** Call on opposite sides of the general authentication rate limiter. */
export function mountChildDailyUsageHeartbeat(app: Application, database: Pick<Pool, 'getConnection'>,
    readContext: ReturnType<typeof createProviderAuthContextReader>): void {
    app.use('/auth/child-daily-usage/heartbeat', createChildDailyUsageHeartbeatRouter(database, readContext));
}

export function mountChildDailyUsageEndpoints(app: Application, database: Pick<Pool, 'getConnection'>,
    readContext: ReturnType<typeof createProviderAuthContextReader>): void {
    app.use('/auth/child-daily-usage', createChildDailyUsageRouter(database, readContext));
}

/** Separate mounting can keep heartbeat traffic outside the general /auth limit. */
export function createChildDailyUsageHeartbeatRouter(database: Pick<Pool, 'getConnection'>,
    readContext: ReturnType<typeof createProviderAuthContextReader>): Router {
    const router = Router();
    router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
    // Bound unauthenticated traffic per network, then bound verified sessions separately.
    const heartbeatNetworkLimit = rateLimit({ windowMs: 15 * 60_000, limit: 6000, standardHeaders: 'draft-8', legacyHeaders: false,
        passOnStoreError: false, message: { error: 'RATE_LIMITED' } });
    const heartbeatSessionLimit = rateLimit({ windowMs: 15 * 60_000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false,
        passOnStoreError: false, message: { error: 'RATE_LIMITED' },
        keyGenerator: (_req, res) => createHash('sha256').update(res.locals.dailyUsageContext.session.sessionId, 'ascii').digest('hex') });
    router.post('/', heartbeatNetworkLimit, json({ limit: '1kb', strict: true }), async (req, res, next) => {
        if (!record(req.body) || !exact(req.body, [])) return res.status(400).json({ error: 'INVALID_REQUEST' });
        try {
            const context = await readContext(req, 'complete');
            if (!context?.account || !context.session) return res.status(403).json({ error: 'INVALID_CONTEXT' });
            res.locals.dailyUsageContext = context;
            return next();
        } catch { return res.status(503).json({ error: 'UNAVAILABLE' }); }
    }, heartbeatSessionLimit, async (_req, res) => {
        try { return res.json(await heartbeatChildDailyUsage(database, res.locals.dailyUsageContext)); }
        catch { return res.status(503).json({ error: 'UNAVAILABLE' }); }
    });
    return router;
}

const record = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (body: Record<string, unknown>, names: string[]) => {
    const keys = Object.keys(body);
    return keys.length === names.length && names.every(name => Object.prototype.hasOwnProperty.call(body, name));
};
const timeZoneValid = (value: unknown): value is string => {
    if (typeof value !== 'string' || value.length < 1 || value.length > 100) return false;
    try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
};

/** Available only when the child-usage feature is enabled after qualification. */
export function createChildDailyUsageRouter(database: Pick<Pool, 'getConnection'>,
    readContext: ReturnType<typeof createProviderAuthContextReader>): Router {
    const router = Router();
    router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
    router.use('/heartbeat', createChildDailyUsageHeartbeatRouter(database, readContext));
    router.use(json({ limit: '1kb', strict: true }));
    const parentLimit = rateLimit({ windowMs: 15 * 60_000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false,
        passOnStoreError: false, message: { error: 'RATE_LIMITED' } });
    router.post('/get', parentLimit, async (req, res) => {
        if (!record(req.body) || !exact(req.body, ['childAccountId']) || !isAccountId(req.body.childAccountId)) {
            return res.status(400).json({ error: 'INVALID_REQUEST' });
        }
        try {
            const context = await readContext(req, 'complete');
            if (!context?.account || !context.session) return res.status(403).json({ error: 'INVALID_CONTEXT' });
            return res.json({ usage: await getChildDailyUsageLimit(database, context, req.body.childAccountId) });
        } catch { return res.status(503).json({ error: 'UNAVAILABLE' }); }
    });
    router.post('/set', parentLimit, async (req, res) => {
        if (!record(req.body) || !exact(req.body, ['childAccountId', 'timeZone', 'dailyLimitMs', 'consent', 'noticeVersion'])
            || !isAccountId(req.body.childAccountId) || !timeZoneValid(req.body.timeZone)
            || req.body.consent !== true || req.body.noticeVersion !== CHILD_DAILY_USAGE_NOTICE_VERSION
            || !Number.isSafeInteger(req.body.dailyLimitMs) || Number(req.body.dailyLimitMs) < 60_000
            || Number(req.body.dailyLimitMs) > MAX_CHILD_DAILY_LIMIT_MS) {
            return res.status(400).json({ error: 'INVALID_REQUEST' });
        }
        try {
            const context = await readContext(req, 'complete');
            if (!context?.account || !context.session) return res.status(403).json({ error: 'INVALID_CONTEXT' });
            const usage = await setChildDailyUsageLimit(database, context, req.body.childAccountId,
                { timeZone: req.body.timeZone, dailyLimitMs: Number(req.body.dailyLimitMs) },
                { accepted: true, noticeVersion: req.body.noticeVersion });
            return res.json({ usage });
        } catch { return res.status(503).json({ error: 'UNAVAILABLE' }); }
    });
    router.post('/clear', parentLimit, async (req, res) => {
        if (!record(req.body) || !exact(req.body, ['childAccountId']) || !isAccountId(req.body.childAccountId)) {
            return res.status(400).json({ error: 'INVALID_REQUEST' });
        }
        try {
            const context = await readContext(req, 'complete');
            if (!context?.account || !context.session) return res.status(403).json({ error: 'INVALID_CONTEXT' });
            await clearChildDailyUsageLimit(database, context, req.body.childAccountId);
            return res.status(204).end();
        } catch { return res.status(503).json({ error: 'UNAVAILABLE' }); }
    });
    return router;
}
