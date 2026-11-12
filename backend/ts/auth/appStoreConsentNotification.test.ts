import assert from 'node:assert/strict';
import test from 'node:test';
import { VerificationException, VerificationStatus, type SignedDataVerifier } from '@apple/app-store-server-library';
import { readAppStoreConsentNotification } from './appStoreConsentNotification';

const notificationId = '6a45449e-988e-4a66-9968-211e92b3331c';
const base = { notificationType: 'RESCIND_CONSENT', notificationUUID: notificationId,
    signedDate: 1_800_000_000_000, appData: { signedAppTransactionInfo: 'signed-transaction' } };

function fixture(notification: unknown = base, transaction: unknown = { appTransactionId: 'fictional-install-id' }) {
    const calls: string[] = [];
    const verifier = {
        async verifyAndDecodeNotification(value: string) { calls.push(`notification:${value}`); return notification; },
        async verifyAndDecodeAppTransaction(value: string) { calls.push(`transaction:${value}`); return transaction; },
    } as unknown as Pick<SignedDataVerifier, 'verifyAndDecodeNotification' | 'verifyAndDecodeAppTransaction'>;
    return { verifier, calls };
}

test('verifies the outer notification and nested transaction before exposing the install identifier', async () => {
    const f = fixture();
    assert.deepEqual(await readAppStoreConsentNotification('signed-envelope', f.verifier), {
        kind: 'consent-withdrawn', notificationId, signedAt: base.signedDate, appTransactionId: 'fictional-install-id',
    });
    assert.deepEqual(f.calls, ['notification:signed-envelope', 'transaction:signed-transaction']);
});

test('rejects malformed notifications and never treats an unverified transaction as a withdrawal', async () => {
    for (const value of [undefined, '', 'x'.repeat(65_537)]) {
        const f = fixture();
        assert.deepEqual(await readAppStoreConsentNotification(value, f.verifier), { kind: 'invalid' });
        assert.deepEqual(f.calls, []);
    }
    for (const value of [{ ...base, notificationUUID: 'invalid' }, { ...base, signedDate: -1 },
        { ...base, signedDate: undefined }, { ...base, appData: {} }, { ...base, appData: { signedAppTransactionInfo: 'x'.repeat(65_537) } }]) {
        const f = fixture(value);
        assert.deepEqual(await readAppStoreConsentNotification('signed-envelope', f.verifier), { kind: 'invalid' });
        assert.equal(f.calls.length, 1);
    }
    for (const appTransactionId of [undefined, '', 'unsafe\nvalue', 'x'.repeat(256)]) {
        const f = fixture(base, { appTransactionId });
        assert.deepEqual(await readAppStoreConsentNotification('signed-envelope', f.verifier), { kind: 'invalid' });
        assert.equal(f.calls.length, 2);
    }
});

test('handles verified Apple test events separately and retries verifier outages', async () => {
    const other = fixture({ ...base, notificationType: 'TEST' });
    assert.deepEqual(await readAppStoreConsentNotification('signed-envelope', other.verifier), { kind: 'test' });
    assert.equal(other.calls.length, 1);
    assert.deepEqual(await readAppStoreConsentNotification('signed-envelope', fixture({ ...base, notificationType: 'UNKNOWN' }).verifier),
        { kind: 'unsupported' });
    const invalid = fixture();
    invalid.verifier.verifyAndDecodeNotification = async () => { throw new VerificationException(VerificationStatus.INVALID_CERTIFICATE); };
    assert.deepEqual(await readAppStoreConsentNotification('signed-envelope', invalid.verifier), { kind: 'invalid' });
    const unavailable = fixture();
    unavailable.verifier.verifyAndDecodeAppTransaction = async () => { throw new VerificationException(VerificationStatus.RETRYABLE_VERIFICATION_FAILURE); };
    assert.deepEqual(await readAppStoreConsentNotification('signed-envelope', unavailable.verifier), { kind: 'unavailable' });
    unavailable.verifier.verifyAndDecodeAppTransaction = async () => { throw new Error('unexpected internal failure'); };
    assert.deepEqual(await readAppStoreConsentNotification('signed-envelope', unavailable.verifier), { kind: 'unavailable' });
});
