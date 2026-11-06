import assert from 'node:assert/strict';
import test from 'node:test';
import { interpretChildUsageLease } from './childDailyUsageLease.ts';

test('network latency can only shorten the local lease', () => {
    const response = { status: 'configured', remainingMs: 60_000, allowedForMs: 30_000 };
    assert.deepEqual(interpretChildUsageLease(response, 100, 1_100), { kind: 'active', remainingMs: 60_000, deadline: 30_100 });
    assert.deepEqual(interpretChildUsageLease(response, 100, 30_101), { kind: 'blocked', remainingMs: 60_000 });
    assert.deepEqual(interpretChildUsageLease({ ...response, remainingMs: 0, allowedForMs: 0 }, 100, 100), { kind: 'blocked', remainingMs: 0 });
});

test('unknown, inconsistent or malformed responses fail closed', () => {
    assert.deepEqual(interpretChildUsageLease({ status: 'not-configured' }, 0, 1), { kind: 'not-configured' });
    assert.deepEqual(interpretChildUsageLease({ status: 'not-managed' }, 0, 1), { kind: 'not-managed' });
    for (const response of [null, {}, { status: 'configured', remainingMs: 0, allowedForMs: 1 },
        { status: 'configured', remainingMs: 60_000, allowedForMs: 30_001 }, { status: 'unexpected' }]) {
        assert.throws(() => interpretChildUsageLease(response, 0, 1));
    }
    assert.throws(() => interpretChildUsageLease({ status: 'not-managed' }, 2, 1));
});
