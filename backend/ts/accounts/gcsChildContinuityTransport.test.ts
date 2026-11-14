import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createGcsChildContinuityTransport } from './gcsChildContinuityTransport';
import { openAppendOnlyContinuitySession } from './childContinuityAppendOnly';
import { ContinuityHeadUnavailableError, type ContinuityHead } from './childContinuityHead';
import type { JournalHttpClient, JournalHttpRequest } from './gcsDeletionJournal';

const bucket = 'synthetic-child-history';
const prefix = `v1/events/${'a'.repeat(64)}/`;
const name = `${prefix}000000000001.json`;
const fields = 'kind,nextPageToken,items(bucket,name,generation,size,md5Hash,timeDeleted,softDeleteTime)';
const signal = () => new AbortController().signal;
const metadata = { bucket, name, generation: '42', size: '2', md5Hash: 'mZFLkyvTelC5g8XnyQrpOw==' };

const projectNumber = '1012884798546';
const bucketConfig = { name: bucket, projectNumber, metageneration: '3',
    iamConfiguration: { uniformBucketLevelAccess: { enabled: true }, publicAccessPrevention: 'enforced' },
    versioning: { enabled: true }, softDeletePolicy: { retentionDurationSeconds: '604800' } };
const permissions = ['storage.buckets.get', 'storage.objects.create', 'storage.objects.get', 'storage.objects.list'];

function fixture(handler: (request: JournalHttpRequest) => Promise<{ status: number; data: unknown }>) {
    const calls: JournalHttpRequest[] = [];
    const client: JournalHttpClient = { async request(request) { calls.push(request); return handler(request); } };
    const transport = createGcsChildContinuityTransport({ bucket, expectedBucket: bucket, client });
    return { calls, transport };
}

test('startup pins bucket policy and verifies create/read-only runtime access without changing it', async () => {
    const f = fixture(async request => ({ status: request.url.includes('storage.objects.setIamPolicy') ? 400 : 200,
        data: request.url.includes('/iam/testPermissions?')
        ? { kind: 'storage#testIamPermissionsResponse', permissions } : bucketConfig }));
    await f.transport.verifyConfiguration(projectNumber);
    assert.equal(f.calls.length, 3);
    assert.ok(f.calls.every(call => call.method === 'GET' && call.retry === false));
    assert.equal(f.calls[2].params.ifMetagenerationMatch, '3');
    const requested = new URL(f.calls[1].url).searchParams.getAll('permissions');
    for (const forbidden of ['storage.objects.delete', 'storage.objects.move', 'storage.objects.restore', 'storage.buckets.update', 'storage.buckets.setIamPolicy']) {
        assert.ok(requested.includes(forbidden));
    }
});

test('startup rejects changed bucket policy, missing reads and destructive runtime grants', async () => {
    for (const patch of [{ name: 'wrong-bucket' }, { projectNumber: '999999999999' }, { versioning: { enabled: false } },
        { softDeletePolicy: { retentionDurationSeconds: '0' } }, { lifecycle: { rule: [{ action: { type: 'Delete' } }] } },
        { iamConfiguration: { uniformBucketLevelAccess: { enabled: false } } }, { hierarchicalNamespace: { enabled: true } }]) {
        const f = fixture(async () => ({ status: 200, data: { ...bucketConfig, ...patch } }));
        await assert.rejects(f.transport.verifyConfiguration(projectNumber), /configuration differs/);
        assert.equal(f.calls.length, 1);
    }
    for (const granted of [permissions.slice(1), [...permissions, 'storage.objects.delete'], [...permissions, 'storage.objects.move'],
        [...permissions, 'storage.buckets.setIamPolicy'], [...permissions.slice(1), permissions[1]]]) {
        const f = fixture(async request => ({ status: 200, data: request.url.includes('/iam/testPermissions?')
            ? { kind: 'storage#testIamPermissionsResponse', permissions: granted } : bucketConfig }));
        await assert.rejects(f.transport.verifyConfiguration(projectNumber), /permissions differ/);
        assert.equal(f.calls.length, 2);
    }
});

