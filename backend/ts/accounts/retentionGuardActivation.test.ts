import assert from 'node:assert/strict';
import test from 'node:test';
import type { PoolConnection } from 'mysql2/promise';
import { activateRetentionGuard } from './retentionGuardActivation';
import type { createGcsRetentionJournal, RetentionResolution } from './gcsRetentionJournal';
import type { RetentionIntent } from './childInactivityWorkflow';
import type { DeletionIntent, DeletionJournalReader } from './deletionJournal';

const original = '11111111-1111-4111-8111-111111111111';
const target = '22222222-2222-4222-8222-222222222222';
const child = '33333333-3333-4333-8333-333333333333';
const warning = '44444444-4444-4444-8444-444444444444';
const pins = { database: 'synthetic', serverUuid: target, originalServerUuid: original, currentUser: 'admin@localhost',
    confirmation: 'ALL WRITERS FENCED AND INTENTS RECONCILED' };
const intent: RetentionIntent = { parentId: original, childId: child, warningId: warning,
    activityAt: '2020-01-01T00:00:00.000000Z', deliveredAt: '2023-01-01T00:00:00.000000Z',
    targetDigest: 'a'.repeat(64), noticeDigest: 'b'.repeat(64), receiptDigest: 'c'.repeat(64), channel: 'in-app' };
const deleted: RetentionResolution = { outcome: 'deleted', confirmedAt: '2024-01-01T00:00:00.000000Z',
    observedActivityAt: null, proofDigest: 'd'.repeat(64) };
const explicitIntent: DeletionIntent = { version: 1, accountId: child, action: 'delete-account', requestedAt: '2024-01-01T00:00:00.000Z' };
const emptyDeletionJournal: DeletionJournalReader = { async readDeletionIntents() { return { digest: 'a'.repeat(64), intents: [] }; } };

