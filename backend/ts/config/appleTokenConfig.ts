import { createAppleTokenRepository } from '../accounts/appleTokenRepository';
import { createAppleTokenClient } from '../auth/appleTokenClient';
import { loadAppleWebConfig } from './appleWebConfig';

type Environment = Readonly<Record<string, string | undefined>>;
export type AppleClientLifecycle = Readonly<{
    clientId: string;
    client: ReturnType<typeof createAppleTokenClient>;
    repository: ReturnType<typeof createAppleTokenRepository>;
}>;
export type AppleTokenLifecycle = AppleClientLifecycle & Readonly<{ web?: AppleClientLifecycle & { redirectUri: string } }>;

/** Separate credentials from session signing and App Store Connect; no I/O on construction. */
export function loadAppleTokenConfig(env: Environment = process.env): AppleTokenLifecycle | undefined {
    if (env.APPLE_TOKEN_LIFECYCLE_ENABLED !== 'true') return undefined;
    try {
        const clientId = env.APPLE_IOS_BUNDLE_ID ?? '';
        const web = loadAppleWebConfig(env);
        const encodedKeys: unknown = JSON.parse(env.APPLE_TOKEN_ENCRYPTION_KEYS ?? '');
        if (!encodedKeys || typeof encodedKeys !== 'object' || Array.isArray(encodedKeys)) throw new Error();
        const keys: Record<string, Buffer> = Object.create(null);
        const entries = Object.entries(encodedKeys);
        if (entries.length === 0 || entries.length > 8) throw new Error();
        for (const [id, value] of entries) {
            if (typeof value !== 'string' || value.length !== 44 || /[^A-Za-z0-9+/=]/u.test(value)) throw new Error();
            const key = Buffer.from(value, 'base64');
            if (key.length !== 32 || key.toString('base64') !== value) throw new Error();
            keys[id] = key;
        }
        const createLifecycle = (audience: string, redirectUri?: string): AppleClientLifecycle => Object.freeze({
            clientId: audience,
            repository: createAppleTokenRepository({ clientId: audience,
                activeKeyId: env.APPLE_TOKEN_ACTIVE_KEY_ID ?? '', encryptionKeys: keys }),
            client: createAppleTokenClient({ clientId: audience, teamId: env.APPLE_SIGN_IN_TEAM_ID ?? '',
                keyId: env.APPLE_SIGN_IN_KEY_ID ?? '', privateKey: env.APPLE_SIGN_IN_PRIVATE_KEY ?? '', redirectUri }),
        });
        return Object.freeze({ ...createLifecycle(clientId),
            ...(web ? { web: Object.freeze({ ...createLifecycle(web.clientId, web.redirectUri), redirectUri: web.redirectUri }) } : {}) });
    } catch {
        // JSON/crypto errors may contain secret fragments. Never expose their message or cause.
        throw new Error('Apple token lifecycle requires valid dedicated signing and encryption credentials.');
    }
}
