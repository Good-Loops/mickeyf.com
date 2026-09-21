import { createPublicKey, KeyObject, timingSafeEqual } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { IdentityProvider, VerifiedProviderIdentity } from './providerIdentity';

export const PROVIDER_TOKEN_MAX_LENGTH = 16_384;
export const PROVIDER_TOKEN_MAX_AGE_SECONDS = 5 * 60;
export const PROVIDER_JWKS_TIMEOUT_MS = 5_000;

const MAX_JWKS_BYTES = 65_536;
const MAX_JWKS_KEYS = 16;
const MAX_CACHE_AGE_MS = 60 * 60 * 1_000;
const DEFAULT_CACHE_AGE_MS = 5 * 60 * 1_000;
const REFRESH_COOLDOWN_MS = 30_000;
const FUTURE_ISSUANCE_TOLERANCE_SECONDS = 30;
const PROVIDERS = {
    google: {
        issuers: ['https://accounts.google.com', 'accounts.google.com'],
        jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs',
    },
    apple: {
        issuers: ['https://appleid.apple.com'],
        jwksUrl: 'https://appleid.apple.com/auth/keys',
    },
} as const;

export type ProviderTokenVerifierConfiguration = Readonly<{
    googleAudience?: string;
    appleAudience?: string;
    /** Defaults to googleAudience; an explicit presenter supports one known native client. */
    googleAuthorizedParty?: string;
}>;

export type ProviderTokenVerificationResult =
    | { verified: true; identity: VerifiedProviderIdentity }
    | {
        verified: false;
        reason: 'INVALID_PROVIDER_TOKEN' | 'PROVIDER_UNAVAILABLE' | 'PROVIDER_NOT_CONFIGURED';
    };

export type ProviderTokenVerifier = {
    /**
     * expectedNonce must come from the server's pending authentication attempt,
     * never from the submitted token/request. The caller must bind that attempt
     * to the session and consume it once; token verification alone cannot prevent
     * replay. Pass the exact nonce sent to the provider (including any hashing
     * required by the native client), not an untransformed secret nonce.
     */
    verify(
        provider: IdentityProvider, token: unknown, expectedNonce: string
    ): Promise<ProviderTokenVerificationResult>;
};

type Dependencies = {
    fetch?: typeof globalThis.fetch;
    now?: () => number;
};

type KeyCache = {
    keys: Map<string, KeyObject>;
    expiresAtMs: number;
    nextRefreshAtMs: number;
    pending?: Promise<Map<string, KeyObject>>;
};

class ProviderKeysUnavailable extends Error {
    constructor() { super('Provider verification keys unavailable.'); }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIdentifier(value: unknown, maximumLength: number): value is string {
    return typeof value === 'string' && value.length > 0
        && value.length <= maximumLength && /^[\x21-\x7e]+$/u.test(value);
}

function isKeyId(value: unknown): value is string {
    return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/u.test(value);
}

function decodeSegment(segment: string): unknown {
    const bytes = Buffer.from(segment, 'base64url');
    if (bytes.toString('base64url') !== segment) throw new Error('Invalid token encoding.');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

function readTokenKeyId(token: unknown): string | undefined {
    if (typeof token !== 'string' || token.length > PROVIDER_TOKEN_MAX_LENGTH) return undefined;
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some(part => !/^[a-zA-Z0-9_-]+$/u.test(part))
        || parts[0].length > 1_024 || parts[2].length > 2_048) return undefined;
    const header = decodeSegment(parts[0]);
    if (!isRecord(header) || header.alg !== 'RS256' || !isKeyId(header.kid)
        || (header.typ !== undefined && header.typ !== 'JWT')
        || ['crit', 'b64', 'jku', 'jwk', 'x5u', 'x5c'].some(field => field in header)
        || !isRecord(decodeSegment(parts[1]))
        || Buffer.from(parts[2], 'base64url').toString('base64url') !== parts[2]) return undefined;
    // The header selects only among keys obtained from the fixed provider endpoint.
    // Neither these decoded claims nor this key ID establish an identity.
    return header.kid;
}

function parseProviderKeys(document: unknown): Map<string, KeyObject> {
    if (!isRecord(document) || !Array.isArray(document.keys)
        || document.keys.length === 0 || document.keys.length > MAX_JWKS_KEYS) {
        throw new ProviderKeysUnavailable();
    }
    const keys = new Map<string, KeyObject>();
    for (const jwk of document.keys) {
        if (!isRecord(jwk) || !isKeyId(jwk.kid) || keys.has(jwk.kid)
            || jwk.kty !== 'RSA' || jwk.alg !== 'RS256' || jwk.use !== 'sig'
            || typeof jwk.n !== 'string' || !/^[a-zA-Z0-9_-]{342,1366}$/u.test(jwk.n)
            || typeof jwk.e !== 'string' || !/^[a-zA-Z0-9_-]{1,8}$/u.test(jwk.e)
            || 'd' in jwk
            || (jwk.key_ops !== undefined && (!Array.isArray(jwk.key_ops)
                || jwk.key_ops.length !== 1 || jwk.key_ops[0] !== 'verify'))) {
            throw new ProviderKeysUnavailable();
        }
        const key = createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' });
        const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
        if (key.asymmetricKeyType !== 'rsa' || bits < 2_048 || bits > 8_192) {
            throw new ProviderKeysUnavailable();
        }
        keys.set(jwk.kid, key);
    }
    return keys;
}

function cacheAgeMs(headers: Headers): number {
    const control = headers.get('cache-control') ?? '';
    if (/(?:^|,)\s*(?:no-store|no-cache)(?:\s|=|,|$)/iu.test(control)) return 0;
    const match = /(?:^|,)\s*max-age\s*=\s*"?(\d+)"?\s*(?:,|$)/iu.exec(control);
    const ttl = match ? Math.min(Number(match[1]) * 1_000, MAX_CACHE_AGE_MS) : DEFAULT_CACHE_AGE_MS;
    const age = Number(headers.get('age') ?? '0');
    return Number.isFinite(age) && age >= 0 ? Math.max(0, ttl - age * 1_000) : 0;
}

async function readJwksResponse(response: Response): Promise<unknown> {
    const contentLength = Number(response.headers.get('content-length') ?? '0');
    if (!response.ok || response.redirected || !response.body
        || !Number.isFinite(contentLength) || contentLength < 0 || contentLength > MAX_JWKS_BYTES) {
        throw new ProviderKeysUnavailable();
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            length += value.byteLength;
            if (length > MAX_JWKS_BYTES) throw new ProviderKeysUnavailable();
            chunks.push(value);
        }
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    } finally {
        void reader.cancel().catch(() => undefined);
        reader.releaseLock();
    }
}

