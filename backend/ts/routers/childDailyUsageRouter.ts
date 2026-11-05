import { json, Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { Pool } from 'mysql2/promise';
import type { createProviderAuthContextReader } from '../auth/providerAuthContext';
import { clearChildDailyUsageLimit, getChildDailyUsageLimit, heartbeatChildDailyUsage, setChildDailyUsageLimit } from '../accounts/childDailyUsageService';
import { MAX_CHILD_DAILY_LIMIT_MS } from '../accounts/childDailyUsage';
import { isAccountId } from '../accounts/deletionJournal';

/** Draft only: do not mount until storage, disclosures and enforcement are qualified. */
export function createChildDailyUsageRouter(database: Pick<Pool, 'getConnection'>,
    readContext: ReturnType<typeof createProviderAuthContextReader>): Router {
    const router = Router();
    router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
    router.use(json({ limit: '1kb', strict: true }));
    const parentLimit = rateLimit({ windowMs: 15 * 60_000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false,
        passOnStoreError: false, message: { error: 'RATE_LIMITED' } });
    const heartbeatLimit = rateLimit({ windowMs: 15 * 60_000, limit: 1200, standardHeaders: 'draft-8', legacyHeaders: false,
        passOnStoreError: false, message: { error: 'RATE_LIMITED' } });
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
    router.post('/heartbeat', heartbeatLimit, async (req, res) => {
        if (!record(req.body) || !exact(req.body, [])) return res.status(400).json({ error: 'INVALID_REQUEST' });
        try {
            const context = await readContext(req, 'complete');
            if (!context?.account || !context.session) return res.status(403).json({ error: 'INVALID_CONTEXT' });
            return res.json(await heartbeatChildDailyUsage(database, context));
        } catch { return res.status(503).json({ error: 'UNAVAILABLE' }); }
    });
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
        if (!record(req.body) || !exact(req.body, ['childAccountId', 'timeZone', 'dailyLimitMs'])
            || !isAccountId(req.body.childAccountId) || !timeZoneValid(req.body.timeZone)
            || !Number.isSafeInteger(req.body.dailyLimitMs) || Number(req.body.dailyLimitMs) < 60_000
            || Number(req.body.dailyLimitMs) > MAX_CHILD_DAILY_LIMIT_MS) {
            return res.status(400).json({ error: 'INVALID_REQUEST' });
        }
        try {
            const context = await readContext(req, 'complete');
            if (!context?.account || !context.session) return res.status(403).json({ error: 'INVALID_CONTEXT' });
            const usage = await setChildDailyUsageLimit(database, context, req.body.childAccountId,
                { timeZone: req.body.timeZone, dailyLimitMs: Number(req.body.dailyLimitMs) });
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
