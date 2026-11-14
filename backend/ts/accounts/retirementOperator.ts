import { createProductionActiveWitnessSource, retireActiveWitness } from './activeWitnessRetirement';
import { CHILD_ACTIVITY_CONTINUITY_BUCKET } from '../config/childActivityContinuity';
import { createCloudSqlMetadataClient } from './cloudSqlRecoveryInventory';
import { verifyRetirementSchemas } from './retirementSourceSchema';
import { assertNoRetentionRuntimeWriters } from './retentionReconciliation';
import type { KeyObject } from 'node:crypto';
import type { PoolConnection } from 'mysql2/promise';
import { createGcsRetentionJournal } from './gcsRetentionJournal';
import { createGcsDeletionJournal } from './gcsDeletionJournal';
import { verifyRetiredJournalObjects } from './verifyRetiredJournalObjects';
import { verifyRetirementSourceSchema } from './retirementSourceSchema';
import { conditionalRetirementEntry } from './conditionalRetirementEntry';
import { verifyKeptActivity } from './verifiedKeptActivity';
import { verifyDeletedAccountEffects } from './verifiedDeletionEffects';
import { previewRetirementCandidates } from './previewRetirementCandidates';
import { CHILD_RETENTION_BUCKET } from '../config/childInactivityDeployment';
import { PRODUCTION_CLOUD_SQL_TARGET } from '../security/cloudSqlRuntimeRoleRemover';
import { DELETION_JOURNAL_BUCKET } from './gcsDeletionJournal';
import { verifyRetirementBatch, type PreparedRetirementCheckpoint, type RetirementBatchPermit } from './retirementBatchPermit';
import { retireExplicitDeletionEntryForOperator, inspectExplicitRetirement } from './retireExplicitDeletionEntry';
import { retireConditionalPairForOperator, resumeConditionalResolutionForOperator } from './retireConditionalPair';

type Connection = Pick<PoolConnection, 'query' | 'beginTransaction' | 'commit' | 'rollback' | 'destroy'>;
type Pins = Readonly<{ database: string; currentUser: string; serverUuid: string }>;
type Identity = Readonly<{ name: string; generation: string; contentSha256: string }>;
type ConditionalPair = Awaited<ReturnType<ReturnType<typeof createGcsRetentionJournal>['readConditionalRetirementPairs']>>['pairs'][number];
export type RetirementOperatorContext = Readonly<{ connection: Connection; pins: Pins; bucket: string; expectedBucket: string;
    guardKey: Buffer; publicKey?: KeyObject; activityKey?: Buffer; warningKey?: Buffer }>;

function resources(context: RetirementOperatorContext) {
    if (context.bucket !== CHILD_RETENTION_BUCKET || context.expectedBucket !== CHILD_RETENTION_BUCKET
        || context.pins.database !== 'cms' || context.pins.serverUuid !== PRODUCTION_CLOUD_SQL_TARGET.serverUuid
        || context.pins.currentUser !== 'ludolume_release_ops@cloudsqlproxy~%') {
        throw new Error('Unapproved retirement target.');
    }
    let guard: ReturnType<typeof createGcsRetentionJournal>;
    const verifyRetired = async (objects: readonly Readonly<{ bucket: string; name: string; generation: string; stamp: unknown }>[]) => {
        const current = await guard.readRestoreGuard();
        if (!current.recoveryCheckpoint) { if (objects.length) throw new Error('Unexpected retired objects.'); return; }
        if (!context.publicKey) throw new Error('Retirement public key unavailable.');
        await verifyRetiredJournalObjects(context.connection, guard, { database: context.pins.database,
            currentUser: context.pins.currentUser, targetServerUuid: context.pins.serverUuid,
            originalServerUuid: context.pins.serverUuid }, objects, context.publicKey);
    };
    guard = createGcsRetentionJournal({ bucket: context.bucket, expectedBucket: context.expectedBucket, key: context.guardKey,
        verifyActivityContinuity: async () => false, verifyRetiredObjects: verifyRetired });
    const journal = createGcsDeletionJournal({ verifyRetiredObjects: verifyRetired });
    return { guard, journal };
}

