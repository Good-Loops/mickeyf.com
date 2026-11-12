import assert from 'node:assert/strict';
import test from 'node:test';
import { readAppStoreTransaction } from './appStoreTransaction.ts';

const signedTransaction = 'fictionalHeader.fictionalPayload.fictionalSignature';
const fixture = result => ({ isIos: () => true, load: () => ({
    async readSignedTransaction(options) { assert.deepEqual(options, {}); return result; },
}) });

test('does not access the native bridge on web or Android', async () => {
    assert.deepEqual(await readAppStoreTransaction({ isIos: () => false, load: () => { throw Error('not called'); } }),
        { kind: 'unsupported' });
});

test('returns a well-formed signed transaction only when explicitly requested', async () => {
    assert.deepEqual(await readAppStoreTransaction(fixture({ status: 'available', signedTransaction })),
        { kind: 'available', signedTransaction });
    assert.deepEqual(await readAppStoreTransaction(fixture({ status: 'unsupported' })), { kind: 'unsupported' });
});

test('does not return malformed, oversized or unexpected native data', async () => {
    for (const result of [null, {}, { status: 'unavailable' }, { status: 'available', signedTransaction: '' },
        { status: 'available', signedTransaction: 'not.a.jwt.more' },
        { status: 'available', signedTransaction: `${'x'.repeat(65_536)}.x.x` },
        { status: 'available', signedTransaction, deviceIdentifier: 'unexpected' }, { status: 'unsupported', extra: true }]) {
        assert.deepEqual(await readAppStoreTransaction(fixture(result)), { kind: 'unavailable' });
    }
});

test('native errors and timeouts leave the transaction unavailable', async () => {
    assert.deepEqual(await readAppStoreTransaction({ isIos: () => { throw Error('private'); } }), { kind: 'unavailable' });
    assert.deepEqual(await readAppStoreTransaction({ isIos: () => true, load: () => { throw Error('private'); } }),
        { kind: 'unavailable' });
    assert.deepEqual(await readAppStoreTransaction({ isIos: () => true, timeoutMs: 5,
        load: () => ({ readSignedTransaction: () => new Promise(() => {}) }) }), { kind: 'unavailable' });
});
