import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import test from 'node:test';
import type { PoolConnection } from 'mysql2/promise';
import { CHILD_ACTIVITY_CONTINUITY_BUCKET as bucket } from '../config/childActivityContinuity';
import { createActiveWitnessSource } from './activeWitnessRetirement';
import { createRetirementWitnessStorage } from './retirementWitnessStorage';
import { openAppendOnlyContinuitySession, type AppendOnlyObjectTransport } from './childContinuityAppendOnly';
import type { JournalHttpClient } from './gcsDeletionJournal';

const accountId = '572ed45a-c57d-4c82-9b50-d4585331bcec', parentId = '572ed45a-c57d-4c82-9b50-d4585331bced';
const activityKey = Buffer.alloc(32, 9), warningKey = Buffer.alloc(32, 8);
const now = Date.parse('2026-11-09T12:00:00.000Z');

async function fixture() {
    type Object = { name: string; generation: string; body: string; soft?: boolean };
    const objects: Object[] = [];
    let warningSoftOnly = false, pending = false, alteredSql = false, explicitParent = false;
    const metadata = (item: Object) => ({ bucket, name: item.name, generation: item.generation,
        size: String(Buffer.byteLength(item.body)), md5Hash: createHash('md5').update(item.body).digest('base64'),
        ...(item.soft ? { softDeleteTime: '2026-11-09T12:00:00Z' } : {}) });
    const warningPrefix = `v1/events/${createHmac('sha256', warningKey).update('ludolume-child-head-id-v1\0').update(accountId).digest('hex')}/`;
    const transport: AppendOnlyObjectTransport = {
        async list(input) {
            if (warningSoftOnly && input.softDeleted && input.prefix === warningPrefix) return { kind: 'storage#objects', nextPageToken: 'uncertain-initial-write' };
            const found = objects.filter(item => !!item.soft === !!input.softDeleted && item.name.startsWith(input.prefix)
                && item.name >= input.startOffset).sort((a, b) => a.name.localeCompare(b.name));
            return { kind: 'storage#objects', items: found.slice(0, 2).map(metadata), ...(found.length > 2 ? { nextPageToken: 'more' } : {}) };
        },
        async readBody(input) {
            const found = objects.find(item => !item.soft && item.name === input.name && item.generation === input.generation);
            assert.ok(found); return found.body;
        },
        async createOnly(input) {
            assert.equal(input.ifGenerationMatch, '0'); assert.ok(!objects.some(item => item.name === input.name));
            const item = { name: input.name, generation: String(objects.length + 1), body: input.body };
            objects.push(item); return metadata(item);
        },
    };
    const client: JournalHttpClient = { async request(input) {
        if (input.url.endsWith('/o')) return { status: 200, data: { kind: 'storage#objects', items: objects.filter(item =>
            !item.soft && (!input.params.prefix || item.name.startsWith(String(input.params.prefix))))
            .map(item => ({ ...metadata(item), metageneration: '1' })) } };
        const name = decodeURIComponent(input.url.slice(input.url.lastIndexOf('/') + 1));
        const found = objects.find(item => item.name === name && item.generation === input.params.generation);
        if (!found) return { status: 404, data: {} };
        if (input.method === 'DELETE') {
            assert.equal(input.params.ifGenerationMatch, found.generation); assert.equal(input.params.ifMetagenerationMatch, '1');
            found.soft = true; return { status: 204, data: undefined };
        }
        return { status: !!found.soft === !!input.params.softDeleted ? 200 : 404,
            data: input.params.alt === 'media' ? found.body : { ...metadata(found), metageneration: '1' } };
    } };
    const stateRow = { parentId, country: 'BR', policyDigest: 'a'.repeat(64), consentVersion: 'test-v1', activityAt: '2026-11-09T11:00:00.000000Z' };
    const state = Buffer.from(JSON.stringify({ version: 1, childId: accountId, parentId, country: stateRow.country,
        policyDigest: stateRow.policyDigest, consentVersion: stateRow.consentVersion, activityAt: stateRow.activityAt }));
    let session = openAppendOnlyContinuitySession({ transport, bucket, expectedBucket: bucket, key: activityKey, sequence: 0, generation: '0' });
    const request = Buffer.from('synthetic');
    let saved = await session.initializeNew(accountId, session.issueOperation(accountId, request, now), now, request, state);
    async function advance(save = true) {
        session = openAppendOnlyContinuitySession({ transport, bucket, expectedBucket: bucket, key: activityKey,
            sequence: saved.head.sequence, generation: saved.head.generation });
        const next = await session.prepareExisting(accountId, saved.head, session.issueOperation(accountId, request, now),
            saved.ledgerRows, now, request, state, state);
        assert.equal(next.status, 'prepared'); if (next.status !== 'prepared') throw new Error();
        if (save) saved = next;
    }
    await advance(); await advance();
    const connection = { async query(input: { sql: string }) {
        if (input.sql.includes('ORDER BY child_uuid')) return [[{ accountId }], []];
        if (input.sql.includes('JOIN users')) return [[{ parentId, nowUtc: '2026-11-09T12:00:00.000000Z' }], []];
        if (input.sql.includes('FROM parent_child_activity_continuity')) return [[{ head: JSON.stringify(saved.head), ledger: JSON.stringify(saved.ledgerRows) }], []];
        if (input.sql.includes('FROM parent_child_warning_history')) return [[], []];
        if (input.sql.includes('LEFT JOIN parent_managed_child_activity')) return [[{ ...stateRow, ...(alteredSql ? { consentVersion: 'tampered' } : {}) }], []];
        throw new Error('Unexpected SQL in read-only witness fixture.');
    } } as unknown as Pick<PoolConnection, 'query'>;
    const store = createRetirementWitnessStorage(client, bucket);
    const source = createActiveWitnessSource({ accountId, activityKey, warningKey, store, transport,
        explicit: { async readDeletionEntries() { return { entries: explicitParent ? [{ intent: { accountId: parentId } } as never] : [], digest: 'a'.repeat(64) }; } },
        conditional: { async readIntents() { return pending ? [{ childId: accountId } as never] : []; } },
        async verifyPolicy() {}, async inspect(entry) { return objects.find(item => item.name === entry.name)?.soft ? 'soft-deleted' : 'live'; } });
    return { source, connection, objects, advance, saved: () => JSON.stringify(saved),
        pending() { pending = true; }, pendingParent() { explicitParent = true; }, alterSql() { alteredSql = true; }, uncertainWarning() { warningSoftOnly = true; } };
}

