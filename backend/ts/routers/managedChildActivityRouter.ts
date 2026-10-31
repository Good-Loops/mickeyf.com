import { json, Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { Pool } from 'mysql2/promise';
import type { createProviderAuthContextReader } from '../auth/providerAuthContext';
import { keepManagedChild, recordOnlineInteraction } from '../accounts/managedChildOnlineActivity';
import type { ParentManagedChildActivity } from '../accounts/parentManagedChildActivity';
import type { RetentionKeepReconciler } from '../accounts/retentionKeepReconciler';

/** Installed only when the reviewed child activity capability is explicitly provided. */
export function createManagedChildActivityRouter(database: Pick<Pool, 'getConnection'>,
    readContext: ReturnType<typeof createProviderAuthContextReader>, activity: ParentManagedChildActivity,
    reconcileKeep?: RetentionKeepReconciler): Router {
    const router = Router();
    router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
    const interactionLimit = rateLimit({ windowMs: 15 * 60_000, limit: 600, standardHeaders: 'draft-8', legacyHeaders: false,
        passOnStoreError: false, message: { error: 'RATE_LIMITED' } });
    const keepLimit = rateLimit({ windowMs: 15 * 60_000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false,
        passOnStoreError: false, message: { error: 'RATE_LIMITED' } });
    router.use(json({ limit: '1kb', strict: true }));
    router.post('/interaction', interactionLimit, async (req, res) => {
        if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length !== 0) {
            return res.status(400).json({ error: 'INVALID_REQUEST' });
        }
        try {
            const context = await readContext(req, 'complete');
            if (!context?.account || !context.session) return res.status(403).json({ error: 'INVALID_CONTEXT' });
            const tracked = await recordOnlineInteraction(database, context, activity);
            return res.status(tracked ? 204 : 202).end();
        } catch { return res.status(503).json({ error: 'UNAVAILABLE' }); }
    });
    router.post('/keep', keepLimit, async (req, res) => {
        if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)
            || Object.keys(req.body).join(',') !== 'childAccountId' || typeof req.body.childAccountId !== 'string') {
            return res.status(400).json({ error: 'INVALID_REQUEST' });
        }
        try {
            const context = await readContext(req, 'complete');
            if (!context?.account || !context.session) return res.status(403).json({ error: 'INVALID_CONTEXT' });
            await keepManagedChild(database, context, req.body.childAccountId, activity);
            await reconcileKeep?.(context, req.body.childAccountId);
            return res.status(204).end();
        } catch { return res.status(503).json({ error: 'UNAVAILABLE' }); }
    });
    return router;
}
