import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import type { AppleTokenEncryptionSettings } from '../accounts/appleTokenRepository';
import type { ProviderAttemptAction } from './providerAttemptRepository';

export const APPLE_ANDROID_HANDOFF_LIFETIME_MS = 300_000;
export const APPLE_ANDROID_HANDOFF_MAX_BYTES = 24_576;
export type AppleAndroidHandoffBinding = Readonly<{
    stateHash: Buffer; bindingHash: Buffer; nonce: string; clientKey: 'apple-android';
    action: ProviderAttemptAction; accountId: string | null; userId: number | null; expiresAt: number;
}>;
export type AppleAndroidHandoffCredential = Readonly<{ idToken: string; authorizationCode: string }>;
const KEY_ID = /^[A-Za-z0-9_-]{1,64}(?![\s\S])/u;
const RANDOM = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048](?![\s\S])/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?![\s\S])/u;
const PURPOSE = 'ludolume:apple-android-handoff:v1';

/** No driver/provider payload or chained error is exposed. */
export class AppleAndroidHandoffError extends Error {
    constructor() { super('Apple Android handoff could not be confirmed.'); this.name = 'AppleAndroidHandoffError'; }
}

export function copyAppleAndroidHandoffBinding(value: AppleAndroidHandoffBinding): AppleAndroidHandoffBinding {
    if (!value || !Buffer.isBuffer(value.stateHash) || value.stateHash.length !== 32
        || !Buffer.isBuffer(value.bindingHash) || value.bindingHash.length !== 32
        || typeof value.nonce !== 'string' || !RANDOM.test(value.nonce) || value.clientKey !== 'apple-android'
        || !['login', 'signup', 'link', 'delete'].includes(value.action)
        || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= 0
        || (value.action === 'login' || value.action === 'signup'
            ? value.accountId !== null || value.userId !== null
            : typeof value.accountId !== 'string' || !UUID.test(value.accountId)
                || !Number.isSafeInteger(value.userId) || Number(value.userId) <= 0 || Number(value.userId) > 2_147_483_647)) {
        throw new AppleAndroidHandoffError();
    }
    return Object.freeze({ ...value, stateHash: Buffer.from(value.stateHash), bindingHash: Buffer.from(value.bindingHash) });
}

function credential(value: AppleAndroidHandoffCredential): AppleAndroidHandoffCredential {
    if (!value || typeof value !== 'object' || Object.keys(value).sort().join(',') !== 'authorizationCode,idToken'
        || typeof value.idToken !== 'string' || value.idToken.length > 16_384
        || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?![\s\S])/u.test(value.idToken)
        || typeof value.authorizationCode !== 'string' || value.authorizationCode.length > 4096
        || !/^[\x21-\x7e]+(?![\s\S])/u.test(value.authorizationCode)) throw new AppleAndroidHandoffError();
    return Object.freeze({ idToken: value.idToken, authorizationCode: value.authorizationCode });
}

/** Reuses the Apple key ring through HKDF; refresh-token ciphertext is a different purpose/key. */
export function createAppleAndroidHandoffCrypto(settings: AppleTokenEncryptionSettings, now = Date.now) {
    if (!settings || typeof settings.clientId !== 'string'
        || !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+(?![\s\S])/u.test(settings.clientId) || settings.clientId.length > 255
        || typeof settings.activeKeyId !== 'string' || !KEY_ID.test(settings.activeKeyId)
        || !settings.encryptionKeys || typeof settings.encryptionKeys !== 'object' || Array.isArray(settings.encryptionKeys)
        || Object.keys(settings.encryptionKeys).length < 1 || Object.keys(settings.encryptionKeys).length > 8
        || Object.entries(settings.encryptionKeys).some(([id, key]) => !KEY_ID.test(id) || !Buffer.isBuffer(key) || key.length !== 32)
        || !Object.prototype.hasOwnProperty.call(settings.encryptionKeys, settings.activeKeyId) || typeof now !== 'function') {
        throw new AppleAndroidHandoffError();
    }
    const { clientId, activeKeyId } = settings;
    const keys = new Map(Object.entries(settings.encryptionKeys).map(([id, key]) =>
        [id, Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), Buffer.from(PURPOSE), 32))]));
    function binding(value: AppleAndroidHandoffBinding) {
        const copy = copyAppleAndroidHandoffBinding(value);
        const time = now();
        if (!Number.isSafeInteger(time) || time <= 0 || copy.expiresAt <= time
            || copy.expiresAt - time > APPLE_ANDROID_HANDOFF_LIFETIME_MS) throw new AppleAndroidHandoffError();
        return copy;
    }
    function aad(value: AppleAndroidHandoffBinding, keyId: string) {
        return Buffer.from(JSON.stringify([PURPOSE, clientId, keyId, value.stateHash.toString('hex'),
            value.bindingHash.toString('hex'), value.nonce, value.clientKey, value.action,
            value.accountId, value.userId, value.expiresAt]));
    }
    return Object.freeze({
        encrypt(value: AppleAndroidHandoffBinding, input: AppleAndroidHandoffCredential): Buffer {
            try {
                const context = binding(value);
                const plain = credential(input);
                const iv = randomBytes(12);
                const cipher = createCipheriv('aes-256-gcm', keys.get(activeKeyId)!, iv);
                cipher.setAAD(aad(context, activeKeyId));
                const data = Buffer.concat([cipher.update(JSON.stringify(plain), 'utf8'), cipher.final()]);
                const id = Buffer.from(activeKeyId, 'ascii');
                return Buffer.concat([Buffer.from([1, id.length]), id, iv, cipher.getAuthTag(), data]);
            } catch { throw new AppleAndroidHandoffError(); }
        },
        decrypt(value: AppleAndroidHandoffBinding, envelope: Buffer): AppleAndroidHandoffCredential {
            try {
                const context = binding(value);
                if (!Buffer.isBuffer(envelope) || envelope.length > APPLE_ANDROID_HANDOFF_MAX_BYTES
                    || envelope[0] !== 1 || envelope[1] < 1 || envelope[1] > 64
                    || envelope.length <= 30 + envelope[1]) throw new AppleAndroidHandoffError();
                const offset = 2 + envelope[1];
                const keyId = envelope.subarray(2, offset).toString('utf8');
                const key = keys.get(keyId);
                if (!KEY_ID.test(keyId) || !key) throw new AppleAndroidHandoffError();
                const decipher = createDecipheriv('aes-256-gcm', key, envelope.subarray(offset, offset + 12));
                decipher.setAAD(aad(context, keyId));
                decipher.setAuthTag(envelope.subarray(offset + 12, offset + 28));
                const plain = Buffer.concat([decipher.update(envelope.subarray(offset + 28)), decipher.final()]);
                try { return credential(JSON.parse(plain.toString('utf8'))); }
                finally { plain.fill(0); }
            } catch { throw new AppleAndroidHandoffError(); }
        },
    });
}
