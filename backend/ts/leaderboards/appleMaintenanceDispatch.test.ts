import assert from 'node:assert/strict';
import test from 'node:test';
import { APPLE_MAINTENANCE_AUDIENCE, APPLE_MAINTENANCE_URL } from '../config/appleMaintenanceConfig';
import { dispatchAppleMaintenance } from './appleMaintenanceDispatch';

const active = { NODE_ENV: 'production', CLOUD_RUN_JOB: 'mickeyf-submission-receipt-cleanup',
    APPLE_MAINTENANCE_DISPATCH_ENABLED: 'true' };
const token = 'encoded-header.encoded-payload.signature';
const metadata = () => new Response(token, { headers: { 'Metadata-Flavor': 'Google' } });
const completed = () => Response.json({ completed: true });
type Request = { url: string; options: RequestInit | undefined };

function harness(responses: Array<Response | (() => Promise<Response>)> = [metadata(), completed()]) {
    const requests: Request[] = [];
    const events: Record<string, unknown>[] = [];
    const request: typeof fetch = async (input, options) => {
        requests.push({ url: String(input), options });
        const response = responses.shift();
        if (!response) throw new Error('Unexpected request with private token.');
        return typeof response === 'function' ? response() : response;
    };
    return { requests, events, dependencies: {
        fetch: request, writeEvent: (event: Record<string, unknown>) => { events.push(event); },
    } };
}

test('disabled dispatch performs no authentication or network request', async () => {
    for (const flag of [undefined, 'false', 'TRUE', '1']) {
        const fake = harness();
        assert.deepEqual(await dispatchAppleMaintenance({ APPLE_MAINTENANCE_DISPATCH_ENABLED: flag },
            fake.dependencies), { status: 'disabled' });
        assert.equal(fake.requests.length, 0);
        assert.equal(fake.events[0].severity, 'INFO');
    }
});

test('dispatch rejects nonproduction, wrong job and isolated runtimes before metadata access', async () => {
    for (const override of [
        { NODE_ENV: 'development' }, { NODE_ENV: undefined }, { CLOUD_RUN_JOB: undefined },
        { CLOUD_RUN_JOB: 'other-job' }, { LUDOLUME_ISOLATED_RUNTIME: 'true' },
        { LUDOLUME_ISOLATED_RUNTIME: '' }, { LUDOLUME_ISOLATED_RUNTIME: 'TRUE' },
    ]) {
        const fake = harness();
        assert.deepEqual(await dispatchAppleMaintenance({ ...active, ...override }, fake.dependencies),
            { status: 'failed', reason: 'configuration' });
        assert.equal(fake.requests.length, 0);
    }
});

test('uses fixed identity metadata and destination, with no redirects or key fallback', async () => {
    const fake = harness();
    const result = await dispatchAppleMaintenance({ ...active, LUDOLUME_ISOLATED_RUNTIME: 'false',
        APPLE_MAINTENANCE_URL: 'https://attacker.invalid', GOOGLE_APPLICATION_CREDENTIALS: 'local-key.json',
    }, fake.dependencies);
    assert.deepEqual(result, { status: 'completed' });
    assert.equal(fake.requests.length, 2);
    const identity = new URL(fake.requests[0].url);
    assert.equal(identity.origin, 'http://metadata.google.internal');
    assert.equal(identity.pathname, '/computeMetadata/v1/instance/service-accounts/default/identity');
    assert.equal(identity.searchParams.get('audience'), APPLE_MAINTENANCE_AUDIENCE);
    assert.equal(identity.searchParams.get('format'), 'full');
    assert.deepEqual(fake.requests[0].options?.headers, { 'Metadata-Flavor': 'Google' });
    assert.equal(fake.requests[1].url, APPLE_MAINTENANCE_URL);
    assert.equal(fake.requests[1].options?.method, 'POST');
    assert.equal(fake.requests[1].options?.body, '');
    assert.deepEqual(fake.requests[1].options?.headers, { Authorization: `Bearer ${token}` });
    assert.equal(fake.requests.every(({ options }) => options?.redirect === 'error'), true);
    assert.equal(JSON.stringify(fake.events).includes(token), false);
});

