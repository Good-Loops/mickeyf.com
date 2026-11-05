import assert from 'node:assert/strict';
import test from 'node:test';
import { expandConditionalRetirementSelection, previewRetirementsForOperator } from './retirementOperator';
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
