import { json, Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { createProviderAuthContextReader } from '../auth/providerAuthContext';
import type { ChildInactivityParentService } from '../accounts/childInactivityParentService';
import { asyncHandler } from '../middleware/errorHandling';

/** Explicit opt-in only: production composition must not mount this before schema and policy qualification. */
export function createChildInactivityParentRouter(service: ChildInactivityParentService,
    readContext: ReturnType<typeof createProviderAuthContextReader>): Router {
    const router = Router();
    router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
    router.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-8',
        legacyHeaders: false, passOnStoreError: false, message: { error: 'RATE_LIMITED' } }));
    router.use(json({ limit: '4kb', strict: true }));
    for (const [path, operation] of [['/warning', service.read], ['/acknowledge', service.acknowledge], ['/pending', service.pending]] as const) {
        router.post(path, asyncHandler(async (req, res) => {
            try {
                const result = await operation(await readContext(req, 'complete'), req.body);
                if ('error' in result && result.error) {
                    return res.status({ INVALID_CONTEXT: 403, INVALID_REQUEST: 400, UNAVAILABLE: 503 }[result.error]).json(result);
                }
                return res.status(200).json(result);
            } catch { return res.status(503).json({ error: 'UNAVAILABLE' }); }
        }));
    }
    return router;
}
