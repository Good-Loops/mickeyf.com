import { createHash, type KeyObject } from 'node:crypto';
import type { Pool } from 'mysql2/promise';
import type { DeletionJournalReader } from './deletionJournal';
import { createGcsDeletionJournal, type JournalHttpClient } from './gcsDeletionJournal';
import type { ObservedRestoreGuard } from './gcsRetentionJournal';
import { verifyRetiredJournalObjects } from './verifyRetiredJournalObjects';

/** Require a stable independent hold, even after all soft-deleted markers expire. */
export async function createGuardedDeletionReplayReader(options: Readonly<{
    database: Pick<Pool, 'getConnection'>;
    guard: Readonly<{ readRestoreGuard(): Promise<ObservedRestoreGuard> }>;
    pins: Readonly<{ database: string; currentUser: string; targetServerUuid: string; originalServerUuid: string }>;
    publicKey?: KeyObject;
    client?: JournalHttpClient;
    readTimeoutMs: number;
}>): Promise<DeletionJournalReader> {
    const initial = await options.guard.readRestoreGuard();
    if (initial.state !== 'hold' || initial.database !== options.pins.database
        || initial.serverUuid !== options.pins.originalServerUuid || (initial.recoveryCheckpoint && !options.publicKey)) {
        throw new Error('Recovery guard or verification key is unavailable.');
    }
    const guardFingerprint = createHash('sha256').update(JSON.stringify(initial)).digest('hex');
    const journal = createGcsDeletionJournal({ client: options.client, readTimeoutMs: options.readTimeoutMs,
        verifyRetiredObjects: async objects => {
            if (JSON.stringify(await options.guard.readRestoreGuard()) !== JSON.stringify(initial)) throw new Error();
            if (!initial.recoveryCheckpoint) {
                if (objects.length) throw new Error();
            } else {
                const connection = await options.database.getConnection();
                try { await verifyRetiredJournalObjects(connection, options.guard, options.pins, objects, options.publicKey!); }
                finally { connection.release(); }
            }
            if (JSON.stringify(await options.guard.readRestoreGuard()) !== JSON.stringify(initial)) throw new Error();
        } });
    return { async readDeletionIntents() {
        const result = await journal.readDeletionIntents();
        return { ...result, digest: createHash('sha256').update(JSON.stringify([guardFingerprint, result.digest])).digest('hex') };
    } };
}
