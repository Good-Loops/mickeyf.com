import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { openAppendOnlyContinuitySession, type AppendOnlyObjectTransport } from './childContinuityAppendOnly';
import { ContinuityHeadUnavailableError, type ContinuityHead } from './childContinuityHead';

const child = '572ed45a-c57d-4c82-9b50-d4585331bcec';
const other = 'b5612c48-c0ba-4324-b055-e6c2f79af10d';
const bucket = 'synthetic-child-witness';
const key = Buffer.alloc(32, 9);
const request = Buffer.from('synthetic request');
const state = Buffer.from('synthetic child state');
const now = 1_800_000_000_000;
const held = ContinuityHeadUnavailableError;

function fixture() {
    type Entry = { bucket: string; name: string; generation: string; size: string; md5Hash: string;
        body: string; timeDeleted?: string; softDeleteTime?: string };
    const objects: Entry[] = [];
    const calls: Array<{ op: string; input: Record<string, unknown> }> = [];
    let nextGeneration = 10; let fixedGeneration: string | null = null; let loseResponse = false;
    let createHook: ((signal: AbortSignal) => Promise<void>) | undefined;
    let pageHook: ((input: Parameters<AppendOnlyObjectTransport['list']>[0], page: Awaited<ReturnType<AppendOnlyObjectTransport['list']>>) => Awaited<ReturnType<AppendOnlyObjectTransport['list']>>) | undefined;
    function metadata(entry: Entry) { const { body: _body, ...result } = entry; return result; }
    const transport: AppendOnlyObjectTransport = {
        async list(input) {
            calls.push({ op: 'list', input: { ...input, signal: undefined } });
            assert.equal(input.maxResults, 2);
            assert.match(input.fields, /nextPageToken/u);
            assert.notEqual(!!input.versions, !!input.softDeleted);
            const matches = objects.filter(item => item.bucket === input.bucket && item.name.startsWith(input.prefix)
                && item.name >= input.startOffset && (!!item.softDeleteTime === !!input.softDeleted));
            matches.sort((a, b) => a.name.localeCompare(b.name, 'en'));
            const page = { kind: 'storage#objects', items: matches.slice(0, 2).map(metadata),
                ...(matches.length > 2 ? { nextPageToken: 'more' } : {}) };
            return pageHook ? pageHook(input, page) : page;
        },
        async readBody(input) {
            calls.push({ op: 'read', input: { ...input, signal: undefined } });
            assert.equal(input.generation, input.ifGenerationMatch);
            const item = objects.find(value => value.bucket === input.bucket && value.name === input.name
                && value.generation === input.generation && !value.timeDeleted && !value.softDeleteTime);
            if (!item) throw new Error('not found'); return item.body;
        },
        async createOnly(input) {
            calls.push({ op: 'create', input: { ...input, body: '<omitted>', signal: undefined } });
            assert.equal(input.ifGenerationMatch, '0');
            if (createHook) await createHook(input.signal);
            if (objects.some(item => item.bucket === input.bucket && item.name === input.name
                && !item.timeDeleted && !item.softDeleteTime)) throw new Error('precondition failed');
            const created = { bucket: input.bucket, name: input.name, generation: fixedGeneration ?? String(++nextGeneration),
                size: String(Buffer.byteLength(input.body)), md5Hash: createHash('md5').update(input.body).digest('base64'), body: input.body };
            objects.push(created);
            if (loseResponse) throw new Error('response lost');
            return metadata(created);
        },
    };
    const open = (head?: ContinuityHead, timeoutMs?: number) => openAppendOnlyContinuitySession({ transport, bucket, expectedBucket: bucket, key,
        sequence: head?.sequence ?? 0, generation: head?.generation ?? '0', timeoutMs });
    return { transport, objects, calls, open, setLost(value: boolean) { loseResponse = value; },
        fixed(value: string) { fixedGeneration = value; }, page(fn: typeof pageHook) { pageHook = fn; },
        onCreate(fn: typeof createHook) { createHook = fn; } };
}