test('metadata failures stop dispatch and never expose raw response or exception text', async () => {
    for (const response of [
        new Response(token, { status: 403, headers: { 'Metadata-Flavor': 'Google' } }),
        new Response(token),
        new Response('private malformed token', { headers: { 'Metadata-Flavor': 'Google' } }),
        new Response('x'.repeat(16 * 1024 + 1), { headers: { 'Metadata-Flavor': 'Google' } }),
        async () => { throw new Error('private key must not escape'); },
    ]) {
        const fake = harness([response]);
        assert.deepEqual(await dispatchAppleMaintenance(active, fake.dependencies),
            { status: 'failed', reason: 'metadata' });
        assert.equal(fake.requests.length, 1);
        assert.equal(JSON.stringify(fake.events).includes('private'), false);
    }
});

test('only an exact completed JSON response counts as success', async () => {
    for (const response of [
        Response.json({ completed: true }, { status: 202 }),
        new Response(null, { status: 204 }),
        new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } }),
        new Response('private invalid JSON', { headers: { 'content-type': 'application/json' } }),
        Response.json({ completed: false }), Response.json({ completed: true, extra: 'private' }),
        Response.json([true]), Response.json(null), Response.json({ status: 'completed' }),
        new Response('x'.repeat(16 * 1024 + 1), { headers: { 'content-type': 'application/json' } }),
    ]) {
        const fake = harness([metadata(), response]);
        assert.deepEqual(await dispatchAppleMaintenance(active, fake.dependencies),
            { status: 'failed', reason: 'dispatch' });
        assert.equal(fake.requests.length, 2, 'no retries');
        assert.equal(JSON.stringify(fake.events).includes('private'), false);
    }
});

test('an oversized content-length rejects without reading the body', async () => {
    const fake = harness([metadata(), new Response('{"completed":true}', {
        headers: { 'content-type': 'application/json', 'content-length': '999999999' },
    })]);
    assert.deepEqual(await dispatchAppleMaintenance(active, fake.dependencies),
        { status: 'failed', reason: 'dispatch' });
});

test('metadata timeout aborts and a late token never initiates dispatch', async () => {
    let resolveResponse!: (response: Response) => void;
    const fake = harness([() => new Promise(resolve => { resolveResponse = resolve; })]);
    const result = await dispatchAppleMaintenance(active, { ...fake.dependencies, metadataDurationMs: 5 });
    assert.deepEqual(result, { status: 'failed', reason: 'deadline' });
    assert.equal(fake.requests[0].options?.signal?.aborted, true);
    resolveResponse(metadata());
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(fake.requests.length, 1);
    assert.equal(fake.events.length, 1, 'late result cannot log success');
});

test('metadata body reading is included in the metadata deadline', async () => {
    const body = new ReadableStream<Uint8Array>({ start() { /* deliberately never supplies a chunk */ } });
    const fake = harness([new Response(body, { headers: { 'Metadata-Flavor': 'Google' } })]);
    assert.deepEqual(await dispatchAppleMaintenance(active, { ...fake.dependencies, metadataDurationMs: 5 }),
        { status: 'failed', reason: 'deadline' });
    assert.equal(fake.requests.length, 1);
});

test('the overall deadline covers HTTP response body and cannot report late success', async () => {
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ start(controller) { stream = controller; },
        cancel() { cancelled = true; } });
    const fake = harness([metadata(), new Response(body, { headers: { 'content-type': 'application/json' } })]);
    assert.deepEqual(await dispatchAppleMaintenance(active, { ...fake.dependencies, durationMs: 10 }),
        { status: 'failed', reason: 'deadline' });
    assert.equal(fake.requests[1].options?.signal?.aborted, true);
    assert.equal(cancelled, true);
    assert.throws(() => stream.enqueue(new TextEncoder().encode('{"completed":true}')));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(fake.events.length, 1);
});

test('a hung POST is aborted at the overall deadline without retrying', async () => {
    const fake = harness([metadata(), () => new Promise(() => undefined)]);
    assert.deepEqual(await dispatchAppleMaintenance(active, { ...fake.dependencies, durationMs: 10 }),
        { status: 'failed', reason: 'deadline' });
    assert.equal(fake.requests.length, 2);
    assert.equal(fake.requests[1].options?.signal?.aborted, true);
});

test('test seams cannot enlarge production duration limits', async () => {
    for (const override of [{ durationMs: 110_001 }, { durationMs: 0 }, { metadataDurationMs: 5_001 }]) {
        const fake = harness();
        assert.deepEqual(await dispatchAppleMaintenance(active, { ...fake.dependencies, ...override }),
            { status: 'failed', reason: 'configuration' });
        assert.equal(fake.requests.length, 0);
    }
});
