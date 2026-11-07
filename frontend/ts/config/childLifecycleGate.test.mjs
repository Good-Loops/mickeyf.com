import assert from 'node:assert/strict';
import test from 'node:test';
import { isChildLifecycleEnabled } from './childLifecycleGate.ts';

test('child activity and parent warning are enabled only together and by explicit opt-in', () => {
    for (const [activity, warning] of [[undefined, undefined], ['1', undefined], [undefined, '1'], ['0', '1'], ['1', '0'], ['true', 'true']]) {
        assert.equal(isChildLifecycleEnabled(activity, warning), false);
    }
    assert.equal(isChildLifecycleEnabled('1', '1'), true);
});
