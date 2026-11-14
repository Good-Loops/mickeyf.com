import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { isAccountId } from './deletionJournal';
import type { DeletionJournalEntry } from './gcsDeletionJournal';
import type { RetentionIntent } from './childInactivityWorkflow';

/** Read inside a fenced transaction, using the actual authenticated journals. */
export async function readRetirementKnownAccounts(options: Readonly<{
    connection: Pick<PoolConnection, 'query'>;
    explicit: Readonly<{ readDeletionEntries(): Promise<Readonly<{ entries: readonly DeletionJournalEntry[] }>> }>;
    conditional: Readonly<{ readIntents(): Promise<readonly RetentionIntent[]> }>;
}>): Promise<readonly string[]> {
    const [rows] = await options.connection.query<RowDataPacket[]>({ sql: `SELECT child_uuid AS accountId
        FROM parent_managed_child_activity ORDER BY child_uuid LIMIT 100001`, timeout: 10_000 });
    if (!Array.isArray(rows) || rows.length > 100_000) throw new Error();
    const explicit = await options.explicit.readDeletionEntries(), conditional = await options.conditional.readIntents();
    if (!explicit || !Array.isArray(explicit.entries) || explicit.entries.length > 10_000
        || !Array.isArray(conditional) || conditional.length > 10_000) throw new Error();
    const ids: unknown[] = [...rows.map(row => row.accountId), ...explicit.entries.map(entry => entry.intent.accountId),
        ...conditional.map(intent => intent.childId)];
    if (ids.some(id => !isAccountId(id))) throw new Error();
    return [...new Set(ids as string[])].sort();
}
