import { createAppleTokenRepository } from '../accounts/appleTokenRepository';
import { createAppleTokenClient } from '../auth/appleTokenClient';

type Environment = Readonly<Record<string, string | undefined>>;
export type AppleTokenLifecycle = Readonly<{
    clientId: string;
    client: ReturnType<typeof createAppleTokenClient>;
    repository: ReturnType<typeof createAppleTokenRepository>;
}>;

/** Separate credentials from session signing and App Store Connect; no I/O on construction. */
export function loadAppleTokenConfig(env: Environment = process.env): AppleTokenLifecycle | undefined {
    if (env.APPLE_TOKEN_LIFECYCLE_ENABLED !== 'true') return undefined;
    try {
        const clientId = env.APPLE_IOS_BUNDLE_ID ?? '';
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
        const repository = createAppleTokenRepository({ clientId,
            activeKeyId: env.APPLE_TOKEN_ACTIVE_KEY_ID ?? '', encryptionKeys: keys });
        const client = createAppleTokenClient({ clientId, teamId: env.APPLE_SIGN_IN_TEAM_ID ?? '',
            keyId: env.APPLE_SIGN_IN_KEY_ID ?? '', privateKey: env.APPLE_SIGN_IN_PRIVATE_KEY ?? '' });
        return Object.freeze({ clientId, client, repository });
    } catch {
        // JSON/crypto errors may contain secret fragments. Never expose their message or cause.
        throw new Error('Apple token lifecycle requires valid dedicated signing and encryption credentials.');
    }
}
