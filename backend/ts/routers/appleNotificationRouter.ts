import { json, Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { AppleNotificationVerifier, VerifiedAppleNotification } from '../auth/appleNotificationVerifier';
import { asyncHandler } from '../middleware/errorHandling';

/** Authentication is Apple's signature, never a browser cookie or caller-selected subject. */
export function createAppleNotificationRouter(verifier: AppleNotificationVerifier | undefined,
    apply: (notification: VerifiedAppleNotification) => Promise<void>): Router {
    const router = Router();
    if (!verifier) return router;
    router.post('/', rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-8',
        legacyHeaders: false, passOnStoreError: false, message: { error: 'RATE_LIMITED' } }),
    // Production's global parser runs first; keep standalone mounts on the same
    // 32 KiB envelope limit. The signed payload itself remains capped at 16 KiB.
    json({ limit: '32kb', strict: true }), asyncHandler(async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        if (!req.is('application/json') || !req.body || Array.isArray(req.body)
            || typeof req.body !== 'object' || Object.keys(req.body).join(',') !== 'payload'
            || typeof req.body.payload !== 'string' || req.body.payload.length > 16_384) {
            return res.status(400).json({ error: 'INVALID_APPLE_NOTIFICATION' });
        }
        const verified = await verifier.verify(req.body.payload);
        if (!verified.verified) return res.status(verified.reason === 'INVALID_APPLE_NOTIFICATION' ? 400 : 503)
            .json({ error: verified.reason === 'INVALID_APPLE_NOTIFICATION' ? 'INVALID_APPLE_NOTIFICATION' : 'UNAVAILABLE' });
        try {
            await apply(verified.notification);
            return res.status(200).json({ received: true });
        } catch {
            // A committed watermark with unfinished session cleanup still needs
            // redelivery; never acknowledge partial or uncertain application.
            return res.status(503).json({ error: 'UNAVAILABLE' });
        }
    }));
    return router;
}
