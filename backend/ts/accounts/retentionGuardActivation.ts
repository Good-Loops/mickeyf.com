import { randomUUID } from 'node:crypto';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { isAccountId } from './deletionJournal';
import { parseInactivityInstant } from './childInactivityPolicy';
import type { createGcsRetentionJournal, RestoreGuard } from './gcsRetentionJournal';
import { assertNoRetentionRuntimeWriters } from './retentionReconciliation';
import { readRecoveryCheckpoint } from './accountRecoveryCheckpoint';

type Connection = Pick<PoolConnection, 'query' | 'destroy'>;
type Journal = Pick<ReturnType<typeof createGcsRetentionJournal>, 'readRestoreGuard' | 'readIntents' | 'readResolution' | 'writeRestoreGuard'>;
type Pins = Readonly<{ database: string; serverUuid: string; originalServerUuid: string; currentUser: string; confirmation: string }>;

/**
 * A deliberate cutover operation: all writers must already be externally
 * stopped and must remain stopped after the short SQL lock is released.
 */
export async function activateRetentionGuard(connection: Connection, journal: Journal, pins: Pins): Promise<string> {
    if (!/^[A-Za-z0-9_]{1,64}$/u.test(pins.database) || !isAccountId(pins.serverUuid) || !isAccountId(pins.originalServerUuid)
        || !pins.currentUser || pins.confirmation !== 'ALL WRITERS FENCED AND INTENTS RECONCILED') {
        throw new Error('Retention activation refused.');
    }
    let activating: RestoreGuard | undefined;
    try {
        const guard = await journal.readRestoreGuard();
        if (guard.state !== 'hold' || guard.serverUuid !== pins.originalServerUuid
            || guard.database !== pins.database) throw new Error('Guard is not held for this database.');
        async function identity() {
            const [rows] = await connection.query<RowDataPacket[]>({ sql: `SELECT DATABASE() AS db,CURRENT_USER() AS user,
                @@GLOBAL.server_uuid AS serverUuid,@@GLOBAL.read_only AS readOnly,@@GLOBAL.super_read_only AS superReadOnly,
                DATE_FORMAT(UTC_TIMESTAMP(6),'%Y-%m-%dT%H:%i:%s.%fZ') AS nowUtc`, timeout: 10_000 });
            if (!Array.isArray(rows) || rows.length !== 1 || rows[0].db !== pins.database || rows[0].user !== pins.currentUser
                || rows[0].serverUuid !== pins.serverUuid || ![0, '0'].includes(rows[0].readOnly)
                || ![0, '0'].includes(rows[0].superReadOnly) || parseInactivityInstant(rows[0].nowUtc) === null) {
                throw new Error('Target identity unavailable.');
            }
            return rows[0].nowUtc as string;
        }
        await identity();
        await connection.query({ sql: 'FLUSH TABLES WITH READ LOCK', timeout: 10_000 });
        const nowUtc = await identity();
        await assertNoRetentionRuntimeWriters(connection);
        if (guard.recoveryCheckpoint !== undefined) {
            await readRecoveryCheckpoint(connection, { database: pins.database, currentUser: pins.currentUser,
                serverUuid: pins.serverUuid, lineage: guard.recoveryCheckpoint.lineage,
                minimumEpoch: guard.recoveryCheckpoint.minimumEpoch });
        }
        const intents = await journal.readIntents();
        for (const intent of intents) {
            const resolution = await journal.readResolution(intent);
            if (!resolution) throw new Error('Unresolved intent.');
            const [rows] = await connection.query<RowDataPacket[]>({ sql: `SELECT u.account_uuid AS childId,c.parent_uuid AS parentId,
                DATE_FORMAT(a.retention_activity_at,'%Y-%m-%dT%H:%i:%s.%fZ') AS activityAt FROM users u
                LEFT JOIN parent_child_consents c ON c.child_uuid=u.account_uuid
                LEFT JOIN parent_managed_child_activity a ON a.child_uuid=u.account_uuid
                WHERE u.account_uuid=? LIMIT 2`, timeout: 10_000 }, [intent.childId]);
            if (!Array.isArray(rows) || rows.length > 1) throw new Error('Target account lookup ambiguous.');
            if (resolution.outcome === 'deleted') {
                if (rows.length !== 0 || resolution.observedActivityAt !== null) throw new Error('Deleted account remains.');
            } else if (resolution.outcome === 'kept') {
                if (rows.length !== 1 || rows[0].parentId !== intent.parentId || rows[0].childId !== intent.childId
                    || parseInactivityInstant(rows[0].activityAt) === null || !resolution.observedActivityAt
                    || parseInactivityInstant(resolution.observedActivityAt) === null
                    || resolution.observedActivityAt <= intent.activityAt || rows[0].activityAt < resolution.observedActivityAt) {
                    throw new Error('Kept account state differs.');
                }
            } else throw new Error('Invalid retention outcome.');
        }
        if (JSON.stringify(intents) !== JSON.stringify(await journal.readIntents())
            || JSON.stringify(guard) !== JSON.stringify(await journal.readRestoreGuard())) throw new Error('Retention inventory changed.');
        activating = { state: 'active', database: pins.database, serverUuid: pins.serverUuid,
            epoch: randomUUID(), expiresAt: new Date(Date.parse(nowUtc) + 364 * 24 * 60 * 60_000).toISOString(),
            ...(guard.recoveryCheckpoint === undefined ? {} : { recoveryCheckpoint: guard.recoveryCheckpoint }) };
        const generation = await journal.writeRestoreGuard(activating, guard.generation);
        await identity();
        await connection.query({ sql: 'UNLOCK TABLES', timeout: 10_000 });
        return generation;
    } catch {
        // Any lost GCS acknowledgement or SQL lock response is ambiguous.
        // Closing the physical session releases a possibly acquired SQL lock.
        connection.destroy();
        if (activating) {
            try {
                const current = await journal.readRestoreGuard();
                if (current.state === 'active' && current.epoch === activating.epoch && current.database === activating.database
                    && current.serverUuid === activating.serverUuid && current.expiresAt === activating.expiresAt) {
                    await journal.writeRestoreGuard({ ...activating, state: 'hold' }, current.generation);
                }
            } catch { /* The caller must keep writers stopped and inspect the guard. */ }
        }
        throw new Error('Retention activation unavailable or unconfirmed. Keep all writers and traffic stopped.');
    }
}
