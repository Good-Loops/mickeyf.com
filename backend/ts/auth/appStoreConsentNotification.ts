import type { SignedDataVerifier } from '@apple/app-store-server-library';
import { appStoreVerificationFailure, MAX_APP_STORE_SIGNED_PAYLOAD_LENGTH, readAppStoreTransaction } from './appStoreTransaction';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

type AppleVerifier = Pick<SignedDataVerifier, 'verifyAndDecodeNotification' | 'verifyAndDecodeAppTransaction'>;
export type AppStoreConsentResult =
    | { kind: 'consent-withdrawn'; notificationId: string; signedAt: number; appTransactionId: string }
    | { kind: 'test' }
    | { kind: 'unsupported' }
    | { kind: 'invalid' }
    | { kind: 'unavailable' };

/** Verify both Apple signatures before exposing the identifier used for consent withdrawal. */
export async function readAppStoreConsentNotification(
    payload: unknown, verifier: AppleVerifier,
): Promise<AppStoreConsentResult> {
    if (typeof payload !== 'string' || payload.length === 0 || payload.length > MAX_APP_STORE_SIGNED_PAYLOAD_LENGTH) {
        return { kind: 'invalid' };
    }
    try {
        const notification = await verifier.verifyAndDecodeNotification(payload);
        if (typeof notification.notificationType !== 'string' || !notification.notificationType) return { kind: 'invalid' };
        if (notification.notificationType === 'TEST') return { kind: 'test' };
        if (notification.notificationType !== 'RESCIND_CONSENT') return { kind: 'unsupported' };
        const signedTransaction = notification.appData?.signedAppTransactionInfo;
        if (typeof notification.notificationUUID !== 'string' || !UUID.test(notification.notificationUUID)
            || !Number.isSafeInteger(notification.signedDate) || notification.signedDate! <= 0
            || typeof signedTransaction !== 'string' || !signedTransaction || signedTransaction.length > MAX_APP_STORE_SIGNED_PAYLOAD_LENGTH) {
            return { kind: 'invalid' };
        }
        const transaction = await readAppStoreTransaction(signedTransaction, verifier);
        if (transaction.kind !== 'verified') return transaction;
        return { kind: 'consent-withdrawn', notificationId: notification.notificationUUID,
            signedAt: notification.signedDate!, appTransactionId: transaction.appTransactionId };
    } catch (error) {
        // Temporary certificate/status failures must be retried rather than acknowledged.
        return appStoreVerificationFailure(error);
    }
}
