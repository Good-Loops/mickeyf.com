import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { assertActiveGuardedTransaction } from '../db/queryTimeoutConnection';
import type { ChildActivityContinuityConfig } from '../config/childActivityContinuity';
import { isAccountId } from './deletionJournal';
import { openAppendOnlyContinuitySession, type AppendOnlyObjectTransport } from './childContinuityAppendOnly';
import { ContinuityHeadUnavailableError, type ContinuityHead, type ContinuityLedgerRow } from './childContinuityHead';
import { parentManagedChildActivity, type ChildActivityKind, type ParentManagedChildActivity } from './parentManagedChildActivity';

type Connection = Pick<PoolConnection, 'query'>;
type SavedWitness = Readonly<{ head: ContinuityHead; ledgerRows: readonly ContinuityLedgerRow[] }>;
const timeout = 10_000;
const clockSkewMs = 5_000;
const kinds = new Set<ChildActivityKind>(['online', 'parent-keep', 'password-login', 'score']);

/** Canonical SQL state shared with the fenced retirement operator; does not authorize a write. */
export async function readChildActivityState(connection: Connection, childId: string, parentId: string): Promise<Buffer | null> {
    const [found] = await connection.query<RowDataPacket[]>({ sql: `SELECT c.parent_uuid AS parentId, c.country_code AS country,
        LOWER(HEX(c.policy_digest)) AS policyDigest, c.consent_version AS consentVersion,
        DATE_FORMAT(a.retention_activity_at,'%Y-%m-%dT%H:%i:%s.%fZ') AS activityAt
        FROM parent_child_consents c LEFT JOIN parent_managed_child_activity a ON a.child_uuid=c.child_uuid
        WHERE c.child_uuid=? LIMIT 2 FOR SHARE`, timeout }, [childId]);
    if (!Array.isArray(found) || found.length !== 1 || found[0].parentId !== parentId) throw new ContinuityHeadUnavailableError();
    if (found[0].activityAt === null) return null;
    const row = found[0];
    if (!['BR', 'US'].includes(row.country) || !/^[a-f0-9]{64}$/u.test(row.policyDigest)
        || typeof row.consentVersion !== 'string' || row.consentVersion.length < 1 || row.consentVersion.length > 128
        || typeof row.activityAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u.test(row.activityAt)) {
        throw new ContinuityHeadUnavailableError();
    }
    return Buffer.from(JSON.stringify({ version: 1, childId, parentId, country: row.country,
        policyDigest: row.policyDigest, consentVersion: row.consentVersion, activityAt: row.activityAt }));
}

/**
 * Runs inside the caller's guarded transaction and existing account lock.
 * External evidence precedes SQL COMMIT; an uncertain write is never retried.
 * This records activity continuity, not warning delivery or deletion authority.
 */