/** Read-only candidate triage; checkpointing independently verifies effects and recovery coverage. */
export async function previewRetirementsForOperator(context: RetirementOperatorContext, kind: 'explicit' | 'conditional' | 'witness',
    confirmation: string, offset = 0, accountId?: string) {
    const { guard, journal } = resources(context);
    await guard.assertRestoreGuardHistory();
    if (kind === 'witness') {
        if (offset !== 0 || confirmation !== 'ORIGINAL PRIMARY AND ALL WRITERS FENCED') throw new Error();
        const held = await guard.readRestoreGuard();
        if (held.state !== 'hold' || held.database !== context.pins.database || held.serverUuid !== context.pins.serverUuid) throw new Error();
        await verifyRetirementSchemas(context.connection);
        await assertNoRetentionRuntimeWriters(context.connection, true);
        const source = createProductionActiveWitnessSource({ accountId: accountId!, activityKey: context.activityKey!,
            warningKey: context.warningKey!, explicit: journal, conditional: guard });
        let begun = false;
        try {
            await context.connection.beginTransaction(); begun = true;
            const entries = await source.candidates(context.connection);
            if (JSON.stringify(await guard.readRestoreGuard()) !== JSON.stringify(held)) throw new Error();
            await assertNoRetentionRuntimeWriters(context.connection, true);
            await context.connection.rollback(); begun = false;
            return { accountId, candidates: entries.slice(0, 100).map(({ name, generation, contentSha256 }) =>
                ({ name, generation, contentSha256 })), more: entries.length > 100 };
        } catch {
            if (begun) { try { await context.connection.rollback(); } catch { context.connection.destroy(); } }
            else context.connection.destroy();
            throw new Error('Witness preview unavailable. Keep recovery held.');
        }
    }
    let pairs: readonly ConditionalPair[] = [];
    const conditional = { async readDeletionEntries() {
        const snapshot = await guard.readConditionalRetirementPairs();
        pairs = snapshot.pairs;
        return { entries: snapshot.pairs.map(conditionalRetirementEntry), digest: snapshot.digest };
    } };
    if (kind !== 'explicit' && kind !== 'conditional') throw new Error('Invalid retirement journal.');
    return previewRetirementCandidates({ connection: context.connection, pins: context.pins, guard,
        journal: kind === 'conditional' ? conditional : journal, verifySchema: verifyRetirementSourceSchema, confirmation, offset,
        ...(kind === 'conditional' ? { async verifyCandidate(connection: Pick<PoolConnection, 'query'>, entry: ReturnType<typeof conditionalRetirementEntry>) {
            return verifyConditionalRetirementCandidate(connection, pairs, entry);
        } } : {}) });
}

export async function verifyConditionalRetirementCandidate(connection: Pick<PoolConnection, 'query'>,
    pairs: readonly ConditionalPair[], entry: Identity): Promise<boolean> {
    const found = pairs.filter(pair => pair.intentObject.name === entry.name && pair.intentObject.generation === entry.generation
        && pair.intentObject.contentSha256 === entry.contentSha256);
    if (found.length !== 1) throw new Error('Conditional retirement candidate changed.');
    return found[0].resolution.outcome === 'kept' ? verifyKeptActivity(connection, found[0])
        : verifyDeletedAccountEffects(connection, [found[0].intent.childId]);
}

/** Expand a selected conditional intent to its authenticated intent/outcome pair. */
export function expandConditionalRetirementSelection(selected: readonly Identity[],
    pairs: Awaited<ReturnType<ReturnType<typeof createGcsRetentionJournal>['readConditionalRetirementPairs']>>['pairs']): Identity[] {
    const identity = (value: Identity) => JSON.stringify([value.name, value.generation, value.contentSha256]);
    if (!Array.isArray(selected) || selected.length < 1 || selected.length > 50 || !Array.isArray(pairs)) throw new Error();
    const wanted = new Set(selected.map(identity));
    if (wanted.size !== selected.length) throw new Error();
    const matching = pairs.filter(pair => wanted.has(identity(pair.intentObject)));
    if (matching.length !== wanted.size) throw new Error();
    return matching.flatMap(pair => [pair.intentObject, pair.resolutionObject]);
}

