import type { Pool, RowDataPacket } from 'mysql2/promise';
import { isAccountId } from './deletionJournal';
import { deleteChildAfterNonresponse, type createChildWarningNonresponse } from './childWarningNonresponse';
import type { DurableWarningStore } from './durableChildWarningStore';
import type { RetentionJournal } from './childInactivityWorkflow';

type Workflow = ReturnType<typeof createChildWarningNonresponse>;
type Counts = { examined: number; sent: number; pending: number; waiting: number; held: number; deleted: number; nextAfterChildId: string | null };

/** Bounded keyset scan. All decisions, sends and deletions recheck the locked current state. */
export async function runChildWarningMaintenance(database: Pick<Pool, 'query'>, store: DurableWarningStore,
    workflow: Workflow, journal: RetentionJournal, options: Readonly<{ afterChildId: string | null; batchSize?: number }>): Promise<Counts> {
    const size = options?.batchSize ?? 50;
    if (!options || !(options.afterChildId === null || isAccountId(options.afterChildId))
        || !Number.isInteger(size) || size < 1 || size > 100) throw new TypeError('Invalid warning maintenance page.');
    const [rows] = await database.query<RowDataPacket[]>({ sql: `SELECT c.parent_uuid AS parentId,c.child_uuid AS childId,c.country_code AS country
        FROM parent_child_consents c JOIN parent_managed_child_activity a ON a.child_uuid=c.child_uuid
        WHERE (? IS NULL OR c.child_uuid>?) AND a.retention_activity_at<=UTC_TIMESTAMP(6)-INTERVAL 3 YEAR
        ORDER BY c.child_uuid LIMIT ${size + 1}`, timeout: 10_000 }, [options.afterChildId, options.afterChildId]);
    if (!Array.isArray(rows) || rows.length > size + 1) throw new Error('Warning scan unavailable.');
    let previous = options.afterChildId ?? '';
    for (const row of rows) {
        if (!isAccountId(row.parentId) || !isAccountId(row.childId) || row.parentId === row.childId
            || row.childId <= previous || !['BR', 'US'].includes(row.country)) throw new Error('Warning scan unavailable.');
        previous = row.childId;
    }
    const page = rows.slice(0, size);
    const counts: Counts = { examined: page.length, sent: 0, pending: 0, waiting: 0, held: 0, deleted: 0,
        nextAfterChildId: rows.length > size ? page[page.length - 1].childId : null };
    for (const { parentId, childId, country } of page) {
        let action = await workflow.nextAction(parentId, childId);
        if (action === 'prepare') {
            if (!await workflow.prepare(parentId, childId, country === 'BR' ? 'pt-BR' : 'en')) { counts.held++; continue; }
            action = await workflow.nextAction(parentId, childId);
        }
        if (action === 'dispatch') {
            if (await workflow.dispatch(parentId, childId) !== 'accepted') { counts.held++; continue; }
            counts.sent++;
            action = await workflow.nextAction(parentId, childId);
        }
        if (action === 'observe') {
            const result = await workflow.observe(parentId, childId);
            if (result === 'pending') { counts.pending++; continue; }
            if (result === 'held') { counts.held++; continue; }
            action = await workflow.nextAction(parentId, childId);
        }
        // An old saved delivery does not require provider logs to last a year.
        // Provider failure ingestion is qualified separately before activation.
        if (action === 'candidate') {
            const result = await deleteChildAfterNonresponse(store, journal, parentId, childId);
            if (result === 'deleted') counts.deleted++; else counts.held++;
        } else if (action === 'waiting') counts.waiting++;
        else counts.held++;
    }
    return Object.freeze(counts);
}
