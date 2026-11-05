import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { DeletionJournalEntry } from './gcsDeletionJournal';
import type { ObservedRestoreGuard } from './gcsRetentionJournal';
import { verifyDeletedAccountEffects } from './verifiedDeletionEffects';
import { assertNoRetentionRuntimeWriters } from './retentionReconciliation';
import { readRecoveryCheckpoint } from './accountRecoveryCheckpoint';

type Connection = Pick<PoolConnection, 'query' | 'beginTransaction' | 'rollback' | 'destroy'>;
type Identity = Readonly<{ name: string; generation: string; contentSha256: string }>;

/** Read-only triage; the checkpoint transaction must independently recheck each selected account. */
export async function previewRetirementCandidates(options: Readonly<{
    connection: Connection; pins: Readonly<{ database: string; currentUser: string; serverUuid: string }>;
    guard: Readonly<{ readRestoreGuard(): Promise<ObservedRestoreGuard> }>;
    journal: Readonly<{ readDeletionEntries(): Promise<Readonly<{ entries: readonly DeletionJournalEntry[]; digest: string }>> }>;
    verifySchema(connection: Pick<PoolConnection, 'query'>): Promise<void>; confirmation: string; offset?: number;
}>): Promise<Readonly<{ candidates: readonly Identity[]; held: number; total: number; nextOffset: number | null }>> {
    let begun = false, beginning = false;
    try {
        if (options.confirmation !== 'ORIGINAL PRIMARY AND ALL WRITERS FENCED') throw new Error();
        const [identity] = await options.connection.query<RowDataPacket[]>({ sql: `SELECT DATABASE() AS db,CURRENT_USER() AS user,
            @@GLOBAL.server_uuid AS uuid`, timeout: 10_000 });
        if (!Array.isArray(identity) || identity.length !== 1 || identity[0].db !== options.pins.database
            || identity[0].user !== options.pins.currentUser || identity[0].uuid !== options.pins.serverUuid) throw new Error();
        await options.verifySchema(options.connection);
        const guard = await options.guard.readRestoreGuard(), guardText = JSON.stringify(guard);
        if (guard.state !== 'hold' || guard.database !== options.pins.database || guard.serverUuid !== options.pins.serverUuid) throw new Error();
        if (guard.recoveryCheckpoint) await readRecoveryCheckpoint(options.connection, { ...options.pins,
            lineage: guard.recoveryCheckpoint.lineage, minimumEpoch: guard.recoveryCheckpoint.minimumEpoch });
        await assertNoRetentionRuntimeWriters(options.connection);
        const snapshot = await options.journal.readDeletionEntries(), offset = options.offset ?? 0;
        if (!Array.isArray(snapshot.entries) || snapshot.entries.length > 10_000 || !/^[a-f0-9]{64}$/u.test(snapshot.digest)
            || !Number.isSafeInteger(offset) || offset < 0 || offset > snapshot.entries.length) throw new Error();
        const end = Math.min(offset + 100, snapshot.entries.length), candidates: Identity[] = []; let held = 0;
        for (const entry of snapshot.entries.slice(offset, end)) {
            beginning = true; await options.connection.beginTransaction(); beginning = false; begun = true;
            const absent = await verifyDeletedAccountEffects(options.connection, [entry.intent.accountId]);
            await options.connection.rollback(); begun = false;
            if (absent) candidates.push({ name: entry.name, generation: entry.generation, contentSha256: entry.contentSha256 });
            else held++;
        }
        await assertNoRetentionRuntimeWriters(options.connection);
        if (JSON.stringify(await options.guard.readRestoreGuard()) !== guardText
            || (await options.journal.readDeletionEntries()).digest !== snapshot.digest) throw new Error();
        return { candidates, held, total: snapshot.entries.length, nextOffset: end < snapshot.entries.length ? end : null };
    } catch {
        if (beginning) options.connection.destroy();
        else if (begun) { try { await options.connection.rollback(); } catch { options.connection.destroy(); } }
        throw new Error('Retirement preview unavailable or unconfirmed. Keep recovery held.');
    }
}
