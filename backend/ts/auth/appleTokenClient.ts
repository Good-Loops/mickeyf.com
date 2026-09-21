import { createPrivateKey, type KeyObject } from 'node:crypto';
import jwt from 'jsonwebtoken';

export const APPLE_TOKEN_REQUEST_TIMEOUT_MS = 5_000;
export const APPLE_OPAQUE_TOKEN_MAX_LENGTH = 4_096;
const ID_TOKEN_MAX_LENGTH = 16_384;
const RESPONSE_MAX_BYTES = 65_536;
const CLIENT_SECRET_LIFETIME_SECONDS = 300;
const APPLE_AUDIENCE = 'https://appleid.apple.com';
const ENDPOINTS = {
    exchange: 'https://appleid.apple.com/auth/token',
    revoke: 'https://appleid.apple.com/auth/revoke',
} as const;

export type AppleTokenClientConfiguration = Readonly<{
    clientId: string;
    teamId: string;
    keyId: string;
    privateKey: string;
}>;

export type AppleTokenClient = Readonly<{
    /** The caller must verify the returned ID token and bind it to its nonce and intended subject. */
    exchangeCode(authorizationCode: string): Promise<Readonly<{ idToken: string; refreshToken: string }>>;
    revoke(refreshToken: string): Promise<void>;
}>;

type Dependencies = { fetchRequest?: typeof globalThis.fetch; now?: () => number };
type ClientCredentials = Readonly<{ clientId: string; teamId: string; keyId: string; privateKey: KeyObject }>;
type FailureCode = 'INVALID_CONFIGURATION' | 'INVALID_REQUEST' | 'INVALID_GRANT' | 'UNAVAILABLE';

/** Deliberately carries no provider payload, credential, upstream error or cause. */
export class AppleTokenClientError extends Error {
    constructor(readonly code: FailureCode) {
        super('Apple authorization could not be completed.');
        this.name = 'AppleTokenClientError';
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isOpaqueToken(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= APPLE_OPAQUE_TOKEN_MAX_LENGTH
        && !/[^\x21-\x7e]/u.test(value);
}

function readCredentials(configuration: AppleTokenClientConfiguration): ClientCredentials {
    try {
        const { clientId, teamId, keyId, privateKey } = configuration;
        if (typeof clientId !== 'string' || clientId.length > 255 || clientId !== clientId.trim()
            || !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/u.test(clientId)
            || typeof teamId !== 'string' || teamId !== teamId.trim() || !/^[A-Z0-9]{10}$/u.test(teamId)
            || typeof keyId !== 'string' || keyId !== keyId.trim() || !/^[A-Z0-9]{10}$/u.test(keyId)
            || clientId.startsWith(`${teamId}.`)
            || typeof privateKey !== 'string' || privateKey.length === 0 || privateKey.length > 16_384) {
            throw new AppleTokenClientError('INVALID_CONFIGURATION');
        }
        const key = createPrivateKey(privateKey);
        if (key.type !== 'private' || key.asymmetricKeyType !== 'ec'
            || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
            throw new AppleTokenClientError('INVALID_CONFIGURATION');
        }
        return Object.freeze({ clientId, teamId, keyId, privateKey: key });
    } catch { throw new AppleTokenClientError('INVALID_CONFIGURATION'); }
}

function createClientSecret(credentials: ClientCredentials, now: () => number): string {
    const milliseconds = now();
    if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) throw new AppleTokenClientError('UNAVAILABLE');
    const issuedAt = Math.floor(milliseconds / 1_000);
    return jwt.sign({ iss: credentials.teamId, sub: credentials.clientId, aud: APPLE_AUDIENCE,
        iat: issuedAt, exp: issuedAt + CLIENT_SECRET_LIFETIME_SECONDS }, credentials.privateKey,
    { algorithm: 'ES256', keyid: credentials.keyId });
}

async function readBoundedBody(response: Response, signal: AbortSignal): Promise<string> {
    const declaredLength = response.headers.get('content-length');
    if (response.redirected || (declaredLength !== null
        && (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > RESPONSE_MAX_BYTES))) {
        throw new AppleTokenClientError('UNAVAILABLE');
    }
    if (!response.body) return '';
    const reader = response.body.getReader();
    const cancel = () => { void reader.cancel().catch(() => undefined); };
    signal.addEventListener('abort', cancel, { once: true });
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
        for (;;) {
            if (signal.aborted) throw new AppleTokenClientError('UNAVAILABLE');
            const { value, done } = await reader.read();
            if (signal.aborted) throw new AppleTokenClientError('UNAVAILABLE');
            if (done) break;
            length += value.byteLength;
            if (length > RESPONSE_MAX_BYTES) throw new AppleTokenClientError('UNAVAILABLE');
            chunks.push(value);
        }
        return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    } finally {
        signal.removeEventListener('abort', cancel);
        cancel();
        reader.releaseLock();
    }
}