test('startup holds when bucket configuration changes during permission verification', async () => {
    const f = fixture(async request => ({ status: request.params.ifMetagenerationMatch ? 412 : 200,
        data: request.url.includes('/iam/testPermissions?') ? { kind: 'storage#testIamPermissionsResponse', permissions } : bucketConfig }));
    await assert.rejects(f.transport.verifyConfiguration(projectNumber), /storage unavailable/);
    assert.equal(f.calls.length, 3);
});

test('uses bounded version and soft-delete inventories with pinned fields and no retries', async () => {
    const f = fixture(async () => ({ status: 200, data: { kind: 'storage#objects', items: [] } }));
    for (const mode of [{ versions: true as const }, { softDeleted: true as const }]) {
        await f.transport.list({ bucket, prefix, startOffset: name, maxResults: 2, fields, signal: signal(), ...mode });
    }
    assert.equal(f.calls.length, 2);
    assert.deepEqual(f.calls.map(call => call.params), [
        { prefix, startOffset: name, maxResults: 2, fields, versions: true },
        { prefix, startOffset: name, maxResults: 2, fields, softDeleted: true },
    ]);
    for (const call of f.calls) {
        assert.equal(call.url, `https://storage.googleapis.com/storage/v1/b/${bucket}/o`);
        assert.equal(call.retry, false); assert.equal(call.maxRedirects, 0);
        assert.equal(call.headers?.['Cache-Control'], 'no-cache, no-store');
    }
});

test('pins generation when reading and uses a create-only precondition on upload', async () => {
    const f = fixture(async call => ({ status: 200, data: call.method === 'POST' ? metadata : '{}' }));
    assert.equal(await f.transport.readBody({ bucket, name, generation: '42', ifGenerationMatch: '42', signal: signal() }), '{}');
    assert.deepEqual(await f.transport.createOnly({ bucket, name, body: '{}', ifGenerationMatch: '0', signal: signal() }), metadata);
    assert.equal(f.calls[0].url, `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(name)}`);
    assert.deepEqual(f.calls[0].params, { alt: 'media', generation: '42', ifGenerationMatch: '42' });
    assert.equal(f.calls[1].url, `https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o`);
    assert.equal(f.calls[1].params.ifGenerationMatch, '0');
    assert.equal(f.calls[1].retry, false); assert.equal(f.calls[1].data, '{}');
});

test('refuses unpinned inputs before sending requests', async () => {
    const f = fixture(async () => ({ status: 200, data: {} }));
    await assert.rejects(f.transport.list({ bucket, prefix, startOffset: `${prefix}../other`, maxResults: 2, fields, versions: true, signal: signal() }));
    await assert.rejects(f.transport.readBody({ bucket: 'another-bucket', name, generation: '42', ifGenerationMatch: '42', signal: signal() }));
    await assert.rejects(f.transport.readBody({ bucket, name, generation: '42', ifGenerationMatch: '43', signal: signal() }));
    await assert.rejects(f.transport.createOnly({ bucket, name, body: 'x'.repeat(1501), ifGenerationMatch: '0', signal: signal() }));
    assert.equal(f.calls.length, 0);
    assert.throws(() => createGcsChildContinuityTransport({ bucket, expectedBucket: 'another-bucket' }));
});

test('provider errors and uncertain creates fail without leaking or retrying', async () => {
    const f = fixture(async () => { throw new Error('PRIVATE token and body'); });
    await assert.rejects(f.transport.createOnly({ bucket, name, body: '{}', ifGenerationMatch: '0', signal: signal() }),
        error => error instanceof Error && error.message === 'Child continuity storage unavailable.');
    assert.equal(f.calls.length, 1);
    const conflict = fixture(async () => ({ status: 412, data: { private: 'value' } }));
    await assert.rejects(conflict.transport.createOnly({ bucket, name, body: '{}', ifGenerationMatch: '0', signal: signal() }));
    assert.equal(conflict.calls.length, 1);
});

test('unsupported soft-delete inventory and malformed provider responses do not become empty history', async () => {
    const unsupported = fixture(async () => ({ status: 400, data: { error: 'invalidArgument' } }));
    await assert.rejects(unsupported.transport.list({ bucket, prefix, startOffset: prefix, maxResults: 2,
        fields, softDeleted: true, signal: signal() }), /Child continuity storage unavailable/);
    assert.equal(unsupported.calls.length, 1);
    const malformed = fixture(async () => ({ status: 200, data: 'not an object' }));
    await assert.rejects(malformed.transport.list({ bucket, prefix, startOffset: prefix, maxResults: 2,
        fields, versions: true, signal: signal() }), /Child continuity storage unavailable/);
});

