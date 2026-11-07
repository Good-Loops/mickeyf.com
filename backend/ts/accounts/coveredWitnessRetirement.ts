import { isDeepStrictEqual } from 'node:util';
import { isAccountId } from './deletionJournal';
import { assertWitnessKeyCoverage } from './witnessKeyCoverage';
import { retireAccountWitnesses } from './retireAccountWitnesses';
import type { RetirementWitness } from './retirementWitnessStorage';

type Identity = Readonly<{ name: string; generation: string }>;
type Store = Readonly<{
    listAllIdentities(): Promise<readonly Identity[]>;
    list(accountId: string, key: Buffer): Promise<RetirementWitness[]>;
    assertEmpty(accountId: string, key: Buffer): Promise<void>;
    remove(entry: RetirementWitness): Promise<void>;
}>;

/**
 * Local composition: unknown keys/accounts or an unstable inventory hold
 * cleanup. The caller must supply all live and journaled IDs from authenticated,
 * fenced sources and must verify the bucket's soft-delete policy.
 */
export function createCoveredWitnessRetirement(options: Readonly<{
    activityKey: Buffer; warningKey: Buffer; store: Store;
    listKnownAccountIds(): Promise<readonly string[]>; verifyPolicy(): Promise<void>;
}>) {
    const keys = [Buffer.from(options.activityKey), Buffer.from(options.warningKey)];
    let coveredTarget: string | undefined;
    async function coverage(target: string): Promise<void> {
        if (!isAccountId(target)) throw new Error();
        const accountIds = await options.listKnownAccountIds();
        if (!Array.isArray(accountIds) || !accountIds.includes(target)) throw new Error();
        const first = await options.store.listAllIdentities();
        assertWitnessKeyCoverage(accountIds, keys[0], keys[1], first);
        const second = await options.store.listAllIdentities();
        if (!isDeepStrictEqual(first, second)) throw new Error();
    }
    return {
        async retireWitnesses(target: string, verifyFence: () => Promise<void>): Promise<void> {
            if (coveredTarget !== undefined) throw new Error();
            await verifyFence(); await options.verifyPolicy(); await coverage(target); await verifyFence();
            coveredTarget = target;
            await retireAccountWitnesses({ accountId: target, activityKey: keys[0], warningKey: keys[1], store: options.store,
                verifyBeforeDelete: verifyFence });
        },
        async verifyWitnessesAbsent(target: string): Promise<void> {
            if (coveredTarget !== target) throw new Error();
            await options.verifyPolicy();
            for (const key of keys) await options.store.assertEmpty(target, key);
        },
        dispose() { coveredTarget = undefined; for (const key of keys) key.fill(0); },
    };
}
