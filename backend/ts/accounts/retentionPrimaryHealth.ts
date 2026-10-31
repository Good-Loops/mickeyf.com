import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { isAccountId } from './deletionJournal';
import type { RetentionIntent } from './childInactivityWorkflow';
import type { ObservedRestoreGuard } from './gcsRetentionJournal';

type Journal = Readonly<{
    readRestoreGuard(): Promise<ObservedRestoreGuard>;
    readIntentsForChild(childId: string): Promise<readonly RetentionIntent[]>;
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
        || typeof options.journal?.readRestoreGuard !== 'function' || typeof options.journal?.readIntentsForChild !== 'function') {
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
            // Earlier attempts for this child need individual manual reconciliation;
            // they must never become automatic replay authority.
            if (!Array.isArray(intents) || intents.length !== 0) return false;
            const after = await options.journal.readRestoreGuard();
            const nowAfter = await identity(connection);
            return nowAfter !== null && nowAfter >= now && nowAfter < expiry && JSON.stringify(before) === JSON.stringify(after);
        } catch { return false; }
    };
}
