import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { loadAppleRuntimeLifecycle } from './appleRuntimeSecrets';

const privateKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey
    .export({ format: 'pem', type: 'pkcs8' }).toString();
const keyring = JSON.stringify({ v1: Buffer.alloc(32, 9).toString('base64') });
const environment = {
    NODE_ENV: 'production', K_SERVICE: 'mickeyf-org', APPLE_TOKEN_RUNTIME_SECRETS_ENABLED: 'true',
    APPLE_TOKEN_LIFECYCLE_ENABLED: 'true', APPLE_IOS_BUNDLE_ID: 'com.example.test',
    APPLE_SIGN_IN_TEAM_ID: 'ABCDEFGHIJ', APPLE_SIGN_IN_KEY_ID: '0123456789', APPLE_TOKEN_ACTIVE_KEY_ID: 'v1',
    APPLE_SIGN_IN_PRIVATE_KEY_SECRET_VERSION: 'projects/noted-reef-387021/secrets/apple-signing/versions/3',
    APPLE_TOKEN_ENCRYPTION_KEYS_SECRET_VERSION: 'projects/noted-reef-387021/secrets/apple-encryption/versions/2',
};
const failure = { message: 'Apple runtime credentials could not be loaded.' };

const crcTable = Array.from({ length: 256 }, (_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ 0x82f63b78 : value >>> 1;
    return value;
});
function checksum(value: string | Buffer): string {
    let crc = 0xffffffff;
    for (const byte of Buffer.from(value)) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return String((crc ^ 0xffffffff) >>> 0);
}

function json(value: unknown, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json', ...headers } });
}
function secretDocument(version: string, value: string | Buffer) {
    return { name: version.replace('noted-reef-387021', '1012884798546'),
        payload: { data: Buffer.from(value).toString('base64'), dataCrc32c: checksum(value) } };
}
type Intercept = (url: string, options?: RequestInit) => Promise<Response> | Response | undefined;
function fixture(intercept?: Intercept) {
    const calls: Array<{ url: string; options?: RequestInit }> = [];
    const fetchRequest = (async (input: string | URL | Request, options?: RequestInit) => {
        const url = String(input);
        calls.push({ url, options });
        const overridden = intercept?.(url, options);
        if (overridden) return overridden;
        if (url.startsWith('http://metadata.google.internal/')) {
            return json({ access_token: 'synthetic-oauth-token', token_type: 'Bearer', expires_in: 3599 }, { 'metadata-flavor': 'Google' });
        }
        const version = url.replace('https://secretmanager.googleapis.com/v1/', '').replace(':access', '');
        return json(secretDocument(version, version.includes('apple-signing') ? privateKey : keyring));
    }) as typeof fetch;
    return { calls, fetch: fetchRequest };
}

