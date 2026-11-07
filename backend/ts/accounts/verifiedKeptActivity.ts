import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { parseInactivityInstant } from './childInactivityPolicy';
import { isAccountId } from './deletionJournal';
import type { ConditionalRetirementPair } from './gcsRetentionJournal';
import { verifyDeletedAccountEffects } from './verifiedDeletionEffects';

/** The pair is authenticated by the journal; the caller owns the transaction and writer fence. */
export async function verifyKeptActivity(connection: Pick<PoolConnection, 'query'>, pair: ConditionalRetirementPair): Promise<boolean> {
    const { intent, resolution } = pair;
    if (resolution.outcome !== 'kept' || !isAccountId(intent.childId) || !isAccountId(intent.parentId)
        || intent.childId === intent.parentId || parseInactivityInstant(intent.activityAt) === null
        || parseInactivityInstant(resolution.observedActivityAt) === null || parseInactivityInstant(resolution.confirmedAt) === null
        || !resolution.observedActivityAt || resolution.observedActivityAt <= intent.activityAt
        || resolution.observedActivityAt > resolution.confirmedAt) return false;
    const [rows] = await connection.query<RowDataPacket[]>({ sql: `SELECT u.account_uuid AS childId,c.parent_uuid AS parentId,
        DATE_FORMAT(a.retention_activity_at,'%Y-%m-%dT%H:%i:%s.%fZ') AS activityAt FROM users u
        LEFT JOIN parent_child_consents c ON c.child_uuid=u.account_uuid
        LEFT JOIN parent_managed_child_activity a ON a.child_uuid=u.account_uuid
        WHERE u.account_uuid=? LIMIT 2 FOR UPDATE`, timeout: 10_000 }, [intent.childId]);
    if (!Array.isArray(rows) || rows.length > 1) throw new Error('Kept account state unavailable.');
    if (!rows.length) return verifyDeletedAccountEffects(connection, [intent.childId]);
    return rows[0].childId === intent.childId && rows[0].parentId === intent.parentId
        && parseInactivityInstant(rows[0].activityAt) !== null && rows[0].activityAt >= resolution.observedActivityAt;
}
