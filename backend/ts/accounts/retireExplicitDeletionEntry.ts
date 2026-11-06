import { createHash, createPublicKey, type KeyObject } from 'node:crypto';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { createGcsDeletionJournal, DELETION_JOURNAL_BUCKET, type DeletionJournalEntry, type JournalHttpClient } from './gcsDeletionJournal';
import { parseDeletionIntent } from './deletionJournal';
import { parseInactivityInstant } from './childInactivityPolicy';
import { readRecoveryCheckpoint, verifyCheckpointRecoveryCoverage } from './accountRecoveryCheckpoint';
import { collectCloudSqlRecoveryInventory, createCloudSqlMetadataClient, type CloudSqlMetadataClient } from './cloudSqlRecoveryInventory';
import { signJournalRetirementClaim, verifyJournalRetirementStamp, type JournalRetirementStamp } from './journalRetirementStamp';
import { verifyRetirementBatch, type RetirementBatchPermit } from './retirementBatchPermit';
import { verifyDeletedAccountEffects } from './verifiedDeletionEffects';
import { assertNoRetentionRuntimeWriters, isProductionRecoveryOperator } from './retentionReconciliation';
import { createGcsRetentionJournal, type ObservedRestoreGuard } from './gcsRetentionJournal';
import { verifyRetiredJournalObjects } from './verifyRetiredJournalObjects';
import { verifyRetirementSchemas } from './retirementSourceSchema';
import { CHILD_RETENTION_BUCKET } from '../config/childInactivityDeployment';
import { createProductionWitnessRetirement } from './productionWitnessRetirement';
import { RETIREMENT_API as API, RETIREMENT_FIELDS as FIELDS, retirementStorageRequest as request,
    retirementObjectMetadata, verifyRetirementBucketPolicy, createRetirementStorageClient,
    type RetirementObjectMetadata as ObjectMetadata } from './gcsRetirementTransport';

type Connection = Pick<PoolConnection, 'query' | 'beginTransaction' | 'rollback' | 'destroy'>;
type Pins = Readonly<{ database: string; currentUser: string; serverUuid: string }>;
const BUCKET = DELETION_JOURNAL_BUCKET;
const metadata = (value: unknown, name: string, softDeleted: boolean) => retirementObjectMetadata(value, BUCKET, name, softDeleted, 512);

/** Construct the real provider dependencies; this does not accept test clients or schema callbacks. */
export async function retireExplicitDeletionEntryForOperator(options: Omit<Parameters<typeof retireExplicitDeletionEntry>[0],
    'guard' | 'journal' | 'cloud' | 'client' | 'verifySchema' | 'retireWitnesses' | 'verifyWitnessesAbsent' | 'project' | 'instance'> & Readonly<{
        guardBucket: string; expectedGuardBucket: string; guardKey: Buffer; activityKey: Buffer; warningKey: Buffer;
    }>): Promise<Readonly<{ status: 'retired'; generation: string }>> {
    if (options.guardBucket !== CHILD_RETENTION_BUCKET || options.expectedGuardBucket !== CHILD_RETENTION_BUCKET) throw new Error('Unapproved retention bucket.');
    let guard: ReturnType<typeof createGcsRetentionJournal>;
    const verifyRetired = (objects: readonly Readonly<{ bucket: string; name: string; generation: string; stamp: unknown }>[]) =>
        verifyRetiredJournalObjects(options.connection, guard,
        { database: options.pins.database, currentUser: options.pins.currentUser, targetServerUuid: options.pins.serverUuid,
            originalServerUuid: options.pins.serverUuid }, objects, options.publicKey);
    guard = createGcsRetentionJournal({ bucket: options.guardBucket, expectedBucket: options.expectedGuardBucket,
        key: options.guardKey, verifyActivityContinuity: async () => false, verifyRetiredObjects: verifyRetired });
    await guard.assertRestoreGuardHistory();
    const journal = createGcsDeletionJournal({ verifyRetiredObjects: verifyRetired });
    const witnesses = createProductionWitnessRetirement({ connection: options.connection, explicit: journal, conditional: guard,
        activityKey: options.activityKey, warningKey: options.warningKey });
    try { return await retireExplicitDeletionEntry({ ...options, guard, journal, cloud: createCloudSqlMetadataClient(),
        verifySchema: verifyRetirementSchemas, ...witnesses, project: 'noted-reef-387021', instance: 'cms-mickeyf' }); }
    finally { witnesses.dispose(); }
}

/**
 * Retire one exact explicit-deletion journal generation. The operator must
 * verify reviewed SQL schema, fence all writers and bucket-policy changes, and
 * account for every outside recovery copy. A failure after PATCH or DELETE is
 * unconfirmed; never automatically retry it or authorize a cutover.
 */
