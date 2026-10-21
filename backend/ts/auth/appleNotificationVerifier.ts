import jwt from 'jsonwebtoken';
import {
    createProviderKeyResolver, ProviderKeysUnavailable,
    PROVIDER_TOKEN_MAX_LENGTH, readProviderJwsKeyId,
} from './providerTokenVerifier';

export const APPLE_NOTIFICATION_MAX_LENGTH = PROVIDER_TOKEN_MAX_LENGTH;
const APPLE_ISSUER = 'https://appleid.apple.com';
const CLOCK_TOLERANCE_SECONDS = 30;
const MILLISECOND_EPOCH_THRESHOLD = 1_000_000_000_000;
const EVENT_TYPES = ['consent-revoked', 'account-deleted', 'email-enabled', 'email-disabled'] as const;

export type AppleNotificationEventType = typeof EVENT_TYPES[number];
declare const verifiedAppleNotification: unique symbol;

/** Only signature-verified, audience-bound events may reach the mutation boundary. */
export type VerifiedAppleNotification = Readonly<{
    audience: string;
    subject: string;
    eventType: AppleNotificationEventType;
    issuedAt: number;
    /** Authentication must be strictly newer; same-second Apple logins are invalidated. */
    eventTime: number;
    [verifiedAppleNotification]: true;
}>;

export type AppleNotificationVerificationResult =
    | { verified: true; notification: VerifiedAppleNotification }
    | { verified: false; reason: 'INVALID_APPLE_NOTIFICATION' | 'APPLE_KEYS_UNAVAILABLE' | 'APPLE_NOT_CONFIGURED' };

export type AppleNotificationVerifier = {
    verify(token: unknown): Promise<AppleNotificationVerificationResult>;
};

type Configuration = Readonly<{ audiences: readonly string[] }>;
type Dependencies = { fetch?: typeof globalThis.fetch; now?: () => number };

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIdentifier(value: unknown): value is string {
    return typeof value === 'string' && /^[\x21-\x7e]{1,255}$/u.test(value);
}

function isPositiveInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function readEvent(value: unknown): Record<string, unknown> | undefined {
    // Apple documents an object; historical deliveries also contain serialized JSON.
    if (typeof value === 'string' && value.length > 4_096) return undefined;
    const event: unknown = typeof value === 'string' ? JSON.parse(value) : value;
    return isRecord(event) ? event : undefined;
}

function normalizedEventTime(value: unknown): number | undefined {
    if (!isPositiveInteger(value)) return undefined;
    // Retain subsecond precision while applying the future-time bounds below.
    const milliseconds = value >= MILLISECOND_EPOCH_THRESHOLD ? value : value * 1_000;
    return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
}

function verifiedClaims(
    claims: unknown, audiences: ReadonlySet<string>, nowMs: number
): VerifiedAppleNotification | undefined {
    if (!isRecord(claims) || claims.iss !== APPLE_ISSUER || typeof claims.aud !== 'string'
        || !audiences.has(claims.aud) || !isIdentifier(claims.jti) || !isPositiveInteger(claims.iat)) {
        return undefined;
    }
    const nowSeconds = Math.floor(nowMs / 1_000);
    if (claims.iat > nowSeconds + CLOCK_TOLERANCE_SECONDS
        || (claims.exp !== undefined && (!isPositiveInteger(claims.exp)
            || claims.exp <= nowSeconds || claims.exp <= claims.iat))
        || (claims.nbf !== undefined && (!isPositiveInteger(claims.nbf) || claims.nbf > nowSeconds))) {
        return undefined;
    }
    const event = readEvent(claims.events);
    if (!event || !isIdentifier(event.sub) || typeof event.type !== 'string'
        || !(EVENT_TYPES as readonly string[]).includes(event.type)) return undefined;
    const eventTimeMs = normalizedEventTime(event.event_time);
    if (eventTimeMs === undefined || eventTimeMs > nowMs + CLOCK_TOLERANCE_SECONDS * 1_000
        || eventTimeMs > (claims.iat + CLOCK_TOLERANCE_SECONDS) * 1_000) return undefined;
    return Object.freeze({
        audience: claims.aud, subject: event.sub, eventType: event.type,
        issuedAt: claims.iat, eventTime: Math.floor(eventTimeMs / 1_000),
    }) as VerifiedAppleNotification;
}

export function createAppleNotificationVerifier(
    configuration: Configuration, dependencies: Dependencies = {}
): AppleNotificationVerifier {
    if (!Array.isArray(configuration.audiences) || configuration.audiences.length > 8
        || configuration.audiences.some(value => !isIdentifier(value))
        || new Set(configuration.audiences).size !== configuration.audiences.length) {
        throw new TypeError('Invalid Apple notification configuration.');
    }
    const audiences = new Set<string>(configuration.audiences);
    const now = dependencies.now ?? Date.now;
    const resolveKey = createProviderKeyResolver(dependencies.fetch ?? globalThis.fetch, now);
    return {
        async verify(token) {
            if (audiences.size === 0) return { verified: false, reason: 'APPLE_NOT_CONFIGURED' };
            try {
                const keyId = readProviderJwsKeyId(token);
                if (!keyId) return { verified: false, reason: 'INVALID_APPLE_NOTIFICATION' };
                const key = await resolveKey('apple', keyId);
                if (!key) return { verified: false, reason: 'INVALID_APPLE_NOTIFICATION' };
                const nowMs = now();
                if (!Number.isSafeInteger(nowMs) || nowMs < 1_000) {
                    return { verified: false, reason: 'INVALID_APPLE_NOTIFICATION' };
                }
                // Notifications can be delayed and need not have exp or nonce. Durable event
                // ordering belongs to the consumer, not the five-minute ID-token login policy.
                const claims: unknown = jwt.verify(token as string, key, {
                    algorithms: ['RS256'], issuer: APPLE_ISSUER,
                    audience: [...audiences] as [string, ...string[]],
                    clockTimestamp: Math.floor(nowMs / 1_000),
                });
                const notification = verifiedClaims(claims, audiences, nowMs);
                return notification ? { verified: true, notification }
                    : { verified: false, reason: 'INVALID_APPLE_NOTIFICATION' };
            } catch (error) {
                return { verified: false, reason: error instanceof ProviderKeysUnavailable
                    ? 'APPLE_KEYS_UNAVAILABLE' : 'INVALID_APPLE_NOTIFICATION' };
            }
        },
    };
}
