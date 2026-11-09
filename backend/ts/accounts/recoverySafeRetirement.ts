import { createHash, createPublicKey } from 'node:crypto';
import type { RowDataPacket } from 'mysql2/promise';
import { isAccountId } from './deletionJournal';
import { parseInactivityInstant } from './childInactivityPolicy';
import { establishRecoveryCheckpoint, readRecoveryCheckpoint, verifyCheckpointRecoveryCoverage } from './accountRecoveryCheckpoint';
import { collectCloudSqlRecoveryInventory } from './cloudSqlRecoveryInventory';
import { verifyDeletedAccountEffects } from './verifiedDeletionEffects';
import { verifyScoreWithdrawal } from './verifiedScoreWithdrawal';
import { verifyKeptActivity } from './verifiedKeptActivity';
import { assertNoRetentionRuntimeWriters, isProductionRecoveryOperator } from './retentionReconciliation';
import { DELETION_JOURNAL_BUCKET } from './gcsDeletionJournal';
import type { ConditionalRetirementPair, ObservedRestoreGuard, RestoreGuard } from './gcsRetentionJournal';
import { signPreparedRetirementCheckpoint, verifyPreparedRetirementCheckpoint, signRetirementBatch,
    type PreparedRetirementCheckpoint, type RetirementBatchPermit } from './retirementBatchPermit';
import type { ActiveWitnessSource } from './activeWitnessRetirement';
import { CHILD_ACTIVITY_CONTINUITY_BUCKET } from '../config/childActivityContinuity';
import type { RetirementGuardAdvanceOptions } from './retirementGuardAdvance';

export type RecoverySafeRetirementOptions = RetirementGuardAdvanceOptions & Readonly<{ witness?: ActiveWitnessSource }>;

type Guard = Readonly<{ read(): Promise<ObservedRestoreGuard>;
    commit(value: RestoreGuard, expectedGeneration: string): Promise<string> }>;
type Identity = Readonly<{ name: string; generation: string; contentSha256: string }>;
const identity = (entry: Identity) => JSON.stringify([entry.name, entry.generation, entry.contentSha256]);

type Effect = Readonly<{ accountId: string; action: 'delete-account' | 'withdraw-public-scores' }>
    | Readonly<{ accountId: string; action: 'kept'; pair: ConditionalRetirementPair }>
    | Readonly<{ accountId: ''; action: 'witness'; source: ActiveWitnessSource; selected: readonly Identity[] }>;
async function selectedEffects(options: RecoverySafeRetirementOptions): Promise<Effect[]> {
    const wanted = new Set(options.selected.map(identity));
    if (!options.selected.length || options.selected.length > 100 || wanted.size !== options.selected.length) throw new Error();
    if (options.witness) {
        if (options.conditional || options.witness.bucket !== CHILD_ACTIVITY_CONTINUITY_BUCKET) throw new Error();
        return [{ accountId: '', action: 'witness', source: options.witness, selected: options.selected }];
    }
    if (options.conditional) {
        const current = await options.conditional.readPairs();
        const matching = current.pairs.filter(pair => wanted.has(identity(pair.intentObject)) || wanted.has(identity(pair.resolutionObject)));
        if (matching.length * 2 !== wanted.size || matching.some(pair => !wanted.has(identity(pair.intentObject))
            || !wanted.has(identity(pair.resolutionObject)))) throw new Error();
        return matching.map(pair => pair.resolution.outcome === 'kept'
            ? { accountId: pair.intent.childId, action: 'kept' as const, pair }
            : { accountId: pair.intent.childId, action: 'delete-account' as const });
    }
    const current = await options.journal.readDeletionEntries();
    const matching = current.entries.filter(entry => wanted.has(identity(entry)));
    if (matching.length !== wanted.size) throw new Error();
    const effects = new Map<string, Effect>();
    for (const entry of matching) {
        const { accountId, action } = entry.intent;
        if (action !== 'delete-account' && action !== 'withdraw-public-scores') throw new Error();
        if (!effects.has(accountId) || action === 'delete-account') effects.set(accountId, { accountId, action });
    }
    return [...effects.values()].sort((a, b) => a.accountId.localeCompare(b.accountId));
}

