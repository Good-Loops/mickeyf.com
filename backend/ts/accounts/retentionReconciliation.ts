import { createHmac } from 'node:crypto';
import { isAccountId } from './deletionJournal';
import { parseInactivityInstant } from './childInactivityPolicy';
import type { RetentionIntent, InactivityStore } from './childInactivityWorkflow';
import type { RetentionResolution } from './gcsRetentionJournal';
import type { ObservedRestoreGuard } from './gcsRetentionJournal';
import { isSessionId, type SessionProof } from '../security/sessionPolicy';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';

type Journal = Readonly<{
    verifyRetentionIntent(intent: RetentionIntent): Promise<boolean>;
    recordResolution(intent: RetentionIntent, resolution: RetentionResolution): Promise<void>;
    readResolution(intent: RetentionIntent): Promise<RetentionResolution | null>;
}>;

/** The exact live parent, current ownership and later SQL activity are rechecked while locked. */
export async function reconcileKeptRetentionIntent(store: InactivityStore, journal: Journal,
    intent: RetentionIntent, proof: SessionProof, receiptKey: Buffer): Promise<boolean> {
    if (!intent || !isAccountId(intent.parentId) || !isAccountId(intent.childId) || intent.parentId === intent.childId
        || !isAccountId(intent.warningId) || parseInactivityInstant(intent.activityAt) === null
        || !proof || proof.accountId !== intent.parentId || !isSessionId(proof.sessionId)
        || !Buffer.isBuffer(receiptKey) || receiptKey.length < 32) return false;
    return store.withLockedChild(intent.parentId, intent.childId, async target => {
        if (!await target.parentSessionValid(proof)) return false;
        const snapshot = await target.snapshot();
        const confirmedAt = await target.databaseTimestamp();
        if (!snapshot || snapshot.parentId !== intent.parentId || snapshot.childId !== intent.childId
            || !snapshot.activityAt || parseInactivityInstant(snapshot.activityAt) === null
            || parseInactivityInstant(confirmedAt) === null || snapshot.activityAt <= intent.activityAt
            || snapshot.activityAt > confirmedAt || !await journal.verifyRetentionIntent(intent)
            || !await target.parentSessionValid(proof)) return false;
        const existing = await journal.readResolution(intent);
        if (existing) return existing.outcome === 'kept' && !!existing.observedActivityAt
            && parseInactivityInstant(existing.observedActivityAt) !== null
            && existing.observedActivityAt > intent.activityAt && snapshot.activityAt >= existing.observedActivityAt
            && await target.parentSessionValid(proof);
        const proofDigest = createHmac('sha256', receiptKey).update('ludolume-retention-kept-v1\0')
            .update(intent.parentId).update('\0').update(intent.childId).update('\0')
            .update(intent.warningId).update('\0').update(proof.sessionId).digest('hex');
        await journal.recordResolution(intent, { outcome: 'kept', confirmedAt, observedActivityAt: snapshot.activityAt, proofDigest });
        return true;
    });
}

type AdminJournal = Journal & Readonly<{ readRestoreGuard(): Promise<ObservedRestoreGuard> }>;
type RestoreJournal = AdminJournal & Readonly<{ readResolution(intent: RetentionIntent): Promise<RetentionResolution | null> }>;
type AdminConnection = Pick<PoolConnection, 'query' | 'destroy'>;
type AdminPins = Readonly<{ database: string; serverUuid: string; currentUser: string; confirmation: string }>;

