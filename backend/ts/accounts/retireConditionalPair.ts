import { createHash, createPublicKey, type KeyObject } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { parseInactivityInstant } from './childInactivityPolicy';
import { readRecoveryCheckpoint, verifyCheckpointRecoveryCoverage } from './accountRecoveryCheckpoint';
import { collectCloudSqlRecoveryInventory, createCloudSqlMetadataClient, type CloudSqlMetadataClient } from './cloudSqlRecoveryInventory';
import { createGcsDeletionJournal, type JournalHttpClient } from './gcsDeletionJournal';
import { createGcsRetentionJournal, type ConditionalRetirementPair, type ObservedRestoreGuard } from './gcsRetentionJournal';
import { signJournalRetirementClaim, verifyJournalRetirementStamp, type JournalRetirementStamp } from './journalRetirementStamp';
import { verifyRetirementBatch, type RetirementBatchPermit } from './retirementBatchPermit';
import { verifyDeletedAccountEffects } from './verifiedDeletionEffects';
import { verifyKeptActivity } from './verifiedKeptActivity';
import { assertNoRetentionRuntimeWriters, isProductionRecoveryOperator } from './retentionReconciliation';
import { verifyRetiredJournalObjects } from './verifyRetiredJournalObjects';
import { verifyRetirementSchemas } from './retirementSourceSchema';
import { CHILD_RETENTION_BUCKET } from '../config/childInactivityDeployment';
import { createProductionWitnessRetirement } from './productionWitnessRetirement';
import { RETIREMENT_API as API, RETIREMENT_FIELDS as FIELDS, retirementStorageRequest as request,
    retirementObjectMetadata as metadata, verifyRetirementBucketPolicy, createRetirementStorageClient,
    type RetirementObjectMetadata } from './gcsRetirementTransport';

type Connection = Pick<PoolConnection, 'query' | 'beginTransaction' | 'rollback' | 'destroy'>;
type Pins = Readonly<{ database: string; currentUser: string; serverUuid: string }>;
type Entry = Readonly<{ name: string; generation: string; contentSha256: string }>;
type Base = Readonly<{ connection: Connection; pins: Pins; bucket: string; permit: RetirementBatchPermit;
    publicKey: KeyObject; privateKey: KeyObject; project: string; instance: string; cloud: CloudSqlMetadataClient;
    guard: Readonly<{ readRestoreGuard(): Promise<ObservedRestoreGuard> }>; client?: JournalHttpClient;
    verifySchema(connection: Pick<PoolConnection, 'query'>): Promise<void>; confirmation: string; externalCopiesConfirmation: string }>;
type PairOptions = Base & Readonly<{ pair: ConditionalRetirementPair;
    retireWitnesses(accountId: string, verifyFence: () => Promise<void>): Promise<void>;
    verifyWitnessesAbsent(accountId: string): Promise<void>;
    journal: Readonly<{ readConditionalRetirementPairs(): Promise<Readonly<{ pairs: readonly ConditionalRetirementPair[]; digest: string }>> }> }>;

/** Construct only real provider and schema dependencies for an operator-run pair retirement. */
export async function retireConditionalPairForOperator(options: Omit<PairOptions,
    'guard' | 'journal' | 'cloud' | 'client' | 'verifySchema' | 'retireWitnesses' | 'verifyWitnessesAbsent' | 'project' | 'instance'> & Readonly<{
        expectedBucket: string; guardKey: Buffer; activityKey: Buffer; warningKey: Buffer;
    }>): Promise<Readonly<{ status: 'retired' }>> {
    if (options.bucket !== CHILD_RETENTION_BUCKET || options.expectedBucket !== CHILD_RETENTION_BUCKET) throw new Error('Unapproved retention bucket.');
    let guard: ReturnType<typeof createGcsRetentionJournal>;
    const verifyRetired = (objects: readonly Readonly<{ bucket: string; name: string; generation: string; stamp: unknown }>[]) =>
        verifyRetiredJournalObjects(options.connection, guard,
            { database: options.pins.database, currentUser: options.pins.currentUser, targetServerUuid: options.pins.serverUuid,
                originalServerUuid: options.pins.serverUuid }, objects, options.publicKey);
    guard = createGcsRetentionJournal({ bucket: options.bucket, expectedBucket: options.expectedBucket, key: options.guardKey,
        verifyActivityContinuity: async () => false, verifyRetiredObjects: verifyRetired });
    await guard.assertRestoreGuardHistory();
    const explicit = createGcsDeletionJournal({ verifyRetiredObjects: verifyRetired });
    const witnesses = createProductionWitnessRetirement({ connection: options.connection, explicit, conditional: guard,
        activityKey: options.activityKey, warningKey: options.warningKey });
    try { return await retireConditionalPair({ ...options, guard, journal: guard, cloud: createCloudSqlMetadataClient(),
        verifySchema: verifyRetirementSchemas, ...witnesses, project: 'noted-reef-387021', instance: 'cms-mickeyf' }); }
    finally { witnesses.dispose(); }
}

