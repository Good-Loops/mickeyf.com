import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { CHILD_ACTIVITY_CONTINUITY_BUCKET } from '../config/childActivityContinuity';
import { DELETION_JOURNAL_BUCKET } from './gcsDeletionJournal';
import { signPreparedRetirementCheckpoint, signRetirementBatch, verifyPreparedRetirementCheckpoint,
    verifyRetirementBatch } from './retirementBatchPermit';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const prefix = `v1/events/${'a'.repeat(64)}/`;
const entry = { name: `${prefix}000000000001.json`, generation: '123', contentSha256: 'b'.repeat(64) };
const claim = { version: 1, bucket: CHILD_ACTIVITY_CONTINUITY_BUCKET, database: 'cms',
    serverUuid: '11111111-1111-4111-8111-111111111111', guardGeneration: '456',
    lineage: '22222222-2222-4222-8222-222222222222', epoch: '1',
    committedBefore: '2026-11-09T00:00:00.000000Z', entries: [entry] };

test('pinned witness claims keep exact signed identities and separate preparation from retirement authority', () => {
    const value = { ...claim, entries: [entry, { ...entry, name: `${prefix}999999999999.json` }] };
    const prepared = signPreparedRetirementCheckpoint(value, privateKey);
    const permit = signRetirementBatch(value, privateKey);
    assert.deepEqual(verifyPreparedRetirementCheckpoint(prepared, publicKey), value);
    assert.deepEqual(verifyRetirementBatch(permit, publicKey), value);
    assert.throws(() => verifyRetirementBatch(prepared, publicKey));
    assert.throws(() => verifyPreparedRetirementCheckpoint(permit, publicKey));
});

test('witness names are accepted only in the pinned continuity bucket', () => {
    for (const bucket of [DELETION_JOURNAL_BUCKET, 'ludolume-child-retention-test', `${CHILD_ACTIVITY_CONTINUITY_BUCKET}-other`]) {
        assert.throws(() => signRetirementBatch({ ...claim, bucket }, privateKey));
        assert.throws(() => signPreparedRetirementCheckpoint({ ...claim, bucket }, privateKey));
    }
    for (const name of [`v1/intents/${claim.lineage}.json`, `v1/conditional/${'a'.repeat(64)}/${'b'.repeat(64)}.json`,
        `v1/resolutions/${'a'.repeat(64)}/${'b'.repeat(64)}.json`]) {
        assert.throws(() => signRetirementBatch({ ...claim, entries: [{ ...entry, name }] }, privateKey));
    }
});

test('witness names require a canonical prefix and a positive twelve-digit sequence', () => {
    for (const name of [`${prefix}000000000000.json`, `${prefix}1.json`, `${prefix}00000000001.json`,
        `${prefix}1000000000000.json`, `${prefix}000000000001.json/extra`, `${prefix}000000000001.JSON`,
        `${prefix}-00000000001.json`, entry.name.replace('events/', 'heads/'), entry.name.replace('/aaaa', '/AAAA'),
        entry.name.replace('v1/', 'v1%2F')]) {
        assert.throws(() => signRetirementBatch({ ...claim, entries: [{ ...entry, name }] }, privateKey), name);
    }
});

test('a signed witness permit cannot be moved to another object generation, sequence, hash or bucket', () => {
    const permit = signRetirementBatch(claim, privateKey);
    for (const changed of [{ ...entry, name: `${prefix}000000000002.json` }, { ...entry, generation: '124' },
        { ...entry, contentSha256: 'c'.repeat(64) }]) {
        assert.throws(() => verifyRetirementBatch({ ...permit, claim: { ...permit.claim, entries: [changed] } }, publicKey));
    }
    assert.throws(() => verifyRetirementBatch({ ...permit, claim: { ...permit.claim, bucket: 'another-bucket' } }, publicKey));
    assert.throws(() => signRetirementBatch({ ...claim, entries: [entry, entry] }, privateKey));
});
