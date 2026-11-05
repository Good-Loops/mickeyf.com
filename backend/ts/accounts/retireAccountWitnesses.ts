import { timingSafeEqual } from 'node:crypto';
import { isAccountId } from './deletionJournal';
import type { RetirementWitness } from './retirementWitnessStorage';

type WitnessStore = Readonly<{
    list(accountId: string, key: Buffer): Promise<RetirementWitness[]>;
    remove(entry: RetirementWitness): Promise<void>;
    assertEmpty(accountId: string, key: Buffer): Promise<void>;
}>;

/**
 * Remove authenticated activity and warning events only after the caller has
 * verified the account, recovery floor and fence. Keys must be obtained from a
 * trusted runtime configuration; this function cannot authenticate their origin.
 * An uncertain delete stops the pass. A later pass must re-inventory first.
 */
export async function retireAccountWitnesses(options: Readonly<{
    accountId: string; activityKey: Buffer; warningKey: Buffer; store: WitnessStore;
    verifyBeforeDelete(): Promise<void>;
}>): Promise<Readonly<{ removed: number }>> {
    const { accountId, store } = options;
    if (!isAccountId(accountId) || !Buffer.isBuffer(options.activityKey) || options.activityKey.length !== 32
        || !Buffer.isBuffer(options.warningKey) || options.warningKey.length !== 32
        || timingSafeEqual(options.activityKey, options.warningKey) || typeof options.verifyBeforeDelete !== 'function') {
        throw new Error('Witness retirement unavailable.');
    }
    const keys = [Buffer.from(options.activityKey), Buffer.from(options.warningKey)];
    try {
        const groups = await Promise.all(keys.map(key => store.list(accountId, key)));
        const entries = groups.flat();
        if (entries.length > 10_000 || new Set(entries.map(entry => `${entry.name}\0${entry.generation}`)).size !== entries.length) throw new Error();
        for (const entry of entries) {
            await options.verifyBeforeDelete();
            await store.remove(entry);
        }
        await options.verifyBeforeDelete();
        for (const key of keys) await store.assertEmpty(accountId, key);
        return { removed: entries.length };
    } catch {
        throw new Error('Witness retirement unavailable or unconfirmed; retain the journal and reconcile.');
    } finally { for (const key of keys) key.fill(0); }
}
