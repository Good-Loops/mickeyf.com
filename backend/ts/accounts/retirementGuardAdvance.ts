import { createHash, createPublicKey, type KeyObject } from 'node:crypto';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { isAccountId } from './deletionJournal';
import { parseInactivityInstant } from './childInactivityPolicy';
import { establishRecoveryCheckpoint, verifyCheckpointRecoveryCoverage } from './accountRecoveryCheckpoint';
import { collectCloudSqlRecoveryInventory, readCloudSqlRecoveryWindow, type CloudSqlMetadataClient } from './cloudSqlRecoveryInventory';
import { verifyDeletedAccountEffects } from './verifiedDeletionEffects';
import { assertNoRetentionRuntimeWriters } from './retentionReconciliation';
import type { DeletionJournalEntry } from './gcsDeletionJournal';
import type { ConditionalRetirementPair, ObservedRestoreGuard, RestoreGuard } from './gcsRetentionJournal';
import { signRetirementBatch, type RetirementBatchPermit } from './retirementBatchPermit';
import { DELETION_JOURNAL_BUCKET } from './gcsDeletionJournal';

type Connection = Pick<PoolConnection, 'query' | 'beginTransaction' | 'commit' | 'rollback' | 'destroy'>;
type Pins = Readonly<{ database: string; currentUser: string; serverUuid: string }>;
type EntryId = Readonly<{ name: string; generation: string; contentSha256: string }>;
export type RetirementGuardAdvanceOptions = Readonly<{
    connection: Connection; pins: Pins; lineage: string; publicKey: KeyObject; privateKey: KeyObject;
    project: string; instance: string; cloud: CloudSqlMetadataClient; selected: readonly EntryId[];
    journal: Readonly<{ readDeletionEntries(): Promise<Readonly<{ entries: readonly DeletionJournalEntry[]; digest: string }>> }>;
    conditional?: Readonly<{ bucket: string; readPairs(): Promise<Readonly<{ pairs: readonly ConditionalRetirementPair[]; digest: string }>> }>;
    /** Trusted operator code must verify the complete reviewed schema and foreign keys. */
    verifySchema(connection: Pick<PoolConnection, 'query'>): Promise<void>;
    confirmation: string; externalCopiesConfirmation: string;
    coveragePolls?: number; waitForCoverage?: () => Promise<void>;
}>;
type GuardCapability = Readonly<{
    read(): Promise<ObservedRestoreGuard>;
    /** Private CAS writer: caller cannot directly lower or replace the checkpoint floor. */
    commit(guard: RestoreGuard, expectedGeneration: string): Promise<string>;
}>;

/**
 * Administrative kernel. The caller must keep every writer and restore path
 * fenced throughout. A held guard is advanced only after the exact selected
 * effects are rechecked in SQL and provider PITR covers the committed epoch.
 * A timeout or uncertain response never authorizes cleanup.
 */
