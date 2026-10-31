import { json, Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { createProviderAuthContextReader } from '../auth/providerAuthContext';
import { type RegistrationAuthorization, RegistrationRequiredError } from '../accounts/registrationAuthorization';
import { asyncHandler } from '../middleware/errorHandling';
import { sessionCookieOptions } from '../security/sessionCookie';

export function createRegistrationRouter(registration: RegistrationAuthorization,
    readContext: ReturnType<typeof createProviderAuthContextReader>, isProduction: boolean,
    parentRegistrationAvailable = false): Router {
    const router = Router();
    router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
    router.get('/config', (_req, res) => {
        const policy = registration.policy;
        if (policy?.mode === 'general-audience') return res.json({ enabled: true, mode: policy.mode,
            policyVersion: policy.version, optionalDetails: false, parentRegistrationAvailable: false });
        return res.json(policy ? { enabled: true, policyVersion: policy.version,
            ...(policy.audience ? { audience: policy.audience, creationEnabled: registration.creationEnabled } : {}),
            countries: Object.entries(policy.countries).map(([country, rule]) => ({ country,
                parentRequiredBelow: rule.parentRequiredBelow, adultFrom: 18 })), parentRegistrationAvailable }
            : { enabled: false });
    });
    router.post('/cancel', rateLimit({ windowMs: 15 * 60 * 1000, limit: 30,
        standardHeaders: 'draft-8', legacyHeaders: false, passOnStoreError: false,
        message: { error: 'RATE_LIMITED' } }), json({ limit: '1kb', strict: true }), asyncHandler(async (req, res) => {
        if (!req.body || Array.isArray(req.body) || Object.keys(req.body).length) return res.status(400).json({ error: 'INVALID_REQUEST' });
        try {
            const context = await readContext(req, 'complete');
            if (!context) return res.status(403).json({ error: 'INVALID_CONTEXT' });
            // A late cancellation must never log out a completed signup/login.
            if (context.account === null) await registration.cancel(context);
            return res.json({ cancelled: true });
        } catch { return res.status(503).json({ error: 'UNAVAILABLE' }); }
    }));
    router.post('/begin', rateLimit({ windowMs: 15 * 60 * 1000, limit: 20,
        standardHeaders: 'draft-8', legacyHeaders: false, passOnStoreError: false,
        message: { error: 'RATE_LIMITED' } }), json({ limit: '1kb', strict: true }), asyncHandler(async (req, res) => {
        try {
            // Check policy before collecting provider or account credentials.
            if (!registration.policy) return res.status(503).json({ error: 'REGISTRATION_CLOSED' });
            // A refresh must not invalidate an already prepared provider nonce on this browser.
            const existing = registration.policy.mode === 'general-audience' ? await readContext(req, 'complete') : null;
            const context = existing ?? await readContext(req, 'begin');
            if (!context || context.account !== null || context.session !== null
                || (registration.policy.mode !== 'general-audience' && !context.anonymousCookie)) {
                return res.status(403).json({ error: 'INVALID_CONTEXT' });
            }
            const result = await registration.begin(context, req.body);
            if (!result.allowed) {
                if (result.reason === 'PARENT_REQUIRED' && registration.audience === 'children-included') {
                    const restricted = await readContext(req, 'parent-required');
                    const marker = restricted?.anonymousCookie;
                    if (!restricted?.parentRequired || !marker) return res.status(503).json({ error: 'UNAVAILABLE' });
                    res.cookie(marker.name, marker.value, { ...sessionCookieOptions(isProduction, marker.name), maxAge: marker.maxAge });
                }
                return res.status(result.reason === 'PARENT_REQUIRED' ? 403 : 400).json({ error: result.reason });
            }
            const cookie = context.anonymousCookie;
            if (cookie) res.cookie(cookie.name, cookie.value,
                { ...sessionCookieOptions(isProduction, cookie.name), maxAge: cookie.maxAge });
            const remaining = cookie ? cookie.maxAge : Math.max(0, (context.bindingExpiresAt ?? 0) - Date.now());
            return res.json({ authorized: true, expiresInSeconds: Math.floor(remaining / 1000),
                scoreVisibility: 'private' });
        } catch (error) {
            return res.status(error instanceof RegistrationRequiredError ? 403 : 503)
                .json({ error: error instanceof RegistrationRequiredError ? 'REGISTRATION_REQUIRED' : 'UNAVAILABLE' });
        }
    }));
    return router;
}
