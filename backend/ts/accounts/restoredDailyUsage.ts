import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { verifyChildDailyUsageSchema } from '../migrations/childDailyUsageSchema';
import { readRecoveryCheckpoint } from './accountRecoveryCheckpoint';
import { assertNoRetentionRuntimeWriters, isProductionRecoveryOperator } from './retentionReconciliation';
import type { createGcsRetentionJournal } from './gcsRetentionJournal';

type Connection = Pick<PoolConnection, 'query' | 'destroy'>;
type Pins = Readonly<{ database: string; serverUuid: string; originalServerUuid: string; currentUser: string }>;
type Journal = Pick<ReturnType<typeof createGcsRetentionJournal>, 'readRestoreGuard'>;

/** A direct query fails closed on missing permissions rather than trusting hidden metadata. */
export async function restoredDailyUsageState(connection: Connection): Promise<'absent' | 'empty' | 'present'> {
    try {
        const [rows] = await connection.query<RowDataPacket[]>({ sql: 'SELECT child_uuid FROM parent_child_daily_usage LIMIT 1', timeout: 10_000 });
        if (!Array.isArray(rows) || rows.length > 1) throw new Error('Usage state unavailable.');
        return rows.length ? 'present' : 'empty';
    } catch (error) {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ER_NO_SUCH_TABLE') return 'absent';
        throw error;
    }
}

/** The restored target must be isolated and its writers remain fenced through cutover. */
export async function resetRestoredDailyUsage(connection: Connection, journal: Journal, pins: Pins): Promise<void> {
    if (pins.serverUuid === pins.originalServerUuid) throw new Error('Cannot reset the original database.');
    const guard = await journal.readRestoreGuard();
    if (guard.state !== 'hold' || guard.database !== pins.database || guard.serverUuid !== pins.originalServerUuid) {
        throw new Error('Restore guard is not held.');
    }
    const [identity] = await connection.query<RowDataPacket[]>({ sql: 'SELECT DATABASE() AS db,CURRENT_USER() AS user,@@GLOBAL.server_uuid AS serverUuid', timeout: 10_000 });
    if (!Array.isArray(identity) || identity.length !== 1 || identity[0].db !== pins.database
        || identity[0].user !== pins.currentUser || identity[0].serverUuid !== pins.serverUuid) throw new Error('Restore identity differs.');
    await assertNoRetentionRuntimeWriters(connection, isProductionRecoveryOperator(pins));
    if (guard.recoveryCheckpoint) await readRecoveryCheckpoint(connection, { database: pins.database,
        currentUser: pins.currentUser, serverUuid: pins.serverUuid, lineage: guard.recoveryCheckpoint.lineage,
        minimumEpoch: guard.recoveryCheckpoint.minimumEpoch });
    const state = await restoredDailyUsageState(connection);
    if (state !== 'absent') {
        await verifyChildDailyUsageSchema(connection);
        if (JSON.stringify(await journal.readRestoreGuard()) !== JSON.stringify(guard)) throw new Error('Restore guard changed.');
        await connection.query({ sql: 'DELETE FROM parent_child_daily_usage', timeout: 30_000 });
        if (await restoredDailyUsageState(connection) !== 'empty') throw new Error('Usage reset incomplete.');
    }
    if (JSON.stringify(await journal.readRestoreGuard()) !== JSON.stringify(guard)) throw new Error('Restore guard changed.');
}