/** Uses the actual pinned provider and reviewed schema through the guard adapter. */
export async function prepareRetirementGuardForOperator(context: RetirementOperatorContext & Readonly<{
    publicKey: KeyObject; privateKey: KeyObject;
}>, options: Readonly<{ kind: 'explicit' | 'conditional' | 'witness'; accountId?: string; lineage: string; selected: readonly Identity[];
    confirmation: string; externalCopiesConfirmation: string }>) {
    const { guard } = resources(context);
    if (options.kind !== 'explicit' && options.kind !== 'conditional' && options.kind !== 'witness') throw new Error('Invalid retirement journal.');
    await guard.assertRestoreGuardHistory();
    const selected = options.kind === 'conditional'
        ? expandConditionalRetirementSelection(options.selected, (await guard.readConditionalRetirementPairs()).pairs)
        : options.selected;
    return guard.prepareRetirementCheckpoint({ kind: options.kind, accountId: options.accountId, activityKey: context.activityKey, warningKey: context.warningKey, connection: context.connection, pins: context.pins,
        lineage: options.lineage, publicKey: context.publicKey, privateKey: context.privateKey,
        selected, confirmation: options.confirmation, externalCopiesConfirmation: options.externalCopiesConfirmation });
}

export async function advanceRetirementGuardForOperator(context: RetirementOperatorContext & Readonly<{
    publicKey: KeyObject; privateKey: KeyObject;
}>, options: Readonly<{ kind: 'explicit' | 'conditional' | 'witness'; accountId?: string; lineage: string; selected: readonly Identity[];
    prepared: PreparedRetirementCheckpoint; confirmation: string; externalCopiesConfirmation: string }>) {
    const { guard } = resources(context);
    if (options.kind !== 'explicit' && options.kind !== 'conditional' && options.kind !== 'witness') throw new Error('Invalid retirement journal.');
    await guard.assertRestoreGuardHistory();
    const selected = options.kind === 'conditional'
        ? expandConditionalRetirementSelection(options.selected, (await guard.readConditionalRetirementPairs()).pairs)
        : options.selected;
    return guard.finishRetirementCheckpoint({ kind: options.kind, accountId: options.accountId, activityKey: context.activityKey, warningKey: context.warningKey, connection: context.connection, pins: context.pins,
        lineage: options.lineage, publicKey: context.publicKey, privateKey: context.privateKey,
        selected, confirmation: options.confirmation, externalCopiesConfirmation: options.externalCopiesConfirmation }, options.prepared);
}

/** Resolve the account internally from the current authenticated journal; do not log it. */
export async function retireJournalRecordForOperator(context: RetirementOperatorContext & Readonly<{
    publicKey: KeyObject; privateKey: KeyObject; activityKey: Buffer; warningKey: Buffer;
}>, options: Readonly<{ kind: 'explicit' | 'conditional' | 'witness'; accountId?: string; permit: RetirementBatchPermit; selected: Identity;
    confirmation: string; externalCopiesConfirmation: string }>) {
    const { guard, journal } = resources(context);
    const permit = verifyRetirementBatch(options.permit, context.publicKey);
    const expectedBucket = options.kind === 'explicit' ? DELETION_JOURNAL_BUCKET
        : options.kind === 'witness' ? CHILD_ACTIVITY_CONTINUITY_BUCKET : CHILD_RETENTION_BUCKET;
    const same = (value: Identity) => value.name === options.selected.name && value.generation === options.selected.generation
        && value.contentSha256 === options.selected.contentSha256;
    if (!['explicit', 'conditional', 'witness'].includes(options.kind) || permit.bucket !== expectedBucket || !permit.entries.some(same)) throw new Error();
    const common = { connection: context.connection, pins: context.pins, permit: options.permit, publicKey: context.publicKey,
        privateKey: context.privateKey, guardKey: context.guardKey,
        activityKey: context.activityKey, warningKey: context.warningKey, confirmation: options.confirmation,
        externalCopiesConfirmation: options.externalCopiesConfirmation };
    if (options.kind === 'witness') return inspectOrRetireWitnessForOperator(context, { ...options, accountId: options.accountId! });
    if (options.kind === 'explicit') {
        const matches = (await journal.readDeletionEntries()).entries.filter(same);
        if (matches.length !== 1) throw new Error();
        return retireExplicitDeletionEntryForOperator({ ...common, entry: matches[0], guardBucket: CHILD_RETENTION_BUCKET,
            expectedGuardBucket: CHILD_RETENTION_BUCKET });
    }
    const matches = (await guard.readConditionalRetirementPairs()).pairs.filter(pair => same(pair.intentObject));
    if (matches.length !== 1) throw new Error();
    return retireConditionalPairForOperator({ ...common, pair: matches[0], bucket: CHILD_RETENTION_BUCKET,
        expectedBucket: CHILD_RETENTION_BUCKET });
}