async function fetchProviderKeys(
    endpoint: string, fetcher: typeof globalThis.fetch
): Promise<{ keys: Map<string, KeyObject>; lifetimeMs: number }> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
            controller.abort();
            reject(new ProviderKeysUnavailable());
        }, PROVIDER_JWKS_TIMEOUT_MS);
    });
    try {
        return await Promise.race([
            (async () => {
                const response = await fetcher(endpoint, {
                    method: 'GET', redirect: 'error', signal: controller.signal,
                    headers: { accept: 'application/json' },
                });
                return {
                    keys: parseProviderKeys(await readJwksResponse(response)),
                    lifetimeMs: cacheAgeMs(response.headers),
                };
            })(),
            deadline,
        ]);
    } catch {
        controller.abort();
        throw new ProviderKeysUnavailable();
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

function createKeyResolver(fetcher: typeof globalThis.fetch, now: () => number) {
    const caches = new Map<IdentityProvider, KeyCache>();
    return async (provider: IdentityProvider, keyId: string): Promise<KeyObject | undefined> => {
        let cache = caches.get(provider);
        if (!cache) {
            cache = { keys: new Map(), expiresAtMs: 0, nextRefreshAtMs: 0 };
            caches.set(provider, cache);
        }
        const currentTime = now();
        const cachedKey = cache.keys.get(keyId);
        if (currentTime < cache.expiresAtMs && cachedKey) return cachedKey;
        if (cache.pending) return (await cache.pending).get(keyId);
        // Unknown kids cannot force an unbounded refetch. Rotation can take up to
        // 30 seconds to become visible; expired keys are never a fallback.
        if (currentTime < cache.nextRefreshAtMs) {
            if (currentTime < cache.expiresAtMs) return undefined;
            throw new ProviderKeysUnavailable();
        }
        cache.nextRefreshAtMs = currentTime + REFRESH_COOLDOWN_MS;
        const currentCache = cache;
        cache.pending = fetchProviderKeys(PROVIDERS[provider].jwksUrl, fetcher).then(result => {
            currentCache.keys = result.keys;
            currentCache.expiresAtMs = now() + result.lifetimeMs;
            return result.keys;
        });
        try {
            return (await cache.pending).get(keyId);
        } finally {
            cache.pending = undefined;
        }
    };
}

function validClaims(
    claims: unknown, provider: IdentityProvider, audience: string,
    authorizedParty: string | undefined, expectedNonce: string, nowSeconds: number
): claims is { sub: string } {
    if (!isRecord(claims) || claims.aud !== audience || !isIdentifier(claims.sub, 255)
        || !Number.isSafeInteger(claims.exp) || !Number.isSafeInteger(claims.iat)
        || (claims.iat as number) <= 0 || (claims.exp as number) <= nowSeconds
        || (claims.exp as number) <= (claims.iat as number)
        || (claims.iat as number) > nowSeconds + FUTURE_ISSUANCE_TOLERANCE_SECONDS
        || nowSeconds - (claims.iat as number) >= PROVIDER_TOKEN_MAX_AGE_SECONDS
        || (claims.nbf !== undefined && (!Number.isSafeInteger(claims.nbf)
            || (claims.nbf as number) > nowSeconds))
        || typeof claims.nonce !== 'string' || claims.nonce.length !== expectedNonce.length
        || !timingSafeEqual(Buffer.from(claims.nonce, 'utf8'), Buffer.from(expectedNonce, 'utf8'))) {
        return false;
    }
    // A single audience is mandatory. For Google hybrid flows the presenter is
    // configured separately; all other azp values (or a missing hybrid azp) fail.
    return provider !== 'google'
        || (claims.azp === undefined ? authorizedParty === audience : claims.azp === authorizedParty);
}

function verifiedProviderEmail(provider: IdentityProvider, claims: unknown): string | undefined {
    if (!isRecord(claims)
        || (claims.email_verified !== true && !(provider === 'apple' && claims.email_verified === 'true'))
        || typeof claims.email !== 'string') return undefined;
    const email = claims.email.trim().toLowerCase();
    if (provider === 'google') {
        const hostedDomain = claims.hd;
        const managedDomain = typeof hostedDomain === 'string' && hostedDomain.length <= 253
            && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/iu.test(hostedDomain);
        // External email ownership can change independently of a Google account.
        // Only Gmail or a signed managed-domain claim is authoritative for signup.
        if (!email.endsWith('@gmail.com') && !managedDomain) return undefined;
    }
    // Apple verifies both shared and private-relay email addresses. The signed
    // subject remains the account key; absent email must not block linked login.
    return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)
        && !/[\u0000-\u001f\u007f]/u.test(email) ? email : undefined;
}

