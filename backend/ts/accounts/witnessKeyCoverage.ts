import { createHmac, timingSafeEqual } from 'node:crypto';
import { isAccountId } from './deletionJournal';

/**
 * A wrong key can make one account's prefix appear empty. Reject cleanup unless
 * every live/noncurrent witness belongs to a known live or journaled account
 * under one of the supplied keys. Callers must supply complete, fenced sources.
 */
export function assertWitnessKeyCoverage(accountIds: readonly string[], activityKey: Buffer, warningKey: Buffer,
    objects: readonly Readonly<{ name: string; generation: string }>[]): void {
    if (!Array.isArray(accountIds) || accountIds.length > 100_000 || accountIds.some(id => !isAccountId(id))
        || !Buffer.isBuffer(activityKey) || activityKey.length !== 32 || !Buffer.isBuffer(warningKey) || warningKey.length !== 32
        || timingSafeEqual(activityKey, warningKey) || !Array.isArray(objects) || objects.length > 100_000) throw new Error();
    const tags = new Set<string>();
    for (const id of new Set(accountIds)) for (const key of [activityKey, warningKey]) {
        tags.add(createHmac('sha256', key).update('ludolume-child-head-id-v1\0').update(id).digest('hex'));
    }
    for (const object of objects) {
        const match = typeof object?.name === 'string' && /^v1\/events\/([a-f0-9]{64})\/[0-9]{12}\.json$/u.exec(object.name);
        if (!match || !tags.has(match[1]) || typeof object.generation !== 'string' || !/^[1-9][0-9]*$/u.test(object.generation)) {
            throw new Error('Witness keys or account inventory do not cover the continuity bucket.');
        }
    }
}
