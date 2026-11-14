import { timingSafeEqual } from 'node:crypto';
import { isAccountId } from '../accounts/deletionJournal';

export const CHILD_ACTIVITY_CONTINUITY_BUCKET = 'ludolume-child-continuity-1012884798546';
export type ChildActivityContinuityConfig = Readonly<{
    bucket: string; database: string; serverUuid: string; key: Buffer;
}>;

/** Tracking must never silently fall back to a SQL-only timestamp. */
export function loadChildActivityContinuity(env: Readonly<Record<string, string | undefined>>,
    activityEnabled: boolean): ChildActivityContinuityConfig | undefined {
    if (!activityEnabled) return undefined;
    if (env.NODE_ENV !== 'production' || env.CHILD_ACTIVITY_CONTINUITY_BUCKET !== CHILD_ACTIVITY_CONTINUITY_BUCKET
        || !env.DB_NAME || !/^[A-Za-z0-9_]{1,64}$/u.test(env.DB_NAME)
        || !isAccountId(env.APPLE_MAINTENANCE_EXPECTED_SERVER_UUID)
        || !env.CHILD_ACTIVITY_CONTINUITY_KEY || !/^[a-f0-9]{64}$/u.test(env.CHILD_ACTIVITY_CONTINUITY_KEY)) {
        throw new Error('Child activity requires the pinned independent continuity store, primary and private key.');
    }
    const key = Buffer.from(env.CHILD_ACTIVITY_CONTINUITY_KEY, 'hex');
    const otherKeys = (env.CHILD_INACTIVITY_KEYS ?? '').split(':').filter(value => /^[a-f0-9]{64}$/u.test(value));
    if (key.every(byte => byte === 0) || otherKeys.some(value => timingSafeEqual(key, Buffer.from(value, 'hex')))) {
        throw new Error('The child activity continuity key must be independent.');
    }
    return Object.freeze({ bucket: CHILD_ACTIVITY_CONTINUITY_BUCKET, database: env.DB_NAME,
        serverUuid: env.APPLE_MAINTENANCE_EXPECTED_SERVER_UUID, key });
}