async function verifyEffects(connection: Pick<RetirementGuardAdvanceOptions['connection'], 'query'>, effects: readonly Effect[]): Promise<boolean> {
    for (const effect of effects) if (effect.action === 'witness') await effect.source.verify(connection, effect.selected);
    const deleted = [...new Set(effects.filter(effect => effect.action === 'delete-account').map(effect => effect.accountId))];
    if (deleted.length && !await verifyDeletedAccountEffects(connection, deleted)) return false;
    for (const effect of effects) if (effect.action === 'withdraw-public-scores'
        && !await verifyScoreWithdrawal(connection, effect.accountId)) return false;
    for (const effect of effects) if (effect.action === 'kept' && !await verifyKeptActivity(connection, effect.pair)) return false;
    return effects.length > 0;
}

async function checkContext(options: RecoverySafeRetirementOptions, guard: Guard) {
    const { pins, connection, publicKey, privateKey } = options;
    if (options.confirmation !== 'ORIGINAL PRIMARY AND ALL WRITERS FENCED'
        || options.externalCopiesConfirmation !== 'ALL PERMITTED RECOVERY COPIES ACCOUNTED FOR'
        || !isAccountId(options.lineage) || typeof options.verifySchema !== 'function'
        || publicKey.type !== 'public' || publicKey.asymmetricKeyType !== 'ed25519'
        || privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519'
        || !createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).equals(publicKey.export({ type: 'spki', format: 'der' }))) throw new Error();
    const observed = await guard.read();
    const fingerprint = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
    if (observed.state !== 'hold' || observed.database !== pins.database || observed.serverUuid !== pins.serverUuid
        || (observed.recoveryCheckpoint && (observed.recoveryCheckpoint.lineage !== options.lineage
            || observed.recoveryCheckpoint.keySha256 !== fingerprint))) throw new Error();
    const [rows] = await connection.query<RowDataPacket[]>({ sql: `SELECT DATABASE() AS databaseName,
        CURRENT_USER() AS currentUser, @@GLOBAL.server_uuid AS serverUuid,
        DATE_FORMAT(UTC_TIMESTAMP(6),'%Y-%m-%dT%H:%i:%s.%fZ') AS nowUtc`, timeout: 10_000 });
    if (!Array.isArray(rows) || rows.length !== 1 || rows[0].databaseName !== pins.database
        || rows[0].currentUser !== pins.currentUser || rows[0].serverUuid !== pins.serverUuid
        || parseInactivityInstant(rows[0].nowUtc) === null) throw new Error();
    await options.verifySchema(connection);
    await assertNoRetentionRuntimeWriters(connection, isProductionRecoveryOperator(pins));
    return { observed, fingerprint, nowUtc: rows[0].nowUtc as string };
}

/** Make a signed, non-authorizing checkpoint. Release the writer fence while backups age. */
export async function prepareRecoverySafeRetirement(options: RecoverySafeRetirementOptions, guard: Guard): Promise<PreparedRetirementCheckpoint> {
    try {
        const { observed } = await checkContext(options, guard);
        const effects = await selectedEffects(options);
        if (JSON.stringify(await guard.read()) !== JSON.stringify(observed)) throw new Error();
        const checkpoint = await establishRecoveryCheckpoint(options.connection, { ...options.pins, lineage: options.lineage,
            minimumEpoch: observed.recoveryCheckpoint?.minimumEpoch ?? '0' },
        transaction => verifyEffects(transaction, effects));
        if (JSON.stringify(await guard.read()) !== JSON.stringify(observed)) throw new Error();
        await assertNoRetentionRuntimeWriters(options.connection, isProductionRecoveryOperator(options.pins));
        return signPreparedRetirementCheckpoint({ version: 1, bucket: options.witness?.bucket ?? options.conditional?.bucket ?? DELETION_JOURNAL_BUCKET,
            database: options.pins.database, serverUuid: options.pins.serverUuid, guardGeneration: observed.generation,
            ...checkpoint, entries: options.selected }, options.privateKey);
    } catch { throw new Error('Retirement checkpoint could not be prepared. The recovery guard was not advanced.'); }
}

