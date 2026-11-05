import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import test from 'node:test';
import { createContinuityHead, type ContinuityHeadStorage } from './childContinuityHead';
import type { JournalHttpClient } from './gcsDeletionJournal';
import { createRetirementWitnessStorage } from './retirementWitnessStorage';

const child = '572ed45a-c57d-4c82-9b50-d4585331bcec';
const key = Buffer.alloc(32, 9), bucket = 'synthetic-continuity';

async function fixture(noncurrent = false) {
    let current: Awaited<ReturnType<ContinuityHeadStorage['read']>> = { kind: 'absent', historyEmpty: true };
    const memory: ContinuityHeadStorage = { async read() { return current; }, async replace(name, body) {
        current = { kind: 'found', name, body, generation: '123', live: true }; return current;
    } };
    const head = createContinuityHead(memory, key, 10_000, 'distinct-objects');
    const now = 1_800_000_000_000, request = Buffer.from('request'), state = Buffer.from('state');
    await head.initializeNew(child, head.issueOperation(child, request, now), now, request, state);
    const saved = await memory.read('', new AbortController().signal);
    if (saved.kind !== 'found') throw new Error();
    let body = saved.body, live = true, deleted = false, writes = 0, loseAck = false;
    const tag = createHmac('sha256', key).update('ludolume-child-head-id-v1\0').update(child).digest('hex');
    const name = `v1/events/${tag}/000000000001.json`;
    const item = () => ({ bucket, name, generation: '123', metageneration: '1', size: String(Buffer.byteLength(body)),
        md5Hash: createHash('md5').update(body).digest('base64'), ...(deleted ? { softDeleteTime: '2026-11-05T00:00:00Z' } : {}) });
    const client: JournalHttpClient = { async request(input) {
        if (input.url.endsWith('/o')) {
            const included = live && (input.params.prefix === undefined || name.startsWith(String(input.params.prefix)));
            const older = { ...item(), generation: '122', timeDeleted: '2026-11-04T00:00:00Z' };
            return { status: 200, data: { kind: 'storage#objects', ...(included ? { items: noncurrent ? [older, item()] : [item()] } : {}) } };
        }
        if (input.method === 'DELETE') {
            writes++; assert.equal(input.params.generation, '123'); assert.equal(input.params.ifGenerationMatch, '123');
            assert.equal(input.params.ifMetagenerationMatch, '1'); live = false; deleted = true;
            if (loseAck) throw new Error('response lost');
            return { status: 204, data: undefined };
        }
        if (input.params.softDeleted) return { status: deleted ? 200 : 404, data: item() };
        return { status: live ? 200 : 404, data: input.params.alt === 'media' ? body : item() };
    } };
    return { storage: createRetirementWitnessStorage(client, bucket), get writes() { return writes; },
        tamper() { body = body.replace('"sequence":1', '"sequence":2'); }, loseAck() { loseAck = true; } };
}

test('inventories an authenticated exact witness and verifies its soft deletion', async () => {
    const f = await fixture(), entries = await f.storage.list(child, key);
    assert.equal(entries.length, 1);
    assert.equal((await f.storage.listAllIdentities()).length, 1);
    await assert.rejects(f.storage.assertEmpty(child, key));
    await f.storage.remove(entries[0]);
    await f.storage.assertEmpty(child, key);
    assert.deepEqual(await f.storage.listAllIdentities(), []);
    assert.equal(f.writes, 1);
});

test('rejects tampering and does not retry a deletion after a lost acknowledgement', async () => {
    const invalid = await fixture(); invalid.tamper();
    await assert.rejects(invalid.storage.list(child, key));
    assert.equal(invalid.writes, 0);
    const f = await fixture(), entries = await f.storage.list(child, key); f.loseAck();
    await assert.rejects(f.storage.remove(entries[0]));
    assert.equal(f.writes, 1);
    await f.storage.assertEmpty(child, key);
});

test('authenticates distinct noncurrent and live generations of the same witness', async () => {
    const f = await fixture(true), entries = await f.storage.list(child, key);
    assert.deepEqual(entries.map(entry => entry.generation), ['122', '123']);
});
