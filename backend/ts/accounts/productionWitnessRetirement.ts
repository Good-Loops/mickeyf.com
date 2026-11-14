import type { PoolConnection } from 'mysql2/promise';
import { CHILD_ACTIVITY_CONTINUITY_BUCKET } from '../config/childActivityContinuity';
import { createRetirementStorageClient, verifyRetirementBucketPolicy } from './gcsRetirementTransport';
import { createRetirementWitnessStorage } from './retirementWitnessStorage';
import { createCoveredWitnessRetirement } from './coveredWitnessRetirement';
import { readRetirementKnownAccounts } from './retirementKnownAccounts';
import type { createGcsDeletionJournal } from './gcsDeletionJournal';
import type { createGcsRetentionJournal } from './gcsRetentionJournal';

/** Actual provider and journal sources only; the calling transaction owns the fence. */
export function createProductionWitnessRetirement(options: Readonly<{
    connection: Pick<PoolConnection, 'query'>;
    explicit: ReturnType<typeof createGcsDeletionJournal>;
    conditional: ReturnType<typeof createGcsRetentionJournal>;
    activityKey: Buffer; warningKey: Buffer;
}>) {
    const client = createRetirementStorageClient();
    const store = createRetirementWitnessStorage(client, CHILD_ACTIVITY_CONTINUITY_BUCKET);
    return createCoveredWitnessRetirement({ activityKey: options.activityKey, warningKey: options.warningKey, store,
        listKnownAccountIds: () => readRetirementKnownAccounts(options),
        verifyPolicy: () => verifyRetirementBucketPolicy(client, CHILD_ACTIVITY_CONTINUITY_BUCKET) });
}
