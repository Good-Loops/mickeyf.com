import { createHmac } from 'node:crypto';
import type { PoolConnection } from 'mysql2/promise';
import { isAccountId } from './deletionJournal';
import type { ResolveInactivityQuality } from './childInactivitySqlStore';

/**
 * Construct a stable, channel-specific target, not an email or delivery claim.
 * The SQL store must hold the exact parent/child relationship lock when this
 * runs. Health evidence is mandatory and must be read in the same transaction.
 * Returning true without independent evidence would make deletion unsafe.
 */
export function createInAppInactivityQualityResolver(key: Buffer,
    hasCompleteActivityHistory: (connection: PoolConnection, parentId: string, childId: string) => Promise<boolean>): ResolveInactivityQuality {
    if (!Buffer.isBuffer(key) || key.length < 32 || typeof hasCompleteActivityHistory !== 'function') {
        throw new TypeError('An independent target HMAC key and activity health verifier are required.');
    }
    const secret = Buffer.from(key);
    return async (connection, parentId, childId) => {
        if (!isAccountId(parentId) || !isAccountId(childId) || parentId === childId) throw new TypeError('Invalid relationship.');
        const activityComplete = await hasCompleteActivityHistory(connection, parentId, childId);
        return {
            channel: 'in-app', targetVerified: true, activityComplete: activityComplete === true,
            currentTargetDigest: createHmac('sha256', secret).update('ludolume-inactivity-in-app-v1\0')
                .update(parentId).update('\0').update(childId).digest('hex'),
        };
    };
}