test('new child and repeated transitions write distinct create-only names with bounded reads', async () => {
    const f = fixture(); const initialSession = f.open();
    const first = await initialSession.initializeNew(child, initialSession.issueOperation(child, request, now), now, request, state);
    let current = first;
    for (let index = 0; index < 24; index++) {
        const w = f.open(current.head); const before = f.calls.length;
        const prepared = await w.prepareExisting(child, current.head, w.issueOperation(child, request, now), current.ledgerRows,
            now, request, state, state);
        assert.equal(prepared.status, 'prepared'); if (prepared.status !== 'prepared') throw new Error();
        await w.verifyExisting(child, prepared.head, prepared.ledgerRows, state, now);
        const operations = f.calls.slice(before);
        assert.equal(operations.filter(call => call.op === 'list').length, 12);
        assert.equal(operations.filter(call => call.op === 'read').length, 6);
        assert.equal(operations.filter(call => call.op === 'create').length, 1);
        current = prepared;
    }
    assert.equal(new Set(f.objects.map(object => object.name)).size, 25);
    assert(f.objects.every(object => /\/\d{12}\.json$/u.test(object.name)));
    assert(!JSON.stringify(f.objects).includes(child));
});

test('SQL restore or dangling write finds later evidence and holds even with identical cross-object generations', async () => {
    const f = fixture(); f.fixed('7'); const firstSession = f.open();
    const first = await firstSession.initializeNew(child, firstSession.issueOperation(child, request, now), now, request, state);
    const secondSession = f.open(first.head);
    const second = await secondSession.prepareExisting(child, first.head, secondSession.issueOperation(child, request, now),
        first.ledgerRows, now, request, state, state);
    assert.equal(second.status, 'prepared'); if (second.status !== 'prepared') throw new Error();
    assert.equal(first.head.generation, second.head.generation);
    await assert.rejects(f.open(first.head).verifyExisting(child, first.head, first.ledgerRows, state, now), held);
    await f.open(second.head).verifyExisting(child, second.head, second.ledgerRows, state, now);
});

test('lost create response leaves later evidence and does not retry or advance SQL', async () => {
    const f = fixture(); const firstSession = f.open();
    const first = await firstSession.initializeNew(child, firstSession.issueOperation(child, request, now), now, request, state);
    const w = f.open(first.head); const operation = w.issueOperation(child, request, now); f.setLost(true);
    await assert.rejects(w.prepareExisting(child, first.head, operation, first.ledgerRows, now, request, state, state), held);
    assert.equal(f.objects.length, 2);
    await assert.rejects(f.open(first.head).prepareExisting(child, first.head, operation, first.ledgerRows, now, request, state, state), held);
    assert.equal(f.calls.filter(call => call.op === 'create').length, 2);
});

test('replayed committed operation returns its ledger result without creating another event', async () => {
    const f = fixture(); const initial = f.open(); const firstOp = initial.issueOperation(child, request, now);
    const first = await initial.initializeNew(child, firstOp, now, request, state);
    const secondSession = f.open(first.head); const secondOp = secondSession.issueOperation(child, request, now);
    const second = await secondSession.prepareExisting(child, first.head, secondOp, first.ledgerRows, now, request, state, state);
    assert.equal(second.status, 'prepared'); if (second.status !== 'prepared') throw new Error();
    const retry = await f.open(second.head).prepareExisting(child, second.head, secondOp, second.ledgerRows, now, request, state, state);
    assert.deepEqual(retry, { status: 'already-committed', sequence: 2 }); assert.equal(f.objects.length, 2);
});

test('concurrent writers from one predecessor cannot both create the same next name', async () => {
    const f = fixture(); const initial = f.open();
    const first = await initial.initializeNew(child, initial.issueOperation(child, request, now), now, request, state);
    let count = 0; let release!: () => void; const both = new Promise<void>(resolve => { release = resolve; });
    f.onCreate(async () => { if (++count === 2) release(); await both; });
    const one = f.open(first.head); const two = f.open(first.head);
    const results = await Promise.allSettled([
        one.prepareExisting(child, first.head, one.issueOperation(child, request, now), first.ledgerRows, now, request, state, state),
        two.prepareExisting(child, first.head, two.issueOperation(child, request, now), first.ledgerRows, now, request, state, state),
    ]);
    assert.equal(results.filter(value => value.status === 'fulfilled').length, 1);
    assert.equal(results.filter(value => value.status === 'rejected').length, 1);
    assert.equal(f.objects.length, 2);
});

