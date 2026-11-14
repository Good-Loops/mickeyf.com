import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { verifyOptionalAccountSessionSchema } from '../migrations/accountSessionSchema';
import { verifyOptionalProviderAttemptSchema } from '../migrations/providerAttemptSchema';
import { APPLE_ANDROID_HANDOFF_MIGRATION, verifyAppleAndroidHandoffSchema } from '../migrations/appleAndroidHandoffSchema';
import { readRecoveryCheckpoint } from './accountRecoveryCheckpoint';
import { assertNoRetentionRuntimeWriters, isProductionRecoveryOperator } from './retentionReconciliation';
import type { createGcsRetentionJournal } from './gcsRetentionJournal';

type Connection = Pick<PoolConnection, 'query' | 'destroy'>;
type Pins = Readonly<{ database: string; serverUuid: string; originalServerUuid: string; currentUser: string }>;
type Journal = Pick<ReturnType<typeof createGcsRetentionJournal>, 'readRestoreGuard'>;
const TABLES = ['account_sessions', 'provider_auth_attempts', 'apple_android_handoffs'] as const;
type Table = typeof TABLES[number];
type State = 'absent' | 'empty' | 'present';

async function tableState(connection: Connection, table: Table): Promise<State> {
    try {
        const [rows] = await connection.query<RowDataPacket[]>({
            sql: 'SELECT 1 AS present FROM ' + table + ' LIMIT 1', timeout: 10_000 });
        if (!Array.isArray(rows) || rows.length > 1) throw new Error('Authentication state unavailable.');
        return rows.length ? 'present' : 'empty';
    } catch (error) {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ER_NO_SUCH_TABLE') return 'absent';
        throw error;
    }
}

/** Direct reads reject missing permissions; only an actually absent legacy table is allowed. */
export async function restoredAuthenticationState(connection: Connection): Promise<'clear' | 'present'> {
    let present = false;
    for (const table of TABLES) if (await tableState(connection, table) === 'present') present = true;
    return present ? 'present' : 'clear';
}

/** Invalidate restored bearer sessions and in-flight provider returns, preserving accounts and results. */
export async function resetRestoredAuthentication(connection: Connection, journal: Journal, pins: Pins): Promise<void> {
    try {
        if (pins.serverUuid === pins.originalServerUuid) throw new Error('Cannot reset the original database.');
        const guard = await journal.readRestoreGuard();
        if (guard.state !== 'hold' || guard.database !== pins.database || guard.serverUuid !== pins.originalServerUuid) {
            throw new Error('Restore guard is not held.');
        }
        const unchanged = async () => {
            if (JSON.stringify(await journal.readRestoreGuard()) !== JSON.stringify(guard)) throw new Error('Restore guard changed.');
        };
        const [identity] = await connection.query<RowDataPacket[]>({
            sql: 'SELECT DATABASE() AS db,CURRENT_USER() AS user,@@GLOBAL.server_uuid AS serverUuid', timeout: 10_000 });
        if (!Array.isArray(identity) || identity.length !== 1 || identity[0].db !== pins.database
            || identity[0].user !== pins.currentUser || identity[0].serverUuid !== pins.serverUuid) throw new Error('Restore identity differs.');
        await assertNoRetentionRuntimeWriters(connection, isProductionRecoveryOperator(pins));
        if (guard.recoveryCheckpoint) await readRecoveryCheckpoint(connection, { database: pins.database,
            currentUser: pins.currentUser, serverUuid: pins.serverUuid, lineage: guard.recoveryCheckpoint.lineage,
            minimumEpoch: guard.recoveryCheckpoint.minimumEpoch });
        const states = new Map<Table, State>();
        for (const table of TABLES) states.set(table, await tableState(connection, table));
        const metadata = { query: (sql: string, values?: unknown[]) => connection.query({ sql, timeout: 10_000 }, values) };
        await verifyOptionalAccountSessionSchema(metadata);
        await verifyOptionalProviderAttemptSchema(metadata);
        if (states.get('apple_android_handoffs') !== 'absent') await verifyAppleAndroidHandoffSchema(metadata);
        else {
            const [records] = await metadata.query('SELECT version FROM schema_migrations WHERE version=?', [APPLE_ANDROID_HANDOFF_MIGRATION]);
            if (!Array.isArray(records) || records.length) throw new Error('Recorded handoff table is missing.');
        }
        await unchanged();
        await connection.query({ sql: 'START TRANSACTION', timeout: 10_000 });
        if (states.get('account_sessions') !== 'absent') await connection.query({ sql: 'DELETE FROM account_sessions', timeout: 30_000 });
        // The reviewed handoff foreign key cascades removal of its encrypted return.
        if (states.get('provider_auth_attempts') !== 'absent') await connection.query({ sql: 'DELETE FROM provider_auth_attempts', timeout: 30_000 });
        if (await restoredAuthenticationState(connection) !== 'clear') throw new Error('Authentication reset incomplete.');
        await unchanged();
        await connection.query({ sql: 'COMMIT', timeout: 10_000 });
        if (await restoredAuthenticationState(connection) !== 'clear') throw new Error('Authentication reset unconfirmed.');
        await unchanged();
    } catch {
        // Closing rolls back an open transaction; a lost COMMIT acknowledgement
        // requires fresh exact-target readback while the restore guard stays held.
        connection.destroy();
        throw new Error('Restored authentication reset unconfirmed. Keep traffic stopped and inspect the held target.');
    }
}
