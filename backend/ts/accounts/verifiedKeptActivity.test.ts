import assert from 'node:assert/strict';
import test from 'node:test';
import type { PoolConnection } from 'mysql2/promise';
import type { ConditionalRetirementPair } from './gcsRetentionJournal';
import { verifyKeptActivity } from './verifiedKeptActivity';

const childId = '42a23d28-40cf-4d69-9fdb-74206ef3fa70', parentId = '42a23d28-40cf-4d69-9fdb-74206ef3fa71';
const pair: ConditionalRetirementPair = { intent: { parentId, childId, warningId: '42a23d28-40cf-4d69-9fdb-74206ef3fa72',
    activityAt: '2023-01-01T00:00:00.000000Z', deliveredAt: '2026-10-01T00:00:00.000000Z', channel: 'in-app',
    targetDigest: 'a'.repeat(64), noticeDigest: 'b'.repeat(64), receiptDigest: 'c'.repeat(64) },
    resolution: { outcome: 'kept', confirmedAt: '2026-10-02T00:00:00.000000Z',
        observedActivityAt: '2026-10-01T12:00:00.000000Z', proofDigest: 'd'.repeat(64) },
    intentObject: { name: 'synthetic-intent', generation: '1', contentSha256: 'e'.repeat(64) },
    resolutionObject: { name: 'synthetic-resolution', generation: '2', contentSha256: 'f'.repeat(64) } };

function database(row: Record<string, unknown>) {
    return { async query() { return [[row], []]; } } as unknown as PoolConnection;
}
test('a kept outcome requires the same parent and the recorded or newer activity', async () => {
    const valid = { childId, parentId, activityAt: '2026-10-01T12:00:00.000000Z' };
    assert.equal(await verifyKeptActivity(database(valid), pair), true);
    assert.equal(await verifyKeptActivity(database({ ...valid, activityAt: '2026-10-03T00:00:00.000000Z' }), pair), true);
    assert.equal(await verifyKeptActivity(database({ ...valid, activityAt: '2026-09-30T00:00:00.000000Z' }), pair), false);
    assert.equal(await verifyKeptActivity(database({ ...valid, parentId: childId }), pair), false);
    assert.equal(await verifyKeptActivity(database({ ...valid, activityAt: null }), pair), false);
    assert.equal(await verifyKeptActivity(database(valid), { ...pair, resolution: { ...pair.resolution, outcome: 'deleted', observedActivityAt: null } }), false);
});
