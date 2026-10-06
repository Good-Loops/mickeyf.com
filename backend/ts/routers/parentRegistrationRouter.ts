import { clearAuthenticationCookies } from '../security/sessionCookie';
import { json, Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { ParentRegistrationFlow } from '../accounts/parentRegistrationFlow';
import type { createProviderAuthContextReader } from '../auth/providerAuthContext';
import { asyncHandler } from '../middleware/errorHandling';

/** Readiness and reviewed regional policy are enforced by the application composition. */
export function createParentRegistrationRouter(flow: ParentRegistrationFlow,
    readContext: ReturnType<typeof createProviderAuthContextReader>, isProduction = false): Router {
    const router = Router();
    router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
    router.get('/config', (_req, res) => res.json(flow.config()));
    router.get('/scores/config', (_req, res) => res.json(flow.scoreConfig()));
    router.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-8',
        legacyHeaders: false, passOnStoreError: false, message: { error: 'RATE_LIMITED' } }));
    router.use(json({ limit: '24kb', strict: true }));
    for (const [path, operation] of [
        ['/begin', flow.begin], ['/complete', flow.complete], ['/cancel', flow.cancel],
        ['/children', flow.createChild], ['/withdraw', flow.withdrawChild],
        ['/children/list', flow.listChildren], ['/family/delete', flow.deleteFamily],
        ['/forms/request', flow.requestSignedForm], ['/forms/list', flow.listSignedForms], ['/forms/cancel', flow.cancelSignedForm],
        ['/scores/status', flow.scoreStatus], ['/scores/publish', flow.publishScores], ['/scores/withdraw', flow.withdrawScores],
    ] as const) router.post(path, asyncHandler(async (req, res) => {
        try {
            const result = await operation(await readContext(req, 'complete'), req.body);
            const status = 'error' in result ? ({ CLOSED: 503, UNAVAILABLE: 503, INVALID_REQUEST: 400,
                INVALID_CONTEXT: 403, INVALID_ATTEMPT: 403, INVALID_PROVIDER_TOKEN: 401,
                PROVIDER_NOT_LINKED: 403, VERIFIED_CONTACT_REQUIRED: 403, SIGNED_FORM_REQUIRED: 403 }[result.error]) : 200;
            if (path === '/family/delete' && 'deleted' in result) clearAuthenticationCookies(res, isProduction);
            return res.status(status).json(result);
        } catch { return res.status(503).json({ error: 'UNAVAILABLE' }); }
    }));
    return router;
}
