import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { createHmac } from 'node:crypto';
import { withUserSubmissionLock } from '../leaderboards/userSubmissionLock';
import { openAppendOnlyContinuitySession, type AppendOnlyObjectTransport } from './childContinuityAppendOnly';
import { ContinuityHeadUnavailableError, type ContinuityHead, type ContinuityLedgerRow } from './childContinuityHead';
import { isAccountId } from './deletionJournal';
import { parseInactivityInstant, type InactivitySnapshot } from './childInactivityPolicy';
import { deleteOwnedAccountRows } from './accountDeletionRepository';
import type { RetentionIntent, RetentionJournal } from './childInactivityWorkflow';
import { readLiveSession } from '../auth/accountSessionRepository';
import { isSessionId, type SessionProof } from '../security/sessionPolicy';

const timeout = 10_000;
const limit = 16_384;
export type WarningEvent = Readonly<{
    kind: 'prepared' | 'dispatch' | 'accepted' | 'delivered' | 'hold';
    attemptId: string; at: string;
    activityAt?: string; targetDigest?: string; noticeDigest?: string; language?: 'en' | 'pt-BR';
    messageId?: string; deliveredAt?: string;
}>;
export type WarningHistory = Readonly<{ version: 1; parentId: string; childId: string; events: readonly WarningEvent[] }>;
export type WarningContext = Readonly<{ snapshot: InactivitySnapshot; recipient: string | null }>;
type Witness = Readonly<{ head: ContinuityHead; ledgerRows: readonly ContinuityLedgerRow[] }>;
export type LockedWarning = Readonly<{
    context: WarningContext; now: string; history: WarningHistory;
    append(event: WarningEvent): Promise<void>;
    verifyJournal(intent: RetentionIntent, journal: RetentionJournal): Promise<boolean>;
    deleteChild(): Promise<void>;
    parentSessionValid(proof: SessionProof): Promise<boolean>;
}>;
export type DurableWarningStore = Readonly<{
    withChild<T>(parentId: string, childId: string, run: (target: LockedWarning) => Promise<T>): Promise<T>;
}>;
export type WarningStoreOptions = Readonly<{
    database: string; serverUuid: string; bucket: string; key: Buffer;
    transport: AppendOnlyObjectTransport;
    /** Must verify independent activity history on this same locked transaction. */
    verifyActivity(connection: PoolConnection, childId: string): Promise<void>;
    /** Resolve the immutable used-form contact and its still-linked provider identity. */
    resolveContext(connection: PoolConnection, parentId: string, childId: string): Promise<WarningContext>;
    clock?: () => number;
}>;