function fixture({ records = [], resolution = null, resolutions = {}, childPresent = false, writers = 0, secondRecords,
    recoveryCheckpoint, targetCheckpoint = '6', explicitRecords = [], changedExplicit = false, scoreVisibility = 'private', pendingScore = false, activeForm = false, usage = 'empty', receipts = 'clear' }:
    { records?: RetentionIntent[]; resolution?: RetentionResolution | null; resolutions?: Record<string, RetentionResolution>; childPresent?: boolean; writers?: number;
        secondRecords?: RetentionIntent[]; recoveryCheckpoint?: { lineage: string; minimumEpoch: string; keySha256: string };
        targetCheckpoint?: string | null; explicitRecords?: DeletionIntent[]; changedExplicit?: boolean; scoreVisibility?: string;
        pendingScore?: boolean; activeForm?: boolean; usage?: 'empty' | 'present' | 'absent' | 'denied'; receipts?: 'clear' | 'expired' | 'absent' | 'denied' } = {}) {
    const guard = { state: 'hold' as const, database: pins.database, serverUuid: original, epoch: warning,
        expiresAt: '2027-01-01T00:00:00.000Z', generation: '8',
        ...(recoveryCheckpoint === undefined ? {} : { recoveryCheckpoint }) };
    let locked = false, destroyed = false, writes = 0, lists = 0;
    const connection = { destroy() { destroyed = true; }, async query(query: { sql: string }) {
        if (query.sql.includes('USER_PRIVILEGES')) return [[{ count: 1 }], []];
        if (query.sql.includes('PROCESSLIST')) return [[{ count: writers }], []];
        if (query.sql.includes('FROM account_recovery_checkpoint')) return [targetCheckpoint === null ? [] : [{
            databaseName: pins.database, currentUser: pins.currentUser, serverUuid: target,
            lineageId: recoveryCheckpoint?.lineage, checkpointEpoch: targetCheckpoint }], []];
        if (query.sql.includes('CURRENT_USER')) return [[{ db: pins.database, user: pins.currentUser, serverUuid: target,
            readOnly: 0, superReadOnly: 0, nowUtc: '2026-01-01T00:00:00.000000Z' }], []];
        if (query.sql === 'FLUSH TABLES WITH READ LOCK') { locked = true; return [[], []]; }
        if (query.sql === 'UNLOCK TABLES') { locked = false; return [[], []]; }
        if (query.sql.includes('FROM account_score_permissions')) return [[{ visibility: scoreVisibility }], []];
        if (query.sql.includes('FROM parent_registration_attempts')) return [pendingScore ? [{ child_uuid: child }] : [], []];
        if (query.sql.includes('FROM parent_child_daily_usage')) {
            if (usage === 'absent') throw Object.assign(new Error('missing'), { code: 'ER_NO_SUCH_TABLE' });
            if (usage === 'denied') throw Object.assign(new Error('denied'), { code: 'ER_TABLEACCESS_DENIED_ERROR' });
            return [usage === 'present' ? [{ child_uuid: child }] : [], []];
        }
        if (query.sql.includes('FROM child_daily_usage_withdrawal_receipts')) {
            if (receipts === 'absent') throw Object.assign(new Error('missing'), { code: 'ER_NO_SUCH_TABLE' });
            if (receipts === 'denied') throw Object.assign(new Error('denied'), { code: 'ER_TABLEACCESS_DENIED_ERROR' });
            return [receipts === 'expired' ? [{ receipt_uuid: child }] : [], []];
        }
        if (query.sql.includes('information_schema.TABLES')) return [[{ count: 1 }], []];
        if (query.sql.includes('FROM parent_signed_forms')) return [activeForm ? [{ child_uuid: child }] : [], []];
        if (query.sql.includes('FROM users')) return [childPresent ? [{ childId: child, parentId: original,
            activityAt: '2025-01-01T00:00:00.000000Z' }] : [], []];
        throw new Error('unexpected SQL');
    } } as unknown as PoolConnection;
    const journal = { async readRestoreGuard() { return guard; }, async readIntents() { return ++lists === 1 ? records : (secondRecords ?? records); },
        async readResolution(item: RetentionIntent) { return resolutions[item.warningId] ?? resolution; }, async writeRestoreGuard(value: { state: string; serverUuid: string }, generation: string) {
            assert.equal(locked, true); assert.equal(value.state, 'active'); assert.equal(value.serverUuid, target);
            assert.deepEqual((value as { recoveryCheckpoint?: unknown }).recoveryCheckpoint, recoveryCheckpoint);
            assert.equal(generation, '8'); writes++; return '9';
        } } as unknown as Pick<ReturnType<typeof createGcsRetentionJournal>, 'readRestoreGuard' | 'readIntents' | 'readResolution' | 'writeRestoreGuard'>;
    let explicitReads = 0;
    const deletionJournal: DeletionJournalReader = { async readDeletionIntents() { return { digest: 'a'.repeat(64),
        intents: ++explicitReads > 1 && changedExplicit ? [] : explicitRecords }; } };
    return { connection, journal, deletionJournal, get writes() { return writes; }, get locked() { return locked; }, get destroyed() { return destroyed; } };
}

