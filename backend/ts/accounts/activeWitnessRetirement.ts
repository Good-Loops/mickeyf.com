import { createHash, createHmac, type KeyObject } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { CHILD_ACTIVITY_CONTINUITY_BUCKET as BUCKET } from '../config/childActivityContinuity';
import { isAccountId } from './deletionJournal';
import { openAppendOnlyContinuitySession, type AppendOnlyObjectTransport } from './childContinuityAppendOnly';
import type { ContinuityHead, ContinuityLedgerRow } from './childContinuityHead';
import { readChildActivityState } from './durableChildActivity';
import { normalizeHistory } from './durableChildWarningStore';
import { createGcsChildContinuityTransport } from './gcsChildContinuityTransport';
import type { createGcsDeletionJournal, JournalHttpClient } from './gcsDeletionJournal';
import type { createGcsRetentionJournal, ObservedRestoreGuard } from './gcsRetentionJournal';
import { createRetirementWitnessStorage, type RetirementWitness } from './retirementWitnessStorage';
import { readRetirementKnownAccounts } from './retirementKnownAccounts';
import { assertWitnessKeyCoverage } from './witnessKeyCoverage';
import { RETIREMENT_API, RETIREMENT_FIELDS, retirementStorageRequest, retirementObjectMetadata,
    createRetirementStorageClient, verifyRetirementBucketPolicy } from './gcsRetirementTransport';
import { readRecoveryCheckpoint, verifyCheckpointRecoveryCoverage } from './accountRecoveryCheckpoint';
import { collectCloudSqlRecoveryInventory, type CloudSqlMetadataClient } from './cloudSqlRecoveryInventory';
import { assertNoRetentionRuntimeWriters, isProductionRecoveryOperator } from './retentionReconciliation';
import { verifyRetirementBatch, type RetirementBatchPermit } from './retirementBatchPermit';
import { parseInactivityInstant } from './childInactivityPolicy';

type Connection = Pick<PoolConnection, 'query' | 'beginTransaction' | 'rollback' | 'destroy'>;
type Pins = Readonly<{ database: string; currentUser: string; serverUuid: string }>;
export type WitnessIdentity = Readonly<{ name: string; generation: string; contentSha256: string }>;
const identity = (value: WitnessIdentity) => JSON.stringify([value.name, value.generation, value.contentSha256]);
const sequence = (name: string) => Number(name.slice(-17, -5));
const failure = () => new Error('Witness retirement unavailable or unconfirmed. Keep recovery held and inspect the exact selection.');

export type ActiveWitnessSource = Readonly<{
    bucket: typeof BUCKET;
    candidates(connection: Pick<PoolConnection, 'query'>): Promise<readonly RetirementWitness[]>;
    verify(connection: Pick<PoolConnection, 'query'>, selected: readonly WitnessIdentity[]): Promise<readonly RetirementWitness[]>;
    remove(entry: RetirementWitness): Promise<void>;
    inspect(entry: WitnessIdentity): Promise<'live' | 'soft-deleted'>;
}>;

