import assert from 'node:assert/strict';
import test from 'node:test';
import { ContinuityHeadUnavailableError, createContinuityHead, type ContinuityHead, type ContinuityHeadStorage,
    type ContinuityLedgerRow, type ContinuityOperation } from './childContinuityHead';

const child = '572ed45a-c57d-4c82-9b50-d4585331bcec';
const other = 'b5612c48-c0ba-4324-b055-e6c2f79af10d';
const key = Buffer.alloc(32, 9);
const now = 1_800_000_000_000;
const request = Buffer.from('synthetic canonical transition');
const state = Buffer.from('synthetic canonical child state');
const day = 24 * 60 * 60 * 1000;
const held = ContinuityHeadUnavailableError;

function fixture() {
    type Read = Awaited<ReturnType<ContinuityHeadStorage['read']>>;
    let current: Read = { kind: 'absent', historyEmpty: true };
    let generation = 100; let reads = 0; let writes = 0;
    let readTransform: (value: Read, count: number) => Read = value => value;
    let hook: ((signal: AbortSignal) => Promise<void>) | undefined;
    let lostResponse = false;
    const storage: ContinuityHeadStorage = {
        async read() { return readTransform({ ...current }, ++reads); },
        async replace(name, body, expected, signal) {
            writes++;
            if (hook) await hook(signal);
            const actual = current.kind === 'found' ? current.generation : '0';
            if (actual !== expected) throw new Error('precondition failed');
            current = { kind: 'found', name, body, generation: String(++generation), live: true };
            if (lostResponse) throw new Error('response lost');
            return { ...current };
        },
    };
    const raw = createContinuityHead(storage, key);
    const witness = { ...raw,
        issueOperation: (id: string, _digest: string, at: number) => raw.issueOperation(id, request, at),
        initializeNew: (id: string, operation: ContinuityOperation, at: number) => raw.initializeNew(id, operation, at, request, state),
        verifyExisting: (id: string, head: ContinuityHead, rows: readonly ContinuityLedgerRow[]) => raw.verifyExisting(id, head, rows, state, now),
        prepareExisting: (id: string, head: ContinuityHead, operation: ContinuityOperation, rows: readonly ContinuityLedgerRow[], at: number) =>
            raw.prepareExisting(id, head, operation, rows, at, request, state, state),
    };
    const issue = (letter: string, at = now) => witness.issueOperation(child, letter.repeat(64), at);
    return { storage, witness, raw, issue, get reads() { return reads; }, get writes() { return writes; },
        get current() { return current; }, set current(value: Read) { current = value; },
        alter(fn: typeof readTransform) { readTransform = fn; }, setLost(value: boolean) { lostResponse = value; },
        setHook(fn: typeof hook) { hook = fn; } };
}

test('bounded head and ledger record each transition and match exact SQL state', async () => {
    const f = fixture(); const first = await f.witness.initializeNew(child, f.issue('a'), now);
    assert.equal(first.head.sequence, 1); assert.equal(f.reads, 4); assert.equal(f.writes, 1);
    await f.witness.verifyExisting(child, first.head, first.ledgerRows);
    const second = await f.witness.prepareExisting(child, first.head, f.issue('b'), first.ledgerRows, now);
    assert.equal(second.status, 'prepared'); if (second.status !== 'prepared') throw new Error();
    assert.equal(second.head.sequence, 2); assert.notEqual(second.head.generation, first.head.generation);
    await f.witness.verifyExisting(child, second.head, [...second.ledgerRows].reverse());
    assert(!JSON.stringify(f.current).includes(child)); assert(!JSON.stringify(f.current).includes('email'));
    assert.equal(f.writes, 2);
});

test('archived event inspection authenticates the child, generation and exact envelope', async () => {
    const f = fixture(); await f.witness.initializeNew(child, f.issue('a'), now);
    if (f.current.kind !== 'found') throw new Error();
    assert.equal(f.raw.inspectArchivedEvent(child, f.current.generation, f.current.body).sequence, 1);
    assert.throws(() => f.raw.inspectArchivedEvent(other, f.current.kind === 'found' ? f.current.generation : '0',
        f.current.kind === 'found' ? f.current.body : ''), held);
    assert.throws(() => f.raw.inspectArchivedEvent(child, '0', f.current.kind === 'found' ? f.current.body : ''), held);
    assert.throws(() => f.raw.inspectArchivedEvent(child, f.current.kind === 'found' ? f.current.generation : '0',
        f.current.kind === 'found' ? f.current.body.replace('"sequence":1', '"sequence":2') : ''), held);
});

