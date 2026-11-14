import { isIP } from 'node:net';

type Environment = Readonly<Record<string, string | undefined>>;
export type AppleWebConfiguration = Readonly<{ clientId: string; redirectUri: string }>;

export function validAppleRedirectUri(value: unknown): value is string {
    if (typeof value !== 'string' || value.length > 2048) return false;
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && url.hostname.includes('.') && !isIP(url.hostname)
            && !url.hostname.endsWith('.localhost') && !url.username && !url.password && !url.port
            && !url.search && !url.hash && url.href === value;
    } catch { return false; }
}

/** Keep these identifiers when issuance is paused so stored web tokens can still be revoked. */
export function loadAppleWebConfig(env: Environment): AppleWebConfiguration | undefined {
    if (env.APPLE_WEB_CLIENT_ID !== undefined) throw new Error('Use the explicit Apple web Services ID configuration.');
    const clientId = env.APPLE_WEB_SERVICES_ID;
    const redirectUri = env.APPLE_WEB_REDIRECT_URI;
    if (clientId === undefined && redirectUri === undefined && env.APPLE_WEB_AUTH_ENABLED !== 'true') return undefined;
    if (!clientId || clientId.length > 255 || !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/u.test(clientId)
        || clientId === env.APPLE_IOS_BUNDLE_ID || !validAppleRedirectUri(redirectUri)) {
        throw new Error('Apple web requires a distinct Services ID and one exact HTTPS domain return URL.');
    }
    return Object.freeze({ clientId, redirectUri });
}