export function createProviderTokenVerifier(
    configuration: ProviderTokenVerifierConfiguration,
    dependencies: Dependencies = {}
): ProviderTokenVerifier {
    for (const value of [configuration.googleAudience, configuration.appleAudience,
        configuration.googleAuthorizedParty]) {
        if (value !== undefined && !isIdentifier(value, 255)) {
            throw new TypeError('Invalid provider verification configuration.');
        }
    }
    if (configuration.googleAuthorizedParty && !configuration.googleAudience) {
        throw new TypeError('Invalid provider verification configuration.');
    }
    const audiences = { google: configuration.googleAudience, apple: configuration.appleAudience };
    const authorizedParty = configuration.googleAuthorizedParty ?? configuration.googleAudience;
    const now = dependencies.now ?? Date.now;
    const resolveKey = createKeyResolver(dependencies.fetch ?? globalThis.fetch, now);
    return {
        async verify(provider, token, expectedNonce) {
            if (provider !== 'google' && provider !== 'apple') {
                return { verified: false, reason: 'INVALID_PROVIDER_TOKEN' };
            }
            const audience = audiences[provider];
            if (!audience) return { verified: false, reason: 'PROVIDER_NOT_CONFIGURED' };
            try {
                if (typeof expectedNonce !== 'string' || !/^[a-zA-Z0-9_-]{32,256}$/u.test(expectedNonce)) {
                    return { verified: false, reason: 'INVALID_PROVIDER_TOKEN' };
                }
                const keyId = readTokenKeyId(token);
                if (!keyId) return { verified: false, reason: 'INVALID_PROVIDER_TOKEN' };
                const key = await resolveKey(provider, keyId);
                if (!key) return { verified: false, reason: 'INVALID_PROVIDER_TOKEN' };
                const nowMs = now();
                if (!Number.isSafeInteger(nowMs) || nowMs < 1_000) {
                    return { verified: false, reason: 'INVALID_PROVIDER_TOKEN' };
                }
                const nowSeconds = Math.floor(nowMs / 1_000);
                const claims: unknown = jwt.verify(token as string, key, {
                    algorithms: ['RS256'], issuer: [...PROVIDERS[provider].issuers],
                    audience, clockTimestamp: nowSeconds, maxAge: PROVIDER_TOKEN_MAX_AGE_SECONDS,
                });
                if (!validClaims(claims, provider, audience, authorizedParty, expectedNonce, nowSeconds)) {
                    return { verified: false, reason: 'INVALID_PROVIDER_TOKEN' };
                }
                const email = verifiedProviderEmail(provider, claims);
                return {
                    verified: true,
                    identity: Object.freeze({ provider, subject: claims.sub,
                        ...(email === undefined ? {} : { email }) }) as VerifiedProviderIdentity,
                };
            } catch (error) {
                return { verified: false, reason: error instanceof ProviderKeysUnavailable
                    ? 'PROVIDER_UNAVAILABLE' : 'INVALID_PROVIDER_TOKEN' };
            }
        },
    };
}
