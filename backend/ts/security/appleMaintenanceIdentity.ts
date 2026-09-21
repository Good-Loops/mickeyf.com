import { OAuth2Client, type TokenPayload } from 'google-auth-library';
import { readProviderJwsKeyId } from '../auth/providerTokenVerifier';
import type { AppleMaintenanceConfig } from '../config/appleMaintenanceConfig';

export const APPLE_MAINTENANCE_AUTH_TIMEOUT_MS = 5_000;
export type AppleMaintenanceIdentityVerifier = { verify(token: string): Promise<boolean> };
type Dependencies = { createClient?: () => OAuth2Client; timeoutMs?: number };

function permittedIdentity(payload: TokenPayload | undefined, config: AppleMaintenanceConfig): boolean {
    const now = Math.floor(Date.now() / 1_000);
    return !!payload && payload.aud === config.audience
        && (payload.iss === 'https://accounts.google.com' || payload.iss === 'accounts.google.com')
        && payload.sub === config.callerSubject && payload.email === config.callerEmail
        && payload.email_verified === true
        && Number.isSafeInteger(payload.exp) && payload.exp > now
        && Number.isSafeInteger(payload.iat) && payload.iat <= now + 30 && payload.iat > 0
        && payload.exp > payload.iat && payload.exp - payload.iat <= 3_600;
}

/** Google signs the identity; neither a caller-supplied email nor a website cookie authenticates this route. */
export function createAppleMaintenanceIdentityVerifier(config: AppleMaintenanceConfig,
    dependencies: Dependencies = {}): AppleMaintenanceIdentityVerifier {
    const timeoutMs = dependencies.timeoutMs ?? APPLE_MAINTENANCE_AUTH_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > APPLE_MAINTENANCE_AUTH_TIMEOUT_MS) {
        throw new Error('Invalid Apple maintenance verification deadline.');
    }
    return { async verify(token) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const controller = new AbortController();
        try {
            if (!readProviderJwsKeyId(token)) return false;
            const client = dependencies.createClient?.() ?? new OAuth2Client();
            // The library explicitly enables certificate-fetch retries. Override
            // those per-request defaults, not only its transporter's defaults.
            client.transporter.interceptors.request.add({ resolved: async options => ({ ...options,
                signal: controller.signal, timeout: timeoutMs, retry: false, retryConfig: { retry: 0 },
                maxContentLength: 65_536, size: 65_536, maxRedirects: 0, redirect: 'error' }) });
            const deadline = new Promise<false>(resolve => {
                timer = setTimeout(() => { controller.abort(); resolve(false); }, timeoutMs);
            });
            return await Promise.race([
                client.verifyIdToken({ idToken: token, audience: config.audience, maxExpiry: 3_630 })
                    .then(ticket => !controller.signal.aborted && permittedIdentity(ticket.getPayload(), config)),
                deadline,
            ]);
        } catch {
            // Google's errors may contain the raw JWT. Never expose or log them.
            return false;
        } finally {
            controller.abort();
            if (timer !== undefined) clearTimeout(timer);
        }
    } };
}