export async function advanceRetirementGuard(options: RetirementGuardAdvanceOptions, guard: GuardCapability): Promise<Readonly<{
    generation: string; lineage: string; epoch: string; committedBefore: string; permit: RetirementBatchPermit;
}>> {
    try {
        const { connection, pins } = options;
        if (options.confirmation !== 'ORIGINAL PRIMARY AND ALL WRITERS FENCED'
            || options.externalCopiesConfirmation !== 'ALL PERMITTED RECOVERY COPIES ACCOUNTED FOR'
            || !isAccountId(options.lineage) || typeof options.verifySchema !== 'function'
            || !Array.isArray(options.selected) || options.selected.length < 1 || options.selected.length > 100
            || options.publicKey.type !== 'public' || options.publicKey.asymmetricKeyType !== 'ed25519'
            || options.privateKey.type !== 'private' || options.privateKey.asymmetricKeyType !== 'ed25519'
            || !createPublicKey(options.privateKey).export({ type: 'spki', format: 'der' })
                .equals(options.publicKey.export({ type: 'spki', format: 'der' }))) throw new Error();
        const polls = options.coveragePolls ?? 60;
        if (!Number.isInteger(polls) || polls < 1 || polls > 360) throw new Error();
        const selected = options.selected.map(value => ({ ...value }));
        const selectedKeys = new Set(selected.map(value => JSON.stringify([value.name, value.generation, value.contentSha256])));
        if (selectedKeys.size !== selected.length) throw new Error();
        const initial = await guard.read(), initialText = JSON.stringify(initial);
        const fingerprint = createHash('sha256').update(options.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
        if (initial.state !== 'hold' || initial.database !== pins.database || initial.serverUuid !== pins.serverUuid
            || (initial.recoveryCheckpoint && (initial.recoveryCheckpoint.lineage !== options.lineage
                || initial.recoveryCheckpoint.keySha256 !== fingerprint))) throw new Error();
        const [identity] = await connection.query<RowDataPacket[]>({ sql: `SELECT DATABASE() AS databaseName,
            CURRENT_USER() AS currentUser, @@GLOBAL.server_uuid AS serverUuid`, timeout: 10_000 });
        if (!Array.isArray(identity) || identity.length !== 1 || identity[0].databaseName !== pins.database
            || identity[0].currentUser !== pins.currentUser || identity[0].serverUuid !== pins.serverUuid) throw new Error();
        await options.verifySchema(connection);
        await assertNoRetentionRuntimeWriters(connection);
        const id = (value: EntryId) => JSON.stringify([value.name, value.generation, value.contentSha256]);
        const now = async (): Promise<string> => {
            const [rows] = await connection.query<RowDataPacket[]>({ sql: `SELECT DATABASE() AS databaseName,
                CURRENT_USER() AS currentUser, @@GLOBAL.server_uuid AS serverUuid,
                DATE_FORMAT(UTC_TIMESTAMP(6),'%Y-%m-%dT%H:%i:%s.%fZ') AS nowUtc`, timeout: 10_000 });
            if (!Array.isArray(rows) || rows.length !== 1 || rows[0].databaseName !== pins.database
                || rows[0].currentUser !== pins.currentUser || rows[0].serverUuid !== pins.serverUuid
                || parseInactivityInstant(rows[0].nowUtc) === null) throw new Error();
            return rows[0].nowUtc as string;
        };
        async function resolveBatch() {
            const source = options.conditional;
            if (!source) {
                const current = await options.journal.readDeletionEntries();
                if (!/^[a-f0-9]{64}$/u.test(current.digest) || !Array.isArray(current.entries)) throw new Error();
                const entries = current.entries.filter(value => selectedKeys.has(id(value)));
                if (entries.length !== selected.length) throw new Error();
                return { digest: current.digest, accountIds: [...new Set(entries.map(value => value.intent.accountId))].sort() };
            }
            const current = await source.readPairs();
            if (!/^[a-f0-9]{64}$/u.test(current.digest) || !Array.isArray(current.pairs)) throw new Error();
            const matching = current.pairs.filter(pair => selectedKeys.has(id(pair.intentObject)) || selectedKeys.has(id(pair.resolutionObject)));
            if (matching.length * 2 !== selected.length || matching.some(pair => !selectedKeys.has(id(pair.intentObject))
                || !selectedKeys.has(id(pair.resolutionObject)))) throw new Error();
            return { digest: current.digest, accountIds: [...new Set(matching.map(pair => pair.intent.childId))].sort() };
        }
        const current = await resolveBatch(), accountIds = current.accountIds;
        const before = await now();
        await readCloudSqlRecoveryWindow({ project: options.project, instance: options.instance, observedAt: before, client: options.cloud });
        if (JSON.stringify(await guard.read()) !== initialText) throw new Error();
        const checkpoint = await establishRecoveryCheckpoint(connection, { ...pins, lineage: options.lineage,
            minimumEpoch: initial.recoveryCheckpoint?.minimumEpoch ?? '0' },
        async transaction => verifyDeletedAccountEffects(transaction, accountIds));
        if (checkpoint.committedBefore < before) throw new Error();
        const wait = options.waitForCoverage ?? (() => new Promise<void>(resolve => setTimeout(resolve, 5000)));
        let covered = false;
        for (let index = 0; index < polls; index++) {
            const window = await readCloudSqlRecoveryWindow({ project: options.project, instance: options.instance,
                observedAt: await now(), client: options.cloud });
            if (window.latest >= checkpoint.committedBefore) {
                covered = true; break;
            }
            if (index + 1 < polls) await wait();
        }
        if (!covered || JSON.stringify(await guard.read()) !== initialText) throw new Error();
        await assertNoRetentionRuntimeWriters(connection);
        const final = await resolveBatch();
        const recovery = await collectCloudSqlRecoveryInventory({ project: options.project, instance: options.instance,
            observedAt: await now(), client: options.cloud });
        verifyCheckpointRecoveryCoverage(checkpoint, recovery,
            { project: options.project, instance: options.instance });
        if (final.digest !== current.digest || JSON.stringify(final.accountIds) !== JSON.stringify(accountIds)
            || JSON.stringify(await guard.read()) !== initialText) throw new Error();
        await assertNoRetentionRuntimeWriters(connection);
        const next: RestoreGuard = { state: 'hold', database: initial.database, serverUuid: initial.serverUuid,
            epoch: initial.epoch, expiresAt: initial.expiresAt,
            recoveryCheckpoint: { lineage: checkpoint.lineage, minimumEpoch: checkpoint.epoch, keySha256: fingerprint } };
        const generation = await guard.commit(next, initial.generation);
        const after = await guard.read();
        if (after.generation !== generation || JSON.stringify({ ...next, generation }) !== JSON.stringify(after)) throw new Error();
        const permit = signRetirementBatch({ version: 1, bucket: options.conditional?.bucket ?? DELETION_JOURNAL_BUCKET, database: pins.database,
            serverUuid: pins.serverUuid, guardGeneration: generation, lineage: checkpoint.lineage, epoch: checkpoint.epoch,
            committedBefore: checkpoint.committedBefore, entries: selected }, options.privateKey);
        return { generation, ...checkpoint, permit };
    } catch { throw new Error('Guard advancement unavailable or unconfirmed. Keep the guard held and reconcile before retrying.'); }
}
