import type { AppleTokenLifecycle } from '../config/appleTokenConfig';
import type { ProviderAccount } from '../accounts/providerAccountRepository';
import type { VerifiedProviderIdentity } from './providerIdentity';
import type { StagedAppleCredential } from './providerAuthFlow';

/** Prepare in memory; persistence belongs to the locked session transaction. */
export function stageAppleCredential(repository: AppleTokenLifecycle['repository'],
    account: ProviderAccount, identity: VerifiedProviderIdentity, token: string): StagedAppleCredential {
    if (identity.provider !== 'apple' || !identity.appleClientId || !identity.appleIssuedAt) {
        throw new Error('Apple credential could not be staged.');
    }
    const expected = Object.freeze({ userId: account.userId, accountId: account.accountId,
        subject: identity.subject, clientId: identity.appleClientId, issuedAt: identity.appleIssuedAt });
    const prepared = repository.prepare(token, expected.accountId);
    if (prepared.client_id !== expected.clientId) {
        prepared.encrypted_token.fill(0);
        throw new Error('Apple credential client did not match.');
    }
    let disposed = false;
    let used = false;
    return Object.freeze({
        async write(connection, target, proof) {
            if (disposed || used || target.userId !== expected.userId || target.accountId !== expected.accountId
                || proof.subject !== expected.subject || proof.clientId !== expected.clientId
                || proof.issuedAt !== expected.issuedAt) throw new Error('Apple credential binding failed.');
            used = true;
            await repository.save(connection, prepared);
        },
        dispose() { if (!disposed) { disposed = true; prepared.encrypted_token.fill(0); } },
    });
}
