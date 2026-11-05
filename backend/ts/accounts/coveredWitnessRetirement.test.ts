import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { createCoveredWitnessRetirement } from './coveredWitnessRetirement';
import type { RetirementWitness } from './retirementWitnessStorage';

const account = '572ed45a-c57d-4c82-9b50-d4585331bcec', other = 'b5612c48-c0ba-4324-b055-e6c2f79af10d';
const activity = Buffer.alloc(32, 1), warning = Buffer.alloc(32, 2);
function event(id: string, key: Buffer, generation: string): RetirementWitness {
    const tag = createHmac('sha256', key).update('ludolume-child-head-id-v1\0').update(id).digest('hex');
    return { name: `v1/events/${tag}/000000000001.json`, generation, metageneration: '1', contentSha256: 'a'.repeat(64) };
}
function fixture() {
    let items = [event(account, activity, '1'), event(account, warning, '2'), event(other, activity, '3')], unstable = false, reads = 0;
    const store = {
        async listAllIdentities() { reads++; return items.map(({ name, generation }) => ({ name, generation }))
            .concat(unstable && reads % 2 === 0 ? [{ name: 'changed', generation: '9' }] : []); },
        async list(id: string, key: Buffer) { const prefix = event(id, key, '1').name; return items.filter(item => item.name === prefix); },
        async remove(item: RetirementWitness) { items = items.filter(value => value.name !== item.name || value.generation !== item.generation); },
        async assertEmpty(id: string, key: Buffer) { assert.equal((await this.list(id, key)).length, 0); },
    };
    const create = (keys = { activityKey: activity, warningKey: warning }, accountIds = [account, other]) =>
        createCoveredWitnessRetirement({ ...keys, store, async listKnownAccountIds() { return accountIds; }, async verifyPolicy() {} });
    return { create, get count() { return items.length; }, makeUnstable() { unstable = true; } };
}
test('reconciles all witness names before removing only the deleted account', async () => {
    const f = fixture(), gate = f.create();
    await assert.rejects(gate.verifyWitnessesAbsent(account));
    await gate.retireWitnesses(account, async () => {}); await gate.verifyWitnessesAbsent(account);
    assert.equal(f.count, 1); gate.dispose();
});
test('wrong keys, unknown accounts and changing inventory cannot authorize deletion', async () => {
    const wrong = fixture(); await assert.rejects(wrong.create({ activityKey: Buffer.alloc(32, 8), warningKey: warning })
        .retireWitnesses(account, async () => {})); assert.equal(wrong.count, 3);
    const orphan = fixture(); await assert.rejects(orphan.create(undefined, [account]).retireWitnesses(account, async () => {}));
    assert.equal(orphan.count, 3);
    const unstable = fixture(); unstable.makeUnstable();
    await assert.rejects(unstable.create().retireWitnesses(account, async () => {})); assert.equal(unstable.count, 3);
});
