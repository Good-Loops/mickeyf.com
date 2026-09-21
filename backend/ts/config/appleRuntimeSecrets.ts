import { performance } from 'node:perf_hooks';
import { loadAppleTokenConfig, type AppleTokenLifecycle } from './appleTokenConfig';

type Environment = Readonly<Record<string, string | undefined>>;
type Dependencies = { fetch?: typeof globalThis.fetch; timeoutMs?: number };
const TIMEOUT_MS = 10_000;
const RESPONSE_MAX_BYTES = 32_768;
const SECRET_MAX_BYTES = 16_384;
const METADATA_TOKEN_URL = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
const PROJECT_ID = 'noted-reef-387021';
const PROJECT_NUMBER = '1012884798546';
const FAILURE = 'Apple runtime credentials could not be loaded.';

function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
}

function secretVersion(value: string | undefined): string {
    if (!value || value.length > 400
        || !/^projects\/(noted-reef-387021|1012884798546)\/secrets\/[A-Za-z0-9_-]{1,255}\/versions\/[1-9][0-9]{0,18}(?![\s\S])/u.test(value)) {
        throw new Error();
    }
    return value;
}

function normalizeProject(version: string): string {
    return version.replace(`projects/${PROJECT_ID}/`, `projects/${PROJECT_NUMBER}/`);
}

/** Secret Manager supplies Castagnoli CRC32C, not the ZIP/Ethernet CRC32 polynomial. */
function crc32c(bytes: Uint8Array): number {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0x82f63b78 : 0);
    }
    return (~crc) >>> 0;
}

async function readDocument(response: Response, signal: AbortSignal, assertActive: () => void): Promise<Record<string, unknown>> {
    assertActive();
    const declared = response.headers.get('content-length');
    if (response.status !== 200 || response.redirected
        || response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json'
        || (declared !== null && (!/^[0-9]+$/u.test(declared) || Number(declared) > RESPONSE_MAX_BYTES))
        || !response.body) throw new Error();
    const reader = response.body.getReader();
    const cancel = () => { void reader.cancel().catch(() => undefined); };
    signal.addEventListener('abort', cancel, { once: true });
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
        for (;;) {
            assertActive();
            const { done, value } = await reader.read();
            assertActive();
            if (done) break;
            length += value.byteLength;
            if (length > RESPONSE_MAX_BYTES) throw new Error();
            chunks.push(value);
        }
        return record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))));
    } finally {
        signal.removeEventListener('abort', cancel);
        cancel();
        reader.releaseLock();
    }
}

function decodeSecret(document: Record<string, unknown>, version: string): string {
    if (typeof document.name !== 'string' || normalizeProject(document.name) !== normalizeProject(version)) throw new Error();
    const payload = record(document.payload);
    if (typeof payload.data !== 'string' || payload.data.length === 0 || payload.data.length > Math.ceil(SECRET_MAX_BYTES / 3) * 4
        || /[^A-Za-z0-9+/=]/u.test(payload.data) || typeof payload.dataCrc32c !== 'string'
        || !/^(0|[1-9][0-9]{0,9})(?![\s\S])/u.test(payload.dataCrc32c)) throw new Error();
    const bytes = Buffer.from(payload.data, 'base64');
    if (bytes.length > SECRET_MAX_BYTES || bytes.toString('base64') !== payload.data
        || Number(payload.dataCrc32c) !== crc32c(bytes)) throw new Error();
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/** Runtime-only fetch: unavailable Apple secrets cannot prevent the HTTP service or SQL purge from starting. */
export async function loadAppleRuntimeLifecycle(env: Environment = process.env,
    { fetch: fetchRequest = globalThis.fetch, timeoutMs = TIMEOUT_MS }: Dependencies = {}): Promise<AppleTokenLifecycle> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = performance.now() + timeoutMs;
    const assertActive = () => {
        if (controller.signal.aborted || performance.now() >= deadline) throw new Error();
    };
    try {
        if (env.APPLE_TOKEN_RUNTIME_SECRETS_ENABLED !== 'true' || env.APPLE_TOKEN_LIFECYCLE_ENABLED !== 'true'
            || env.NODE_ENV !== 'production' || env.K_SERVICE !== 'mickeyf-org'
            || (env.LUDOLUME_ISOLATED_RUNTIME !== undefined && env.LUDOLUME_ISOLATED_RUNTIME !== 'false')
            || env.APPLE_SIGN_IN_PRIVATE_KEY !== undefined || env.APPLE_TOKEN_ENCRYPTION_KEYS !== undefined
            || typeof fetchRequest !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > TIMEOUT_MS) {
            throw new Error();
        }
        const signingVersion = secretVersion(env.APPLE_SIGN_IN_PRIVATE_KEY_SECRET_VERSION);
        const encryptionVersion = secretVersion(env.APPLE_TOKEN_ENCRYPTION_KEYS_SECRET_VERSION);
        if (normalizeProject(signingVersion) === normalizeProject(encryptionVersion)) throw new Error();
        const work = async () => {
            assertActive();
            const response = await fetchRequest(METADATA_TOKEN_URL, {
                method: 'GET', headers: { 'Metadata-Flavor': 'Google', accept: 'application/json' },
                redirect: 'error', credentials: 'omit', cache: 'no-store', signal: controller.signal,
            });
            assertActive();
            if (response.headers.get('metadata-flavor') !== 'Google') throw new Error();
            const metadata = await readDocument(response, controller.signal, assertActive);
            if (metadata.token_type !== 'Bearer' || typeof metadata.access_token !== 'string'
                || !/^[\x21-\x7e]{1,8192}(?![\s\S])/u.test(metadata.access_token)
                || !Number.isSafeInteger(metadata.expires_in) || Number(metadata.expires_in) < 1) throw new Error();
            const readSecret = async (version: string) => {
                assertActive();
                const secretResponse = await fetchRequest(`https://secretmanager.googleapis.com/v1/${version}:access`, {
                    method: 'GET', headers: { authorization: `Bearer ${metadata.access_token}`, accept: 'application/json' },
                    redirect: 'error', credentials: 'omit', cache: 'no-store', signal: controller.signal,
                });
                return decodeSecret(await readDocument(secretResponse, controller.signal, assertActive), version);
            };
            const [privateKey, encryptionKeys] = await Promise.all([readSecret(signingVersion), readSecret(encryptionVersion)]);
            assertActive();
            const lifecycle = loadAppleTokenConfig({ ...env, APPLE_SIGN_IN_PRIVATE_KEY: privateKey,
                APPLE_TOKEN_ENCRYPTION_KEYS: encryptionKeys });
            if (!lifecycle) throw new Error();
            assertActive();
            return lifecycle;
        };
        return await Promise.race([new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => { controller.abort(); reject(new Error()); }, timeoutMs);
        }), work()]);
    } catch {
        controller.abort();
        throw new Error(FAILURE);
    } finally {
        if (timer) clearTimeout(timer);
    }
}
