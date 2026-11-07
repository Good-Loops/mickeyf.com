import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import { JournalRetirementAuthorizationError, signJournalRetirementClaim, verifyJournalRetirementStamp } from './journalRetirementStamp';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const claim = {
    version: 1, bucket: 'synthetic-journal-bucket', name: 'v1/intents/synthetic.json', generation: '123456789',
    contentSha256: 'a'.repeat(64), effectConfirmedAt: '2026-10-01T12:00:00.000001Z',
    recoveryFloor: '2026-10-02T12:00:00.000001Z', checkpointLineage: '553b99f4-10f1-46e8-a2d0-003445c10bed',
    checkpointEpoch: '6', signedAt: '2026-10-03T12:00:00.000001Z',
} as const;
const expected = { bucket: claim.bucket, name: claim.name, generation: claim.generation,
    checkpointLineage: claim.checkpointLineage, checkpointEpoch: '6', observedAt: '2026-10-04T12:00:00.000001Z' };

test('accepts only the signed exact generation when the restored database has its checkpoint', () => {
    const stamp = signJournalRetirementClaim(claim, privateKey);
    assert.doesNotThrow(() => verifyJournalRetirementStamp(stamp, expected, publicKey));
    assert.throws(() => verifyJournalRetirementStamp(stamp,
        { ...expected, checkpointEpoch: '5' }, publicKey), JournalRetirementAuthorizationError);
    for (const change of [{ bucket: 'other-journal-bucket' }, { name: 'v1/intents/other.json' },
        { generation: '123456790' }, { checkpointLineage: '533b99f4-10f1-46e8-a2d0-003445c10bed' }]) {
        assert.throws(() => verifyJournalRetirementStamp(stamp, { ...expected, ...change }, publicKey), JournalRetirementAuthorizationError);
    }
});

test('rejects tampering, another signing key, extra fields and malformed signatures', () => {
    const stamp = signJournalRetirementClaim(claim, privateKey);
    const other = generateKeyPairSync('ed25519');
    assert.throws(() => verifyJournalRetirementStamp(stamp, expected, other.publicKey), JournalRetirementAuthorizationError);
    assert.throws(() => verifyJournalRetirementStamp({ ...stamp, claim: { ...claim, contentSha256: 'b'.repeat(64) } }, expected, publicKey), JournalRetirementAuthorizationError);
    assert.throws(() => verifyJournalRetirementStamp({ ...stamp, claim: { ...claim, extra: true } }, expected, publicKey), JournalRetirementAuthorizationError);
    assert.throws(() => verifyJournalRetirementStamp({ ...stamp, signature: stamp.signature.slice(1) }, expected, publicKey), JournalRetirementAuthorizationError);
});

test('rejects ambiguous times and signatures created before the deletion was safely outside the recovery window', () => {
    for (const change of [
        { effectConfirmedAt: claim.recoveryFloor },
        { recoveryFloor: '2026-10-04T00:00:00.000000Z' },
        { signedAt: '2026-02-30T00:00:00.000000Z' },
        { effectConfirmedAt: '2026-10-01T12:00:00.000Z' },
    ]) assert.throws(() => signJournalRetirementClaim({ ...claim, ...change }, privateKey), JournalRetirementAuthorizationError);
    const stamp = signJournalRetirementClaim(claim, privateKey);
    assert.throws(() => verifyJournalRetirementStamp(stamp,
        { ...expected, observedAt: '2026-10-03T12:00:00.000000Z' }, publicKey), JournalRetirementAuthorizationError);
    assert.throws(() => verifyJournalRetirementStamp(stamp,
        { ...expected, checkpointEpoch: '18446744073709551616' }, publicKey), JournalRetirementAuthorizationError);
});
