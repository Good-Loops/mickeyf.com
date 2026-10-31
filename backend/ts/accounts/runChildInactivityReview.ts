import { isAccountId } from './deletionJournal';
import { INACTIVITY_NOTICE, INACTIVITY_NOTICE_DIGEST } from './childInactivityPolicy';
import { assertChildSchemaCleanSource, childSchemaCommandSettings, createChildSchemaConnection } from '../migrations/runChildSignedFormSchema';
import type { MigrationConnection } from '../migrations/leaderboardSchema';

const FAILURE = 'Inactivity review unavailable; no complete page was produced.';
const PAGE_SIZE = 100;
type Environment = Readonly<Record<string, string | undefined>>;
type Input = AsyncIterable<Uint8Array | string>;
type Loaded = ReturnType<typeof childSchemaCommandSettings>;
type Dependencies = Readonly<{
    settings?: (env: Environment) => Loaded;
    assertSource?: (commit: string, env: Environment) => void;
    connect?: (config: Loaded['config']) => { connection: MigrationConnection; close(): Promise<void> };
    input?: Input;
    write?: (value: string) => void;
}>;

async function readCursor(input: Input): Promise<string | null> {
    const buffers: Buffer[] = []; let length = 0;
    for await (const chunk of input) {
        const part = Buffer.from(chunk); length += part.length;
        if (length > 4096) throw new Error(FAILURE);
        buffers.push(part);
    }
    const value: unknown = JSON.parse(Buffer.concat(buffers).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).join(',') !== 'afterChildId') throw new Error(FAILURE);
    const cursor = (value as { afterChildId?: unknown }).afterChildId;
    if (cursor !== null && !isAccountId(cursor)) throw new Error(FAILURE);
    return cursor;
}

/** Read-only, bounded review only. A row is never evidence of eligibility or current contact. */
export async function runChildInactivityReview(args = process.argv.slice(2), env: Environment = process.env,
    deps: Dependencies = {}): Promise<void> {
    if (args.length !== 0) throw new Error(FAILURE);
    let session: ReturnType<typeof createChildSchemaConnection> | undefined;
    try {
        const after = await readCursor(deps.input ?? process.stdin);
        const loaded = (deps.settings ?? childSchemaCommandSettings)(env);
        const assertSource = () => (deps.assertSource ?? ((commit, environment) => assertChildSchemaCleanSource(commit, undefined, environment)))(loaded.source.sourceCommit, env);
        assertSource();
        session = (deps.connect ?? createChildSchemaConnection)(loaded.config);
        const { connection } = session;
        await connection.query('START TRANSACTION READ ONLY');
        async function targetIdentity(): Promise<string> {
            const [rows] = await connection.query(`SELECT DATABASE() AS databaseName, CURRENT_USER() AS currentUser,
                @@GLOBAL.server_uuid AS serverUuid, @@version AS serverVersion, @@version_comment AS versionComment,
                DATE_FORMAT(UTC_TIMESTAMP(6),'%Y-%m-%dT%H:%i:%s.%fZ') AS observedAt`);
            if (!Array.isArray(rows) || rows.length !== 1) throw new Error(FAILURE);
            const row = rows[0], expected = loaded.settings;
            if (!row || row.databaseName !== expected.target.database || row.currentUser !== expected.expectedCurrentUser
                || row.serverUuid !== expected.target.serverUuid || row.serverVersion !== expected.expectedServerVersion
                || row.versionComment !== expected.expectedVersionComment || !validTimestamp(row.observedAt)) throw new Error(FAILURE);
            return row.observedAt;
        }
        const observedAt = await targetIdentity();
        // The extra day intentionally includes borderline candidates; the scan does not make policy decisions.
        const [rows] = await connection.query(`SELECT c.parent_uuid AS parentId, c.child_uuid AS childId,
            DATE_FORMAT(a.retention_activity_at,'%Y-%m-%dT%H:%i:%s.%fZ') AS activityAt
            FROM parent_child_consents c LEFT JOIN parent_managed_child_activity a ON a.child_uuid=c.child_uuid
            WHERE (? IS NULL OR c.child_uuid>?) AND (a.child_uuid IS NULL
                OR a.retention_activity_at<=UTC_TIMESTAMP(6)-INTERVAL 3 YEAR+INTERVAL 31 DAY)
            ORDER BY c.child_uuid LIMIT ${PAGE_SIZE + 1}`, [after, after]);
        if (!Array.isArray(rows) || rows.length > PAGE_SIZE + 1) throw new Error(FAILURE);
        let previous = after ?? '';
        const candidates = rows.map(row => {
            if (!row || Object.keys(row).sort().join(',') !== 'activityAt,childId,parentId'
                || !isAccountId(row.parentId) || !isAccountId(row.childId) || row.parentId === row.childId
                || row.childId <= previous || (row.activityAt !== null && !validTimestamp(row.activityAt))) throw new Error(FAILURE);
            previous = row.childId;
            return { parentId: row.parentId, childId: row.childId, activityAt: row.activityAt,
                review: row.activityAt === null ? 'missing-activity' : 'potentially-approaching-warning' };
        });
        await targetIdentity();
        assertSource();
        await connection.query('ROLLBACK');
        const completed = session; session = undefined; await completed.close();
        const hasMore = candidates.length > PAGE_SIZE;
        const page = candidates.slice(0, PAGE_SIZE);
        const report = { operation: 'read-only-inactivity-review', observedAt, draftOnly: true,
            warning: 'Potential candidates only. Do not contact, warn or delete until the current contact, activity completeness, parent interface and notice have been independently qualified. If the parent does not confirm, keep the account pending.',
            draft: { noticeDigest: INACTIVITY_NOTICE_DIGEST, en: INACTIVITY_NOTICE.en, ptBR: INACTIVITY_NOTICE.ptBR },
            candidates: page, nextAfterChildId: hasMore ? page[page.length - 1].childId : null };
        (deps.write ?? (value => { process.stdout.write(value); }))(`${JSON.stringify(report, null, 2)}\n`);
    } catch { throw new Error(FAILURE); }
    finally { if (session) { try { await session.close(); } catch { throw new Error(FAILURE); } } }
}

function validTimestamp(value: unknown): value is string {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u.test(value)
        && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === `${value.slice(0, 23)}Z`;
}

if (require.main === module) runChildInactivityReview().catch(() => { console.error(FAILURE); process.exitCode = 1; });