test('activation audits all resolved outcomes under a pinned SQL lock and updates guard by generation', async () => {
    const f = fixture({ records: [intent], resolution: deleted });
    assert.equal(await activateRetentionGuard(f.connection, f.journal, pins, f.deletionJournal), '9');
    assert.equal(f.writes, 1); assert.equal(f.locked, false);
});
test('restored limits must be reset before activation; missing schema is allowed but inaccessible schema is not', async () => {
    for (const usage of ['present', 'denied'] as const) {
        const f = fixture({ usage });
        await assert.rejects(activateRetentionGuard(f.connection, f.journal, pins, f.deletionJournal));
        assert.equal(f.writes, 0);
    }
    for (const usage of ['empty', 'absent'] as const) {
        const f = fixture({ usage });
        assert.equal(await activateRetentionGuard(f.connection, f.journal, pins, f.deletionJournal), '9');
    }
});
test('activation refuses expired or inaccessible restored consent receipts', async () => {
    for (const receipts of ['expired', 'denied'] as const) {
        const f = fixture({ receipts });
        await assert.rejects(activateRetentionGuard(f.connection, f.journal, pins, f.deletionJournal));
        assert.equal(f.writes, 0);
    }
    for (const receipts of ['clear', 'absent'] as const) {
        const f = fixture({ receipts });
        assert.equal(await activateRetentionGuard(f.connection, f.journal, pins, f.deletionJournal), '9');
    }
});
test('activation rejects an old or missing SQL checkpoint and preserves the authenticated floor', async () => {
    const recoveryCheckpoint = { lineage: child, minimumEpoch: '6', keySha256: 'a'.repeat(64) };
    const good = fixture({ recoveryCheckpoint });
    assert.equal(await activateRetentionGuard(good.connection, good.journal, pins, good.deletionJournal), '9');
    for (const targetCheckpoint of ['5', null]) {
        const f = fixture({ recoveryCheckpoint, targetCheckpoint });
        await assert.rejects(activateRetentionGuard(f.connection, f.journal, pins, f.deletionJournal), /Keep all writers and traffic stopped/);
        assert.equal(f.writes, 0);
    }
});
test('activation accepts a kept outcome only when the restored relationship preserves later recorded activity', async () => {
    const resolution: RetentionResolution = { outcome: 'kept', confirmedAt: '2025-01-03T00:00:00.000000Z',
        observedActivityAt: '2025-01-02T00:00:00.000000Z', proofDigest: 'd'.repeat(64) };
    const f = fixture({ records: [intent], resolution, childPresent: true });
    await assert.rejects(activateRetentionGuard(f.connection, f.journal, pins, f.deletionJournal), /Keep all writers and traffic stopped/);
    const later: RetentionResolution = { ...resolution, observedActivityAt: '2024-01-01T00:00:00.000000Z' };
    const good = fixture({ records: [intent], resolution: later, childPresent: true });
    assert.equal(await activateRetentionGuard(good.connection, good.journal, pins, good.deletionJournal), '9');
});
test('activation accepts an absent kept child only with a later recorded deletion', async () => {
    const kept: RetentionResolution = { outcome: 'kept', confirmedAt: '2025-01-03T00:00:00.000000Z',
        observedActivityAt: '2025-01-02T00:00:00.000000Z', proofDigest: 'd'.repeat(64) };
    const laterExplicit = { ...explicitIntent, requestedAt: '2025-01-04T00:00:00.000Z' };
    const good = fixture({ records: [intent], resolution: kept, explicitRecords: [laterExplicit] });
    assert.equal(await activateRetentionGuard(good.connection, good.journal, pins, good.deletionJournal), '9');
    for (const explicitRecords of [[], [explicitIntent]]) {
        const held = fixture({ records: [intent], resolution: kept, explicitRecords });
        await assert.rejects(activateRetentionGuard(held.connection, held.journal, pins, held.deletionJournal));
        assert.equal(held.writes, 0);
    }
    const otherWarning = '55555555-5555-4555-8555-555555555555';
    const laterIntent = { ...intent, warningId: otherWarning, activityAt: kept.observedActivityAt!, deliveredAt: '2025-01-05T00:00:00.000000Z' };
    const laterDeleted: RetentionResolution = { ...deleted, confirmedAt: '2026-01-10T00:00:00.000000Z' };
    const subsequent = fixture({ records: [intent, laterIntent], resolutions: { [warning]: kept, [otherWarning]: laterDeleted } });
    assert.equal(await activateRetentionGuard(subsequent.connection, subsequent.journal, pins, subsequent.deletionJournal), '9');
    const earlier = fixture({ records: [intent, laterIntent], resolutions: { [warning]: kept, [otherWarning]: deleted } });
    await assert.rejects(activateRetentionGuard(earlier.connection, earlier.journal, pins, earlier.deletionJournal));
    const staleIntent = { ...laterIntent, activityAt: intent.activityAt };
    const stale = fixture({ records: [intent, staleIntent], resolutions: { [warning]: kept, [otherWarning]: laterDeleted } });
    await assert.rejects(activateRetentionGuard(stale.connection, stale.journal, pins, stale.deletionJournal));
});
test('activation holds on unresolved outcomes, restored deleted accounts, writers or changing inventories', async () => {
    for (const options of [
        { records: [intent], resolution: null }, { records: [intent], resolution: deleted, childPresent: true },
        { writers: 1 }, { records: [intent], resolution: deleted, secondRecords: [] },
    ]) {
        const f = fixture(options);
        await assert.rejects(activateRetentionGuard(f.connection, f.journal, pins, f.deletionJournal), /Keep all writers and traffic stopped/);
        assert.equal(f.writes, 0); assert.equal(f.destroyed, true);
    }
});

