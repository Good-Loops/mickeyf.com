import { raw, Router, type Request } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { AppleMaintenanceConfig } from '../config/appleMaintenanceConfig';
import { asyncHandler } from '../middleware/errorHandling';
import { APPLE_MAINTENANCE_AUTH_TIMEOUT_MS, createAppleMaintenanceIdentityVerifier,
    type AppleMaintenanceIdentityVerifier } from '../security/appleMaintenanceIdentity';

function headerCount(request: Request, name: string): number {
    let count = 0;
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
        if (request.rawHeaders[index].toLowerCase() === name) count++;
    }
    return count;
}

function bearerToken(request: Request): string | undefined {
    if (headerCount(request, 'authorization') !== 1 || headerCount(request, 'cookie')
        || headerCount(request, 'origin') || request.originalUrl.includes('?')) return undefined;
    return /^Bearer ([A-Za-z0-9._-]{1,16384})$/u.exec(request.headers.authorization ?? '')?.[1];
}

async function authenticate(verifier: AppleMaintenanceIdentityVerifier, token: string): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([Promise.resolve().then(() => verifier.verify(token)),
            new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), APPLE_MAINTENANCE_AUTH_TIMEOUT_MS); })]);
    } catch { return false; }
    finally { if (timer !== undefined) clearTimeout(timer); }
}

/** Mount on the exact maintenance path before the public JSON/cookie middleware. */
export function createAppleMaintenanceRouter(config: AppleMaintenanceConfig | undefined,
    run: () => Promise<number>, testVerifier?: AppleMaintenanceIdentityVerifier): Router {
    const router = Router({ strict: true });
    let running = false;
    router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
    if (!config) {
        router.use((_req, res) => { res.status(404).json({ error: 'NOT_FOUND' }); });
        return router;
    }
    const verifier = testVerifier ?? createAppleMaintenanceIdentityVerifier(config);
    router.post('/', rateLimit({ windowMs: 5 * 60_000, limit: 20, standardHeaders: 'draft-8',
        legacyHeaders: false, passOnStoreError: false, message: { error: 'RATE_LIMITED' } }),
    asyncHandler(async (req, res, next) => {
        const token = bearerToken(req);
        if (!token || !await authenticate(verifier, token)) return res.status(401).json({ error: 'UNAUTHORIZED' });
        if (req.aborted || res.destroyed) return;
        if (headerCount(req, 'transfer-encoding') || headerCount(req, 'content-encoding')
            || (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0')) {
            return res.status(400).json({ error: 'INVALID_REQUEST' });
        }
        next();
    }), raw({ type: () => true, limit: 1, inflate: false }), asyncHandler(async (req, res) => {
        if ((Buffer.isBuffer(req.body) && req.body.length !== 0)
            || (req.body !== undefined && !Buffer.isBuffer(req.body) && Object.keys(req.body).length !== 0)) {
            return res.status(400).json({ error: 'INVALID_REQUEST' });
        }
        if (req.aborted || res.destroyed) return;
        if (running) return res.status(503).json({ error: 'UNAVAILABLE' });
        running = true;
        try {
            const code = await run();
            return code === 0 ? res.status(200).json({ completed: true })
                : res.status(503).json({ error: 'UNAVAILABLE' });
        } catch { return res.status(503).json({ error: 'UNAVAILABLE' }); }
        finally { running = false; }
    }));
    router.all('/', (_req, res) => { res.setHeader('Allow', 'POST'); res.status(405).json({ error: 'METHOD_NOT_ALLOWED' }); });
    router.use((_req, res) => { res.status(404).json({ error: 'NOT_FOUND' }); });
    return router;
}