/** Advance only once every eligible provider recovery point is newer than the checkpoint. */
export async function finishRecoverySafeRetirement(options: RecoverySafeRetirementOptions, guard: Guard,
    prepared: PreparedRetirementCheckpoint): Promise<Readonly<{ status: 'waiting' } | {
        status: 'advanced'; generation: string; permit: RetirementBatchPermit }>> {
    let transactionStarted = false, transactionStarting = false;
    try {
        const claim = verifyPreparedRetirementCheckpoint(prepared, options.publicKey);
        const { observed, fingerprint, nowUtc } = await checkContext(options, guard);
        const preparationSha256 = createHash('sha256').update('ludolume-retirement-preparation-id-v1\0')
            .update(JSON.stringify(claim)).update('\0').update(prepared.signature).digest('hex');
        const resumed = observed.generation !== claim.guardGeneration
            && observed.recoveryCheckpoint?.preparationSha256 === preparationSha256
            && observed.recoveryCheckpoint.minimumEpoch === claim.epoch;
        if (claim.database !== options.pins.database || claim.serverUuid !== options.pins.serverUuid
            || claim.lineage !== options.lineage || (claim.guardGeneration !== observed.generation && !resumed)
            || claim.bucket !== (options.witness?.bucket ?? options.conditional?.bucket ?? DELETION_JOURNAL_BUCKET)
            || JSON.stringify(claim.entries.map(identity).sort()) !== JSON.stringify(options.selected.map(identity).sort())) throw new Error();
        const effects = await selectedEffects(options);
        const inventory = await collectCloudSqlRecoveryInventory({ project: options.project, instance: options.instance,
            observedAt: nowUtc, client: options.cloud });
        if (JSON.stringify(await guard.read()) !== JSON.stringify(observed)) throw new Error();
        if (claim.committedBefore >= inventory.cloudSqlFloor) return { status: 'waiting' };
        verifyCheckpointRecoveryCoverage(claim, inventory, { project: options.project, instance: options.instance });
        transactionStarting = true;
        await options.connection.beginTransaction();
        transactionStarting = false; transactionStarted = true;
        await readRecoveryCheckpoint(options.connection, { ...options.pins, lineage: claim.lineage, minimumEpoch: claim.epoch });
        if (!await verifyEffects(options.connection, effects)) throw new Error();
        if (JSON.stringify(await guard.read()) !== JSON.stringify(observed)) throw new Error();
        await assertNoRetentionRuntimeWriters(options.connection, isProductionRecoveryOperator(options.pins));
        const next: RestoreGuard = { state: 'hold', database: observed.database, serverUuid: observed.serverUuid,
            epoch: observed.epoch, expiresAt: observed.expiresAt,
            recoveryCheckpoint: { lineage: claim.lineage, minimumEpoch: claim.epoch, keySha256: fingerprint, preparationSha256 } };
        const generation = resumed ? observed.generation : await guard.commit(next, observed.generation);
        if (JSON.stringify(await guard.read()) !== JSON.stringify({ ...next, generation })) throw new Error();
        const permit = signRetirementBatch({ ...claim, guardGeneration: generation }, options.privateKey);
        await options.connection.rollback(); transactionStarted = false;
        return { status: 'advanced', generation, permit };
    } catch {
        if (transactionStarting) options.connection.destroy();
        else if (transactionStarted) { try { await options.connection.rollback(); } catch { options.connection.destroy(); } }
        throw new Error('Retirement remains pending or unconfirmed. Keep its journal records and reconcile the guard before retrying.');
    }
}