test('selects only older authenticated witnesses and preserves SQL head and ledger through removal', async () => {
    const f = await fixture(), before = f.saved();
    const candidates = await f.source.candidates(f.connection);
    assert.deepEqual(candidates.map(item => item.name.slice(-17)), ['000000000001.json', '000000000002.json']);
    const [selected] = await f.source.verify(f.connection, [candidates[0]]);
    await f.source.remove(selected);
    assert.equal(await f.source.inspect(selected), 'soft-deleted');
    assert.equal((await f.source.candidates(f.connection)).length, 1);
    assert.equal(f.saved(), before);
    await f.advance();
    assert.equal((await f.source.candidates(f.connection)).length, 2, 'a newer independently valid head remains usable');
});

test('rejects current, duplicate, wrong-generation and wrong-content selections', async () => {
    const f = await fixture(), [selected] = await f.source.candidates(f.connection);
    for (const values of [[selected, selected], [{ ...selected, generation: '999' }], [{ ...selected, contentSha256: '0'.repeat(64) }],
        [{ ...selected, name: selected.name.replace('000000000001', '000000000003'), generation: '3' }], []]) {
        await assert.rejects(f.source.verify(f.connection, values));
    }
    assert.equal(f.objects.some(item => item.soft), false);
    await assert.rejects(f.source.inspect({ ...selected, name: `v1/events/${'f'.repeat(64)}/000000000001.json` }));
});

test('holds pending intents, changed SQL, future uncertain writes, duplicate generations and unknown key coverage', async () => {
    for (const change of [async (f: Awaited<ReturnType<typeof fixture>>) => f.pending(),
        async (f: Awaited<ReturnType<typeof fixture>>) => f.alterSql(),
        async (f: Awaited<ReturnType<typeof fixture>>) => f.pendingParent(),
        async (f: Awaited<ReturnType<typeof fixture>>) => f.advance(false),
        async (f: Awaited<ReturnType<typeof fixture>>) => f.uncertainWarning(),
        async (f: Awaited<ReturnType<typeof fixture>>) => f.objects.push({ ...f.objects[0], generation: '99' }),
        async (f: Awaited<ReturnType<typeof fixture>>) => f.objects.push({ ...f.objects[0], name: `v1/events/${'f'.repeat(64)}/000000000001.json` }),
        async (f: Awaited<ReturnType<typeof fixture>>) => { f.objects[0].body += ' '; }]) {
        const f = await fixture(); await change(f);
        await assert.rejects(f.source.candidates(f.connection));
        assert.equal(f.objects.some(item => item.soft), false);
    }
});