test('SQL restore, partial ledger restore, missing head, or recreated old head holds', async () => {
    const f = fixture(); const first = await f.witness.initializeNew(child, f.issue('a'), now); const old = f.current;
    const next = await f.witness.prepareExisting(child, first.head, f.issue('b'), first.ledgerRows, now);
    assert.equal(next.status, 'prepared'); if (next.status !== 'prepared') throw new Error();
    await assert.rejects(f.witness.verifyExisting(child, first.head, first.ledgerRows), held);
    await assert.rejects(f.witness.verifyExisting(child, next.head, next.ledgerRows.slice(1)), held);
    await assert.rejects(f.witness.prepareExisting(child, next.head, f.issue('c'), next.ledgerRows.slice(1), now), held);
    await assert.rejects(f.raw.verifyExisting(child, next.head, next.ledgerRows, Buffer.from('restored old activity or warning'), now), held);
    await assert.rejects(f.raw.prepareExisting(child, next.head, f.issue('d'), next.ledgerRows, now, request,
        Buffer.from('restored old contact'), state), held);
    f.current = { kind: 'absent', historyEmpty: true };
    await assert.rejects(f.witness.verifyExisting(child, next.head, next.ledgerRows), held);
    if (old.kind !== 'found') throw new Error();
    f.current = { ...old, generation: '987654' };
    await assert.rejects(f.witness.verifyExisting(child, first.head, first.ledgerRows), held);
});

test('prepared state is rechecked against actual SQL state before commit', async () => {
    const f = fixture(); const first = await f.witness.initializeNew(child, f.issue('a'), now);
    const nextState = Buffer.from('synthetic updated child state');
    const next = await f.raw.prepareExisting(child, first.head, f.issue('b'), first.ledgerRows, now,
        request, state, nextState);
    assert.equal(next.status, 'prepared'); if (next.status !== 'prepared') throw new Error();
    await f.raw.verifyExisting(child, next.head, next.ledgerRows, nextState, now);
    await assert.rejects(f.raw.verifyExisting(child, next.head, next.ledgerRows, state, now), held);
});

test('committed operations retry without a write even after later committed transitions', async () => {
    const f = fixture(); const firstOp = f.issue('a'); const first = await f.witness.initializeNew(child, firstOp, now);
    assert.deepEqual(await f.witness.prepareExisting(child, first.head, firstOp, first.ledgerRows, now),
        { status: 'already-committed', sequence: 1 });
    assert.equal(f.writes, 1);
    const operation = f.issue('b');
    const second = await f.witness.prepareExisting(child, first.head, operation, first.ledgerRows, now);
    assert.equal(second.status, 'prepared'); if (second.status !== 'prepared') throw new Error();
    assert.deepEqual(await f.witness.prepareExisting(child, second.head, operation, second.ledgerRows, now),
        { status: 'already-committed', sequence: 2 });
    const third = await f.witness.prepareExisting(child, second.head, f.issue('c'), second.ledgerRows, now);
    assert.equal(third.status, 'prepared'); if (third.status !== 'prepared') throw new Error();
    assert.deepEqual(await f.witness.prepareExisting(child, third.head, operation, third.ledgerRows, now),
        { status: 'already-committed', sequence: 2 });
    assert.equal(f.writes, 3);
    await assert.rejects(f.witness.prepareExisting(child, third.head, { ...operation, requestDigest: 'd'.repeat(64) }, third.ledgerRows, now), TypeError);
    await assert.rejects(f.witness.prepareExisting(child, third.head, operation, third.ledgerRows.map(row => ({ ...row, childId: other })), now), held);
});

test('operation tokens are child-bound and expire before old rows can be replayed', async () => {
    const f = fixture(); const firstOp = f.issue('a'); const first = await f.witness.initializeNew(child, firstOp, now);
    await assert.rejects(f.witness.prepareExisting(child, first.head, firstOp, first.ledgerRows, now + day + 1), TypeError);
    await assert.rejects(f.witness.initializeNew(other, firstOp, now), TypeError);
    const currentOp = f.issue('b', now + day);
    const second = await f.witness.prepareExisting(child, first.head, currentOp, first.ledgerRows, now + day);
    assert.equal(second.status, 'prepared'); if (second.status !== 'prepared') throw new Error();
    assert.equal(second.ledgerRows.length, 2, 'the row is retained at its expiration instant');
    const after = f.issue('c', now + day + 1);
    const third = await f.witness.prepareExisting(child, second.head, after, second.ledgerRows, now + day + 1);
    assert.equal(third.status, 'prepared'); if (third.status !== 'prepared') throw new Error();
    assert.equal(third.ledgerRows.length, 2, 'expired rows are pruned only in the next witnessed transaction');
    await assert.rejects(f.witness.prepareExisting(child, third.head, firstOp, third.ledgerRows, now + day + 1), TypeError);
    await assert.rejects(f.witness.prepareExisting(child, third.head, firstOp, third.ledgerRows, now + day), held,
        'a regressed SQL clock must not revive a pruned operation');
    await assert.rejects(f.raw.prepareExisting(child, third.head, after, third.ledgerRows, now + day + 1,
        Buffer.from('different canonical transition'), state, state), TypeError);
});

