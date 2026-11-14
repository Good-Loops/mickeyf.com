import { sign, verify, type KeyObject } from 'node:crypto';
import { isAccountId } from './deletionJournal';
import { parseInactivityInstant } from './childInactivityPolicy';
import { DELETION_JOURNAL_BUCKET } from './gcsDeletionJournal';
import { CHILD_ACTIVITY_CONTINUITY_BUCKET } from '../config/childActivityContinuity';

type Entry = Readonly<{ name: string; generation: string; contentSha256: string }>;
type Claim = Readonly<{ version: 1; bucket: string; database: string; serverUuid: string; guardGeneration: string;
    lineage: string; epoch: string; committedBefore: string; entries: readonly Entry[] }>;
export type RetirementBatchPermit = Readonly<{ claim: Claim; signature: string }>;
const DOMAIN = 'ludolume-retirement-batch-v1\0';
const PREPARED_DOMAIN = 'ludolume-retirement-prepared-v1\0';
const NAME = /^v1\/intents\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/u;
const CONDITIONAL_NAME = /^v1\/(?:conditional|resolutions)\/[a-f0-9]{64}\/[a-f0-9]{64}\.json$/u;
const WITNESS_NAME = /^v1\/events\/[a-f0-9]{64}\/([0-9]{12})\.json$/u;
const NUM = /^[1-9][0-9]{0,19}$/u;

function validEntryName(bucket: string, name: string): boolean {
    if (bucket === DELETION_JOURNAL_BUCKET) return NAME.test(name);
    if (bucket !== CHILD_ACTIVITY_CONTINUITY_BUCKET) return CONDITIONAL_NAME.test(name);
    const witness = WITNESS_NAME.exec(name);
    return witness !== null && Number(witness[1]) > 0;
}

function normalize(value: unknown): Claim {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    const item = value as Record<string, unknown>;
    if (Object.keys(item).sort().join(',') !== 'bucket,committedBefore,database,entries,epoch,guardGeneration,lineage,serverUuid,version'
        || item.version !== 1 || typeof item.bucket !== 'string' || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(item.bucket)
        || item.bucket.includes('..') || typeof item.database !== 'string'
        || !/^[A-Za-z0-9_]{1,64}$/u.test(item.database) || !isAccountId(item.serverUuid) || !isAccountId(item.lineage)
        || typeof item.guardGeneration !== 'string' || !NUM.test(item.guardGeneration)
        || typeof item.epoch !== 'string' || !NUM.test(item.epoch) || BigInt(item.epoch) > BigInt('18446744073709551615')
        || parseInactivityInstant(item.committedBefore) === null || !Array.isArray(item.entries)
        || item.entries.length < 1 || item.entries.length > 100) throw new Error();
    const entries: Entry[] = item.entries.map(value => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
        const row = value as Record<string, unknown>;
        if (Object.keys(row).sort().join(',') !== 'contentSha256,generation,name' || typeof row.name !== 'string'
            || !validEntryName(item.bucket as string, row.name)
            || typeof row.generation !== 'string' || !NUM.test(row.generation) || typeof row.contentSha256 !== 'string'
            || !/^[a-f0-9]{64}$/u.test(row.contentSha256)) throw new Error();
        return { name: row.name, generation: row.generation, contentSha256: row.contentSha256 };
    });
    entries.sort((a, b) => a.name.localeCompare(b.name) || a.generation.localeCompare(b.generation));
    if (new Set(entries.map(row => JSON.stringify([row.name, row.generation]))).size !== entries.length) throw new Error();
    return { version: 1, bucket: item.bucket, database: item.database, serverUuid: item.serverUuid,
        guardGeneration: item.guardGeneration, lineage: item.lineage, epoch: item.epoch,
        committedBefore: item.committedBefore as string, entries };
}
function payload(claim: Claim): Buffer { return Buffer.from(DOMAIN + JSON.stringify(claim)); }

/** A prepared checkpoint is not authority to retire an object. */
export type PreparedRetirementCheckpoint = Readonly<{ claim: Claim; signature: string }>;

export function signPreparedRetirementCheckpoint(value: unknown, privateKey: KeyObject): PreparedRetirementCheckpoint {
    try {
        if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519') throw new Error();
        const claim = normalize(value);
        return { claim, signature: sign(null, Buffer.from(PREPARED_DOMAIN + JSON.stringify(claim)), privateKey).toString('base64url') };
    } catch { throw new Error('Prepared retirement checkpoint is invalid.'); }
}

export function verifyPreparedRetirementCheckpoint(value: unknown, publicKey: KeyObject): Claim {
    try {
        if (publicKey.type !== 'public' || publicKey.asymmetricKeyType !== 'ed25519' || !value
            || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'claim,signature') throw new Error();
        const prepared = value as Record<string, unknown>, claim = normalize(prepared.claim);
        if (typeof prepared.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/u.test(prepared.signature)) throw new Error();
        const signature = Buffer.from(prepared.signature, 'base64url');
        if (signature.length !== 64 || signature.toString('base64url') !== prepared.signature
            || !verify(null, Buffer.from(PREPARED_DOMAIN + JSON.stringify(claim)), publicKey, signature)) throw new Error();
        return claim;
    } catch { throw new Error('Prepared retirement checkpoint is invalid.'); }
}

/** Only the guarded advancement path may issue a permit after confirming recovery coverage. */
export function signRetirementBatch(value: unknown, privateKey: KeyObject): RetirementBatchPermit {
    try {
        if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519') throw new Error();
        const claim = normalize(value);
        return { claim, signature: sign(null, payload(claim), privateKey).toString('base64url') };
    } catch { throw new Error('Retirement batch permit is invalid.'); }
}

export function verifyRetirementBatch(value: unknown, publicKey: KeyObject): Claim {
    try {
        if (publicKey.type !== 'public' || publicKey.asymmetricKeyType !== 'ed25519' || !value
            || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'claim,signature') throw new Error();
        const permit = value as Record<string, unknown>, claim = normalize(permit.claim);
        if (typeof permit.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/u.test(permit.signature)) throw new Error();
        const signature = Buffer.from(permit.signature, 'base64url');
        if (signature.length !== 64 || signature.toString('base64url') !== permit.signature
            || !verify(null, payload(claim), publicKey, signature)) throw new Error();
        return claim;
    } catch { throw new Error('Retirement batch permit is invalid.'); }
}
