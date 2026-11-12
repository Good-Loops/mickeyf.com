import assert from 'node:assert/strict';
import test from 'node:test';
import { VerificationException, VerificationStatus, type SignedDataVerifier } from '@apple/app-store-server-library';
import { readAppStoreTransaction } from './appStoreTransaction';

test('only returns an identifier after the signed app transaction verifies', async () => {
    let calls = 0;
    const verifier: Pick<SignedDataVerifier, 'verifyAndDecodeAppTransaction'> = {
        async verifyAndDecodeAppTransaction() { calls++; return { appTransactionId: 'fictional-apple-app-id' }; },
    };
    for (const invalid of [undefined, '', 'x'.repeat(65_537)]) {
        assert.deepEqual(await readAppStoreTransaction(invalid, verifier), { kind: 'invalid' });
    }
    assert.equal(calls, 0);
    assert.deepEqual(await readAppStoreTransaction('signed-test-transaction', verifier),
        { kind: 'verified', appTransactionId: 'fictional-apple-app-id' });
    assert.equal(calls, 1);
});

test('invalid certificates and temporary verifier failures remain distinct', async () => {
    const verifier: Pick<SignedDataVerifier, 'verifyAndDecodeAppTransaction'> = {
        async verifyAndDecodeAppTransaction() { throw new VerificationException(VerificationStatus.INVALID_CERTIFICATE); },
    };
    assert.deepEqual(await readAppStoreTransaction('forged', verifier), { kind: 'invalid' });
    verifier.verifyAndDecodeAppTransaction = async () => { throw new VerificationException(VerificationStatus.RETRYABLE_VERIFICATION_FAILURE); };
    assert.deepEqual(await readAppStoreTransaction('signed-test-transaction', verifier), { kind: 'unavailable' });
});
