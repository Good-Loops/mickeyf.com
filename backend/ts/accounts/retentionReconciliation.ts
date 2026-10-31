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
type AdminConnection = Pick<PoolConnection, 'query'>;
type AdminPins = Readonly<{ database: string; serverUuid: string; currentUser: string; confirmation: string }>;

/**
 * Administrative use only, after stopping and draining all original writers.
 * An authenticated hold must remain stable while the pinned original primary
 * proves the account is absent. This records evidence, not permission to
 * delete a restored account. The caller must separately fence the old writers.
 */
export async function reconcileDeletedRetentionIntent(connection: AdminConnection, journal: AdminJournal,
    intent: RetentionIntent, pins: AdminPins, auditKey: Buffer): Promise<boolean> {
    if (!intent || !isAccountId(intent.parentId) || !isAccountId(intent.childId) || !isAccountId(intent.warningId)
        || intent.parentId === intent.childId || !/^[A-Za-z0-9_]{1,64}$/u.test(pins.database)
        || !isAccountId(pins.serverUuid) || typeof pins.currentUser !== 'string' || !pins.currentUser
        || pins.confirmation !== 'ORIGINAL PRIMARY DRAINED AND ACCOUNT ABSENT'
        || !Buffer.isBuffer(auditKey) || auditKey.length < 32) return false;
    let transaction = false;
    try {
        const before = await journal.readRestoreGuard();
        if (before.state !== 'hold' || before.database !== pins.database || before.serverUuid !== pins.serverUuid
            || !isAccountId(before.epoch) || !/^[1-9][0-9]*$/u.test(before.generation)) return false;
        await connection.query({ sql: 'START TRANSACTION', timeout: 10_000 }); transaction = true;
        const [identity] = await connection.query<RowDataPacket[]>({ sql: `SELECT DATABASE() AS db, CURRENT_USER() AS user,
            @@GLOBAL.server_uuid AS serverUuid, DATE_FORMAT(UTC_TIMESTAMP(6),'%Y-%m-%dT%H:%i:%s.%fZ') AS nowUtc`, timeout: 10_000 });
        if (!Array.isArray(identity) || identity.length !== 1 || identity[0].db !== pins.database
            || identity[0].user !== pins.currentUser || identity[0].serverUuid !== pins.serverUuid
            || parseInactivityInstant(identity[0].nowUtc) === null) throw new Error('Primary identity unavailable.');
        const [rows] = await connection.query<RowDataPacket[]>({ sql: `SELECT account_uuid FROM users
            WHERE account_uuid=? LIMIT 2 FOR UPDATE`, timeout: 10_000 }, [intent.childId]);
        if (!Array.isArray(rows) || rows.length !== 0 || !await journal.verifyRetentionIntent(intent)) {
            await connection.query({ sql: 'ROLLBACK', timeout: 10_000 }); transaction = false; return false;
        }
        const after = await journal.readRestoreGuard();
        if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Restore hold changed.');
        const confirmedAt = identity[0].nowUtc as string;
        if (confirmedAt < intent.deliveredAt) throw new Error('Primary clock differs.');
        const proofDigest = createHmac('sha256', auditKey).update('ludolume-retention-deleted-admin-v1\0')
            .update(pins.serverUuid).update('\0').update(pins.database).update('\0').update(pins.currentUser).update('\0')
            .update(before.epoch).update('\0').update(before.generation).update('\0')
            .update(intent.childId).update('\0').update(intent.warningId).update('\0').update(confirmedAt).digest('hex');
        await journal.recordResolution(intent, { outcome: 'deleted', confirmedAt, observedActivityAt: null, proofDigest });
        await connection.query({ sql: 'COMMIT', timeout: 10_000 }); transaction = false;
        return true;
    } catch {
        if (transaction) { try { await connection.query({ sql: 'ROLLBACK', timeout: 10_000 }); } catch { /* caller must discard uncertain connections */ } }
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
