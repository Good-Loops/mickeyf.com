import { createHash, type KeyObject } from 'node:crypto';
import type { DeletionJournalReader } from './deletionJournal';
import { createGcsDeletionJournal, type JournalHttpClient } from './gcsDeletionJournal';
import type { ObservedRestoreGuard } from './gcsRetentionJournal';
import { verifyRetiredJournalObjects } from './verifyRetiredJournalObjects';

/** Read-only audit: a checkpoint must be read from the same pinned primary. */
export function createGuardedDeletionAuditReader(options: Readonly<{
    guard: Readonly<{ readRestoreGuard(): Promise<ObservedRestoreGuard> }>;
    pins: Readonly<{ database: string; currentUser: string; serverUuid: string }>;
    publicKey?: KeyObject;
    client: JournalHttpClient;
    readTimeoutMs: number;
}>): DeletionJournalReader {
    return { async readDeletionIntents(connection) {
        if (!connection) throw new Error('Deletion audit requires its pinned database connection');
        const initial = await options.guard.readRestoreGuard();
        if (initial.database !== options.pins.database || initial.serverUuid !== options.pins.serverUuid) throw new Error('Invalid audit guard');
        const journal = createGcsDeletionJournal({ client: options.client, readTimeoutMs: options.readTimeoutMs,
            verifyRetiredObjects: async objects => {
                if (JSON.stringify(await options.guard.readRestoreGuard()) !== JSON.stringify(initial)) throw new Error('Audit guard changed');
                if (!initial.recoveryCheckpoint) {
                    if (objects.length) throw new Error('Unexpected retired objects');
                } else {
                    if (!options.publicKey) throw new Error('Verification key unavailable');
                    await verifyRetiredJournalObjects(connection, options.guard, { database: options.pins.database,
                        currentUser: options.pins.currentUser, targetServerUuid: options.pins.serverUuid,
                        originalServerUuid: options.pins.serverUuid }, objects, options.publicKey, 'audit');
                }
                if (JSON.stringify(await options.guard.readRestoreGuard()) !== JSON.stringify(initial)) throw new Error('Audit guard changed');
            } });
        const result = await journal.readDeletionIntents();
        const digest = createHash('sha256').update(JSON.stringify([initial, result.digest])).digest('hex');
        return { ...result, digest };
    } };
}