/** Fenced operator only. Earlier external snapshots are redundant; SQL state and replay ledgers are never pruned here. */
export function createActiveWitnessSource(options: Readonly<{
    accountId: string; activityKey: Buffer; warningKey: Buffer; transport: AppendOnlyObjectTransport;
    store: ReturnType<typeof createRetirementWitnessStorage>;
    explicit: Pick<ReturnType<typeof createGcsDeletionJournal>, 'readDeletionEntries'>;
    conditional: Pick<ReturnType<typeof createGcsRetentionJournal>, 'readIntents'>;
    verifyPolicy(): Promise<void>;
    inspect(entry: WitnessIdentity): Promise<'live' | 'soft-deleted'>;
}>): ActiveWitnessSource {
    if (!isAccountId(options.accountId) || [options.activityKey, options.warningKey].some(key =>
        !Buffer.isBuffer(key) || key.length !== 32 || key.every(byte => byte === 0))
        || options.activityKey.equals(options.warningKey)) throw failure();
    const { accountId, store } = options;
    async function candidates(connection: Pick<PoolConnection, 'query'>): Promise<readonly RetirementWitness[]> {
        await options.verifyPolicy();
        const explicit = await options.explicit.readDeletionEntries(), intents = await options.conditional.readIntents();
        if (!Array.isArray(explicit.entries) || explicit.entries.length > 10_000 || !Array.isArray(intents) || intents.length > 10_000
            || explicit.entries.some(entry => entry.intent.accountId === accountId)
            || intents.some(intent => intent.childId === accountId || intent.parentId === accountId)) throw failure();
        const known = await readRetirementKnownAccounts({ connection, explicit: options.explicit, conditional: options.conditional });
        const inventory = await store.listAllIdentities();
        assertWitnessKeyCoverage(known, options.activityKey, options.warningKey, inventory);
        if (!known.includes(accountId) || !isDeepStrictEqual(inventory, await store.listAllIdentities())) throw failure();
        const [relation] = await connection.query<RowDataPacket[]>({ sql: `SELECT c.parent_uuid AS parentId,
            DATE_FORMAT(UTC_TIMESTAMP(6),'%Y-%m-%dT%H:%i:%s.%fZ') AS nowUtc
            FROM parent_child_consents c JOIN users u ON u.account_uuid=c.child_uuid
            JOIN users p ON p.account_uuid=c.parent_uuid WHERE c.child_uuid=? LIMIT 2 FOR SHARE`, timeout: 10_000 }, [accountId]);
        if (!Array.isArray(relation) || relation.length !== 1 || !isAccountId(relation[0].parentId)
            || relation[0].parentId === accountId || parseInactivityInstant(relation[0].nowUtc) === null) throw failure();
        const parentId = relation[0].parentId as string, now = Date.parse(relation[0].nowUtc);
        if (explicit.entries.some(entry => entry.intent.accountId === parentId)) throw failure();
        const result: RetirementWitness[] = [];
        for (const kind of ['activity', 'warning'] as const) {
            const key = kind === 'activity' ? options.activityKey : options.warningKey;
            const query = kind === 'activity'
                ? 'SELECT CAST(head_json AS CHAR) AS head,CAST(ledger_json AS CHAR) AS ledger FROM parent_child_activity_continuity WHERE child_uuid=? LIMIT 2 FOR UPDATE'
                : 'SELECT CAST(head_json AS CHAR) AS head,CAST(ledger_json AS CHAR) AS ledger,CAST(state_json AS CHAR) AS state FROM parent_child_warning_history WHERE child_uuid=? LIMIT 2 FOR UPDATE';
            const [rows] = await connection.query<RowDataPacket[]>({ sql: query, timeout: 10_000 }, [accountId]);
            if (!Array.isArray(rows) || rows.length > 1 || (kind === 'activity' && rows.length !== 1)) throw failure();
            const objects = await store.list(accountId, key);
            if (!rows.length) {
                if (objects.length) throw failure();
                // Also reject a soft-deleted or uncertain initial warning write.
                const prefix = `v1/events/${createHmac('sha256', key).update('ludolume-child-head-id-v1\0').update(accountId).digest('hex')}/`;
                for (const mode of [{ versions: true as const }, { softDeleted: true as const }]) {
                    const page = await options.transport.list({ bucket: BUCKET, prefix, startOffset: prefix, maxResults: 2,
                        fields: 'kind,nextPageToken,items(bucket,name,generation,size,md5Hash,timeDeleted,softDeleteTime)',
                        signal: AbortSignal.timeout(10_000), ...mode });
                    if (page.kind !== 'storage#objects' || page.nextPageToken !== undefined
                        || (page.items !== undefined && (!Array.isArray(page.items) || page.items.length))) throw failure();
                }
                continue;
            }
            const row = rows[0];
            if (typeof row.head !== 'string' || row.head.length > 1500 || typeof row.ledger !== 'string'
                || row.ledger.length > 1_000_000) throw failure();
            const head = JSON.parse(row.head) as ContinuityHead, ledger = JSON.parse(row.ledger) as ContinuityLedgerRow[];
            if (!head || !Number.isSafeInteger(head.sequence) || head.sequence < 1 || !Array.isArray(ledger)
                || ledger.length < 1 || ledger.length > 2048) throw failure();
            let state: Buffer | null;
            if (kind === 'activity') state = await readChildActivityState(connection, accountId, parentId);
            else {
                if (typeof row.state !== 'string' || Buffer.byteLength(row.state) > 16_384) throw failure();
                const history = normalizeHistory(JSON.parse(row.state));
                if (history.parentId !== parentId || history.childId !== accountId || history.events.length < 1
                    || history.events.length > 64) throw failure();
                state = Buffer.from(JSON.stringify(history));
            }
            if (!state || new Set(objects.map(item => item.name)).size !== objects.length) throw failure();
            await openAppendOnlyContinuitySession({ transport: options.transport, bucket: BUCKET, expectedBucket: BUCKET,
                key, sequence: head.sequence, generation: head.generation }).verifyExisting(accountId, head, ledger, state, now);
            if (objects.filter(item => sequence(item.name) === head.sequence && item.generation === head.generation
                && item.contentSha256 === head.digest).length !== 1 || objects.some(item => sequence(item.name) > head.sequence)) throw failure();
            result.push(...objects.filter(item => sequence(item.name) < head.sequence));
        }
        return result.sort((a, b) => a.name.localeCompare(b.name));
    }
    return {
        bucket: BUCKET, candidates, remove: store.remove,
        async inspect(entry) {
            const belongs = [options.activityKey, options.warningKey].some(key => entry.name.startsWith(
                `v1/events/${createHmac('sha256', key).update('ludolume-child-head-id-v1\0').update(accountId).digest('hex')}/`));
            if (!belongs) throw failure();
            return options.inspect(entry);
        },
        async verify(connection, selected) {
            if (!Array.isArray(selected) || !selected.length || selected.length > 100) throw failure();
            const wanted = new Set(selected.map(identity));
            if (wanted.size !== selected.length) throw failure();
            const matching = (await candidates(connection)).filter(item => wanted.has(identity(item)));
            if (matching.length !== wanted.size) throw failure();
            return matching;
        },
    };
}

