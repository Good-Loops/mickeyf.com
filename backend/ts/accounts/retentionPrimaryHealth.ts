import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { isAccountId } from './deletionJournal';
import type { RetentionIntent } from './childInactivityWorkflow';
import type { ObservedRestoreGuard, RetentionResolution } from './gcsRetentionJournal';
import { parseInactivityInstant } from './childInactivityPolicy';

type Journal = Readonly<{
    readRestoreGuard(): Promise<ObservedRestoreGuard>;
    readIntentsForChild(childId: string): Promise<readonly RetentionIntent[]>;
    readResolution(intent: RetentionIntent): Promise<RetentionResolution | null>;
}>;
type Connection = Pick<PoolConnection, 'query'>;
const timeout = 10_000;
const MAX_ATTESTATION_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * The GCS guard is an authenticated administrative control, not a detector of
 * an undeclared in-place restore. The restore procedure MUST place it on hold
 * and drain existing writers before changing the primary, then reconcile.
 */
export function createPinnedPrimaryHealth(options: Readonly<{ database: string; serverUuid: string; journal: Journal }>) {
    if (!/^[A-Za-z0-9_]{1,64}$/u.test(options.database) || !isAccountId(options.serverUuid)
        || typeof options.journal?.readRestoreGuard !== 'function' || typeof options.journal?.readIntentsForChild !== 'function'
        || typeof options.journal?.readResolution !== 'function') {
        throw new TypeError('Invalid retention primary pin.');
    }
    async function identity(connection: Connection): Promise<number | null> {
        const [rows] = await connection.query<RowDataPacket[]>({ sql: `SELECT DATABASE() AS databaseName,
            @@GLOBAL.server_uuid AS serverUuid, @@GLOBAL.read_only AS readOnly,
            @@GLOBAL.super_read_only AS superReadOnly,
            DATE_FORMAT(UTC_TIMESTAMP(6),'%Y-%m-%dT%H:%i:%s.%fZ') AS nowUtc`, timeout });
        if (!Array.isArray(rows) || rows.length !== 1) return null;
        const row = rows[0], now = typeof row.nowUtc === 'string' ? Date.parse(row.nowUtc) : NaN;
        if (row.databaseName !== options.database || row.serverUuid !== options.serverUuid
            || ![0, '0'].includes(row.readOnly) || ![0, '0'].includes(row.superReadOnly)
            || !Number.isFinite(now) || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/u.test(row.nowUtc)
            || new Date(now).toISOString() !== `${row.nowUtc.slice(0, 23)}Z`) return null;
        return now;
    }
    return async (connection: Connection, parentId: string, childId: string): Promise<boolean> => {
        if (!isAccountId(parentId) || !isAccountId(childId) || parentId === childId) return false;
        try {
            const now = await identity(connection);
            if (now === null) return false;
            const before = await options.journal.readRestoreGuard();
            const expiry = Date.parse(before.expiresAt);
            if (before.state !== 'active' || before.serverUuid !== options.serverUuid || before.database !== options.database
                || !isAccountId(before.epoch) || !/^[1-9][0-9]*$/u.test(before.generation)
                || !Number.isFinite(expiry) || expiry <= now || expiry - now > MAX_ATTESTATION_MS) return false;
            const intents = await options.journal.readIntentsForChild(childId);
            if (!Array.isArray(intents)) return false;
            if (intents.length) {
                const [rows] = await connection.query<RowDataPacket[]>({ sql: `SELECT DATE_FORMAT(a.retention_activity_at,
                    '%Y-%m-%dT%H:%i:%s.%fZ') AS activityAt FROM parent_managed_child_activity a
                    INNER JOIN parent_child_consents c ON c.child_uuid=a.child_uuid
                    WHERE c.parent_uuid=? AND c.child_uuid=? LIMIT 1`, timeout }, [parentId, childId]);
                if (!Array.isArray(rows) || rows.length !== 1 || parseInactivityInstant(rows[0].activityAt) === null) return false;
                const current = rows[0].activityAt as string;
                for (const intent of intents) {
                    const resolution = await options.journal.readResolution(intent);
                    // Deleted outcomes still hold if the account is present. Kept outcomes
                    // only clear a previous attempt when durable SQL shows later use.
                    if (intent.parentId !== parentId || intent.childId !== childId || !resolution || resolution.outcome !== 'kept'
                        || !resolution.observedActivityAt || parseInactivityInstant(resolution.observedActivityAt) === null
                        || resolution.observedActivityAt <= intent.activityAt || current < resolution.observedActivityAt) return false;
                }
            }
            const after = await options.journal.readRestoreGuard();
            const nowAfter = await identity(connection);
            return nowAfter !== null && nowAfter >= now && nowAfter < expiry && JSON.stringify(before) === JSON.stringify(after);
        } catch { return false; }
    };
}