/** Requires direct PROCESS privilege so a restricted account cannot hide writer sessions. */
export async function assertNoRetentionRuntimeWriters(connection: AdminConnection): Promise<void> {
    const [privileges] = await connection.query<RowDataPacket[]>({ sql: `SELECT COUNT(*) AS count
        FROM information_schema.USER_PRIVILEGES WHERE PRIVILEGE_TYPE='PROCESS'
        AND GRANTEE=CONCAT("'",SUBSTRING_INDEX(CURRENT_USER(),'@',1),"'@'",SUBSTRING_INDEX(CURRENT_USER(),'@',-1),"'")`, timeout: 10_000 });
    if (!Array.isArray(privileges) || privileges.length !== 1 || ![0, '0', 1, '1'].includes(privileges[0].count)) {
        throw new Error('The administrator cannot verify writer sessions.');
    }
    if ([0, '0'].includes(privileges[0].count)) {
        // SHOW GRANTS without FOR includes effective enabled-role privileges;
        // USER_PRIVILEGES can hide the underlying role from a restricted user.
        const [rows] = await connection.query<RowDataPacket[]>({ sql: 'SHOW GRANTS', timeout: 10_000 });
        const hasProcess = Array.isArray(rows) && rows.length <= 100 && rows.some(row => {
            const values = Object.values(row);
            if (values.length !== 1 || typeof values[0] !== 'string') return false;
            const match = /^GRANT ([A-Z_, ]+) ON \*\.\* TO /u.exec(values[0]);
            return !!match && match[1].split(',').map(value => value.trim()).some(value => value === 'PROCESS' || value === 'ALL PRIVILEGES');
        });
        if (!hasProcess) throw new Error('The administrator cannot verify writer sessions.');
    }
    const [writers] = await connection.query<RowDataPacket[]>({ sql: `SELECT COUNT(*) AS count
        FROM information_schema.PROCESSLIST WHERE USER='cms_mickeyf' AND ID<>CONNECTION_ID()`, timeout: 10_000 });
    if (!Array.isArray(writers) || writers.length !== 1 || ![0, '0'].includes(writers[0].count)) {
        throw new Error('Runtime writers are not drained.');
    }
}

/**
 * Administrative use only, after stopping and draining all original writers.
 * A short global MySQL read lock fences database writes while the pinned
 * original primary proves absence. The caller must continue to fence all old
 * writers after the lock is released and until cutover.
 */
export async function reconcileDeletedRetentionIntent(connection: AdminConnection, journal: AdminJournal,
    intent: RetentionIntent, pins: AdminPins, auditKey: Buffer): Promise<boolean> {
    if (!intent || !isAccountId(intent.parentId) || !isAccountId(intent.childId) || !isAccountId(intent.warningId)
        || intent.parentId === intent.childId || !/^[A-Za-z0-9_]{1,64}$/u.test(pins.database)
        || !isAccountId(pins.serverUuid) || typeof pins.currentUser !== 'string' || !pins.currentUser
        || pins.confirmation !== 'ORIGINAL PRIMARY DRAINED AND ACCOUNT ABSENT'
        || !Buffer.isBuffer(auditKey) || auditKey.length < 32) return false;
    try {
        const before = await journal.readRestoreGuard();
        if (before.state !== 'hold' || before.database !== pins.database || before.serverUuid !== pins.serverUuid
            || !isAccountId(before.epoch) || !/^[1-9][0-9]*$/u.test(before.generation)) return false;
        async function identity() {
            const [rows] = await connection.query<RowDataPacket[]>({ sql: `SELECT DATABASE() AS db, CURRENT_USER() AS user,
                @@GLOBAL.server_uuid AS serverUuid, DATE_FORMAT(UTC_TIMESTAMP(6),'%Y-%m-%dT%H:%i:%s.%fZ') AS nowUtc`, timeout: 10_000 });
            if (!Array.isArray(rows) || rows.length !== 1 || rows[0].db !== pins.database
                || rows[0].user !== pins.currentUser || rows[0].serverUuid !== pins.serverUuid
                || parseInactivityInstant(rows[0].nowUtc) === null) throw new Error('Primary identity unavailable.');
            return rows[0];
        }
        await identity(); // Never acquire the global lock on an unverified target.
        await connection.query({ sql: 'FLUSH TABLES WITH READ LOCK', timeout: 10_000 });
        const current = await identity();
        await assertNoRetentionRuntimeWriters(connection);
        const [rows] = await connection.query<RowDataPacket[]>({ sql: `SELECT account_uuid FROM users
            WHERE account_uuid=? LIMIT 2`, timeout: 10_000 }, [intent.childId]);
        if (!Array.isArray(rows) || rows.length !== 0 || !await journal.verifyRetentionIntent(intent)) {
            await connection.query({ sql: 'UNLOCK TABLES', timeout: 10_000 }); return false;
        }
        const after = await journal.readRestoreGuard();
        if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Restore hold changed.');
        const confirmedAt = current.nowUtc as string;
        if (confirmedAt < intent.deliveredAt) throw new Error('Primary clock differs.');
        const proofDigest = createHmac('sha256', auditKey).update('ludolume-retention-deleted-admin-v1\0')
            .update(pins.serverUuid).update('\0').update(pins.database).update('\0').update(pins.currentUser).update('\0')
            .update(before.epoch).update('\0').update(before.generation).update('\0')
            .update(intent.childId).update('\0').update(intent.warningId).update('\0').update(confirmedAt).digest('hex');
        await journal.recordResolution(intent, { outcome: 'deleted', confirmedAt, observedActivityAt: null, proofDigest });
        await identity();
        await connection.query({ sql: 'UNLOCK TABLES', timeout: 10_000 });
        return true;
    } catch {
        // A timed-out FLUSH/UNLOCK may still own or later acquire a global lock.
        // Discard the physical connection rather than retrying an uncertain query.
        connection.destroy();
        throw new Error('Retention reconciliation unavailable or unconfirmed. Keep restoration on hold.');
    }
}