export async function retireExplicitDeletionEntry(options: Readonly<{
    connection: Connection; pins: Pins; entry: DeletionJournalEntry; permit: RetirementBatchPermit;
    publicKey: KeyObject; privateKey: KeyObject; project: string; instance: string;
    guard: Readonly<{ readRestoreGuard(): Promise<ObservedRestoreGuard> }>;
    journal: Readonly<{ readDeletionEntries(): Promise<Readonly<{ entries: readonly DeletionJournalEntry[]; digest: string }>> }>;
    cloud: CloudSqlMetadataClient; client?: JournalHttpClient; verifySchema(connection: Pick<PoolConnection, 'query'>): Promise<void>;
    confirmation: string; externalCopiesConfirmation: string;
    retireWitnesses(accountId: string, verifyFence: () => Promise<void>): Promise<void>;
    verifyWitnessesAbsent(accountId: string): Promise<void>;
}>): Promise<Readonly<{ status: 'retired'; generation: string }>> {
    const connection = options.connection;
    let begun = false, beginning = false;
    try {
        if (options.confirmation !== 'ORIGINAL PRIMARY AND ALL WRITERS FENCED'
            || options.externalCopiesConfirmation !== 'ALL PERMITTED RECOVERY COPIES ACCOUNTED FOR'
            || typeof options.verifySchema !== 'function' || options.privateKey.type !== 'private'
            || options.privateKey.asymmetricKeyType !== 'ed25519' || options.publicKey.type !== 'public'
            || options.publicKey.asymmetricKeyType !== 'ed25519' || !createPublicKey(options.privateKey)
                .export({ type: 'spki', format: 'der' }).equals(options.publicKey.export({ type: 'spki', format: 'der' }))) throw new Error();
        const pins = { ...options.pins };
        const entry = { ...options.entry, intent: parseDeletionIntent(options.entry.intent) };
        const permit = verifyRetirementBatch(options.permit, options.publicKey);
        if (permit.database !== pins.database || permit.serverUuid !== pins.serverUuid
            || !permit.entries.some(item => item.name === entry.name && item.generation === entry.generation
                && item.contentSha256 === entry.contentSha256)) throw new Error();
        const guard = await options.guard.readRestoreGuard(), guardText = JSON.stringify(guard);
        const fingerprint = createHash('sha256').update(options.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
        if (guard.state !== 'hold' || guard.database !== pins.database || guard.serverUuid !== pins.serverUuid
            || !guard.recoveryCheckpoint || guard.recoveryCheckpoint.lineage !== permit.lineage
            || BigInt(guard.recoveryCheckpoint.minimumEpoch) < BigInt(permit.epoch)
            || guard.recoveryCheckpoint.keySha256 !== fingerprint) throw new Error();
        await readRecoveryCheckpoint(connection, { ...pins, lineage: permit.lineage, minimumEpoch: guard.recoveryCheckpoint.minimumEpoch });
        await options.verifySchema(connection);
        await assertNoRetentionRuntimeWriters(connection, isProductionRecoveryOperator(pins));
        const now = async (): Promise<string> => {
            const [clock] = await connection.query<RowDataPacket[]>({ sql: `SELECT DATABASE() AS databaseName,
                CURRENT_USER() AS currentUser, @@GLOBAL.server_uuid AS serverUuid,
                DATE_FORMAT(UTC_TIMESTAMP(6),'%Y-%m-%dT%H:%i:%s.%fZ') AS nowUtc`, timeout: 10_000 });
            if (!Array.isArray(clock) || clock.length !== 1 || clock[0].databaseName !== pins.database
                || clock[0].currentUser !== pins.currentUser || clock[0].serverUuid !== pins.serverUuid
                || parseInactivityInstant(clock[0].nowUtc) === null) throw new Error();
            return clock[0].nowUtc as string;
        };
        const inventory = await options.journal.readDeletionEntries();
        if (!Array.isArray(inventory.entries) || !/^[a-f0-9]{64}$/u.test(inventory.digest)
            || inventory.entries.filter(item => item.name === entry.name && item.generation === entry.generation
                && item.contentSha256 === entry.contentSha256).length !== 1) throw new Error();
        const recovery = await collectCloudSqlRecoveryInventory({ project: options.project, instance: options.instance,
            observedAt: await now(), client: options.cloud });
        if (permit.committedBefore >= recovery.cloudSqlFloor) throw new Error();
        verifyCheckpointRecoveryCoverage({ lineage: permit.lineage, epoch: permit.epoch, committedBefore: permit.committedBefore },
            recovery, { project: options.project, instance: options.instance });
        const observedAt = permit.committedBefore;
        const client = options.client ?? createRetirementStorageClient();
        const base = `${API}/storage/v1/b/${BUCKET}`, objectUrl = `${base}/o/${encodeURIComponent(entry.name)}`;
        const bucketCheck = () => verifyRetirementBucketPolicy(client, BUCKET);
        await bucketCheck();
        const meta = metadata(await request(client, { method: 'GET', url: objectUrl,
            params: { generation: entry.generation, ifGenerationMatch: entry.generation, fields: FIELDS }, responseType: 'json' }), entry.name, false);
        if (meta.generation !== entry.generation) throw new Error();
        const body = await request(client, { method: 'GET', url: objectUrl,
            params: { alt: 'media', generation: entry.generation, ifGenerationMatch: entry.generation }, responseType: 'text' });
        if (typeof body !== 'string' || Buffer.byteLength(body) !== meta.size || createHash('md5').update(body).digest('base64') !== meta.md5
            || createHash('sha256').update(body).digest('hex') !== entry.contentSha256
            || JSON.stringify(parseDeletionIntent(JSON.parse(body))) !== JSON.stringify(entry.intent)) throw new Error();
        beginning = true; await connection.beginTransaction(); beginning = false; begun = true;
        if (!await verifyDeletedAccountEffects(connection, [entry.intent.accountId])) throw new Error();
        await readRecoveryCheckpoint(connection, { ...pins, lineage: permit.lineage, minimumEpoch: guard.recoveryCheckpoint.minimumEpoch });
        const verifyFence = async () => {
            if (JSON.stringify(await options.guard.readRestoreGuard()) !== guardText) throw new Error();
            await assertNoRetentionRuntimeWriters(connection, isProductionRecoveryOperator(pins));
        };
        await verifyFence();
        await options.retireWitnesses(entry.intent.accountId, verifyFence);
        await verifyFence();
        await options.verifyWitnessesAbsent(entry.intent.accountId);
        const signedAt = await now();
        let stamp: JournalRetirementStamp;
        const existing = meta.metadata.ludolumeRetirement;
        if (existing === undefined) {
            stamp = signJournalRetirementClaim({ version: 1, bucket: BUCKET, name: entry.name, generation: entry.generation,
                contentSha256: entry.contentSha256, effectConfirmedAt: observedAt, recoveryFloor: recovery.cloudSqlFloor,
                checkpointLineage: permit.lineage, checkpointEpoch: permit.epoch, signedAt }, options.privateKey);
        } else {
            stamp = JSON.parse(existing) as JournalRetirementStamp;
            verifyJournalRetirementStamp(stamp, { bucket: BUCKET, name: entry.name, generation: entry.generation,
                checkpointLineage: permit.lineage, checkpointEpoch: guard.recoveryCheckpoint.minimumEpoch, observedAt: signedAt }, options.publicKey);
            if (stamp.claim.contentSha256 !== entry.contentSha256 || stamp.claim.effectConfirmedAt !== observedAt
                || stamp.claim.checkpointEpoch !== permit.epoch) throw new Error();
        }
        let ready = meta;
        if (existing === undefined) {
            const value = await request(client, { method: 'PATCH', url: objectUrl, params: { generation: entry.generation,
                ifGenerationMatch: entry.generation, ifMetagenerationMatch: meta.metageneration, fields: FIELDS },
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
                data: JSON.stringify({ metadata: { ...meta.metadata, ludolumeRetirement: JSON.stringify(stamp) } }), responseType: 'json' });
            ready = metadata(value, entry.name, false);
            if (ready.generation !== entry.generation || ready.metadata.ludolumeRetirement !== JSON.stringify(stamp)) throw new Error();
        }
        const current = await collectCloudSqlRecoveryInventory({ project: options.project, instance: options.instance,
            observedAt: await now(), client: options.cloud });
        verifyCheckpointRecoveryCoverage({ lineage: permit.lineage, epoch: permit.epoch, committedBefore: permit.committedBefore },
            current, { project: options.project, instance: options.instance });
        if (permit.committedBefore >= current.cloudSqlFloor || JSON.stringify(await options.guard.readRestoreGuard()) !== guardText) throw new Error();
        await assertNoRetentionRuntimeWriters(connection, isProductionRecoveryOperator(pins));
        await bucketCheck();
        await options.verifyWitnessesAbsent(entry.intent.accountId);
        await request(client, { method: 'DELETE', url: objectUrl, params: { generation: entry.generation,
            ifGenerationMatch: entry.generation, ifMetagenerationMatch: ready.metageneration }, responseType: 'json' });
        await connection.rollback(); begun = false;
        const retired = metadata(await request(client, { method: 'GET', url: objectUrl, params: { generation: entry.generation,
            softDeleted: true, fields: FIELDS }, responseType: 'json' }), entry.name, true);
        if (retired.generation !== entry.generation || retired.metadata.ludolumeRetirement !== JSON.stringify(stamp)
            || JSON.stringify(await options.guard.readRestoreGuard()) !== guardText) throw new Error();
        return { status: 'retired', generation: entry.generation };
    } catch {
        if (beginning) connection.destroy();
        else if (begun) { try { await connection.rollback(); } catch { connection.destroy(); } }
        throw new Error('Journal retirement unavailable or unconfirmed. Keep recovery held and reconcile before retrying.');
    }
}

/** Read-only reconciliation after an uncertain PATCH or DELETE acknowledgement. */
export async function inspectExplicitRetirement(options: Readonly<{
    connection: Pick<PoolConnection, 'query'>; pins: Pins; entry: Pick<DeletionJournalEntry, 'name' | 'generation' | 'contentSha256'>;
    permit: RetirementBatchPermit;
    publicKey: KeyObject; guard: Readonly<{ readRestoreGuard(): Promise<ObservedRestoreGuard> }>;
    client?: JournalHttpClient;
}>): Promise<'live-unstamped' | 'live-stamped' | 'retired'> {
    try {
        const { pins, entry } = options, permit = verifyRetirementBatch(options.permit, options.publicKey);
        if (permit.database !== pins.database || permit.serverUuid !== pins.serverUuid
            || !permit.entries.some(value => value.name === entry.name && value.generation === entry.generation
                && value.contentSha256 === entry.contentSha256)) throw new Error();
        const guard = await options.guard.readRestoreGuard(), guardText = JSON.stringify(guard);
        const fingerprint = createHash('sha256').update(options.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
        if (guard.state !== 'hold' || guard.database !== pins.database || guard.serverUuid !== pins.serverUuid
            || !guard.recoveryCheckpoint || guard.recoveryCheckpoint.lineage !== permit.lineage
            || BigInt(guard.recoveryCheckpoint.minimumEpoch) < BigInt(permit.epoch)
            || guard.recoveryCheckpoint.keySha256 !== fingerprint) throw new Error();
        await readRecoveryCheckpoint(options.connection, { ...pins, lineage: permit.lineage, minimumEpoch: guard.recoveryCheckpoint.minimumEpoch });
        const [clock] = await options.connection.query<RowDataPacket[]>({ sql: `SELECT DATABASE() AS databaseName,
            CURRENT_USER() AS currentUser, @@GLOBAL.server_uuid AS serverUuid,
            DATE_FORMAT(UTC_TIMESTAMP(6),'%Y-%m-%dT%H:%i:%s.%fZ') AS nowUtc`, timeout: 10_000 });
        if (!Array.isArray(clock) || clock.length !== 1 || clock[0].databaseName !== pins.database
            || clock[0].currentUser !== pins.currentUser || clock[0].serverUuid !== pins.serverUuid
            || parseInactivityInstant(clock[0].nowUtc) === null) throw new Error();
        const client = options.client ?? createRetirementStorageClient(), url = `${API}/storage/v1/b/${BUCKET}/o/${encodeURIComponent(entry.name)}`;
        const live = await request(client, { method: 'GET', url,
            params: { generation: entry.generation, ifGenerationMatch: entry.generation, fields: FIELDS }, responseType: 'json' }, true);
        let item: ObjectMetadata, status: 'live-unstamped' | 'live-stamped' | 'retired';
        if (live !== null) {
            item = metadata(live, entry.name, false);
            const body = await request(client, { method: 'GET', url, params: { alt: 'media', generation: entry.generation,
                ifGenerationMatch: entry.generation }, responseType: 'text' });
            if (typeof body !== 'string' || Buffer.byteLength(body) !== item.size || createHash('md5').update(body).digest('base64') !== item.md5
                || createHash('sha256').update(body).digest('hex') !== entry.contentSha256) throw new Error();
            status = item.metadata.ludolumeRetirement === undefined ? 'live-unstamped' : 'live-stamped';
        } else {
            const deleted = await request(client, { method: 'GET', url, params: { generation: entry.generation,
                softDeleted: true, fields: FIELDS }, responseType: 'json' }, true);
            if (deleted === null) throw new Error();
            item = metadata(deleted, entry.name, true); status = 'retired';
        }
        if (item.generation !== entry.generation) throw new Error();
        if (status !== 'live-unstamped') {
            const stamp = JSON.parse(item.metadata.ludolumeRetirement) as JournalRetirementStamp;
            verifyJournalRetirementStamp(stamp, { bucket: BUCKET, name: entry.name, generation: entry.generation,
                checkpointLineage: permit.lineage, checkpointEpoch: guard.recoveryCheckpoint.minimumEpoch, observedAt: clock[0].nowUtc }, options.publicKey);
            if (stamp.claim.contentSha256 !== entry.contentSha256 || stamp.claim.checkpointEpoch !== permit.epoch) throw new Error();
        }
        if (JSON.stringify(await options.guard.readRestoreGuard()) !== guardText) throw new Error();
        return status;
    } catch { throw new Error('Journal retirement state is unavailable or unconfirmed. Keep recovery held.'); }
}