/** Production sources are constructed here, never supplied by command JSON. */
export function createProductionActiveWitnessSource(options: Readonly<{
    accountId: string; activityKey: Buffer; warningKey: Buffer;
    explicit: Pick<ReturnType<typeof createGcsDeletionJournal>, 'readDeletionEntries'>;
    conditional: Pick<ReturnType<typeof createGcsRetentionJournal>, 'readIntents'>;
}>) {
    const client = createRetirementStorageClient();
    return createActiveWitnessSource({ ...options, store: createRetirementWitnessStorage(client, BUCKET),
        transport: createGcsChildContinuityTransport({ bucket: BUCKET, expectedBucket: BUCKET, client }),
        verifyPolicy: () => verifyRetirementBucketPolicy(client, BUCKET), inspect: entry => inspectWitnessObject(client, entry) });
}

async function inspectWitnessObject(client: JournalHttpClient, entry: WitnessIdentity): Promise<'live' | 'soft-deleted'> {
    const url = `${RETIREMENT_API}/storage/v1/b/${BUCKET}/o/${encodeURIComponent(entry.name)}`;
    for (const soft of [false, true]) {
        const value = await retirementStorageRequest(client, { method: 'GET', url, responseType: 'json', params: {
            generation: entry.generation, fields: RETIREMENT_FIELDS, ...(soft ? { softDeleted: true } : { ifGenerationMatch: entry.generation }) } }, true);
        if (value === null) continue;
        const meta = retirementObjectMetadata(value, BUCKET, entry.name, soft, 1500);
        if (meta.generation !== entry.generation) throw failure();
        if (!soft) {
            const body = await retirementStorageRequest(client, { method: 'GET', url, responseType: 'text', params: {
                generation: entry.generation, ifGenerationMatch: entry.generation, alt: 'media' } });
            if (typeof body !== 'string' || createHash('sha256').update(body).digest('hex') !== entry.contentSha256) throw failure();
        }
        return soft ? 'soft-deleted' : 'live';
    }
    throw failure(); // Absence without provider confirmation is not success.
}

