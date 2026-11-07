import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { assertWitnessKeyCoverage } from './witnessKeyCoverage';

const live = '572ed45a-c57d-4c82-9b50-d4585331bcec', deleted = 'b5612c48-c0ba-4324-b055-e6c2f79af10d';
const activity = Buffer.alloc(32, 1), warning = Buffer.alloc(32, 2);
function event(id: string, key: Buffer) {
    const tag = createHmac('sha256', key).update('ludolume-child-head-id-v1\0').update(id).digest('hex');
    return { name: `v1/events/${tag}/000000000001.json`, generation: '1' };
}
test('covers live and journaled deleted accounts with both keys', () => {
    const objects = [event(live, activity), event(deleted, warning)];
    assert.doesNotThrow(() => assertWitnessKeyCoverage([live, deleted], activity, warning, objects));
    assert.throws(() => assertWitnessKeyCoverage([live], activity, warning, objects));
    assert.throws(() => assertWitnessKeyCoverage([live, deleted], Buffer.alloc(32, 3), warning, objects));
    assert.throws(() => assertWitnessKeyCoverage([live, deleted], activity, activity, objects));
});
test('rejects unknown objects but permits an actually empty bucket', () => {
    assert.throws(() => assertWitnessKeyCoverage([live], activity, warning, [{ name: 'unknown', generation: '1' }]));
    assert.doesNotThrow(() => assertWitnessKeyCoverage([live], activity, warning, []));
});
