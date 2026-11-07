import { json, Router, urlencoded, type ErrorRequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import { asyncHandler } from '../middleware/errorHandling';
import type { createAppleAndroidHandoffFlow } from '../auth/appleAndroidHandoffFlow';
import type { createProviderAuthContextReader } from '../auth/providerAuthContext';

export function createAppleAndroidHandoffRouter(flow: ReturnType<typeof createAppleAndroidHandoffFlow>,
    readContext: ReturnType<typeof createProviderAuthContextReader>, issuanceAvailable: () => boolean) {
    const router = Router();
    const limit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 60, standardHeaders: 'draft-8',
        legacyHeaders: false, message: { error: 'RATE_LIMITED' }, passOnStoreError: false });
    router.use((_request, response, next) => {
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('Referrer-Policy', 'no-referrer');
        next();
    });
    router.post('/callback', limit, urlencoded({ extended: false, limit: '32kb', parameterLimit: 5 }), asyncHandler(async (req, res) => {
        if (!req.is('application/x-www-form-urlencoded')) return res.status(400).json({ error: 'INVALID_APPLE_RETURN' });
        try {
            // No context read, session creation, cookie forwarding, or token exchange in this browser.
            const target = await flow.callback(req.body, issuanceAvailable());
            return target ? res.redirect(303, target) : res.status(400).json({ error: 'INVALID_APPLE_RETURN' });
        } catch { return res.status(503).json({ error: 'UNAVAILABLE' }); }
    }));
    router.post('/credential', limit, json({ limit: '1kb', strict: true }), asyncHandler(async (req, res) => {
        if (req.headers.origin !== 'capacitor://localhost') return res.status(403).json({ error: 'INVALID_CONTEXT' });
        try {
            const credential = await flow.redeem(await readContext(req, 'complete'), req.body, issuanceAvailable());
            return credential ? res.json(credential) : res.status(400).json({ error: 'INVALID_ATTEMPT' });
        } catch { return res.status(503).json({ error: 'UNAVAILABLE' }); }
    }));
    const invalidBody: ErrorRequestHandler = (_error, _req, res, _next) => {
        res.status(400).json({ error: 'INVALID_APPLE_RETURN' });
    };
    router.use(invalidBody);
    return router;
}