/** An existing signed permit and held writer fence are required even for one older object. */
export async function retireActiveWitness(options: Readonly<{
    connection: Connection; pins: Pins; source: ActiveWitnessSource; selected: WitnessIdentity;
    permit: RetirementBatchPermit; publicKey: KeyObject;
    guard: Readonly<{ readRestoreGuard(): Promise<ObservedRestoreGuard> }>;
    cloud: CloudSqlMetadataClient; project: string; instance: string;
    verifySchema(connection: Pick<PoolConnection, 'query'>): Promise<void>;
    confirmation: string; externalCopiesConfirmation: string;
}>, inspectOnly = false): Promise<'retired' | 'live' | 'soft-deleted'> {
    let beginning = false, begun = false;
    try {
        const claim = verifyRetirementBatch(options.permit, options.publicKey), { connection, pins, source } = options;
        if (claim.bucket !== BUCKET || source.bucket !== BUCKET || claim.database !== pins.database || claim.serverUuid !== pins.serverUuid
            || !claim.entries.some(entry => identity(entry) === identity(options.selected))
            || options.confirmation !== 'ORIGINAL PRIMARY AND ALL WRITERS FENCED'
            || options.externalCopiesConfirmation !== 'ALL PERMITTED RECOVERY COPIES ACCOUNTED FOR') throw failure();
        const guard = await options.guard.readRestoreGuard(), guardText = JSON.stringify(guard);
        if (guard.state !== 'hold' || guard.database !== pins.database || guard.serverUuid !== pins.serverUuid
            || guard.generation !== claim.guardGeneration || guard.recoveryCheckpoint?.lineage !== claim.lineage
            || guard.recoveryCheckpoint.minimumEpoch !== claim.epoch || guard.recoveryCheckpoint.keySha256 !==
                createHash('sha256').update(options.publicKey.export({ type: 'spki', format: 'der' })).digest('hex')) throw failure();
        await options.verifySchema(connection);
        const verifyFence = async () => {
            await assertNoRetentionRuntimeWriters(connection, isProductionRecoveryOperator(pins));
            if (JSON.stringify(await options.guard.readRestoreGuard()) !== guardText) throw failure();
        };
        await verifyFence();
        beginning = true; await connection.beginTransaction(); beginning = false; begun = true;
        await readRecoveryCheckpoint(connection, { ...pins, lineage: claim.lineage, minimumEpoch: claim.epoch });
        let entry: RetirementWitness | undefined, status: 'live' | 'soft-deleted' | undefined;
        if (inspectOnly) {
            await source.candidates(connection);
            status = await source.inspect(options.selected);
        } else [entry] = await source.verify(connection, [options.selected]);
        // Read recovery coverage after the potentially longer authenticated inventory, immediately before mutation.
        const [clock] = await connection.query<RowDataPacket[]>({ sql: `SELECT DATABASE() AS databaseName,
            CURRENT_USER() AS currentUser,@@GLOBAL.server_uuid AS serverUuid,
            DATE_FORMAT(UTC_TIMESTAMP(6),'%Y-%m-%dT%H:%i:%s.%fZ') AS nowUtc`, timeout: 10_000 });
        if (!Array.isArray(clock) || clock.length !== 1 || clock[0].databaseName !== pins.database
            || clock[0].currentUser !== pins.currentUser || clock[0].serverUuid !== pins.serverUuid
            || parseInactivityInstant(clock[0].nowUtc) === null) throw failure();
        const inventory = await collectCloudSqlRecoveryInventory({ project: options.project, instance: options.instance,
            observedAt: clock[0].nowUtc, client: options.cloud });
        if (claim.committedBefore >= inventory.cloudSqlFloor) throw failure();
        verifyCheckpointRecoveryCoverage(claim, inventory, options);
        if (inspectOnly) {
            await verifyFence(); await connection.rollback(); begun = false;
            return status!;
        }
        if (!entry) throw failure();
        await verifyFence(); await source.remove(entry); await verifyFence();
        if (await source.inspect(entry) !== 'soft-deleted') throw failure();
        await source.candidates(connection); // Current runtime proof must still succeed after removal.
        await verifyFence(); await connection.rollback(); begun = false;
        return 'retired';
    } catch {
        if (beginning) options.connection.destroy();
        else if (begun) { try { await options.connection.rollback(); } catch { options.connection.destroy(); } }
        throw failure();
    }
}
