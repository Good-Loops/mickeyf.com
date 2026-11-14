import assert from 'node:assert/strict';
import test from 'node:test';
import { retireAccountWitnesses } from './retireAccountWitnesses';
import type { RetirementWitness } from './retirementWitnessStorage';

const accountId = '572ed45a-c57d-4c82-9b50-d4585331bcec';
const activityKey = Buffer.alloc(32, 1), warningKey = Buffer.alloc(32, 2);
const event = (name: string): RetirementWitness => ({ name, generation: '1', metageneration: '1', contentSha256: 'a'.repeat(64) });

function fixture() {
    const groups = new Map([[1, [event('activity')]], [2, [event('warning')]]]);
    let checks = 0, deletes = 0, fail = false;
    const store = {
        async list(id: string, key: Buffer) { assert.equal(id, accountId); return [...(groups.get(key[0]) ?? [])]; },
        async remove(entry: RetirementWitness) {
            deletes++; for (const [key, entries] of groups) groups.set(key, entries.filter(value => value.name !== entry.name));
            if (fail) throw new Error('lost response');
        },
        async assertEmpty(_id: string, key: Buffer) { assert.equal(groups.get(key[0])?.length, 0); },
    };
    return { options: { accountId, activityKey, warningKey, store, async verifyBeforeDelete() { checks++; } },
        get checks() { return checks; }, get deletes() { return deletes; }, loseResponse() { fail = true; }, restoreResponse() { fail = false; } };
}

test('removes both authenticated witness streams with a fence before each removal', async () => {
    const f = fixture();
    assert.deepEqual(await retireAccountWitnesses(f.options), { removed: 2 });
    assert.equal(f.checks, 3); assert.equal(f.deletes, 2);
});

test('stops after uncertain removal and re-inventories on a later pass', async () => {
    const f = fixture(); f.loseResponse();
    await assert.rejects(retireAccountWitnesses(f.options));
    assert.equal(f.deletes, 1);
    f.restoreResponse();
    assert.deepEqual(await retireAccountWitnesses(f.options), { removed: 1 });
    assert.equal(f.deletes, 2);
    assert.deepEqual(activityKey, Buffer.alloc(32, 1));
});

test('rejects repeated keys and changed fences without deleting witnesses', async () => {
    const f = fixture();
    await assert.rejects(retireAccountWitnesses({ ...f.options, warningKey: activityKey }));
    await assert.rejects(retireAccountWitnesses({ ...f.options, verifyBeforeDelete: async () => { throw new Error(); } }));
    assert.equal(f.deletes, 0);
});
