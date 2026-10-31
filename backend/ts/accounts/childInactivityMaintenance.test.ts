import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { Pool } from 'mysql2/promise';
import { runChildInactivityMaintenance } from './childInactivityMaintenance';
import { InactivityDeletionUncertainError, type InactivityStore, type RetentionJournal } from './childInactivityWorkflow';

const parent = '11111111-1111-4111-8111-111111111111';
const first = '22222222-2222-4222-8222-222222222222';
const second = '33333333-3333-4333-8333-333333333333';
const third = '44444444-4444-4444-8444-444444444444';
const store = {} as InactivityStore;
const journal = {} as RetentionJournal;
function database(rows: unknown[]): Pick<Pool, 'query'> {
    return { query: async () => [rows, []] } as unknown as Pick<Pool, 'query'>;
}

test('bounded maintenance examines only a page and returns a private continuation cursor', async () => {
    const seen: string[] = [];
    const report = await runChildInactivityMaintenance(database([
        { parentId: parent, childId: first }, { parentId: parent, childId: second }, { parentId: parent, childId: third },
    ]), store, journal, { afterChildId: null, batchSize: 2 }, async (_store, _journal, _parent, child) => {
        seen.push(child); return child === first ? 'held' : 'deleted';
    });
    assert.deepEqual(seen, [first, second]);
    assert.deepEqual(report, { examined: 2, held: 1, deleted: 1, nextAfterChildId: second });
});

test('malformed, repeated or unordered candidates cause no deletion', async () => {
    for (const rows of [
        [{ parentId: parent, childId: first }, { parentId: parent, childId: first }],
        [{ parentId: parent, childId: second }, { parentId: parent, childId: first }],
        [{ parentId: parent, childId: first }, { parentId: parent, childId: third, extra: true }],
    ]) {
        let calls = 0;
        await assert.rejects(runChildInactivityMaintenance(database(rows), store, journal,
            { afterChildId: null }, async () => { calls++; return 'deleted'; }));
        assert.equal(calls, 0);
    }
});

test('uncertain deletion aborts the batch without retrying or touching the next account', async () => {
    let calls = 0;
    await assert.rejects(runChildInactivityMaintenance(database([
        { parentId: parent, childId: first }, { parentId: parent, childId: second },
    ]), store, journal, { afterChildId: null }, async () => {
        calls++; throw new InactivityDeletionUncertainError(new Error('synthetic lost acknowledgement'));
    }), InactivityDeletionUncertainError);
    assert.equal(calls, 1);
});

test('rejects invalid bounds before contacting the database', async () => {
    let queried = false;
    const db = { query: async () => { queried = true; return [[], []]; } } as unknown as Pick<Pool, 'query'>;
    for (const batchSize of [0, 101, 1.5]) {
        await assert.rejects(runChildInactivityMaintenance(db, store, journal, { afterChildId: null, batchSize }));
    }
    await assert.rejects(runChildInactivityMaintenance(db, store, journal, { afterChildId: 'not-an-account' }));
    assert.equal(queried, false);
});