/** Separate append-only witness; no sender, scheduler or deletion is enabled here. */
export function createDurableChildWarningStore(database: Pick<Pool, 'getConnection'>, options: WarningStoreOptions): DurableWarningStore {
    if (!options || !/^[A-Za-z0-9_]{1,64}$/u.test(options.database) || !isAccountId(options.serverUuid)
        || !Buffer.isBuffer(options.key) || options.key.length !== 32 || options.key.every(byte => byte === 0)
        || typeof options.verifyActivity !== 'function' || typeof options.resolveContext !== 'function') {
        throw new TypeError('Invalid warning history configuration.');
    }
    const key = Buffer.from(options.key), clock = options.clock ?? Date.now;
    const open = (head?: ContinuityHead) => openAppendOnlyContinuitySession({ transport: options.transport,
        bucket: options.bucket, expectedBucket: options.bucket, key, sequence: head?.sequence ?? 0,
        generation: head?.generation ?? '0' });
    open();
    const unavailable = () => new ContinuityHeadUnavailableError();
    async function rows(connection: PoolConnection, sql: string, values: unknown[] = []) {
        const [result] = await connection.query<RowDataPacket[]>({ sql, timeout }, values);
        if (!Array.isArray(result)) throw unavailable();
        return result;
    }
    async function instant(connection: PoolConnection) {
        const before = clock();
        const found = await rows(connection, `SELECT DATABASE() AS db, @@GLOBAL.server_uuid AS serverUuid,
            DATE_FORMAT(UTC_TIMESTAMP(6),'%Y-%m-%dT%H:%i:%s.%fZ') AS instant`);
        const after = clock(), value = found[0]?.instant, parsed = parseInactivityInstant(value);
        if (found.length !== 1 || found[0].db !== options.database || found[0].serverUuid !== options.serverUuid
            || !Number.isSafeInteger(before) || !Number.isSafeInteger(after) || after < before || after - before > timeout
            || parsed === null || parsed < before - 5_000 || parsed > after + 5_000) throw unavailable();
        return value as string;
    }
    const canonical = (history: WarningHistory) => {
        const bytes = Buffer.from(JSON.stringify(history));
        if (bytes.length > limit) throw unavailable();
        return bytes;
    };
    async function locked<T>(connection: PoolConnection, parentUserId: number, childUserId: number, parentId: string, childId: string,
        run: (target: LockedWarning) => Promise<T>): Promise<T> {
        const relation = await rows(connection, 'SELECT parent_uuid FROM parent_child_consents WHERE child_uuid=? FOR SHARE', [childId]);
        if (relation.length !== 1 || relation[0].parent_uuid !== parentId) throw unavailable();
        await options.verifyActivity(connection, childId);
        const resolved = await options.resolveContext(connection, parentId, childId);
        if (!resolved || resolved.snapshot.parentId !== parentId || resolved.snapshot.childId !== childId
            || resolved.snapshot.channel !== 'email') throw unavailable();
        // Bind the actual recipient as well as the immutable form/identity revision.
        // A resolver cannot accidentally keep the same digest after an address change.
        const targetDigest = resolved.recipient && /^[a-f0-9]{64}$/u.test(resolved.snapshot.currentTargetDigest ?? '')
            ? createHmac('sha256', key).update('warning-target-v1\0').update(parentId).update('\0')
                .update(resolved.snapshot.currentTargetDigest!).update('\0').update(resolved.recipient).digest('hex') : null;
        const context = Object.freeze({ recipient: resolved.recipient,
            snapshot: Object.freeze({ ...resolved.snapshot, currentTargetDigest: targetDigest }) });
        const now = await instant(connection);
        const found = await rows(connection, `SELECT CAST(state_json AS CHAR) AS state,
            CAST(head_json AS CHAR) AS head, CAST(ledger_json AS CHAR) AS ledger
            FROM parent_child_warning_history WHERE child_uuid=? LIMIT 2 FOR UPDATE`, [childId]);
        if (found.length > 1) throw unavailable();
        let history: WarningHistory = { version: 1, parentId, childId, events: [] };
        let saved: Witness | undefined;
        if (found.length) {
            const row = found[0];
            if (typeof row.state !== 'string' || Buffer.byteLength(row.state) > limit
                || typeof row.head !== 'string' || row.head.length > 1500
                || typeof row.ledger !== 'string' || row.ledger.length > 1_000_000) throw unavailable();
            history = JSON.parse(row.state);
            saved = { head: JSON.parse(row.head), ledgerRows: JSON.parse(row.ledger) };
            if (history?.version !== 1 || history.parentId !== parentId || history.childId !== childId
                || !Array.isArray(history.events) || history.events.length < 1 || history.events.length > 64) throw unavailable();
        }
        const session = open(saved?.head);
        // MySQL JSON reorders object keys. Reconstruct our exact canonical field order.
        history = normalizeHistory(history);
        if (saved) await session.verifyExisting(childId, saved.head, saved.ledgerRows, canonical(history), Date.parse(now));
        let appended = false;
        const target: LockedWarning = {
            context, now, history,
            parentSessionValid: async proof => !!proof && proof.accountId === parentId && isSessionId(proof.sessionId)
                && !!await readLiveSession(connection, parentUserId, parentId, proof.sessionId),
            verifyJournal: (intent, journal) => journal.verifyActivityContinuity(intent, connection),
            async deleteChild() {
                await options.verifyActivity(connection, childId);
                // The relationship and warning were read while these same account
                // locks were held; ordinary activity/keep cannot interleave.
                await deleteOwnedAccountRows(connection, childUserId, childId);
            },
            async append(event) {
                if (appended || event.at !== now || !isAccountId(event.attemptId) || history.events.length >= 64) throw unavailable();
                const next = normalizeHistory({ ...history, events: [...history.events, event] });
                const nextBytes = canonical(next), request = Buffer.from(JSON.stringify(next.events.at(-1)));
                const operation = session.issueOperation(childId, request, Date.parse(now));
                const witness = saved
                    ? await session.prepareExisting(childId, saved.head, operation, saved.ledgerRows,
                        Date.parse(now), request, canonical(history), nextBytes)
                    : await session.initializeNew(childId, operation, Date.parse(now), request, nextBytes);
                if (!('head' in witness)) throw unavailable();
                const values = [nextBytes.toString(), JSON.stringify(witness.head), JSON.stringify(witness.ledgerRows)];
                const [result] = saved
                    ? await connection.query<ResultSetHeader>({ sql: `UPDATE parent_child_warning_history
                        SET state_json=?,head_json=?,ledger_json=? WHERE child_uuid=?
                        AND JSON_UNQUOTE(JSON_EXTRACT(head_json,'$.token'))=?`, timeout }, [...values, childId, saved.head.token])
                    : await connection.query<ResultSetHeader>({ sql: `INSERT INTO parent_child_warning_history
                        (state_json,head_json,ledger_json,child_uuid) VALUES (?,?,?,?)`, timeout }, [...values, childId]);
                if (result.affectedRows !== 1) throw unavailable();
                await session.verifyExisting(childId, witness.head, witness.ledgerRows, nextBytes, Date.parse(await instant(connection)));
                appended = true;
            },
        };
        return run(target);
    }
    return Object.freeze({
        async withChild(parentId, childId, run) {
            try {
                if (!isAccountId(parentId) || !isAccountId(childId) || parentId === childId) throw unavailable();
                const lookup = await database.getConnection();
                let parentUserId: number;
                try {
                    const found = await rows(lookup, 'SELECT user_id FROM users WHERE account_uuid=? LIMIT 2', [parentId]);
                    if (found.length !== 1 || !Number.isSafeInteger(found[0].user_id)) throw unavailable();
                    parentUserId = found[0].user_id;
                } finally { lookup.release(); }
                return await withUserSubmissionLock(database, parentUserId, async parentLock => {
                    const found = await rows(parentLock.connection, `SELECT u.user_id FROM users u JOIN parent_child_consents c
                        ON c.child_uuid=u.account_uuid WHERE c.parent_uuid=? AND c.child_uuid=? LIMIT 2`, [parentId, childId]);
                    if (found.length !== 1 || !Number.isSafeInteger(found[0].user_id) || found[0].user_id === parentUserId) throw unavailable();
                    return parentLock.withAdditionalLock(found[0].user_id, async lock => {
                        let phase: 'begin' | 'active' | 'commit' = 'begin';
                        try {
                            await lock.connection.query({ sql: 'START TRANSACTION', timeout }); phase = 'active';
                            const value = await locked(lock.connection, parentUserId, found[0].user_id, parentId, childId, run);
                            phase = 'commit'; await lock.connection.query({ sql: 'COMMIT', timeout }); return value;
                        } catch (error) {
                            if (phase !== 'active') lock.invalidateConnection();
                            else try { await lock.connection.query({ sql: 'ROLLBACK', timeout }); } catch { lock.invalidateConnection(); }
                            throw error;
                        }
                    });
                });
            } catch { throw unavailable(); } // Never leak SQL/provider request details.
        },
    });
}

