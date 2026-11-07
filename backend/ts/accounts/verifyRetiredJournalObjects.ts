import { createHash, type KeyObject } from 'node:crypto';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { isAccountId } from './deletionJournal';
import type { ObservedRestoreGuard } from './gcsRetentionJournal';
import { readRecoveryCheckpoint } from './accountRecoveryCheckpoint';
import { verifyJournalRetirementStamp } from './journalRetirementStamp';

type Connection = Pick<PoolConnection, 'query'>;
type GuardReader = Readonly<{ readRestoreGuard(): Promise<ObservedRestoreGuard> }>;
type RetiredObject = Readonly<{ bucket: string; name: string; generation: string; stamp: unknown }>;

/**
 * Check soft-deleted generations against the independent guard and the actual
 * recovery target. A signed stamp alone is never permission to ignore an
 * object: its checkpoint must already be included in the durable guard floor.
 * Callers must also fence writers and verify a stable complete inventory.
 */
export async function verifyRetiredJournalObjects(connection: Connection, journal: GuardReader,
    pins: Readonly<{ database: string; currentUser: string; targetServerUuid: string; originalServerUuid: string }>,
    objects: readonly RetiredObject[], publicKey: KeyObject, mode: 'recovery' | 'audit' = 'recovery'): Promise<void> {
    try {
        if (!isAccountId(pins.targetServerUuid) || !isAccountId(pins.originalServerUuid)
            || !Array.isArray(objects) || objects.length > 10_000) throw new Error();
        const before = await journal.readRestoreGuard();
        if ((mode !== 'recovery' && mode !== 'audit') || !['hold', 'active'].includes(before.state)
            || (mode === 'recovery' && before.state !== 'hold')
            || (mode === 'audit' && pins.targetServerUuid !== pins.originalServerUuid)
            || before.database !== pins.database || before.serverUuid !== pins.originalServerUuid
            || !before.recoveryCheckpoint) throw new Error();
        if (publicKey.type !== 'public' || publicKey.asymmetricKeyType !== 'ed25519'
            || createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex')
                !== before.recoveryCheckpoint.keySha256) throw new Error();
        await readRecoveryCheckpoint(connection, { database: pins.database, currentUser: pins.currentUser,
            serverUuid: pins.targetServerUuid, lineage: before.recoveryCheckpoint.lineage,
            minimumEpoch: before.recoveryCheckpoint.minimumEpoch });
        const [rows] = await connection.query<RowDataPacket[]>({ sql: `SELECT DATABASE() AS databaseName,
            CURRENT_USER() AS currentUser, @@GLOBAL.server_uuid AS serverUuid,
            DATE_FORMAT(UTC_TIMESTAMP(6),'%Y-%m-%dT%H:%i:%s.%fZ') AS nowUtc`, timeout: 10_000 });
        if (!Array.isArray(rows) || rows.length !== 1 || rows[0].databaseName !== pins.database
            || rows[0].currentUser !== pins.currentUser || rows[0].serverUuid !== pins.targetServerUuid) throw new Error();
        const identities = new Set<string>();
        for (const object of objects) {
            if (!object || typeof object.bucket !== 'string' || typeof object.name !== 'string'
                || typeof object.generation !== 'string') throw new Error();
            const identity = JSON.stringify([object.bucket, object.name, object.generation]);
            if (identities.has(identity)) throw new Error();
            identities.add(identity);
            verifyJournalRetirementStamp(object.stamp, { bucket: object.bucket, name: object.name,
                generation: object.generation, checkpointLineage: before.recoveryCheckpoint.lineage,
                checkpointEpoch: before.recoveryCheckpoint.minimumEpoch, observedAt: rows[0].nowUtc }, publicKey);
        }
        if (JSON.stringify(await journal.readRestoreGuard()) !== JSON.stringify(before)) throw new Error();
    } catch { throw new Error('Retired journal objects cannot be verified. Keep recovery on hold.'); }
}
