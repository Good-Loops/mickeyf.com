import { Environment, SignedDataVerifier } from '@apple/app-store-server-library';
import { appleAppStoreRoots } from './appleAppStoreRoots';

/** Production and sandbox are deliberately separate; Xcode's unsigned mode is never accepted. */
export function createAppStoreSignedDataVerifier(options: {
    environment: 'production' | 'sandbox'; bundleId: string; appAppleId?: number;
}): SignedDataVerifier {
    if (!['production', 'sandbox'].includes(options.environment)
        || typeof options.bundleId !== 'string' || !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/u.test(options.bundleId)
        || options.bundleId.length > 255
        || (options.environment === 'production' && (!Number.isSafeInteger(options.appAppleId) || options.appAppleId! <= 0))
        || (options.environment === 'sandbox' && options.appAppleId !== undefined)) {
        throw new TypeError('Invalid App Store verification configuration.');
    }
    const environment = options.environment === 'production' ? Environment.PRODUCTION : Environment.SANDBOX;
    // Apple's verifier performs online certificate revocation checks as well as app and environment binding.
    return new SignedDataVerifier(appleAppStoreRoots(), true, environment, options.bundleId, options.appAppleId);
}
