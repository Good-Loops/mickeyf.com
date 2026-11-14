import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import test from 'node:test';
import { createGcsRetentionJournal } from './gcsRetentionJournal';
import type { JournalHttpClient } from './gcsDeletionJournal';

const bucket = 'synthetic-guard-history', key = Buffer.alloc(32, 7), name = 'v1/control/restore-guard.json';
const uuid = '572ed45a-c57d-4c82-9b50-d4585331bcec', lineage = 'b5612c48-c0ba-4324-b055-e6c2f79af10d';
function body(epoch?: string, preparationSha256?: string) {
    const guard = { state: 'hold', database: 'synthetic', serverUuid: uuid, epoch: uuid, expiresAt: '2027-01-01T00:00:00.000Z',
        ...(epoch ? { recoveryCheckpoint: { lineage, minimumEpoch: epoch, keySha256: 'a'.repeat(64),
            ...(preparationSha256 ? { preparationSha256 } : {}) } } : {}) };
    const mac = createHmac('sha256', key).update('ludolume-retention-restore-guard-v1\0').update(JSON.stringify(guard)).digest('hex');
    return JSON.stringify({ version: 1, guard, mac });
}
function fixture(currentEpoch?: string, previousEpoch?: string, deleted = false, tamper = false, unsafePolicy = false,
    currentPreparation?: string, previousPreparation?: string) {
    const data = new Map([['3', body(currentEpoch, currentPreparation)], ['90', tamper
        ? body(previousEpoch, previousPreparation).replace('"hold"', '"active"') : body(previousEpoch, previousPreparation)]]);
    const metadata = (generation: string) => ({ bucket, name, generation, size: String(Buffer.byteLength(data.get(generation)!)),
        md5Hash: createHash('md5').update(data.get(generation)!).digest('base64'),
        ...(generation === '90' ? { timeDeleted: '2026-11-04T00:00:00Z' } : {}) });
    const client: JournalHttpClient = { async request(request) {
        if (request.url.endsWith(`/b/${bucket}`)) return { status: 200, data: { name: bucket,
            versioning: { enabled: true }, softDeletePolicy: { retentionDurationSeconds: '604800' },
            ...(unsafePolicy ? { lifecycle: { rule: [{ action: { type: 'Delete' } }] } } : {}) } };
        if (request.url.endsWith('/o')) return { status: 200, data: { kind: 'storage#objects',
            items: request.params.softDeleted ? (deleted ? [{ name }] : []) : [metadata('3'), metadata('90')] } };
        const generation = String(request.params.generation ?? '3');
        return { status: 200, data: request.params.alt === 'media' ? data.get(generation) : metadata(generation) };
    } };
    return createGcsRetentionJournal({ bucket, expectedBucket: bucket, key, client, verifyActivityContinuity: async () => false });
}
test('guard history compares signed checkpoint epochs rather than generation numbers', async () => {
    await fixture('10', '9').assertRestoreGuardHistory();
    await assert.rejects(fixture('9', '10').assertRestoreGuardHistory());
    await assert.rejects(fixture(undefined, '10').assertRestoreGuardHistory());
});
test('deleted or altered guard history prevents a recovery cutover', async () => {
    await assert.rejects(fixture('10', '9', true).assertRestoreGuardHistory());
    await assert.rejects(fixture('10', '9', false, true).assertRestoreGuardHistory());
    await assert.rejects(fixture('10', '9', false, false, true).assertRestoreGuardHistory());
});
test('the same checkpoint epoch cannot have conflicting preparation identities', async () => {
    await fixture('10', '10', false, false, false, 'b'.repeat(64), 'b'.repeat(64)).assertRestoreGuardHistory();
    await assert.rejects(fixture('10', '10', false, false, false, 'b'.repeat(64), 'c'.repeat(64)).assertRestoreGuardHistory());
    await assert.rejects(fixture('10', '10', false, false, false, undefined, 'b'.repeat(64)).assertRestoreGuardHistory());
});