test('activation requires explicit deletions and score withdrawals to be reconciled and inventory to remain stable', async () => {
    const withdrawal: DeletionIntent = { ...explicitIntent, action: 'withdraw-public-scores' };
    for (const options of [
        { explicitRecords: [explicitIntent], childPresent: true },
        { explicitRecords: [explicitIntent], changedExplicit: true },
        { explicitRecords: [withdrawal], childPresent: true, scoreVisibility: 'public' },
        { explicitRecords: [withdrawal], childPresent: true, pendingScore: true },
        { explicitRecords: [withdrawal], childPresent: true, activeForm: true },
    ]) {
        const f = fixture(options);
        await assert.rejects(activateRetentionGuard(f.connection, f.journal, pins, f.deletionJournal), /Keep all writers and traffic stopped/);
        assert.equal(f.writes, 0);
    }
    for (const options of [{ explicitRecords: [explicitIntent] }, { explicitRecords: [withdrawal], childPresent: true }]) {
        const f = fixture(options);
        assert.equal(await activateRetentionGuard(f.connection, f.journal, pins, f.deletionJournal), '9');
    }
});

test('an unlock failure after activation attempts to restore hold using the new generation', async () => {
    let current = { state: 'hold' as 'active' | 'hold', database: pins.database, serverUuid: original,
        epoch: warning, expiresAt: '2027-01-01T00:00:00.000Z', generation: '8' };
    let destroyed = false;
    const connection = { destroy() { destroyed = true; }, async query(query: { sql: string }) {
        if (query.sql.includes('USER_PRIVILEGES')) return [[{ count: 1 }], []];
        if (query.sql.includes('PROCESSLIST')) return [[{ count: 0 }], []];
        if (query.sql.includes('CURRENT_USER')) return [[{ db: pins.database, user: pins.currentUser, serverUuid: target,
            readOnly: 0, superReadOnly: 0, nowUtc: '2026-01-01T00:00:00.000000Z' }], []];
        if (query.sql === 'UNLOCK TABLES') throw new Error('synthetic lost unlock');
        return [[], []];
    } } as unknown as PoolConnection;
    const journal = { async readRestoreGuard() { return { ...current }; }, async readIntents() { return []; },
        async readResolution() { return null; }, async writeRestoreGuard(value: typeof current, generation: string) {
            assert.equal(generation, current.generation);
            current = { ...value, generation: String(Number(generation) + 1) }; return current.generation;
        } } as unknown as Pick<ReturnType<typeof createGcsRetentionJournal>, 'readRestoreGuard' | 'readIntents' | 'readResolution' | 'writeRestoreGuard'>;
    await assert.rejects(activateRetentionGuard(connection, journal, pins, emptyDeletionJournal), /Keep all writers and traffic stopped/);
    assert.equal(destroyed, true); assert.equal(current.state, 'hold'); assert.equal(current.generation, '10');
});