/** Construct real dependencies to reconcile or resume a partially retired pair. */
export async function resumeConditionalResolutionForOperator(options: Omit<Base,
    'guard' | 'cloud' | 'client' | 'verifySchema' | 'project' | 'instance'> & Readonly<{
        expectedBucket: string; guardKey: Buffer; intentObject: Entry; resolutionObject: Entry;
    }>): Promise<Readonly<{ status: 'retired' | 'already-retired' }>> {
    if (options.bucket !== CHILD_RETENTION_BUCKET || options.expectedBucket !== CHILD_RETENTION_BUCKET) throw new Error('Unapproved retention bucket.');
    const guard = createGcsRetentionJournal({ bucket: options.bucket, expectedBucket: options.expectedBucket,
        key: options.guardKey, verifyActivityContinuity: async () => false });
    await guard.assertRestoreGuardHistory();
    return resumeConditionalResolution({ ...options, guard, cloud: createCloudSqlMetadataClient(),
        verifySchema: verifyRetirementSchemas, project: 'noted-reef-387021', instance: 'cms-mickeyf' });
}

async function validatedBase(options: Base, intent: Entry, resolution: Entry) {
    if (options.confirmation !== 'ORIGINAL PRIMARY AND ALL WRITERS FENCED'
        || options.externalCopiesConfirmation !== 'ALL PERMITTED RECOVERY COPIES ACCOUNTED FOR'
        || typeof options.verifySchema !== 'function' || options.privateKey.type !== 'private'
        || options.privateKey.asymmetricKeyType !== 'ed25519' || options.publicKey.type !== 'public'
        || options.publicKey.asymmetricKeyType !== 'ed25519' || !createPublicKey(options.privateKey)
            .export({ type: 'spki', format: 'der' }).equals(options.publicKey.export({ type: 'spki', format: 'der' }))) throw new Error();
    const permit = verifyRetirementBatch(options.permit, options.publicKey), pins = { ...options.pins };
    if (permit.bucket !== options.bucket || permit.database !== pins.database || permit.serverUuid !== pins.serverUuid
        || resolution.name !== intent.name.replace('v1/conditional/', 'v1/resolutions/')
        || ![intent, resolution].every(item => permit.entries.some(value => value.name === item.name
            && value.generation === item.generation && value.contentSha256 === item.contentSha256))) throw new Error();
    const guard = await options.guard.readRestoreGuard(), guardText = JSON.stringify(guard);
    const fingerprint = createHash('sha256').update(options.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
    if (guard.state !== 'hold' || guard.database !== pins.database || guard.serverUuid !== pins.serverUuid
        || !guard.recoveryCheckpoint || guard.recoveryCheckpoint.lineage !== permit.lineage
        || BigInt(guard.recoveryCheckpoint.minimumEpoch) < BigInt(permit.epoch) || guard.recoveryCheckpoint.keySha256 !== fingerprint) throw new Error();
    await readRecoveryCheckpoint(options.connection, { ...pins, lineage: permit.lineage, minimumEpoch: guard.recoveryCheckpoint.minimumEpoch });
    await options.verifySchema(options.connection);
    await assertNoRetentionRuntimeWriters(options.connection, isProductionRecoveryOperator(pins));
    const client = options.client ?? createRetirementStorageClient();
    return { permit, pins, guardText, minimumEpoch: guard.recoveryCheckpoint.minimumEpoch, client };
}

async function sqlNow(connection: Connection, pins: Pins): Promise<string> {
    const [rows] = await connection.query<RowDataPacket[]>({ sql: `SELECT DATABASE() AS databaseName,
        CURRENT_USER() AS currentUser, @@GLOBAL.server_uuid AS serverUuid,
        DATE_FORMAT(UTC_TIMESTAMP(6),'%Y-%m-%dT%H:%i:%s.%fZ') AS nowUtc`, timeout: 10_000 });
    if (!Array.isArray(rows) || rows.length !== 1 || rows[0].databaseName !== pins.database
        || rows[0].currentUser !== pins.currentUser || rows[0].serverUuid !== pins.serverUuid
        || parseInactivityInstant(rows[0].nowUtc) === null) throw new Error();
    return rows[0].nowUtc as string;
}

async function readLive(client: JournalHttpClient, bucket: string, entry: Entry) {
    const url = `${API}/storage/v1/b/${bucket}/o/${encodeURIComponent(entry.name)}`;
    const item = metadata(await request(client, { method: 'GET', url, params: { generation: entry.generation,
        ifGenerationMatch: entry.generation, fields: FIELDS }, responseType: 'json' }), bucket, entry.name, false, 2048);
    const body = await request(client, { method: 'GET', url, params: { alt: 'media', generation: entry.generation,
        ifGenerationMatch: entry.generation }, responseType: 'text' });
    if (item.generation !== entry.generation || typeof body !== 'string' || Buffer.byteLength(body) !== item.size
        || createHash('md5').update(body).digest('base64') !== item.md5 || createHash('sha256').update(body).digest('hex') !== entry.contentSha256) throw new Error();
    return { url, item };
}

async function stampAndDelete(options: Base, entry: Entry, item: RetirementObjectMetadata, url: string,
    observedAt: string, floor: string, guard: Awaited<ReturnType<typeof validatedBase>>, beforeDelete: () => Promise<void>) {
    const now = await sqlNow(options.connection, guard.pins), existing = item.metadata.ludolumeRetirement;
    let stamp: JournalRetirementStamp;
    if (existing === undefined) stamp = signJournalRetirementClaim({ version: 1, bucket: options.bucket, name: entry.name,
        generation: entry.generation, contentSha256: entry.contentSha256, effectConfirmedAt: observedAt, recoveryFloor: floor,
        checkpointLineage: guard.permit.lineage, checkpointEpoch: guard.permit.epoch, signedAt: now }, options.privateKey);
    else {
        stamp = JSON.parse(existing) as JournalRetirementStamp;
        verifyJournalRetirementStamp(stamp, { bucket: options.bucket, name: entry.name, generation: entry.generation,
            checkpointLineage: guard.permit.lineage, checkpointEpoch: guard.minimumEpoch, observedAt: now }, options.publicKey);
        if (stamp.claim.contentSha256 !== entry.contentSha256 || stamp.claim.effectConfirmedAt !== observedAt
            || stamp.claim.checkpointEpoch !== guard.permit.epoch) throw new Error();
    }
    let ready = item;
    if (existing === undefined) {
        ready = metadata(await request(guard.client, { method: 'PATCH', url, params: { generation: entry.generation,
            ifGenerationMatch: entry.generation, ifMetagenerationMatch: item.metageneration, fields: FIELDS },
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
            data: JSON.stringify({ metadata: { ...item.metadata, ludolumeRetirement: JSON.stringify(stamp) } }), responseType: 'json' }),
        options.bucket, entry.name, false, 2048);
        if (ready.generation !== entry.generation || ready.metadata.ludolumeRetirement !== JSON.stringify(stamp)) throw new Error();
    }
    await beforeDelete();
    await request(guard.client, { method: 'DELETE', url, params: { generation: entry.generation,
        ifGenerationMatch: entry.generation, ifMetagenerationMatch: ready.metageneration }, responseType: 'json' });
    const deleted = metadata(await request(guard.client, { method: 'GET', url, params: { generation: entry.generation,
        softDeleted: true, fields: FIELDS }, responseType: 'json' }), options.bucket, entry.name, true, 2048);
    if (deleted.generation !== entry.generation || deleted.metadata.ludolumeRetirement !== JSON.stringify(stamp)) throw new Error();
    return stamp;
}

/** Retire the intent first, then its paired outcome. Unknown or unresolved outcomes stay held. */
export async function retireConditionalPair(options: PairOptions): Promise<Readonly<{ status: 'retired' }>> {
    const connection = options.connection; let begun = false, beginning = false;
    try {
        const target = options.pair, guarded = await validatedBase(options, target.intentObject, target.resolutionObject);
        const current = await options.journal.readConditionalRetirementPairs();
        if (!/^[a-f0-9]{64}$/u.test(current.digest) || !current.pairs.some(pair => isDeepStrictEqual(pair, target))) throw new Error();
        const recovery = await collectCloudSqlRecoveryInventory({ project: options.project, instance: options.instance,
            observedAt: await sqlNow(connection, guarded.pins), client: options.cloud });
        if (guarded.permit.committedBefore >= recovery.cloudSqlFloor) throw new Error();
        const observedAt = guarded.permit.committedBefore;
        verifyCheckpointRecoveryCoverage({ lineage: guarded.permit.lineage, epoch: guarded.permit.epoch, committedBefore: guarded.permit.committedBefore },
            recovery, { project: options.project, instance: options.instance });
        await verifyRetirementBucketPolicy(guarded.client, options.bucket);
        const intent = await readLive(guarded.client, options.bucket, target.intentObject);
        const resolution = await readLive(guarded.client, options.bucket, target.resolutionObject);
        beginning = true; await connection.beginTransaction(); beginning = false; begun = true;
        const accountDeleted = await verifyDeletedAccountEffects(connection, [target.intent.childId]);
        if (!accountDeleted && (target.resolution.outcome !== 'kept' || !await verifyKeptActivity(connection, target))) throw new Error();
        await readRecoveryCheckpoint(connection, { ...guarded.pins, lineage: guarded.permit.lineage, minimumEpoch: guarded.minimumEpoch });
        const check = async () => {
            if (JSON.stringify(await options.guard.readRestoreGuard()) !== guarded.guardText) throw new Error();
            await assertNoRetentionRuntimeWriters(connection, isProductionRecoveryOperator(guarded.pins));
        };
        await check();
        if (accountDeleted) {
            await options.retireWitnesses(target.intent.childId, check);
            await check();
            await options.verifyWitnessesAbsent(target.intent.childId);
        }
        const beforeIntent = async () => {
            const inventory = await collectCloudSqlRecoveryInventory({ project: options.project, instance: options.instance,
                observedAt: await sqlNow(connection, guarded.pins), client: options.cloud });
            verifyCheckpointRecoveryCoverage({ lineage: guarded.permit.lineage, epoch: guarded.permit.epoch, committedBefore: guarded.permit.committedBefore },
                inventory, { project: options.project, instance: options.instance });
            if (guarded.permit.committedBefore >= inventory.cloudSqlFloor) throw new Error();
            await check(); await verifyRetirementBucketPolicy(guarded.client, options.bucket);
            if (accountDeleted) await options.verifyWitnessesAbsent(target.intent.childId);
        };
        await stampAndDelete(options, target.intentObject, intent.item, intent.url, observedAt, recovery.cloudSqlFloor, guarded, beforeIntent);
        await stampAndDelete(options, target.resolutionObject, resolution.item, resolution.url, observedAt, recovery.cloudSqlFloor, guarded,
            async () => { await check(); await verifyRetirementBucketPolicy(guarded.client, options.bucket); });
        await connection.rollback(); begun = false;
        await check();
        return { status: 'retired' };
    } catch {
        if (beginning) connection.destroy(); else if (begun) { try { await connection.rollback(); } catch { connection.destroy(); } }
        throw new Error('Conditional retirement unavailable or unconfirmed. Keep recovery held and reconcile before retrying.');
    }
}

/** Resume the outcome only after the exact paired intent has a verified soft-delete stamp. */
export async function resumeConditionalResolution(options: Base & Readonly<{ intentObject: Entry; resolutionObject: Entry }>):
Promise<Readonly<{ status: 'retired' | 'already-retired' }>> {
    const connection = options.connection; let begun = false, beginning = false;
    try {
        const guarded = await validatedBase(options, options.intentObject, options.resolutionObject);
        await verifyRetirementBucketPolicy(guarded.client, options.bucket);
        const intentUrl = `${API}/storage/v1/b/${options.bucket}/o/${encodeURIComponent(options.intentObject.name)}`;
        const live = await request(guarded.client, { method: 'GET', url: intentUrl, params: { generation: options.intentObject.generation,
            ifGenerationMatch: options.intentObject.generation, fields: FIELDS }, responseType: 'json' }, true);
        if (live !== null) throw new Error();
        const deleted = metadata(await request(guarded.client, { method: 'GET', url: intentUrl, params: { generation: options.intentObject.generation,
            softDeleted: true, fields: FIELDS }, responseType: 'json' }), options.bucket, options.intentObject.name, true, 2048);
        const stamp = JSON.parse(deleted.metadata.ludolumeRetirement) as JournalRetirementStamp;
        const now = await sqlNow(connection, guarded.pins);
        verifyJournalRetirementStamp(stamp, { bucket: options.bucket, name: options.intentObject.name, generation: options.intentObject.generation,
            checkpointLineage: guarded.permit.lineage, checkpointEpoch: guarded.minimumEpoch, observedAt: now }, options.publicKey);
        if (deleted.generation !== options.intentObject.generation || stamp.claim.contentSha256 !== options.intentObject.contentSha256
            || stamp.claim.checkpointEpoch !== guarded.permit.epoch) throw new Error();
        const resolutionUrl = `${API}/storage/v1/b/${options.bucket}/o/${encodeURIComponent(options.resolutionObject.name)}`;
        const resolutionLive = await request(guarded.client, { method: 'GET', url: resolutionUrl, params: {
            generation: options.resolutionObject.generation, ifGenerationMatch: options.resolutionObject.generation, fields: FIELDS }, responseType: 'json' }, true);
        if (resolutionLive === null) {
            const already = metadata(await request(guarded.client, { method: 'GET', url: resolutionUrl, params: {
                generation: options.resolutionObject.generation, softDeleted: true, fields: FIELDS }, responseType: 'json' }),
            options.bucket, options.resolutionObject.name, true, 2048);
            const proof = JSON.parse(already.metadata.ludolumeRetirement) as JournalRetirementStamp;
            verifyJournalRetirementStamp(proof, { bucket: options.bucket, name: options.resolutionObject.name,
                generation: options.resolutionObject.generation, checkpointLineage: guarded.permit.lineage,
                checkpointEpoch: guarded.minimumEpoch, observedAt: now }, options.publicKey);
            if (already.generation !== options.resolutionObject.generation || proof.claim.contentSha256 !== options.resolutionObject.contentSha256
                || proof.claim.checkpointEpoch !== guarded.permit.epoch || proof.claim.effectConfirmedAt !== stamp.claim.effectConfirmedAt
                || JSON.stringify(await options.guard.readRestoreGuard()) !== guarded.guardText) throw new Error();
            return { status: 'already-retired' };
        }
        const resolution = await readLive(guarded.client, options.bucket, options.resolutionObject);
        beginning = true; await connection.beginTransaction(); beginning = false; begun = true;
        await readRecoveryCheckpoint(connection, { ...guarded.pins, lineage: guarded.permit.lineage, minimumEpoch: guarded.minimumEpoch });
        const check = async () => {
            const inventory = await collectCloudSqlRecoveryInventory({ project: options.project, instance: options.instance,
                observedAt: await sqlNow(connection, guarded.pins), client: options.cloud });
            verifyCheckpointRecoveryCoverage({ lineage: guarded.permit.lineage, epoch: guarded.permit.epoch,
                committedBefore: guarded.permit.committedBefore }, inventory, { project: options.project, instance: options.instance });
            if (stamp.claim.effectConfirmedAt >= inventory.cloudSqlFloor || guarded.permit.committedBefore >= inventory.cloudSqlFloor
                || JSON.stringify(await options.guard.readRestoreGuard()) !== guarded.guardText) throw new Error();
            await assertNoRetentionRuntimeWriters(connection, isProductionRecoveryOperator(guarded.pins));
            await verifyRetirementBucketPolicy(guarded.client, options.bucket);
        };
        await stampAndDelete(options, options.resolutionObject, resolution.item, resolution.url,
            stamp.claim.effectConfirmedAt, stamp.claim.recoveryFloor, guarded, check);
        await connection.rollback(); begun = false;
        if (JSON.stringify(await options.guard.readRestoreGuard()) !== guarded.guardText) throw new Error();
        return { status: 'retired' };
    } catch {
        if (beginning) connection.destroy(); else if (begun) { try { await connection.rollback(); } catch { connection.destroy(); } }
        throw new Error('Conditional outcome state is unavailable or unconfirmed. Keep recovery held.');
    }
}