test('a session is bound to one child and cannot be reused after any failed read', async () => {
    const f = fixture(); const w = f.open();
    const first = await w.initializeNew(child, w.issueOperation(child, request, now), now, request, state);
    await assert.rejects(w.initializeNew(other, w.issueOperation(other, request, now), now, request, state), held);
    await assert.rejects(w.verifyExisting(child, first.head, first.ledgerRows, state, now), held);
    assert.equal(f.objects.length, 1);
});

test('an internal SQL mismatch poisons the session even when storage reads succeeded', async () => {
    const f = fixture(); const initial = f.open();
    const first = await initial.initializeNew(child, initial.issueOperation(child, request, now), now, request, state);
    const session = f.open(first.head);
    await assert.rejects(session.verifyExisting(child, { ...first.head, token: '0'.repeat(64) }, first.ledgerRows, state, now));
    await assert.rejects(session.verifyExisting(child, first.head, first.ledgerRows, state, now), held);
    assert.throws(() => session.issueOperation(child, request, now), held);
});

test('a timed-out create poisons its session even if the transport later writes the event', async context => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture(); const initial = f.open();
    const first = await initial.initializeNew(child, initial.issueOperation(child, request, now), now, request, state);
    let unblock!: () => void; let started!: () => void;
    const delayed = new Promise<void>(resolve => { unblock = resolve; });
    const reachedCreate = new Promise<void>(resolve => { started = resolve; });
    f.onCreate(async () => { started(); await delayed; });
    const w = f.open(first.head, 20); const operation = w.issueOperation(child, request, now);
    const attempt = w.prepareExisting(child, first.head, operation, first.ledgerRows, now, request, state, state);
    await reachedCreate; context.mock.timers.tick(20); await assert.rejects(attempt, held);
    await assert.rejects(w.verifyExisting(child, first.head, first.ledgerRows, state, now), held);
    unblock(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.objects.length, 2, 'the provider can still complete an aborted request');
    await assert.rejects(w.verifyExisting(child, first.head, first.ledgerRows, state, now), held);
    await assert.rejects(f.open(first.head).verifyExisting(child, first.head, first.ledgerRows, state, now), held);
});

test('overlapping operations on one session fail closed, including append versus verification', async () => {
    for (const overlap of ['verify', 'append']) {
        const f = fixture(); const initial = f.open();
        const first = await initial.initializeNew(child, initial.issueOperation(child, request, now), now, request, state);
        let unblock!: () => void; let started!: () => void;
        const delayed = new Promise<void>(resolve => { unblock = resolve; });
        const reachedCreate = new Promise<void>(resolve => { started = resolve; });
        f.onCreate(async () => { started(); await delayed; });
        const w = f.open(first.head); const one = w.issueOperation(child, request, now);
        const two = w.issueOperation(child, request, now);
        const attempt = w.prepareExisting(child, first.head, one, first.ledgerRows, now, request, state, state);
        await reachedCreate;
        if (overlap === 'verify') await assert.rejects(w.verifyExisting(child, first.head, first.ledgerRows, state, now), held);
        else await assert.rejects(w.prepareExisting(child, first.head, two, first.ledgerRows, now, request, state, state), held);
        unblock(); await assert.rejects(attempt, held);
        await assert.rejects(w.verifyExisting(child, first.head, first.ledgerRows, state, now), held);
    }
});

test('a fresh mutation reserves the same next name before a delayed old create can complete', async context => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture(); const initial = f.open();
    const first = await initial.initializeNew(child, initial.issueOperation(child, request, now), now, request, state);
    let unblock!: () => void; let started!: () => void; let count = 0;
    const delayed = new Promise<void>(resolve => { unblock = resolve; });
    const reachedCreate = new Promise<void>(resolve => { started = resolve; });
    f.onCreate(async () => { if (++count === 1) { started(); await delayed; } });
    const old = f.open(first.head, 20); const oldOperation = old.issueOperation(child, request, now);
    const oldAttempt = old.prepareExisting(child, first.head, oldOperation, first.ledgerRows, now, request, state, state);
    await reachedCreate; context.mock.timers.tick(20); await assert.rejects(oldAttempt, held);
    const fresh = f.open(first.head); const freshOperation = fresh.issueOperation(child, request, now);
    const next = await fresh.prepareExisting(child, first.head, freshOperation, first.ledgerRows, now, request, state, state);
    assert.equal(next.status, 'prepared'); if (next.status !== 'prepared') throw new Error();
    unblock(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.objects.length, 2);
    await fresh.verifyExisting(child, next.head, next.ledgerRows, state, now);
});

