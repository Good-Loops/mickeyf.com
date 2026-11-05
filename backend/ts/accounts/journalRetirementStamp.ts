import { sign, verify, type KeyObject } from 'node:crypto';
import { isAccountId } from './deletionJournal';

/** A stamp identifies one retired GCS generation and its recovery boundary. */
export type JournalRetirementClaim = Readonly<{
    version: 1;
    bucket: string;
    name: string;
    generation: string;
    contentSha256: string;
    effectConfirmedAt: string;
    recoveryFloor: string;
    checkpointLineage: string;
    checkpointEpoch: string;
    signedAt: string;
}>;

export type JournalRetirementStamp = Readonly<{
    claim: JournalRetirementClaim;
    signature: string;
}>;

const DOMAIN = 'ludolume-journal-retirement-v1\0';
const KEYS = ['bucket', 'checkpointEpoch', 'checkpointLineage', 'contentSha256', 'effectConfirmedAt', 'generation', 'name', 'recoveryFloor', 'signedAt', 'version'];
const MAX_EPOCH = BigInt('18446744073709551615');

export class JournalRetirementAuthorizationError extends Error {
    constructor() { super('Journal retirement authorization is invalid or unavailable.'); }
}

function instant(value: unknown): value is string {
    if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/u.test(value)) return false;
    const milliseconds = `${value.slice(0, 23)}Z`;
    const parsed = Date.parse(milliseconds);
    return Number.isFinite(parsed) && new Date(parsed).toISOString() === milliseconds;
}

function claimFrom(value: unknown): JournalRetirementClaim {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).sort().join(',') !== KEYS.join(',')) throw new JournalRetirementAuthorizationError();
    const claim = value as Record<string, unknown>;
    if (claim.version !== 1 || typeof claim.bucket !== 'string'
        || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(claim.bucket) || claim.bucket.includes('..')
        || typeof claim.name !== 'string' || claim.name.length < 1 || claim.name.length > 1024
        || typeof claim.generation !== 'string' || !/^[1-9][0-9]{0,19}$/u.test(claim.generation)
        || typeof claim.contentSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(claim.contentSha256)
        || !isAccountId(claim.checkpointLineage) || typeof claim.checkpointEpoch !== 'string'
        || !/^[1-9][0-9]{0,19}$/u.test(claim.checkpointEpoch) || BigInt(claim.checkpointEpoch) > MAX_EPOCH
        || !instant(claim.effectConfirmedAt) || !instant(claim.recoveryFloor) || !instant(claim.signedAt)
        || claim.effectConfirmedAt >= claim.recoveryFloor || claim.recoveryFloor > claim.signedAt) {
        throw new JournalRetirementAuthorizationError();
    }
    // Reconstruct the canonical payload; the input object's property order is irrelevant.
    return { version: 1, bucket: claim.bucket, name: claim.name, generation: claim.generation,
        contentSha256: claim.contentSha256, effectConfirmedAt: claim.effectConfirmedAt,
        recoveryFloor: claim.recoveryFloor, checkpointLineage: claim.checkpointLineage,
        checkpointEpoch: claim.checkpointEpoch, signedAt: claim.signedAt };
}

function payload(claim: JournalRetirementClaim): Buffer {
    return Buffer.from(DOMAIN + JSON.stringify(claim), 'utf8');
}

/**
 * Signing is NOT eligibility verification: the caller must first authenticate
 * the complete recovery boundary and confirm the deletion effect. Do not expose
 * this function through the runtime or use it as deletion authorization alone.
 */
export function signJournalRetirementClaim(input: unknown, privateKey: KeyObject): JournalRetirementStamp {
    try {
        if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519') throw new Error();
        const claim = claimFrom(input);
        return { claim, signature: sign(null, payload(claim), privateKey).toString('base64url') };
    } catch { throw new JournalRetirementAuthorizationError(); }
}

/**
 * The checkpoint must be read from the pinned restored database, after the
 * independent guard is checked. A caller-supplied value is not proof by itself.
 */
export function verifyJournalRetirementStamp(input: unknown, expected: Readonly<{
    bucket: string; name: string; generation: string;
    checkpointLineage: string; checkpointEpoch: string; observedAt: string;
}>, publicKey: KeyObject): void {
    try {
        if (publicKey.type !== 'public' || publicKey.asymmetricKeyType !== 'ed25519'
            || !input || typeof input !== 'object' || Array.isArray(input)
            || Object.keys(input).sort().join(',') !== 'claim,signature') throw new Error();
        const stamp = input as Record<string, unknown>;
        const claim = claimFrom(stamp.claim);
        if (typeof stamp.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/u.test(stamp.signature)
            || !instant(expected.observedAt) || !isAccountId(expected.checkpointLineage)
            || typeof expected.checkpointEpoch !== 'string' || !/^(?:0|[1-9][0-9]{0,19})$/u.test(expected.checkpointEpoch)
            || BigInt(expected.checkpointEpoch) > MAX_EPOCH
            || claim.bucket !== expected.bucket || claim.name !== expected.name || claim.generation !== expected.generation
            || claim.checkpointLineage !== expected.checkpointLineage
            || BigInt(claim.checkpointEpoch) > BigInt(expected.checkpointEpoch)
            || claim.signedAt > expected.observedAt) throw new Error();
        const signature = Buffer.from(stamp.signature, 'base64url');
        if (signature.length !== 64 || signature.toString('base64url') !== stamp.signature
            || !verify(null, payload(claim), publicKey, signature)) throw new Error();
    } catch { throw new JournalRetirementAuthorizationError(); }
}