/** Reconcile an uncertain explicit deletion using only the signed object identity. */
export async function inspectExplicitRetirementForOperator(context: RetirementOperatorContext & Readonly<{ publicKey: KeyObject }>,
    permit: RetirementBatchPermit, selected: Identity) {
    const { guard } = resources(context);
    await guard.assertRestoreGuardHistory();
    if (verifyRetirementBatch(permit, context.publicKey).bucket !== DELETION_JOURNAL_BUCKET) throw new Error();
    return inspectExplicitRetirement({ connection: context.connection, pins: context.pins, entry: selected,
        publicKey: context.publicKey, permit, guard });
}

/** Resume a paired outcome only when the signed permit contains the exact pair. */
export async function resumeConditionalRetirementForOperator(context: RetirementOperatorContext & Readonly<{
    publicKey: KeyObject; privateKey: KeyObject;
}>, options: Readonly<{ permit: RetirementBatchPermit; selected: Identity; confirmation: string; externalCopiesConfirmation: string }>) {
    resources(context); // Enforce the pinned bucket before resolving any object.
    const claim = verifyRetirementBatch(options.permit, context.publicKey);
    if (claim.bucket !== CHILD_RETENTION_BUCKET || !claim.entries.some(item => item.name === options.selected.name
        && item.generation === options.selected.generation && item.contentSha256 === options.selected.contentSha256)) throw new Error();
    const resolutionName = options.selected.name.replace('v1/conditional/', 'v1/resolutions/');
    if (resolutionName === options.selected.name) throw new Error();
    const matches = claim.entries.filter(item => item.name === resolutionName);
    if (matches.length !== 1) throw new Error();
    return resumeConditionalResolutionForOperator({ connection: context.connection, pins: context.pins, bucket: CHILD_RETENTION_BUCKET,
        expectedBucket: CHILD_RETENTION_BUCKET, guardKey: context.guardKey, permit: options.permit, publicKey: context.publicKey,
        privateKey: context.privateKey, intentObject: options.selected, resolutionObject: matches[0],
        confirmation: options.confirmation, externalCopiesConfirmation: options.externalCopiesConfirmation });
}

/** Exact-identity inspection never retries an uncertain deletion. It still requires the held fence. */
export async function inspectOrRetireWitnessForOperator(context: RetirementOperatorContext & Readonly<{ publicKey: KeyObject }>,
    options: Readonly<{ accountId: string; permit: RetirementBatchPermit; selected: Identity;
        confirmation: string; externalCopiesConfirmation: string }>, inspectOnly = false) {
    const { guard, journal } = resources(context);
    await guard.assertRestoreGuardHistory();
    const source = createProductionActiveWitnessSource({ accountId: options.accountId, activityKey: context.activityKey!,
        warningKey: context.warningKey!, explicit: journal, conditional: guard });
    const status = await retireActiveWitness({ ...options, connection: context.connection, pins: context.pins, publicKey: context.publicKey,
        source, guard, cloud: createCloudSqlMetadataClient(), project: 'noted-reef-387021', instance: 'cms-mickeyf',
        verifySchema: verifyRetirementSchemas }, inspectOnly);
    return inspectOnly ? status : { status, generation: options.selected.generation };
}
