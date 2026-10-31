import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { withUserSubmissionLock } from '../leaderboards/userSubmissionLock';
import { deleteOwnedAccountRows } from './accountDeletionRepository';
import { readLiveSession } from '../auth/accountSessionRepository';
import { INACTIVITY_NOTICE_DIGEST, type InactivityChannel, type InactivitySnapshot, type InactivityWarning } from './childInactivityPolicy';
import type { InactivityStore, LockedInactivityTarget, PendingInactivityWarning } from './childInactivityWorkflow';

const timeout = 10_000;
type Queryable = Pick<Pool, 'getConnection'>;
type TargetQuality = Readonly<{ activityComplete: boolean; targetVerified: boolean; currentTargetDigest: string | null; channel: InactivityChannel }>;

/**
 * Must resolve the exact notification channel/target and independently verified
 * tracking health using this same transaction. An in-app target is not a verified
 * email; historical signup email alone is insufficient for an email target.
 * Return false/null on unknown evidence; never make network calls.
 */
export type ResolveInactivityQuality = (connection: PoolConnection, parentId: string, childId: string) => Promise<TargetQuality>;

function sqlTimestamp(value: string): string { return value.replace('T', ' ').replace(/Z$/u, ''); }
async function rows(connection: PoolConnection, sql: string, params: unknown[]): Promise<RowDataPacket[]> {
    const [result] = await connection.query<RowDataPacket[]>({ sql, timeout }, params);
    if (!Array.isArray(result)) throw new Error('Inactivity lookup unavailable.');
    return result;
}

