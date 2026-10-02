import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
    createGcsDeletionJournal, DELETION_JOURNAL_BUCKET, DeletionJournalUnavailableError,
    JournalHttpClient, JournalHttpRequest,
} from './gcsDeletionJournal';

const ACCOUNT_ID = '42a23d28-40cf-4d69-9fdb-74206ef3fa70';
const REQUEST_ID = '42272598-9d28-457d-a63d-e3e3cd0d2a00';
const SECOND_ID = '52272598-9d28-457d-a63d-e3e3cd0d2a00';
const NOW = '2026-09-11T12:00:00.000Z';
const INTENT = { version: 1, accountId: ACCOUNT_ID, action: 'delete-account', requestedAt: NOW };
const BODY = JSON.stringify(INTENT);

function metadata(id = REQUEST_ID, body = BODY) {
    return {
        bucket: DELETION_JOURNAL_BUCKET, name: `v1/intents/${id}.json`,
        generation: '12345678901234567', size: String(Buffer.byteLength(body)),
        md5Hash: createHash('md5').update(body).digest('base64'),
    };
}

function page(items?: unknown[], nextPageToken?: string) {
    return { kind: 'storage#objects', ...(items === undefined ? {} : { items }),
        ...(nextPageToken === undefined ? {} : { nextPageToken }) };
}

function fakeClient(responses: Array<unknown | Error | ((request: JournalHttpRequest) => Promise<unknown>)>) {
    const requests: JournalHttpRequest[] = [];
    const client: JournalHttpClient = {
        async request(request) {
            requests.push(request);
            if (!responses.length) throw new Error('Unexpected HTTP request');
            const result = responses.shift();
            if (result instanceof Error) throw result;
            const data = typeof result === 'function' ? await result(request) : result;
            return { status: 200, data };
        },
    };
    return { client, requests };
}

function journal(client: JournalHttpClient, timeoutMs?: number) {
    return createGcsDeletionJournal({ client, now: () => new Date(NOW), requestId: () => REQUEST_ID, timeoutMs });
}

test('writer creates exactly one immutable minimal object and verifies its acknowledgement', async () => {
    const { client, requests } = fakeClient([metadata()]);
    await journal(client).recordAccountDeletion(ACCOUNT_ID);
    assert.equal(requests.length, 1);
    const request = requests[0];
    assert.equal(request.method, 'POST');
    assert.equal(request.url, `https://storage.googleapis.com/upload/storage/v1/b/${DELETION_JOURNAL_BUCKET}/o`);
    assert.equal(request.params.uploadType, 'media');
    assert.equal(request.params.ifGenerationMatch, 0);
    assert.equal(request.params.name, metadata().name);
    assert.deepEqual(JSON.parse(request.data!), INTENT);
    assert.equal(request.retry, false);
    assert.equal(request.maxRedirects, 0);
    assert.equal(request.timeout, 10_000);
});

test('writer does not treat errors, conflicts or mismatching stored bytes as confirmed', async () => {
    const conflict = Object.assign(new Error('Bearer secret and private body'), { code: 412 });
    for (const result of [conflict, new Error('500 internal upstream'),
        { ...metadata(), name: metadata(SECOND_ID).name },
        { ...metadata(), bucket: 'wrong-bucket' },
        { ...metadata(), size: '1' },
        { ...metadata(), md5Hash: 'AAAAAAAAAAAAAAAAAAAAAA==' },
        { ...metadata(), generation: 123 },
        { ...metadata(), timeDeleted: NOW }]) {
        const { client, requests } = fakeClient([result]);
        await assert.rejects(journal(client).recordAccountDeletion(ACCOUNT_ID), error => {
            assert.ok(error instanceof DeletionJournalUnavailableError);
            assert.equal(Object.prototype.hasOwnProperty.call(error, 'cause'), false);
            assert.doesNotMatch(String(error), /secret|private body|500|412/);
            return true;
        });
        assert.equal(requests.length, 1);
    }
});

test('writer refuses invalid account, request identity and unapproved bucket without HTTP', async () => {
    const { client, requests } = fakeClient([]);
    await assert.rejects(journal(client).recordAccountDeletion('123'), /Invalid stable account identity/);
    await assert.rejects(createGcsDeletionJournal({ client, requestId: () => '../other' })
        .recordAccountDeletion(ACCOUNT_ID), /Invalid deletion request identity/);
    assert.throws(() => createGcsDeletionJournal({ client, bucket: 'other' }), /Unapproved/);
    assert.throws(() => createGcsDeletionJournal({ client, timeoutMs: 60_000 }), /timeout/);
    assert.equal(requests.length, 0);
});

test('deadline aborts pending request, fails sanitized and never retries', async () => {
    const { client, requests } = fakeClient([async () => new Promise(() => {})]);
    await assert.rejects(journal(client, 10).recordAccountDeletion(ACCOUNT_ID), DeletionJournalUnavailableError);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].signal.aborted, true);
});

