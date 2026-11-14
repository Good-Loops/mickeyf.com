import { json, Router } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { createProviderAuthContextReader, ProviderAuthContext } from '../auth/providerAuthContext';
import { MAX_APP_STORE_SIGNED_PAYLOAD_LENGTH, type AppStoreTransactionResult } from '../auth/appStoreTransaction';

type AuthenticatedContext = ProviderAuthContext & {
    account: NonNullable<ProviderAuthContext['account']>;
    session: NonNullable<ProviderAuthContext['session']>;
};

export const APP_STORE_TRANSACTION_BINDING_PATH = '/auth/app-store/transaction';

/** Unmounted until the durable association and cross-platform restriction are qualified. */
export function createAppStoreTransactionBindingRouter(
    readContext: ReturnType<typeof createProviderAuthContextReader>,
    verify: (payload: string) => Promise<AppStoreTransactionResult>,
    // Must recheck the session and child relationship inside its locked transaction.
    bind: (context: AuthenticatedContext, appTransactionId: string) => Promise<'linked' | 'restricted' | 'ineligible'>,
    eligible: (context: AuthenticatedContext) => Promise<'child' | 'adult' | 'unknown' | 'invalid-session'>,
    sessionSecret: string,
): Router {
    if (!sessionSecret || typeof eligible !== 'function') throw new TypeError('App Store binding configuration unavailable.');
    const router = Router();
    const proof = (context: ProviderAuthContext) => createHmac('sha256', sessionSecret)
        .update('ludolume-app-store-binding-session-v1\0').update(context.bindingHash).digest();
    router.post('/prepare', json({ limit: '1kb', strict: true }), async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        if (!req.is('application/json') || !req.body || Array.isArray(req.body)
            || typeof req.body !== 'object' || Object.keys(req.body).length !== 0) return res.sendStatus(400);
        try {
            const context = await readContext(req, 'complete');
            if (!context?.account || !context.session || context.account.accountId !== context.session.accountId) return res.sendStatus(403);
            const status = await eligible(context as AuthenticatedContext);
            if (status === 'invalid-session') return res.sendStatus(403);
            if (status === 'unknown') return res.sendStatus(409);
            if (status === 'adult') return res.status(204).end();
            if (status !== 'child') return res.sendStatus(503);
            return res.json({ bindingProof: proof(context).toString('base64url') });
        } catch { return res.sendStatus(503); }
    });
    router.post('/', json({ limit: '96kb', strict: true }), async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        const body: unknown = req.body;
        if (!req.is('application/json') || !body || typeof body !== 'object' || Array.isArray(body)
            || Object.keys(body).sort().join(',') !== 'bindingProof,signedTransaction') return res.sendStatus(400);
        const payload = (body as Record<string, unknown>).signedTransaction;
        const bindingProof = (body as Record<string, unknown>).bindingProof;
        if (typeof payload !== 'string' || !payload || payload.length > MAX_APP_STORE_SIGNED_PAYLOAD_LENGTH
            || typeof bindingProof !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(bindingProof)) return res.sendStatus(400);
        try {
            const context = await readContext(req, 'complete');
            if (!context?.account || !context.session || context.account.accountId !== context.session.accountId) return res.sendStatus(403);
            const supplied = Buffer.from(bindingProof, 'base64url'), expected = proof(context);
            if (supplied.length !== expected.length || supplied.toString('base64url') !== bindingProof
                || !timingSafeEqual(supplied, expected)) return res.sendStatus(403);
            const verified = await verify(payload);
            if (verified.kind === 'invalid') return res.sendStatus(400);
            if (verified.kind === 'unavailable') return res.sendStatus(503);
            // A valid Apple signature does not by itself attest the caller's device.
            const outcome = await bind(context as AuthenticatedContext, verified.appTransactionId);
            return res.sendStatus(outcome === 'linked' ? 204 : 403);
        } catch { return res.sendStatus(503); }
    });
    return router;
}
