import type { ProviderAuthContext } from '../auth/providerAuthContext';
import { isAccountId } from './deletionJournal';
import type { InactivityStore, RetentionIntent } from './childInactivityWorkflow';
import type { RetentionResolution } from './gcsRetentionJournal';
import { reconcileKeptRetentionIntent } from './retentionReconciliation';

type Journal = Readonly<{
    readIntentsForChild(childId: string): Promise<readonly RetentionIntent[]>;
    verifyRetentionIntent(intent: RetentionIntent): Promise<boolean>;
    readResolution(intent: RetentionIntent): Promise<RetentionResolution | null>;
    recordResolution(intent: RetentionIntent, resolution: RetentionResolution): Promise<void>;
}>;

/** Called only after the keep transaction commits; unresolved outcomes remain held. */
export function createRetentionKeepReconciler(store: InactivityStore, journal: Journal, receiptKey: Buffer) {
    if (!store || typeof store.withLockedChild !== 'function' || !journal || typeof journal.readIntentsForChild !== 'function'
        || !Buffer.isBuffer(receiptKey) || receiptKey.length < 32) throw new TypeError('Keep reconciliation dependencies are required.');
    const key = Buffer.from(receiptKey);
    return async (context: ProviderAuthContext, childId: string): Promise<void> => {
        if (!context?.account || !context.session || context.account.accountId !== context.session.accountId
            || !isAccountId(childId) || childId === context.account.accountId) throw new Error('Keep reconciliation unavailable.');
        const intents = await journal.readIntentsForChild(childId);
        if (!Array.isArray(intents) || intents.length > 10_000) throw new Error('Keep reconciliation unavailable.');
        for (const intent of intents) {
            if (intent.childId !== childId || intent.parentId !== context.account.accountId
                || !await reconcileKeptRetentionIntent(store, journal, intent, context.session, key)) {
                throw new Error('Keep reconciliation unavailable.');
            }
        }
    };
}
export type RetentionKeepReconciler = ReturnType<typeof createRetentionKeepReconciler>;