test('reader follows every live and soft-deleted page and pins each exact generation', async () => {
    const { client, requests } = fakeClient([
        page([], 'empty-soft-page'), page(),
        page([metadata()], 'live-page-2'), page([metadata(SECOND_ID)]),
        BODY, BODY, page(),
    ]);
    const snapshot = await journal(client).readDeletionIntents();
    assert.deepEqual(snapshot.intents, [INTENT, INTENT]);
    assert.match(snapshot.digest, /^[0-9a-f]{64}$/);
    assert.equal(requests[0].params.softDeleted, true);
    assert.equal(requests[0].params.versions, undefined);
    assert.equal(requests[1].params.pageToken, 'empty-soft-page');
    assert.equal(requests[2].params.versions, true);
    assert.equal(requests[2].params.prefix, undefined);
    assert.equal(requests[3].params.pageToken, 'live-page-2');
    for (const request of requests.slice(4, 6)) {
        assert.equal(request.params.generation, '12345678901234567');
        assert.equal(request.params.ifGenerationMatch, '12345678901234567');
        assert.equal(request.responseType, 'text');
        assert.equal(request.retry, false);
    }
    assert.equal(requests[6].params.softDeleted, true);
});

test('reader is fresh on every call and generation changes change its digest', async () => {
    const { client } = fakeClient([
        page(), page([metadata()]), BODY, page(),
        page(), page([{ ...metadata(), generation: '12345678901234568' }]), BODY, page(),
    ]);
    const source = journal(client);
    const before = await source.readDeletionIntents();
    const after = await source.readDeletionIntents();
    assert.notEqual(before.digest, after.digest);
});

test('reader accepts a verified empty journal, not an unavailable or malformed listing', async () => {
    const empty = journal(fakeClient([page(), page(), page()]).client);
    assert.deepEqual((await empty.readDeletionIntents()).intents, []);
    for (const response of [new Error('403 secret'), {}, [], null, page('bad' as unknown as unknown[]),
        { ...page(), nextPageToken: '' }, { ...page(), prefixes: [] }]) {
        await assert.rejects(journal(fakeClient([response]).client).readDeletionIntents(), DeletionJournalUnavailableError);
    }
});

test('reader refuses soft-deleted records before or after scanning live objects', async () => {
    for (const responses of [
        [page([{ ...metadata(), softDeleteTime: NOW }])],
        [page(), page([metadata()]), BODY, page([{ ...metadata(), softDeleteTime: NOW }])],
    ]) {
        await assert.rejects(journal(fakeClient(responses).client).readDeletionIntents(), DeletionJournalUnavailableError);
    }
});

test('reader refuses any unknown object, historical version or invalid metadata', async () => {
    for (const object of [
        { ...metadata(), name: 'other-prefix/ignored.json' },
        { ...metadata(), timeDeleted: NOW },
        { ...metadata(), softDeleteTime: NOW },
        { ...metadata(), size: '1000000' },
        { ...metadata(), bucket: 'other' },
        { ...metadata(), generation: '0' },
    ]) {
        await assert.rejects(journal(fakeClient([page(), page([object])]).client)
            .readDeletionIntents(), DeletionJournalUnavailableError);
    }
    await assert.rejects(journal(fakeClient([page(), page([metadata(), metadata()])]).client)
        .readDeletionIntents(), DeletionJournalUnavailableError);
});

test('reader rejects checksum mismatches, invalid payloads and interrupted pagination', async () => {
    const invalidBodies = ['{', JSON.stringify({ ...INTENT, userId: 123 }),
        JSON.stringify({ ...INTENT, action: 'other' }), JSON.stringify({ ...INTENT, version: 2 })];
    for (const body of invalidBodies) {
        await assert.rejects(journal(fakeClient([page(), page([metadata(REQUEST_ID, body)]), body]).client)
            .readDeletionIntents(), DeletionJournalUnavailableError);
    }
    for (const responses of [
        [page(), page([metadata()]), BODY.replace(ACCOUNT_ID, SECOND_ID)],
        [page(), page([metadata()], 'again'), new Error('network failed')],
        [page([], 'again'), page([], 'again')],
    ]) {
        await assert.rejects(journal(fakeClient(responses).client).readDeletionIntents(), DeletionJournalUnavailableError);
    }
});

test('reader enforces an aggregate deadline across individually successful requests', async context => {
    context.mock.timers.enable({ apis: ['Date'] });
    const { client, requests } = fakeClient([async () => {
        context.mock.timers.tick(11);
        return page();
    }]);
    await assert.rejects(createGcsDeletionJournal({ client, readTimeoutMs: 10 }).readDeletionIntents(),
        DeletionJournalUnavailableError);
    assert.equal(requests.length, 1);
    assert.throws(() => createGcsDeletionJournal({ client, readTimeoutMs: 300_001 }), /read timeout/);
});

test('reader fails closed at the object ceiling instead of returning a partial journal', async () => {
    const responses: unknown[] = [page()];
    for (let offset = 0; offset <= 10_000; offset += 100) {
        const size = offset < 10_000 ? 100 : 1;
        const objects = Array.from({ length: size }, (_, index) => metadata(
            `${(offset + index).toString(16).padStart(8, '0')}-9d28-457d-a63d-e3e3cd0d2a00`,
        ));
        responses.push(page(objects, `next-${offset}`));
    }
    const { client, requests } = fakeClient(responses);
    await assert.rejects(journal(client).readDeletionIntents(), DeletionJournalUnavailableError);
    assert.equal(requests.length, 102);
    assert.ok(requests.every(request => request.params.alt === undefined));
});