/**
 * Explicit replay on an isolated, pinned restore only. The guard must be on
 * hold and all old writers fenced; a resolution cannot independently fence
 * traffic. Newer activity or a changed identity requires manual review.
 */
export async function reconcileRestoredDeletedIntent(store: InactivityStore, journal: RestoreJournal,
    intent: RetentionIntent, pins: Readonly<{ database: string; serverUuid: string; originalServerUuid: string;
        currentUser: string; confirmation: string }>): Promise<boolean> {
    if (!intent || !isAccountId(intent.parentId) || !isAccountId(intent.childId) || intent.parentId === intent.childId
        || !isAccountId(intent.warningId) || !/^[A-Za-z0-9_]{1,64}$/u.test(pins.database)
        || !isAccountId(pins.serverUuid) || !isAccountId(pins.originalServerUuid) || pins.serverUuid === pins.originalServerUuid
        || typeof pins.currentUser !== 'string' || !pins.currentUser
        || pins.confirmation !== 'ISOLATED RESTORE FENCED AND DELETION VERIFIED') return false;
    try {
        const guard = await journal.readRestoreGuard();
        if (guard.state !== 'hold' || guard.serverUuid !== pins.originalServerUuid) return false;
        return await store.withLockedChild(intent.parentId, intent.childId, async target => {
            if (!target.matchesSqlIdentity || !await target.matchesSqlIdentity(pins.database, pins.serverUuid, pins.currentUser)) return false;
            const snapshot = await target.snapshot();
            if (!snapshot || snapshot.parentId !== intent.parentId || snapshot.childId !== intent.childId
                || !snapshot.activityAt || parseInactivityInstant(snapshot.activityAt) === null
                || parseInactivityInstant(intent.activityAt) === null || snapshot.activityAt > intent.activityAt
                || !await journal.verifyRetentionIntent(intent)) return false;
            const resolution = await journal.readResolution(intent);
            if (!resolution || resolution.outcome !== 'deleted' || resolution.observedActivityAt !== null
                || parseInactivityInstant(resolution.confirmedAt) === null || parseInactivityInstant(intent.deliveredAt) === null
                || resolution.confirmedAt < intent.deliveredAt) return false;
            if (JSON.stringify(await journal.readRestoreGuard()) !== JSON.stringify(guard)) return false;
            await target.deleteChild(intent.childId);
            return true;
        });
    } catch { throw new Error('Restored retention reconciliation unavailable or unconfirmed. Keep restoration on hold.'); }
}