test('simulated SQL deletion commits only when its own event wins the delayed-create race', async context => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    for (const deletionWins of [true, false]) {
        const f = fixture(); const initial = f.open();
        const first = await initial.initializeNew(child, initial.issueOperation(child, request, now), now, request, state);
        let unblock!: () => void; let started!: () => void; let count = 0;
        const delayed = new Promise<void>(resolve => { unblock = resolve; });
        const reachedCreate = new Promise<void>(resolve => { started = resolve; });
        f.onCreate(async () => { if (++count === 1) { started(); await delayed; } });
        const old = f.open(first.head, 20); const oldAttempt = old.prepareExisting(child, first.head,
            old.issueOperation(child, request, now), first.ledgerRows, now, request, state, state);
        await reachedCreate; context.mock.timers.tick(20); await assert.rejects(oldAttempt, held);
        if (!deletionWins) { unblock(); await new Promise(resolve => setImmediate(resolve)); }
        const deletion = f.open(first.head); let sqlDeleted = false;
        const deletionState = Buffer.from('synthetic deletion state');
        const performDeletion = async () => {
            const prepared = await deletion.prepareExisting(child, first.head, deletion.issueOperation(child, request, now),
                first.ledgerRows, now, request, state, deletionState);
            assert.equal(prepared.status, 'prepared'); if (prepared.status !== 'prepared') throw new Error();
            // Simulates a staged SQL mutation, not a real database transaction.
            await deletion.verifyExisting(child, prepared.head, prepared.ledgerRows, deletionState, now);
            sqlDeleted = true;
        };
        if (deletionWins) { await performDeletion(); unblock(); await new Promise(resolve => setImmediate(resolve)); }
        else await assert.rejects(performDeletion(), held);
        assert.equal(sqlDeleted, deletionWins);
        assert.equal(f.objects.length, 2);
    }
});

test('incomplete pages, hidden versions, soft deletions and malformed metadata always hold', async () => {
    for (const mutate of [
        (v: ReturnType<typeof fixture>) => v.page((_input, page) => ({ ...page, nextPageToken: 'unread-page' })),
        (v: ReturnType<typeof fixture>) => v.page((_input, page) => ({ ...page, kind: 'unexpected' })),
        (v: ReturnType<typeof fixture>) => v.page((_input, page) => ({ ...page, prefixes: ['unexpected'] })),
        (v: ReturnType<typeof fixture>) => { v.objects[0].timeDeleted = '2026-01-01'; },
        (v: ReturnType<typeof fixture>) => { v.objects.push({ ...v.objects[0], generation: '99', timeDeleted: '2026-01-01' }); },
        (v: ReturnType<typeof fixture>) => { v.objects.push({ ...v.objects[0], generation: '99', softDeleteTime: '2026-01-01' }); },
        (v: ReturnType<typeof fixture>) => { v.objects[0].md5Hash = 'bad'; },
        (v: ReturnType<typeof fixture>) => { v.objects[0].body += 'tampered'; },
    ]) {
        const f = fixture(); const w = f.open(); const first = await w.initializeNew(child, w.issueOperation(child, request, now), now, request, state);
        mutate(f);
        await assert.rejects(f.open(first.head).verifyExisting(child, first.head, first.ledgerRows, state, now), held);
    }
});

test('a deleted or noncurrent genesis object cannot be silently recreated', async () => {
    const f = fixture(); const w = f.open(); const first = await w.initializeNew(child, w.issueOperation(child, request, now), now, request, state);
    f.objects[0].timeDeleted = '2026-01-01';
    await assert.rejects(f.open().initializeNew(child, f.open().issueOperation(child, request, now), now, request, state), held);
    await assert.rejects(f.open(first.head).verifyExisting(child, first.head, first.ledgerRows, state, now), held);
    assert.equal(f.objects.length, 1);
});

test('config pins bucket and exact string generations', () => {
    const f = fixture();
    assert.throws(() => openAppendOnlyContinuitySession({ transport: f.transport, bucket, expectedBucket: 'other-bucket', key, sequence: 0, generation: '0' }), TypeError);
    assert.throws(() => openAppendOnlyContinuitySession({ transport: f.transport, bucket, expectedBucket: bucket, key, sequence: 1, generation: 3 as never }), TypeError);
});