test('aborting an uncooperative request returns uncertainty and never retries', async () => {
    const f = fixture(async () => new Promise(() => {}));
    const controller = new AbortController();
    const pending = f.transport.createOnly({ bucket, name, body: '{}', ifGenerationMatch: '0', signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, /Child continuity storage unavailable/);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].signal.aborted, true);
    const alreadyAborted = new AbortController(); alreadyAborted.abort();
    await assert.rejects(f.transport.createOnly({ bucket, name, body: '{}', ifGenerationMatch: '0', signal: alreadyAborted.signal }));
    assert.equal(f.calls.length, 1);
});

test('timeout returns uncertainty even when the HTTP client ignores cancellation', async () => {
    let calls = 0;
    const client: JournalHttpClient = { async request() { calls++; return new Promise(() => {}); } };
    const transport = createGcsChildContinuityTransport({ bucket, expectedBucket: bucket, client, timeoutMs: 20 });
    await assert.rejects(transport.createOnly({ bucket, name, body: '{}', ifGenerationMatch: '0', signal: signal() }),
        /Child continuity storage unavailable/);
    assert.equal(calls, 1);
});

test('transport and witness hold an older SQL snapshot after a later activity event', async () => {
    const objects = new Map<string, { body: string; generation: string }>();
    const client: JournalHttpClient = { async request(call) {
        if (call.method === 'POST') {
            const objectName = String(call.params.name);
            if (objects.has(objectName)) return { status: 412, data: {} };
            const body = String(call.data); const generation = String(objects.size + 1);
            objects.set(objectName, { body, generation });
            return { status: 200, data: { bucket, name: objectName, generation,
                size: String(Buffer.byteLength(body)), md5Hash: createHash('md5').update(body).digest('base64') } };
        }
        if (call.params.alt === 'media') {
            const objectName = decodeURIComponent(call.url.slice(call.url.lastIndexOf('/') + 1));
            const object = objects.get(objectName);
            if (!object || object.generation !== call.params.generation) return { status: 404, data: null };
            return { status: 200, data: object.body };
        }
        const items = call.params.softDeleted ? [] : [...objects.entries()]
            .filter(([objectName]) => objectName.startsWith(String(call.params.prefix)) && objectName >= String(call.params.startOffset))
            .sort(([a], [b]) => a.localeCompare(b)).slice(0, 2)
            .map(([objectName, object]) => ({ bucket, name: objectName, generation: object.generation,
                size: String(Buffer.byteLength(object.body)), md5Hash: createHash('md5').update(object.body).digest('base64') }));
        return { status: 200, data: { kind: 'storage#objects', items } };
    } };
    const transport = createGcsChildContinuityTransport({ bucket, expectedBucket: bucket, client });
    const key = Buffer.alloc(32, 9), request = Buffer.from('synthetic request'), state = Buffer.from('synthetic state');
    const child = '572ed45a-c57d-4c82-9b50-d4585331bcec', now = 1_800_000_000_000;
    const open = (head?: ContinuityHead) => openAppendOnlyContinuitySession({ transport, bucket, expectedBucket: bucket, key,
        sequence: head?.sequence ?? 0, generation: head?.generation ?? '0' });
    const firstSession = open();
    const first = await firstSession.initializeNew(child, firstSession.issueOperation(child, request, now), now, request, state);
    const secondSession = open(first.head);
    const second = await secondSession.prepareExisting(child, first.head, secondSession.issueOperation(child, request, now),
        first.ledgerRows, now, request, state, state);
    assert.equal(second.status, 'prepared');
    if (second.status !== 'prepared') throw new Error('Unexpected synthetic state');
    await open(second.head).verifyExisting(child, second.head, second.ledgerRows, state, now);
    await assert.rejects(open(first.head).verifyExisting(child, first.head, first.ledgerRows, state, now), ContinuityHeadUnavailableError);
});
