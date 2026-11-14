import { VerificationException, VerificationStatus, type SignedDataVerifier } from '@apple/app-store-server-library';

export const MAX_APP_STORE_SIGNED_PAYLOAD_LENGTH = 65_536;
type TransactionVerifier = Pick<SignedDataVerifier, 'verifyAndDecodeAppTransaction'>;
export type AppStoreTransactionResult =
    | { kind: 'verified'; appTransactionId: string }
    | { kind: 'invalid' }
    | { kind: 'unavailable' };

export function appStoreVerificationFailure(error: unknown): { kind: 'invalid' | 'unavailable' } {
    return { kind: error instanceof VerificationException
        && error.status !== VerificationStatus.RETRYABLE_VERIFICATION_FAILURE && error.status !== VerificationStatus.FAILURE
        ? 'invalid' : 'unavailable' };
}

/** Validate Apple's app and environment binding before identifying an app transaction. */
export async function readAppStoreTransaction(payload: unknown, verifier: TransactionVerifier): Promise<AppStoreTransactionResult> {
    if (typeof payload !== 'string' || !payload || payload.length > MAX_APP_STORE_SIGNED_PAYLOAD_LENGTH) return { kind: 'invalid' };
    try {
        const transaction = await verifier.verifyAndDecodeAppTransaction(payload);
        if (typeof transaction.appTransactionId !== 'string'
            || !/^[\x21-\x7e]{1,255}$/u.test(transaction.appTransactionId)) return { kind: 'invalid' };
        return { kind: 'verified', appTransactionId: transaction.appTransactionId };
    } catch (error) { return appStoreVerificationFailure(error); }
}
