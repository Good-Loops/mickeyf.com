import { json, Router } from 'express';
import type { AppStoreConsentResult } from '../auth/appStoreConsentNotification';
import { asyncHandler } from '../middleware/errorHandling';

type ConsentWithdrawal = Extract<AppStoreConsentResult, { kind: 'consent-withdrawn' }>;

/** Mount only after the verifier and durable withdrawal handler are configured. */
export function createAppStoreConsentRouter(
    read: (payload: unknown) => Promise<AppStoreConsentResult>,
    apply: (notification: ConsentWithdrawal) => Promise<void>,
): Router {
    const router = Router();
    router.post('/', json({ limit: '96kb', strict: true }), asyncHandler(async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        if (!req.is('application/json') || !req.body || Array.isArray(req.body)
            || typeof req.body !== 'object' || Object.keys(req.body).join(',') !== 'signedPayload'
            || typeof req.body.signedPayload !== 'string') return res.sendStatus(400);
        const result = await read(req.body.signedPayload);
        if (result.kind === 'invalid') return res.sendStatus(400);
        // Unknown event types must not be silently acknowledged: another consumer may need them later.
        if (result.kind === 'unavailable' || result.kind === 'unsupported') return res.sendStatus(503);
        if (result.kind === 'test') return res.sendStatus(200);
        try {
            await apply(result);
            return res.sendStatus(200);
        } catch {
            // Apple can retry; never acknowledge an uncertain durable write.
            return res.sendStatus(503);
        }
    }));
    return router;
}
