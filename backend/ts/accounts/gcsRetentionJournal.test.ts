import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createGcsRetentionJournal, RetentionJournalUnavailableError } from './gcsRetentionJournal';
import type { RetentionIntent } from './childInactivityWorkflow';
import type { JournalHttpClient, JournalHttpRequest } from './gcsDeletionJournal';

const bucket = 'ludolume-test-conditional-intents';
const key = Buffer.alloc(32, 7);
const intent: RetentionIntent = {
    parentId: '42a23d28-40cf-4d69-9fdb-74206ef3fa70', childId: '42a23d28-40cf-4d69-9fdb-74206ef3fa71',
    warningId: '42a23d28-40cf-4d69-9fdb-74206ef3fa72', activityAt: '2023-01-01T00:00:00.000000Z',
    deliveredAt: '2026-01-01T00:00:00.000000Z', channel: 'in-app', targetDigest: 'a'.repeat(64),
    noticeDigest: 'b'.repeat(64), receiptDigest: 'c'.repeat(64),
};

/** A transport fixture models create-only and generation-specific reads; no cloud is contacted. */
function transport() {
    const objects = new Map<string, string>();
    const generations = new Map<string, number>();
    const requests: JournalHttpRequest[] = [];
    const metadata = (name: string, body: string) => ({ bucket, name, generation: String(generations.get(name) ?? 1), size: String(Buffer.byteLength(body)),
        md5Hash: createHash('md5').update(body).digest('base64') });
    const client: JournalHttpClient = { async request(request) {
        requests.push(request);
        if (request.method === 'POST') {
            const name = String(request.params.name);
            if (String(request.params.ifGenerationMatch) !== String(generations.get(name) ?? 0)) return { status: 412, data: {} };
            objects.set(name, request.data!);
            generations.set(name, (generations.get(name) ?? 0) + 1);
            return { status: 200, data: metadata(name, request.data!) };
        }
        if (request.url.endsWith('/o')) return { status: 200, data: {
            kind: 'storage#objects', items: request.params.softDeleted === true ? [] : [...objects]
                .filter(([name]) => name.startsWith(String(request.params.prefix))).map(([name, body]) => metadata(name, body)),
        } };
        const name = decodeURIComponent(request.url.split('/').at(-1)!);
        const body = objects.get(name);
        if (!body) return { status: 404, data: {} };
        return { status: 200, data: request.params.alt === 'media' ? body : metadata(name, body) };
    } };
    return { objects, requests, client };
}
function journal(client: JournalHttpClient, health: () => Promise<boolean> = async () => true) {
    return createGcsRetentionJournal({ bucket, expectedBucket: bucket, key, client, verifyActivityContinuity: health });
}

test('persists an exact authenticated conditional intent and lists it for private reconciliation', async () => {
    const io = transport(); const store = journal(io.client);
    await store.recordRetentionIntent(intent);
    assert.equal(io.requests[0].params.ifGenerationMatch, 0);
    assert.equal(io.requests[0].retry, false);
    assert.equal(io.requests[0].maxRedirects, 0);
    assert.match(String(io.requests[0].params.name), /^v1\/conditional\/[a-f0-9]{64}\/[a-f0-9]{64}\.json$/);
    assert.equal(await store.verifyRetentionIntent(intent), true);
    assert.deepEqual(await store.readIntents(), [intent]);
    assert.equal(await store.verifyActivityContinuity(intent), true);
    await assert.rejects(store.recordRetentionIntent(intent), RetentionJournalUnavailableError);
});

test('changed or absent intents, corrupted bodies, and a different signing key cannot verify', async () => {
    const io = transport(); const store = journal(io.client);
    await store.recordRetentionIntent(intent);
    await assert.rejects(store.verifyRetentionIntent({ ...intent, receiptDigest: 'd'.repeat(64) }), RetentionJournalUnavailableError);
    const [name, body] = [...io.objects][0]; io.objects.set(name, body.replace('42a23d28', '52a23d28'));
    await assert.rejects(store.verifyRetentionIntent(intent), RetentionJournalUnavailableError);
    await assert.rejects(store.readIntents(), RetentionJournalUnavailableError);
    const wrongKey = createGcsRetentionJournal({ bucket, expectedBucket: bucket, key: Buffer.alloc(32, 8),
        client: io.client, verifyActivityContinuity: async () => true });
    await assert.rejects(wrongKey.readIntents(), RetentionJournalUnavailableError);
});

test('per-child inventory uses an opaque prefix and never downloads another child’s intents', async () => {
    const io = transport(); const store = journal(io.client);
    const other = { ...intent, childId: '42a23d28-40cf-4d69-9fdb-74206ef3fa73' };
    await store.recordRetentionIntent(intent);
    await store.recordRetentionIntent(other);
    io.requests.length = 0;
    assert.deepEqual(await store.readIntentsForChild(intent.childId), [intent]);
    const pages = io.requests.filter(request => request.url.endsWith('/o'));
    assert.equal(pages.length, 4);
    for (const page of pages) {
        assert.match(String(page.params.prefix), /^v1\/conditional\/[a-f0-9]{64}\/$/);
        assert.ok(!String(page.params.prefix).includes(intent.childId));
    }
    assert.equal(io.requests.filter(request => request.params.alt === 'media').length, 1);
    await assert.rejects(store.readIntentsForChild('invalid'), /Invalid/);
});

