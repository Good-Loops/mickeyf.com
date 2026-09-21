import type { AppleRevocationSummary } from './appleTokenRevocation';

export type AppleAccountRevocation = Readonly<{
    revokeForAccount(accountId: string): Promise<AppleRevocationSummary>;
}>;

/** Call only after confirmed deletion and lock release; Apple failure cannot undo deletion. */
export async function attemptAppleAccountRevocation(
    accountId: string,
    revocation?: AppleAccountRevocation,
): Promise<void> {
    if (!revocation) return;
    try {
        const result = await revocation.revokeForAccount(accountId);
        if (result.status !== 'completed' || result.retried > 0) {
            console.warn('Apple account revocation has pending work');
        }
    } catch {
        // The durable encrypted queue owns retries; never log identifiers, tokens or upstream errors.
        console.warn('Apple account revocation attempt unavailable; queued work retained');
    }
}
