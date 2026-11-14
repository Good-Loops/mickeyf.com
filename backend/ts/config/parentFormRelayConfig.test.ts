import assert from 'node:assert/strict';
import test from 'node:test';
import { parentFormRelayEnabled } from './parentFormRelayConfig';

test('relay recording defaults off and requires all lifecycle dependencies', () => {
    const ready = { signedForms: true, appleNotifications: true, maintenance: true };
    assert.equal(parentFormRelayEnabled(undefined, ready), false);
    assert.equal(parentFormRelayEnabled('0', ready), false);
    assert.equal(parentFormRelayEnabled('1', ready), true);
    for (const value of ['', 'true', '01', ' 1', '2']) assert.throws(() => parentFormRelayEnabled(value, ready));
    for (const dependency of Object.keys(ready)) assert.throws(() => parentFormRelayEnabled('1', { ...ready, [dependency]: false }));
});