test('unhealthy or unavailable continuity never becomes affirmative', async () => {
    const io = transport();
    assert.equal(await journal(io.client, async () => false).verifyActivityContinuity(intent), false);
    assert.equal(await journal(io.client, async () => { throw new Error('private provider error'); }).verifyActivityContinuity(intent), false);
});

test('rejects unsafe configuration and malformed intents before making a request', async () => {
    const io = transport();
    assert.throws(() => createGcsRetentionJournal({ bucket, expectedBucket: 'another-bucket', key,
        client: io.client, verifyActivityContinuity: async () => false }), /configuration/);
    assert.throws(() => createGcsRetentionJournal({ bucket, expectedBucket: bucket, key: Buffer.alloc(8),
        client: io.client, verifyActivityContinuity: async () => false }), /configuration/);
    await assert.rejects(journal(io.client).recordRetentionIntent({ ...intent, childId: 'not-an-id' }), /Invalid/);
    await assert.rejects(journal(io.client).recordRetentionIntent({ ...intent, activityAt: 'bad' }), /Invalid/);
    assert.equal(io.requests.length, 0);
});

test('a lost acknowledgment times out, aborts and never retries the write', async () => {
    const requests: JournalHttpRequest[] = [];
    const client: JournalHttpClient = { async request(request) { requests.push(request); return new Promise(() => {}); } };
    const store = createGcsRetentionJournal({ bucket, expectedBucket: bucket, key, client, timeoutMs: 10,
        verifyActivityContinuity: async () => false });
    await assert.rejects(store.recordRetentionIntent(intent), RetentionJournalUnavailableError);
    assert.equal(requests.length, 1); assert.equal(requests[0].signal.aborted, true);
});

test('reconciliation refuses a soft-deleted intent or a changed inventory', async () => {
    const io = transport(); const store = journal(io.client);
    await store.recordRetentionIntent(intent);
    const live = [...io.objects][0];
    const metadata = { bucket, name: live[0], generation: '1', size: String(Buffer.byteLength(live[1])),
        md5Hash: createHash('md5').update(live[1]).digest('base64') };
    const deletedClient: JournalHttpClient = { async request(request) {
        if (request.params.softDeleted === true) return { status: 200, data: { kind: 'storage#objects', items: [metadata] } };
        return io.client.request(request);
    } };
    await assert.rejects(journal(deletedClient).readIntents(), RetentionJournalUnavailableError);
    let liveLists = 0;
    const changingClient: JournalHttpClient = { async request(request) {
        if (request.url.endsWith('/o') && request.params.versions === true && ++liveLists === 2) {
            return { status: 200, data: { kind: 'storage#objects', items: [] } };
        }
        return io.client.request(request);
    } };
    await assert.rejects(journal(changingClient).readIntents(), RetentionJournalUnavailableError);
});

test('restore guard is authenticated, generation-pinned and cannot blindly overwrite', async () => {
    const io = transport(); const store = journal(io.client);
    const active = { state: 'active' as const, database: 'synthetic', serverUuid: intent.parentId,
        epoch: intent.warningId, expiresAt: '2026-02-01T00:00:00.000Z' };
    assert.equal(await store.writeRestoreGuard(active, '0'), '1');
    assert.deepEqual(await store.readRestoreGuard(), { ...active, generation: '1' });
    await assert.rejects(store.writeRestoreGuard({ ...active, state: 'hold' }, '0'), RetentionJournalUnavailableError);
    assert.equal(await store.writeRestoreGuard({ ...active, state: 'hold' }, '1'), '2');
    assert.equal((await store.readRestoreGuard()).state, 'hold');
    const name = 'v1/control/restore-guard.json'; const body = io.objects.get(name)!;
    io.objects.set(name, body.replace('"hold"', '"active"'));
    await assert.rejects(store.readRestoreGuard(), RetentionJournalUnavailableError);
});

test('initial guard creation refuses evidence of a previously soft-deleted guard', async () => {
    let writes = 0;
    const client: JournalHttpClient = { async request(request) {
        if (request.method === 'POST') { writes++; throw new Error('unexpected write'); }
        return { status: 200, data: { kind: 'storage#objects', items: [{ name: 'v1/control/restore-guard.json' }] } };
    } };
    const store = journal(client);
    await assert.rejects(store.writeRestoreGuard({ state: 'hold', database: 'synthetic', serverUuid: intent.parentId,
        epoch: intent.warningId, expiresAt: '2026-02-01T00:00:00.000Z' }, '0'), RetentionJournalUnavailableError);
    assert.equal(writes, 0);
});

test('resolution is append-only, authenticated, and bound to the exact conditional intent', async () => {
    const io = transport(); const store = journal(io.client);
    await store.recordRetentionIntent(intent);
    assert.equal(await store.readResolution(intent), null);
    const resolution = { outcome: 'kept' as const, confirmedAt: '2026-01-03T00:00:00.000000Z',
        observedActivityAt: '2026-01-02T00:00:00.000000Z', proofDigest: 'e'.repeat(64) };
    await store.recordResolution(intent, resolution);
    assert.deepEqual(await store.readResolution(intent), resolution);
    await assert.rejects(store.recordResolution(intent, { ...resolution, outcome: 'deleted', observedActivityAt: null }),
        RetentionJournalUnavailableError);
    assert.equal(await store.readResolution({ ...intent, receiptDigest: 'd'.repeat(64) }), null);
    const name = [...io.objects.keys()].find(value => value.startsWith('v1/resolutions/'))!;
    io.objects.set(name, io.objects.get(name)!.replace('"kept"', '"deleted"'));
    assert.equal(await store.readResolution(intent), null);
});
