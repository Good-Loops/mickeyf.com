import { createHmac } from 'node:crypto';
import { isAccountId } from './deletionJournal';
import { parseInactivityInstant } from './childInactivityPolicy';
import type { RetentionIntent, InactivityStore } from './childInactivityWorkflow';
import type { RetentionResolution } from './gcsRetentionJournal';
import { isSessionId, type SessionProof } from '../security/sessionPolicy';

type Journal = Readonly<{
    verifyRetentionIntent(intent: RetentionIntent): Promise<boolean>;
    recordResolution(intent: RetentionIntent, resolution: RetentionResolution): Promise<void>;
}>;

/** The exact live parent, current ownership and later SQL activity are rechecked while locked. */
export async function reconcileKeptRetentionIntent(store: InactivityStore, journal: Journal,
    intent: RetentionIntent, proof: SessionProof, receiptKey: Buffer): Promise<boolean> {
    if (!intent || !isAccountId(intent.parentId) || !isAccountId(intent.childId) || intent.parentId === intent.childId
        || !isAccountId(intent.warningId) || parseInactivityInstant(intent.activityAt) === null
        || !proof || proof.accountId !== intent.parentId || !isSessionId(proof.sessionId)
        || !Buffer.isBuffer(receiptKey) || receiptKey.length < 32) return false;
    return store.withLockedChild(intent.parentId, intent.childId, async target => {
        if (!await target.parentSessionValid(proof)) return false;
        const snapshot = await target.snapshot();
        const confirmedAt = await target.databaseTimestamp();
        if (!snapshot || snapshot.parentId !== intent.parentId || snapshot.childId !== intent.childId
            || !snapshot.activityAt || parseInactivityInstant(snapshot.activityAt) === null
            || parseInactivityInstant(confirmedAt) === null || snapshot.activityAt <= intent.activityAt
            || snapshot.activityAt > confirmedAt || !await journal.verifyRetentionIntent(intent)
            || !await target.parentSessionValid(proof)) return false;
        const proofDigest = createHmac('sha256', receiptKey).update('ludolume-retention-kept-v1\0')
            .update(intent.parentId).update('\0').update(intent.childId).update('\0')
            .update(intent.warningId).update('\0').update(proof.sessionId).digest('hex');
        await journal.recordResolution(intent, { outcome: 'kept', confirmedAt, observedActivityAt: snapshot.activityAt, proofDigest });
        return true;
    });
}
