import { parseInactivityInstant } from './childInactivityPolicy';
import type { DeletionJournalEntry } from './gcsDeletionJournal';
import type { ConditionalRetirementPair } from './gcsRetentionJournal';

/** Only authenticated deleted outcomes are candidates for retirement. */
export function conditionalRetirementEntry(pair: ConditionalRetirementPair): DeletionJournalEntry {
    if (!pair || pair.resolution.outcome !== 'deleted' || pair.resolution.observedActivityAt !== null
        || parseInactivityInstant(pair.intent.deliveredAt) === null || parseInactivityInstant(pair.resolution.confirmedAt) === null
        || pair.resolution.confirmedAt < pair.intent.deliveredAt
        || pair.resolutionObject.name !== pair.intentObject.name.replace('v1/conditional/', 'v1/resolutions/')) throw new Error('Conditional outcome is not eligible.');
    return { ...pair.intentObject, intent: { version: 1, action: 'delete-account', accountId: pair.intent.childId,
        requestedAt: `${pair.intent.deliveredAt.slice(0, 23)}Z` } };
}
