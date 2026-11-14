import assert from 'node:assert/strict';
import test from 'node:test';
import { expandConditionalRetirementSelection, previewRetirementsForOperator, verifyConditionalRetirementCandidate } from './retirementOperator';
import type { ConditionalRetirementPair } from './gcsRetentionJournal';
import type { PoolConnection } from 'mysql2/promise';

test('advances a conditional selection only with its exact paired outcome', () => {
    const intentObject = { name: 'intent', generation: '1', contentSha256: 'a'.repeat(64) };
    const resolutionObject = { name: 'outcome', generation: '2', contentSha256: 'b'.repeat(64) };
    const pair = { intentObject, resolutionObject } as Parameters<typeof expandConditionalRetirementSelection>[1][number];
    assert.deepEqual(expandConditionalRetirementSelection([intentObject], [pair]), [intentObject, resolutionObject]);
    assert.throws(() => expandConditionalRetirementSelection([{ ...intentObject, generation: '3' }], [pair]));
    assert.throws(() => expandConditionalRetirementSelection([intentObject, intentObject], [pair]));
    assert.throws(() => expandConditionalRetirementSelection([resolutionObject], [pair]));
});

test('operator entry refuses unpinned database or bucket before contacting providers', async () => {
    const context = { connection: {} as PoolConnection, pins: { database: 'unapproved', currentUser: 'operator@localhost',
        serverUuid: '42a23d28-40cf-4d69-9fdb-74206ef3fa71' }, bucket: 'wrong-bucket', expectedBucket: 'wrong-bucket',
        guardKey: Buffer.alloc(32, 1) };
    await assert.rejects(previewRetirementsForOperator(context, 'explicit', 'ORIGINAL PRIMARY AND ALL WRITERS FENCED'), /Unapproved retirement target/u);
});

test('conditional preview binds the exact pair to the kept activity check', async () => {
    const childId = '42a23d28-40cf-4d69-9fdb-74206ef3fa70', parentId = '42a23d28-40cf-4d69-9fdb-74206ef3fa71';
    const pair: ConditionalRetirementPair = { intent: { parentId, childId, warningId: '42a23d28-40cf-4d69-9fdb-74206ef3fa72',
        activityAt: '2023-01-01T00:00:00.000000Z', deliveredAt: '2026-10-01T00:00:00.000000Z', channel: 'in-app',
        targetDigest: 'a'.repeat(64), noticeDigest: 'b'.repeat(64), receiptDigest: 'c'.repeat(64) },
        resolution: { outcome: 'kept', confirmedAt: '2026-10-02T00:00:00.000000Z',
            observedActivityAt: '2026-10-01T12:00:00.000000Z', proofDigest: 'd'.repeat(64) },
        intentObject: { name: 'synthetic', generation: '1', contentSha256: 'e'.repeat(64) },
        resolutionObject: { name: 'synthetic-resolution', generation: '2', contentSha256: 'f'.repeat(64) } };
    let activityAt = '2026-10-01T12:00:00.000000Z';
    const connection = { async query() { return [[{ childId, parentId, activityAt }], []]; } } as unknown as PoolConnection;
    assert.equal(await verifyConditionalRetirementCandidate(connection, [pair], pair.intentObject), true);
    activityAt = '2026-09-30T00:00:00.000000Z';
    assert.equal(await verifyConditionalRetirementCandidate(connection, [pair], pair.intentObject), false);
    await assert.rejects(verifyConditionalRetirementCandidate(connection, [pair], { ...pair.intentObject, generation: '3' }));
});