test('a lost write response or failed SQL transaction leaves a persistent hold', async () => {
    const f = fixture(); const first = await f.witness.initializeNew(child, f.issue('a'), now); f.setLost(true);
    const operation = f.issue('b');
    await assert.rejects(f.witness.prepareExisting(child, first.head, operation, first.ledgerRows, now), held);
    await assert.rejects(f.witness.verifyExisting(child, first.head, first.ledgerRows), held);
    await assert.rejects(f.witness.prepareExisting(child, first.head, operation, first.ledgerRows, now), held);
    assert.equal(f.writes, 2);
});

test('concurrent transitions from one predecessor cannot both prepare', async () => {
    const f = fixture(); const first = await f.witness.initializeNew(child, f.issue('a'), now);
    let count = 0; let release!: () => void; const both = new Promise<void>(resolve => { release = resolve; });
    f.setHook(async () => { if (++count === 2) release(); await both; });
    const results = await Promise.allSettled([
        f.witness.prepareExisting(child, first.head, f.issue('b'), first.ledgerRows, now),
        f.witness.prepareExisting(child, first.head, f.issue('c'), first.ledgerRows, now),
    ]);
    assert.equal(results.filter(v => v.status === 'fulfilled').length, 1);
    assert.equal(results.filter(v => v.status === 'rejected').length, 1);
});

test('altered data, historical ambiguity, ledger corruption and unstable reads hold', async () => {
    type Read = Awaited<ReturnType<ContinuityHeadStorage['read']>>;
    for (const mutate of [
        (value: Read) => value.kind === 'found' ? { ...value, body: value.body.replace('"version":1', '"version":2') } : value,
        (value: Read) => value.kind === 'found' ? { ...value, generation: '0' } : value,
        (value: Read) => value.kind === 'found' ? { ...value, generation: 101 } as unknown as Read : value,
        () => ({ kind: 'absent', historyEmpty: false } as unknown as Read),
    ]) {
        const f = fixture(); const first = await f.witness.initializeNew(child, f.issue('a'), now); f.alter(mutate);
        await assert.rejects(f.witness.verifyExisting(child, first.head, first.ledgerRows), held);
    }
    const f = fixture(); const first = await f.witness.initializeNew(child, f.issue('a'), now);
    await assert.rejects(f.witness.verifyExisting(child, first.head, [...first.ledgerRows, first.ledgerRows[0]]), held);
    await assert.rejects(f.witness.verifyExisting(child, first.head, Array(2049).fill(first.ledgerRows[0])), held);
    await assert.rejects(f.witness.verifyExisting(child, first.head, first.ledgerRows.map(row => ({ ...row, token: '0'.repeat(64) }))), held);
    let shared: Read | undefined;
    f.alter((value, index) => {
        if (!shared) shared = value;
        if (index % 2 === 0 && shared.kind === 'found') (shared as { generation: string }).generation = '999';
        return shared;
    });
    await assert.rejects(f.witness.verifyExisting(child, first.head, first.ledgerRows), held);
});

test('caller objects are snapshotted before awaiting untrusted adapter calls', async () => {
    const f = fixture(); const first = await f.witness.initializeNew(child, f.issue('a'), now);
    const operation = { ...f.issue('b') }; const head = { ...first.head };
    const rows = first.ledgerRows.map(row => ({ ...row })); const originalId = operation.id;
    f.alter(value => { operation.id = 'f'.repeat(64); head.generation = '999'; rows[0].token = '0'.repeat(64); return value; });
    const prepared = await f.witness.prepareExisting(child, head, operation, rows, now);
    assert.equal(prepared.status, 'prepared'); if (prepared.status !== 'prepared') throw new Error();
    assert.equal(prepared.ledgerRows[1].id, originalId);
    assert.equal(prepared.ledgerRows[0].token, first.ledgerRows[0].token);
});

test('timeouts abort uncertain writes without retries and malformed inputs fail', async () => {
    const f = fixture(); const witness = createContinuityHead(f.storage, key, 15);
    const first = await witness.initializeNew(child, witness.issueOperation(child, request, now), now, request, state);
    let signal: AbortSignal | undefined;
    f.setHook(async current => { signal = current; await new Promise<void>(() => {}); });
    const second = witness.issueOperation(child, request, now);
    await assert.rejects(witness.prepareExisting(child, first.head, second, first.ledgerRows, now, request, state, state), held);
    assert.equal(signal?.aborted, true); assert.equal(f.writes, 2);
    await assert.rejects(witness.prepareExisting(child, first.head, { ...second, id: 'bad' }, first.ledgerRows, now, request, state, state), TypeError);
    await assert.rejects(witness.verifyExisting(child, null as never, [], state, now), held);
    await assert.rejects(witness.verifyExisting(child, { ...first.head, generation: 101 } as unknown as ContinuityHead, first.ledgerRows, state, now), held);
});
