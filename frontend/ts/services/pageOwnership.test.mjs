import assert from 'node:assert/strict';
import test from 'node:test';
import { capturePageOwnership, requestIsCurrent, sameAccountIds } from './pageOwnership.ts';

test('page ownership ignores query and hash but rejects a changed pathname', t => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const window = { location: { pathname: '/parent-accounts', search: '', hash: '' } };
    Object.defineProperty(globalThis, 'window', { configurable: true, value: window });
    t.after(() => previous ? Object.defineProperty(globalThis, 'window', previous) : delete globalThis.window);
    const current = capturePageOwnership();
    window.location.search = '?synthetic=1'; window.location.hash = '#help';
    assert.equal(current(), true);
    window.location.pathname = '/'; assert.equal(current(), false);
});

test('failed ownership checks are rejected and confirmed family IDs preserve duplicates', () => {
    assert.equal(requestIsCurrent(() => { throw new Error('stale'); }), false);
    assert.equal(sameAccountIds(['a', 'a'], ['a', 'b']), false);
    assert.equal(sameAccountIds(['a', 'b'], ['b', 'a']), true);
    assert.equal(sameAccountIds(['a'], ['a', 'a']), false);
});
