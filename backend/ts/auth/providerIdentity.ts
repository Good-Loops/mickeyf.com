export type IdentityProvider = 'google' | 'apple';

declare const verifiedProviderIdentity: unique symbol;

/**
 * Only the token verifier constructs this identity. The private brand prevents
 * accidental use of decoded or request-supplied claims at repository boundaries;
 * it is a compile-time safeguard, not a substitute for cryptographic verification.
 */
export type VerifiedProviderIdentity = Readonly<{
    provider: IdentityProvider;
    subject: string;
    /** Optional provider-signed verified contact email; never an identity/link key. */
    email?: string;
    [verifiedProviderIdentity]: true;
}>;