test('runtime credentials use only metadata and two pinned secret versions without mutating configuration', async () => {
    assert.equal(checksum('123456789'), '3808858755', 'CRC32C standard test vector');
    const f = fixture();
    const original = { ...environment };
    const lifecycle = await loadAppleRuntimeLifecycle(environment, f);
    const token = lifecycle.repository.prepare('synthetic-refresh-token', '12345678-1234-4234-8234-123456789abc');
    assert.equal(lifecycle.repository.decrypt(token), 'synthetic-refresh-token');
    assert.deepEqual(environment, original);
    assert.equal(f.calls.length, 3);
    assert.equal(f.calls[0].url, 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token');
    assert.equal(new Headers(f.calls[0].options?.headers).get('Metadata-Flavor'), 'Google');
    assert.equal(new Headers(f.calls[0].options?.headers).has('authorization'), false);
    for (const call of f.calls) {
        assert.equal(call.options?.redirect, 'error');
        assert.equal(call.options?.cache, 'no-store');
        assert.equal(call.options?.credentials, 'omit');
        assert.equal(call.options?.method, 'GET');
    }
    assert.deepEqual(f.calls.slice(1).map(call => call.url), [
        `https://secretmanager.googleapis.com/v1/${environment.APPLE_SIGN_IN_PRIVATE_KEY_SECRET_VERSION}:access`,
        `https://secretmanager.googleapis.com/v1/${environment.APPLE_TOKEN_ENCRYPTION_KEYS_SECRET_VERSION}:access`,
    ]);
    for (const call of f.calls.slice(1)) assert.equal(new Headers(call.options?.headers).get('authorization'), 'Bearer synthetic-oauth-token');
});

test('disabled, local, isolated, mixed-inline and unpinned credentials are rejected before any network request', async () => {
    const changes = [
        { APPLE_TOKEN_RUNTIME_SECRETS_ENABLED: 'false' }, { APPLE_TOKEN_RUNTIME_SECRETS_ENABLED: 'true\n' },
        { APPLE_TOKEN_LIFECYCLE_ENABLED: 'false' }, { NODE_ENV: 'development' }, { K_SERVICE: 'wrong-service' },
        { LUDOLUME_ISOLATED_RUNTIME: 'true' }, { LUDOLUME_ISOLATED_RUNTIME: 'FALSE' },
        { APPLE_SIGN_IN_PRIVATE_KEY: '' }, { APPLE_TOKEN_ENCRYPTION_KEYS: 'private-inline-secret' },
        { APPLE_SIGN_IN_PRIVATE_KEY_SECRET_VERSION: undefined },
        ...['projects/another-project/secrets/key/versions/1', 'projects/noted-reef-387021/secrets/key/versions/latest',
            'projects/noted-reef-387021/secrets/key/versions/0', 'projects/noted-reef-387021/secrets/key/versions/01',
            'projects/noted-reef-387021/secrets/key/versions/1\n',
            'projects/noted-reef-387021/secrets/../key/versions/1',
            'https://evil.example/projects/noted-reef-387021/secrets/key/versions/1']
            .map(APPLE_SIGN_IN_PRIVATE_KEY_SECRET_VERSION => ({ APPLE_SIGN_IN_PRIVATE_KEY_SECRET_VERSION })),
        { APPLE_SIGN_IN_PRIVATE_KEY_SECRET_VERSION: environment.APPLE_TOKEN_ENCRYPTION_KEYS_SECRET_VERSION },
    ];
    for (const change of changes) {
        const f = fixture();
        await assert.rejects(loadAppleRuntimeLifecycle({ ...environment, ...change }, f), failure);
        assert.equal(f.calls.length, 0);
    }
    for (const timeoutMs of [0, -1, 10_001, NaN, 1.1]) {
        const f = fixture();
        await assert.rejects(loadAppleRuntimeLifecycle(environment, { ...f, timeoutMs }), failure);
        assert.equal(f.calls.length, 0);
    }
});

test('bad metadata fails without requesting secrets and without leaking credentials', async () => {
    const documents = [
        { token_type: 'Bearer', expires_in: 30 },
        { access_token: 'private-token\n', token_type: 'Bearer', expires_in: 30 },
        { access_token: 'private-token', token_type: 'Basic', expires_in: 30 },
        { access_token: 'private-token', token_type: 'Bearer', expires_in: 0 },
    ];
    for (const document of documents) {
        const f = fixture(() => json(document, { 'metadata-flavor': 'Google' }));
        await assert.rejects(loadAppleRuntimeLifecycle(environment, f), error => {
            assert(error instanceof Error);
            assert.equal(error.message, failure.message);
            assert.equal('cause' in error, false);
            return true;
        });
        assert.equal(f.calls.length, 1);
    }
});

test('wrong secret resource, checksum, encoding or credentials fail closed without fallback or retries', async () => {
    const valid = secretDocument(environment.APPLE_SIGN_IN_PRIVATE_KEY_SECRET_VERSION, privateKey);
    const documents = [
        { ...valid, name: valid.name.replace('/versions/3', '/versions/4') },
        { ...valid, name: valid.name.replace('1012884798546', '987654321') },
        { ...valid, payload: { ...valid.payload, dataCrc32c: '0' } },
        { ...valid, payload: { ...valid.payload, dataCrc32c: undefined } },
        { ...valid, payload: { ...valid.payload, data: `${valid.payload.data}\n` } },
        secretDocument(environment.APPLE_SIGN_IN_PRIVATE_KEY_SECRET_VERSION, Buffer.from([0xff])),
        secretDocument(environment.APPLE_SIGN_IN_PRIVATE_KEY_SECRET_VERSION, 'private-not-a-signing-key'),
    ];
    for (const document of documents) {
        const f = fixture(url => url.includes('apple-signing') ? json(document) : undefined);
        await assert.rejects(loadAppleRuntimeLifecycle(environment, f), failure);
        assert.equal(f.calls.length, 3);
        assert.equal(f.calls[0].options?.signal?.aborted, true);
    }
});

test('secret payloads and JSON streams have strict size limits; redirects and unexpected content are rejected', async () => {
    const responses = [
        () => json(secretDocument(environment.APPLE_SIGN_IN_PRIVATE_KEY_SECRET_VERSION, 'x'.repeat(16_385))),
        () => new Response('x'.repeat(32_769), { headers: { 'content-type': 'application/json' } }),
        () => json({}, { 'content-length': '32769' }),
        () => json({}, { 'content-type': 'text/html' }),
        () => new Response('', { status: 302, headers: { location: 'https://evil.example' } }),
    ];
    for (const response of responses) {
        const f = fixture(url => url.includes('apple-signing') ? response() : undefined);
        await assert.rejects(loadAppleRuntimeLifecycle(environment, f), failure);
        assert.equal(f.calls.length, 3);
    }
});

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(complete => { resolve = complete; });
    return { promise, resolve };
}

test('the overall deadline stops an uncooperative metadata fetch and prevents secret fetches after its late response', async () => {
    const pending = deferred<Response>();
    const f = fixture(() => pending.promise);
    await assert.rejects(loadAppleRuntimeLifecycle(environment, { ...f, timeoutMs: 15 }), failure);
    pending.resolve(json({ access_token: 'synthetic-late-token', token_type: 'Bearer', expires_in: 3600 }, { 'metadata-flavor': 'Google' }));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].options?.signal?.aborted, true);
});

test('the overall deadline includes a stalled response stream and never returns a lifecycle after late completion', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    const f = fixture(url => url.includes('apple-signing') ? new Response(body, { headers: { 'content-type': 'application/json' } }) : undefined);
    await assert.rejects(loadAppleRuntimeLifecycle(environment, { ...f, timeoutMs: 15 }), failure);
    assert.equal(cancelled, true);
    assert.equal(f.calls.length, 3);
    assert.equal(f.calls[0].options?.signal?.aborted, true);
});

test('a late secret response cannot escape the overall timeout', async () => {
    const pending = deferred<Response>();
    const f = fixture(url => url.includes('apple-signing') ? pending.promise : undefined);
    await assert.rejects(loadAppleRuntimeLifecycle(environment, { ...f, timeoutMs: 15 }), failure);
    pending.resolve(json(secretDocument(environment.APPLE_SIGN_IN_PRIVATE_KEY_SECRET_VERSION, privateKey)));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.calls.length, 3);
    assert.equal(f.calls[0].options?.signal?.aborted, true);
});