function normalizeHistory(value: WarningHistory): WarningHistory {
    if (Object.keys(value).sort().join(',') !== 'childId,events,parentId,version') throw new ContinuityHeadUnavailableError();
    const events = value.events.map(event => {
        if (!event || !['prepared', 'dispatch', 'accepted', 'delivered', 'hold'].includes(event.kind)
            || !isAccountId(event.attemptId) || parseInactivityInstant(event.at) === null
            || Object.keys(event).some(key => !['kind', 'attemptId', 'at', 'activityAt', 'targetDigest',
                'noticeDigest', 'language', 'messageId', 'deliveredAt'].includes(key))) {
            throw new ContinuityHeadUnavailableError();
        }
        return Object.freeze({ kind: event.kind, attemptId: event.attemptId, at: event.at,
            ...(event.activityAt !== undefined ? { activityAt: event.activityAt } : {}),
            ...(event.targetDigest !== undefined ? { targetDigest: event.targetDigest } : {}),
            ...(event.noticeDigest !== undefined ? { noticeDigest: event.noticeDigest } : {}),
            ...(event.language !== undefined ? { language: event.language } : {}),
            ...(event.messageId !== undefined ? { messageId: event.messageId } : {}),
            ...(event.deliveredAt !== undefined ? { deliveredAt: event.deliveredAt } : {}) });
    });
    return Object.freeze({ version: 1, parentId: value.parentId, childId: value.childId, events: Object.freeze(events) });
}
