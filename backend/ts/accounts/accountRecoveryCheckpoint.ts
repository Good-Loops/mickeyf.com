import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { isAccountId } from './deletionJournal';
import { parseInactivityInstant } from './childInactivityPolicy';

type Connection = Pick<PoolConnection, 'query'>;
type TransactionConnection = Pick<PoolConnection, 'query' | 'beginTransaction' | 'commit' | 'rollback' | 'destroy'>;
type Pins = Readonly<{ database: string; currentUser: string; serverUuid: string; lineage: string; minimumEpoch: string }>;
const MAX_EPOCH = BigInt('18446744073709551615');
const EPOCH = /^(?:0|[1-9][0-9]{0,19})$/u;

export class RecoveryCheckpointUnavailableError extends Error {
    constructor() { super('Recovery checkpoint is missing, too old, or unverified. Keep recovery on hold.'); }
}

/**
 * Reads the checkpoint from the actual pinned SQL target, not a date supplied by
 * the operator. The lineage and minimum epoch must come from the independently
 * authenticated recovery guard; this read alone does not fence traffic or prove
 * that the checkpoint was created after every effect in a cleanup batch.
 */
async function readCheckpoint(connection: Connection, pins: Pins, lock: boolean, allowZero: boolean): Promise<Readonly<{ lineage: string; epoch: string }>> {
    try {
        if (!/^[A-Za-z0-9_]{1,64}$/u.test(pins.database) || typeof pins.currentUser !== 'string'
            || !/^[A-Za-z0-9_.%-]+@[A-Za-z0-9_.:%/~\-]+$/u.test(pins.currentUser)
            || !isAccountId(pins.serverUuid) || !isAccountId(pins.lineage)
            || typeof pins.minimumEpoch !== 'string' || !EPOCH.test(pins.minimumEpoch)
            || (!allowZero && BigInt(pins.minimumEpoch) < BigInt(1)) || BigInt(pins.minimumEpoch) > MAX_EPOCH) throw new Error();
        const [rows] = await connection.query<RowDataPacket[]>({ sql: `SELECT DATABASE() AS databaseName,
            CURRENT_USER() AS currentUser, @@GLOBAL.server_uuid AS serverUuid,
            lineage_id AS lineageId, CAST(epoch AS CHAR) AS checkpointEpoch
            FROM account_recovery_checkpoint WHERE singleton_id=1 LIMIT 2${lock ? ' FOR UPDATE' : ''}`, timeout: 10_000 });
        if (!Array.isArray(rows) || rows.length !== 1) throw new Error();
        const row = rows[0];
        if (row.databaseName !== pins.database || row.currentUser !== pins.currentUser
            || row.serverUuid !== pins.serverUuid || row.lineageId !== pins.lineage
            || typeof row.checkpointEpoch !== 'string' || !EPOCH.test(row.checkpointEpoch)
            || BigInt(row.checkpointEpoch) > MAX_EPOCH || BigInt(row.checkpointEpoch) < BigInt(pins.minimumEpoch)) throw new Error();
        return Object.freeze({ lineage: pins.lineage, epoch: row.checkpointEpoch });
    } catch { throw new RecoveryCheckpointUnavailableError(); }
}

export async function readRecoveryCheckpoint(connection: Connection, pins: Pins): Promise<Readonly<{ lineage: string; epoch: string }>> {
    return readCheckpoint(connection, pins, false, false);
}

/**
 * A guard must not advance until Cloud SQL can recover past the committed SQL
 * checkpoint. The inventory must come from an authenticated, fresh provider
 * read for the pinned instance; this comparison cannot authenticate its input.
 */
export function verifyCheckpointRecoveryCoverage(checkpoint: Readonly<{ lineage: string; epoch: string; committedBefore: string }>,
    inventory: Readonly<{ project: string; instance: string; latestRecoveryAt: string; observedAt: string; backupCount: number }>,
    expected: Readonly<{ project: string; instance: string }>): void {
    try {
        if (!isAccountId(checkpoint.lineage) || !EPOCH.test(checkpoint.epoch) || BigInt(checkpoint.epoch) < BigInt(1)
            || BigInt(checkpoint.epoch) > MAX_EPOCH || parseInactivityInstant(checkpoint.committedBefore) === null
            || inventory.project !== expected.project || inventory.instance !== expected.instance
            || !Number.isInteger(inventory.backupCount) || inventory.backupCount < 1
            || parseInactivityInstant(inventory.latestRecoveryAt) === null || parseInactivityInstant(inventory.observedAt) === null
            || checkpoint.committedBefore > inventory.latestRecoveryAt || inventory.latestRecoveryAt > inventory.observedAt) throw new Error();
    } catch { throw new RecoveryCheckpointUnavailableError(); }
}

/**
 * On a dedicated fresh connection, commit a new checkpoint only after the
 * caller verifies the exact batch's completed effects in this transaction.
 * The caller must fence other writers and must not advance the external guard
 * until a recoverable backup or PITR includes the returned post-commit time.
 * An uncertain commit or post-commit read never authorizes cleanup.
 */
export async function establishRecoveryCheckpoint(connection: TransactionConnection, pins: Pins,
    verifyEffects: (connection: Connection) => Promise<boolean>): Promise<Readonly<{
        lineage: string; epoch: string; committedBefore: string;
    }>> {
    let begun = false;
    let starting = false;
    let committing = false;
    try {
        if (typeof verifyEffects !== 'function') throw new Error();
        starting = true;
        await connection.beginTransaction();
        starting = false;
        begun = true;
        const before = await readCheckpoint(connection, pins, true, true);
        if (BigInt(before.epoch) >= MAX_EPOCH || await verifyEffects(connection) !== true) throw new Error();
        const [updated] = await connection.query<ResultSetHeader>({ sql: `UPDATE account_recovery_checkpoint
            SET epoch=epoch+1 WHERE singleton_id=1 AND lineage_id=? AND epoch=?`,
        values: [before.lineage, before.epoch], timeout: 10_000 });
        if (updated.affectedRows !== 1) throw new Error();
        const after = await readCheckpoint(connection, pins, true, true);
        if (BigInt(after.epoch) !== BigInt(before.epoch) + BigInt(1)) throw new Error();
        committing = true;
        await connection.commit();
        begun = false;
        const [rows] = await connection.query<RowDataPacket[]>({ sql: `SELECT DATABASE() AS databaseName,
            CURRENT_USER() AS currentUser, @@GLOBAL.server_uuid AS serverUuid,
            DATE_FORMAT(UTC_TIMESTAMP(6),'%Y-%m-%dT%H:%i:%s.%fZ') AS nowUtc`, timeout: 10_000 });
        if (!Array.isArray(rows) || rows.length !== 1 || rows[0].databaseName !== pins.database
            || rows[0].currentUser !== pins.currentUser || rows[0].serverUuid !== pins.serverUuid
            || parseInactivityInstant(rows[0].nowUtc) === null) throw new Error();
        return Object.freeze({ ...after, committedBefore: rows[0].nowUtc });
    } catch {
        if (starting) connection.destroy();
        else if (begun && !committing) {
            try { await connection.rollback(); } catch { connection.destroy(); }
        } else if (committing) connection.destroy();
        throw new RecoveryCheckpointUnavailableError();
    }
}