export function createDurableChildActivity(config: ChildActivityContinuityConfig,
    transport: AppendOnlyObjectTransport, now: () => number = Date.now) {
    if (!config || !/^[A-Za-z0-9_]{1,64}$/u.test(config.database) || !isAccountId(config.serverUuid)
        || !Buffer.isBuffer(config.key) || config.key.length !== 32 || typeof now !== 'function') {
        throw new TypeError('Invalid child activity continuity configuration.');
    }
    const pinned = { ...config, key: Buffer.from(config.key) };
    const open = (head?: ContinuityHead) => openAppendOnlyContinuitySession({ transport,
        bucket: pinned.bucket, expectedBucket: pinned.bucket, key: pinned.key,
        sequence: head?.sequence ?? 0, generation: head?.generation ?? '0' });
    // Validate the complete adapter configuration before accepting a request.
    open();

    async function rows(connection: Connection, sql: string, values: unknown[] = []): Promise<RowDataPacket[]> {
        const [result] = await connection.query<RowDataPacket[]>({ sql, timeout }, values);
        if (!Array.isArray(result)) throw new ContinuityHeadUnavailableError();
        return result;
    }
    async function databaseClock(connection: Connection): Promise<number> {
        assertActiveGuardedTransaction(connection);
        const before = now();
        const result = await rows(connection, `SELECT DATABASE() AS db, @@GLOBAL.server_uuid AS serverUuid,
            DATE_FORMAT(UTC_TIMESTAMP(6),'%Y-%m-%dT%H:%i:%s.%fZ') AS observedAt`);
        const after = now(), instant = Date.parse(result[0]?.observedAt);
        if (result.length !== 1 || result[0].db !== pinned.database || result[0].serverUuid !== pinned.serverUuid
            || !Number.isSafeInteger(before) || !Number.isSafeInteger(after) || after < before || after - before > timeout
            || !Number.isSafeInteger(instant) || instant < before - clockSkewMs || instant > after + clockSkewMs) {
            throw new ContinuityHeadUnavailableError();
        }
        return instant;
    }
    async function requireLock(connection: Connection, childId: string, initializing: boolean): Promise<string | null> {
        assertActiveGuardedTransaction(connection);
        if (!isAccountId(childId)) throw new ContinuityHeadUnavailableError();
        const found = await rows(connection, `SELECT c.parent_uuid AS parentId, u.user_id AS childUserId, p.user_id AS parentUserId
            FROM parent_child_consents c JOIN users u ON u.account_uuid=c.child_uuid JOIN users p ON p.account_uuid=c.parent_uuid
            WHERE c.child_uuid=? LIMIT 2`, [childId]);
        if (found.length === 0 && !initializing) return null; // Ordinary adult accounts are not tracked.
        if (found.length !== 1 || !isAccountId(found[0].parentId) || found[0].parentId === childId
            || !Number.isSafeInteger(found[0].childUserId) || !Number.isSafeInteger(found[0].parentUserId)) {
            throw new ContinuityHeadUnavailableError();
        }
        // Creation is still invisible outside the parent's uncommitted transaction.
        // All later writers use the same named child lock as keep and deletion.
        const owner = await rows(connection, `SELECT IS_USED_LOCK(CONCAT('mickeyf:leaderboard-user:',
            LEFT(SHA2(DATABASE(),256),16),':',?))=CONNECTION_ID() AS ownsLock`,
        [initializing ? found[0].parentUserId : found[0].childUserId]);
        if (owner.length !== 1 || owner[0].ownsLock !== 1) throw new ContinuityHeadUnavailableError();
        return found[0].parentId;
    }
    async function saved(connection: Connection, childId: string): Promise<SavedWitness | null> {
        const found = await rows(connection, `SELECT CAST(head_json AS CHAR) AS head, CAST(ledger_json AS CHAR) AS ledger
            FROM parent_child_activity_continuity WHERE child_uuid=? LIMIT 2 FOR UPDATE`, [childId]);
        if (found.length === 0) return null;
        if (found.length !== 1 || typeof found[0].head !== 'string' || found[0].head.length > 1500
            || typeof found[0].ledger !== 'string' || found[0].ledger.length > 1_000_000) throw new ContinuityHeadUnavailableError();
        const head = JSON.parse(found[0].head), ledgerRows = JSON.parse(found[0].ledger);
        if (!head || typeof head !== 'object' || Array.isArray(head) || !Array.isArray(ledgerRows)
            || ledgerRows.length < 1 || ledgerRows.length > 2048) throw new ContinuityHeadUnavailableError();
        return { head, ledgerRows };
    }
    async function persist(connection: Connection, childId: string, next: SavedWitness, previous?: SavedWitness): Promise<void> {
        const serialized = [JSON.stringify(next.head), JSON.stringify(next.ledgerRows)];
        const [result] = previous
            ? await connection.query<ResultSetHeader>({ sql: `UPDATE parent_child_activity_continuity SET head_json=?,ledger_json=?
                WHERE child_uuid=? AND JSON_UNQUOTE(JSON_EXTRACT(head_json,'$.token'))=?`, timeout }, [...serialized, childId, previous.head.token])
            : await connection.query<ResultSetHeader>({ sql: `INSERT INTO parent_child_activity_continuity
                (head_json,ledger_json,child_uuid) VALUES (?,?,?)`, timeout }, [...serialized, childId]);
        if (result.affectedRows !== 1) throw new ContinuityHeadUnavailableError();
    }
    async function verify(connection: Connection, childId: string, parentId: string,
        session: ReturnType<typeof open>): Promise<void> {
        const actual = await saved(connection, childId), actualState = await readChildActivityState(connection, childId, parentId);
        if (!actual || !actualState) throw new ContinuityHeadUnavailableError();
        await session.verifyExisting(childId, actual.head, actual.ledgerRows, actualState, await databaseClock(connection));
        assertActiveGuardedTransaction(connection);
    }
    async function guarded<T>(operation: () => Promise<T>): Promise<T> {
        try { return await operation(); }
        catch { throw new ContinuityHeadUnavailableError(); } // SQL/provider exceptions may contain private request data.
    }
    const activity: ParentManagedChildActivity = {
        initialize: (connection, childId) => guarded(async () => {
            const parentId = await requireLock(connection, childId, true);
            if (!parentId || await readChildActivityState(connection, childId, parentId) || await saved(connection, childId)) throw new ContinuityHeadUnavailableError();
            const instant = await databaseClock(connection), session = open(), request = Buffer.from('child-activity-v1:create');
            await parentManagedChildActivity.initialize(connection, childId);
            const nextState = await readChildActivityState(connection, childId, parentId);
            if (!nextState) throw new ContinuityHeadUnavailableError();
            const next = await session.initializeNew(childId, session.issueOperation(childId, request, instant), instant, request, nextState);
            await persist(connection, childId, next);
            await verify(connection, childId, parentId, session);
        }),
        recordInteraction: (connection, childId, kind: ChildActivityKind = 'online') => guarded(async () => {
            if (!kinds.has(kind)) throw new ContinuityHeadUnavailableError();
            const parentId = await requireLock(connection, childId, false);
            if (!parentId) return false;
            const previousState = await readChildActivityState(connection, childId, parentId), previous = await saved(connection, childId);
            if (!previousState && !previous) return false; // Historical untracked accounts stay ineligible for deletion.
            if (!previousState || !previous) throw new ContinuityHeadUnavailableError();
            const instant = await databaseClock(connection), session = open(previous.head);
            await session.verifyExisting(childId, previous.head, previous.ledgerRows, previousState, instant);
            if (!await parentManagedChildActivity.recordInteraction(connection, childId, kind)) throw new ContinuityHeadUnavailableError();
            const nextState = await readChildActivityState(connection, childId, parentId);
            if (!nextState) throw new ContinuityHeadUnavailableError();
            const request = Buffer.from(`child-activity-v1:${kind}`);
            // A repeated authenticated activity is another conservative timer reset.
            // We never reinterpret an uncertain prior SQL/external outcome as success.
            const next = await session.prepareExisting(childId, previous.head, session.issueOperation(childId, request, instant),
                previous.ledgerRows, instant, request, previousState, nextState);
            if (next.status !== 'prepared') throw new ContinuityHeadUnavailableError();
            await persist(connection, childId, next, previous);
            await verify(connection, childId, parentId, session);
            return true;
        }),
    };
    return Object.freeze({ ...activity,
        verifyActivity: (connection: Connection, childId: string) => guarded(async () => {
            const parentId = await requireLock(connection, childId, false), current = await saved(connection, childId);
            if (!parentId || !current) throw new ContinuityHeadUnavailableError();
            await verify(connection, childId, parentId, open(current.head));
        }),
    });
}