/** Draft adapter: no route, scheduled job, schema migration or mail transport is installed by importing this module. */
export function createChildInactivitySqlStore(database: Queryable, resolveQuality: ResolveInactivityQuality): InactivityStore {
    if (typeof resolveQuality !== 'function') throw new TypeError('Notification target and tracking verification are required.');
    return {
        async withLockedChild<T>(parentId: string, childId: string, operation: (target: LockedInactivityTarget) => Promise<T>): Promise<T> {
            const lookup = await database.getConnection();
            let parentUserId: number;
            try {
                const found = await rows(lookup, 'SELECT user_id FROM users WHERE account_uuid=? LIMIT 2', [parentId]);
                if (found.length !== 1 || !Number.isSafeInteger(found[0].user_id) || found[0].user_id < 1) throw new Error('Parent unavailable.');
                parentUserId = found[0].user_id;
            } finally { lookup.release(); }
            return withUserSubmissionLock(database, parentUserId, async parentLock => {
                const found = await rows(parentLock.connection, `SELECT u.user_id FROM parent_child_consents c
                    INNER JOIN users u ON u.account_uuid=c.child_uuid WHERE c.parent_uuid=? AND c.child_uuid=? LIMIT 2`, [parentId, childId]);
                if (found.length !== 1 || !Number.isSafeInteger(found[0].user_id) || found[0].user_id < 1
                    || found[0].user_id === parentUserId) throw new Error('Managed child unavailable.');
                const childUserId = found[0].user_id as number;
                return parentLock.withAdditionalLock(childUserId, async lock => {
                    const connection = lock.connection;
                    let phase: 'begin' | 'active' | 'commit' | 'done' = 'begin';
                    try {
                        await connection.query({ sql: 'START TRANSACTION', timeout }); phase = 'active';
                        const relation = await rows(connection, `SELECT c.parent_uuid, c.child_uuid FROM parent_child_consents c
                            INNER JOIN users p ON p.account_uuid=c.parent_uuid AND p.user_id=?
                            INNER JOIN users u ON u.account_uuid=c.child_uuid AND u.user_id=?
                            WHERE c.parent_uuid=? AND c.child_uuid=? LIMIT 1 FOR SHARE`, [parentUserId, childUserId, parentId, childId]);
                        if (relation.length !== 1) throw new Error('Managed relationship changed.');
                        const getData = async () => {
                            const result = await rows(connection, `SELECT DATE_FORMAT(a.retention_activity_at,'%Y-%m-%dT%H:%i:%s.%fZ') AS activityAt,
                                w.parent_uuid AS warningParentId,w.child_uuid AS warningChildId,w.warning_uuid AS warningId,
                                DATE_FORMAT(w.activity_at,'%Y-%m-%dT%H:%i:%s.%fZ') AS warningActivityAt,
                                LOWER(HEX(w.target_digest)) AS targetDigest,w.channel AS warningChannel,
                                LOWER(HEX(w.notice_digest)) AS noticeDigest,
                                DATE_FORMAT(w.delivered_at,'%Y-%m-%dT%H:%i:%s.%fZ') AS deliveredAt,
                                LOWER(HEX(w.receipt_digest)) AS receiptDigest
                                FROM parent_managed_child_activity a LEFT JOIN parent_child_inactivity_warnings w ON w.child_uuid=a.child_uuid
                                WHERE a.child_uuid=? LIMIT 1 FOR UPDATE`, [childId]);
                            if (result.length > 1) throw new Error('Activity lookup ambiguous.');
                            return result[0] ?? null;
                        };
                        const target: LockedInactivityTarget = {
                            async snapshot(): Promise<InactivitySnapshot | null> {
                                const data = await getData(); if (!data) return null;
                                const quality = await resolveQuality(connection, parentId, childId);
                                const warning: InactivityWarning | null = data.warningId && data.deliveredAt && data.receiptDigest
                                    ? { parentId: data.warningParentId, childId: data.warningChildId, warningId: data.warningId,
                                        activityAt: data.warningActivityAt, targetDigest: data.targetDigest, channel: data.warningChannel, noticeDigest: data.noticeDigest,
                                        deliveredAt: data.deliveredAt, receiptDigest: data.receiptDigest } : null;
                                return { parentId, childId, activityAt: data.activityAt,
                                    activityComplete: quality.activityComplete === true, targetVerified: quality.targetVerified === true,
                                    currentTargetDigest: quality.currentTargetDigest, channel: quality.channel, warning };
                            },
                            async pending(): Promise<PendingInactivityWarning | null> {
                                const data = await getData();
                                return data?.warningId ? { parentId: data.warningParentId, childId: data.warningChildId,
                                    warningId: data.warningId, activityAt: data.warningActivityAt, targetDigest: data.targetDigest, channel: data.warningChannel, noticeDigest: data.noticeDigest } : null;
                            },
                            async savePending(warning) {
                                const [updated] = await connection.query<ResultSetHeader>({ sql: `UPDATE parent_child_inactivity_warnings SET
                                    parent_uuid=?,warning_uuid=?,activity_at=?,channel=?,target_digest=UNHEX(?),notice_digest=UNHEX(?),prepared_at=UTC_TIMESTAMP(6),
                                    delivered_at=NULL,receipt_digest=NULL WHERE child_uuid=?`, timeout },
                                [parentId, warning.warningId, sqlTimestamp(warning.activityAt), warning.channel, warning.targetDigest, warning.noticeDigest, childId]);
                                if (updated.affectedRows === 0) {
                                    const [inserted] = await connection.query<ResultSetHeader>({ sql: `INSERT INTO parent_child_inactivity_warnings
                                        (child_uuid,parent_uuid,warning_uuid,activity_at,channel,target_digest,notice_digest,prepared_at)
                                        VALUES (?,?,?,?,?,UNHEX(?),UNHEX(?),UTC_TIMESTAMP(6))`, timeout },
                                    [childId, parentId, warning.warningId, sqlTimestamp(warning.activityAt), warning.channel, warning.targetDigest, warning.noticeDigest]);
                                    if (inserted.affectedRows !== 1) throw new Error('Warning could not be prepared.');
                                } else if (updated.affectedRows !== 1) throw new Error('Warning preparation was ambiguous.');
                            },
                            async saveConfirmed(warning) {
                                const [result] = await connection.query<ResultSetHeader>({ sql: `UPDATE parent_child_inactivity_warnings SET
                                    delivered_at=?,receipt_digest=UNHEX(?) WHERE parent_uuid=? AND child_uuid=? AND warning_uuid=?
                                    AND activity_at=? AND channel=? AND target_digest=UNHEX(?) AND notice_digest=UNHEX(?) AND delivered_at IS NULL`, timeout },
                                [sqlTimestamp(warning.deliveredAt), warning.receiptDigest, parentId, childId, warning.warningId,
                                    sqlTimestamp(warning.activityAt), warning.channel, warning.targetDigest, warning.noticeDigest]);
                                if (result.affectedRows !== 1) throw new Error('Warning receipt could not be recorded.');
                            },
                            async parentSessionValid(proof) {
                                return proof.accountId === parentId && !!await readLiveSession(connection, parentUserId, parentId, proof.sessionId);
                            },
                            async databaseTimestamp() {
                                const time = await rows(connection, "SELECT DATE_FORMAT(UTC_TIMESTAMP(6),'%Y-%m-%dT%H:%i:%s.%fZ') AS value", []);
                                if (time.length !== 1 || typeof time[0].value !== 'string') throw new Error('Database clock unavailable.');
                                return time[0].value;
                            },
                            async assertDeletionStillDue() {
                                // Enforce both deadlines using the SQL clock before the irreversible journal intent.
                                const due = await rows(connection, `SELECT a.child_uuid FROM parent_managed_child_activity a
                                    INNER JOIN parent_child_inactivity_warnings w ON w.child_uuid=a.child_uuid
                                    WHERE a.child_uuid=? AND w.parent_uuid=? AND w.activity_at=a.retention_activity_at
                                    AND w.notice_digest=UNHEX(?)
                                    AND a.retention_activity_at<=UTC_TIMESTAMP(6)-INTERVAL 3 YEAR
                                    AND w.delivered_at<=UTC_TIMESTAMP(6)-INTERVAL 30 DAY AND w.receipt_digest IS NOT NULL
                                    LIMIT 1 FOR UPDATE`, [childId, parentId, INACTIVITY_NOTICE_DIGEST]);
                                if (due.length !== 1) throw new Error('SQL deadline changed.');
                            },
                            async deleteChild(id) {
                                if (id !== childId) throw new Error('Child mismatch.');
                                await deleteOwnedAccountRows(connection, childUserId, childId);
                            },
                        };
                        const value = await operation(target);
                        phase = 'commit'; await connection.query({ sql: 'COMMIT', timeout }); phase = 'done';
                        return value;
                    } catch (error) {
                        if (phase !== 'active') lock.invalidateConnection();
                        else try { await connection.query({ sql: 'ROLLBACK', timeout }); } catch { lock.invalidateConnection(); }
                        throw error;
                    }
                });
            });
        },
    };
}
