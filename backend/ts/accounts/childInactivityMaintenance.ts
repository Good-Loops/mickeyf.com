import type { Pool, RowDataPacket } from 'mysql2/promise';
import { isAccountId } from './deletionJournal';
import { deleteInactiveChild, type InactivityStore, type RetentionJournal } from './childInactivityWorkflow';

const MAX_BATCH_SIZE = 100;
const QUERY_TIMEOUT_MS = 10_000;
type Database = Pick<Pool, 'query'>;
type Candidate = Readonly<{ parentId: string; childId: string }>;
type DeleteOne = typeof deleteInactiveChild;

/**
 * Process a bounded page; every deletion is independently rechecked under the
 * parent/child locks by deleteInactiveChild. The cursor is private account data.
 * An uncertain deletion aborts the batch and must be reconciled, not retried.
 */
export async function runChildInactivityMaintenance(
    database: Database, store: InactivityStore, journal: RetentionJournal,
    options: Readonly<{ afterChildId: string | null; batchSize?: number }>,
    deleteOne: DeleteOne = deleteInactiveChild,
): Promise<Readonly<{ examined: number; held: number; deleted: number; nextAfterChildId: string | null }>> {
    const size = options?.batchSize ?? MAX_BATCH_SIZE;
    if (!database || typeof database.query !== 'function' || !store || !journal
        || !options || !(options.afterChildId === null || isAccountId(options.afterChildId))
        || !Number.isInteger(size) || size < 1 || size > MAX_BATCH_SIZE) {
        throw new TypeError('Invalid inactivity maintenance configuration.');
    }
    const [rows] = await database.query<RowDataPacket[]>({
        sql: `SELECT c.parent_uuid AS parentId, c.child_uuid AS childId
            FROM parent_child_consents c
            INNER JOIN parent_managed_child_activity a ON a.child_uuid=c.child_uuid
            INNER JOIN parent_child_inactivity_warnings w ON w.child_uuid=c.child_uuid AND w.parent_uuid=c.parent_uuid
            WHERE (? IS NULL OR c.child_uuid>?) AND w.activity_at=a.retention_activity_at
                AND w.delivered_at IS NOT NULL AND w.receipt_digest IS NOT NULL
                AND a.retention_activity_at<=UTC_TIMESTAMP(6)-INTERVAL 3 YEAR
                AND w.delivered_at<=UTC_TIMESTAMP(6)-INTERVAL 30 DAY
            ORDER BY c.child_uuid LIMIT ${size + 1}`,
        timeout: QUERY_TIMEOUT_MS,
    }, [options.afterChildId, options.afterChildId]);
    if (!Array.isArray(rows) || rows.length > size + 1) throw new Error('Inactivity maintenance scan unavailable.');
    let previous = options.afterChildId ?? '';
    const candidates: Candidate[] = rows.map(row => {
        if (!row || Object.keys(row).sort().join(',') !== 'childId,parentId'
            || !isAccountId(row.parentId) || !isAccountId(row.childId)
            || row.parentId === row.childId || row.childId <= previous) {
            throw new Error('Inactivity maintenance scan unavailable.');
        }
        previous = row.childId;
        return { parentId: row.parentId, childId: row.childId };
    });
    const page = candidates.slice(0, size);
    let held = 0;
    let deleted = 0;
    for (const target of page) {
        const result = await deleteOne(store, journal, target.parentId, target.childId);
        if (result === 'held') held++;
        else if (result === 'deleted') deleted++;
        else throw new Error('Inactivity maintenance result unavailable.');
    }
    return Object.freeze({ examined: page.length, held, deleted,
        nextAfterChildId: candidates.length > size ? page[page.length - 1].childId : null });
}

/** Drain a bounded number of pages; an incomplete scan must be surfaced for follow-up. */
export async function runChildInactivityMaintenanceCycle(
    database: Database, store: InactivityStore, journal: RetentionJournal,
    options: Readonly<{ afterChildId: string | null; batchSize?: number; maxPages?: number }>,
    deleteOne: DeleteOne = deleteInactiveChild,
): Promise<Readonly<{ examined: number; held: number; deleted: number; nextAfterChildId: string | null }>> {
    const maxPages = options?.maxPages ?? 100;
    if (!options || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100) throw new TypeError('Invalid inactivity maintenance page limit.');
    let cursor = options.afterChildId;
    let examined = 0, held = 0, deleted = 0;
    for (let page = 0; page < maxPages; page++) {
        const result = await runChildInactivityMaintenance(database, store, journal,
            { afterChildId: cursor, batchSize: options.batchSize }, deleteOne);
        examined += result.examined; held += result.held; deleted += result.deleted;
        if (result.nextAfterChildId === null) return Object.freeze({ examined, held, deleted, nextAfterChildId: null });
        if (cursor !== null && result.nextAfterChildId <= cursor) throw new Error('Inactivity maintenance did not advance.');
        cursor = result.nextAfterChildId;
    }
    return Object.freeze({ examined, held, deleted, nextAfterChildId: cursor });
}