function readResponseDocument(body: string): Record<string, unknown> {
    const value: unknown = JSON.parse(body);
    if (!isRecord(value)) throw new AppleTokenClientError('UNAVAILABLE');
    return value;
}

/** Native Apple authorization only: no redirect URI was used, and none is inferred here. */
export function createAppleTokenClient(configuration: AppleTokenClientConfiguration,
    { fetchRequest = globalThis.fetch, now = Date.now }: Dependencies = {}): AppleTokenClient {
    const credentials = readCredentials(configuration);
    if (typeof fetchRequest !== 'function' || typeof now !== 'function') {
        throw new AppleTokenClientError('INVALID_CONFIGURATION');
    }

    async function request(operation: keyof typeof ENDPOINTS, token: string): Promise<Record<string, unknown> | null> {
        if (!isOpaqueToken(token)) throw new AppleTokenClientError('INVALID_REQUEST');
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
                reject(new AppleTokenClientError('UNAVAILABLE'));
                controller.abort();
            }, APPLE_TOKEN_REQUEST_TIMEOUT_MS);
        });
        try {
            return await Promise.race([deadline, (async () => {
                const form = new URLSearchParams({ client_id: credentials.clientId,
                    client_secret: createClientSecret(credentials, now),
                    ...(operation === 'exchange' ? { code: token, grant_type: 'authorization_code' }
                        : { token, token_type_hint: 'refresh_token' }),
                });
                const response = await fetchRequest(ENDPOINTS[operation], {
                    method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store', signal: controller.signal,
                    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
                    body: form.toString(),
                });
                const body = await readBoundedBody(response, controller.signal);
                if (body.trim().length > 0
                    && response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
                    throw new AppleTokenClientError('UNAVAILABLE');
                }
                if (response.status === 400 && readResponseDocument(body).error === 'invalid_grant') {
                    throw new AppleTokenClientError('INVALID_GRANT');
                }
                if (response.status !== 200) throw new AppleTokenClientError('UNAVAILABLE');
                if (operation === 'revoke' && body.trim().length === 0) return null;
                const document = readResponseDocument(body);
                if ('error' in document) throw new AppleTokenClientError('UNAVAILABLE');
                return document;
            })()]);
        } catch (error) {
            controller.abort();
            throw new AppleTokenClientError(error instanceof AppleTokenClientError && error.code === 'INVALID_GRANT'
                ? 'INVALID_GRANT' : 'UNAVAILABLE');
        } finally {
            if (timer !== undefined) clearTimeout(timer);
        }
    }

    return Object.freeze({
        async exchangeCode(authorizationCode: string) {
            const document = await request('exchange', authorizationCode);
            if (!document || typeof document.id_token !== 'string' || document.id_token.length > ID_TOKEN_MAX_LENGTH
                || document.id_token !== document.id_token.trim()
                || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(document.id_token)
                || !isOpaqueToken(document.refresh_token)) throw new AppleTokenClientError('UNAVAILABLE');
            // Access tokens and other provider metadata are not part of this client's contract.
            return Object.freeze({ idToken: document.id_token, refreshToken: document.refresh_token });
        },
        async revoke(refreshToken: string) { await request('revoke', refreshToken); },
    });
}
