import assert from 'node:assert/strict';
import test from 'node:test';
import type { PoolConnection } from 'mysql2/promise';
import { createPinnedPrimaryHealth } from './retentionPrimaryHealth';
import type { ObservedRestoreGuard, RetentionResolution } from './gcsRetentionJournal';
import type { RetentionIntent } from './childInactivityWorkflow';

const parent = '42a23d28-40cf-4d69-9fdb-74206ef3fa70';
const child = '42a23d28-40cf-4d69-9fdb-74206ef3fa71';
const epoch = '42a23d28-40cf-4d69-9fdb-74206ef3fa72';
const database = 'synthetic';
const now = '2026-01-01T00:00:00.000000Z';
const base: ObservedRestoreGuard = { state: 'active', database, serverUuid: parent, epoch,
    expiresAt: '2026-01-10T00:00:00.000Z', generation: '12' };

function fixture({ guard = base, secondGuard, server = parent, name = database, readOnly = 0,
    intentChild = '', resolution = null, activityAt = '2025-01-01T00:00:00.000000Z', throwGuard = false, sqlNow = now }:
    { guard?: ObservedRestoreGuard; secondGuard?: ObservedRestoreGuard; server?: string; name?: string; readOnly?: number;
        intentChild?: string; resolution?: RetentionResolution | null; activityAt?: string; throwGuard?: boolean; sqlNow?: string } = {}) {
    let calls = 0;
    const journal = {
        async readRestoreGuard() { if (throwGuard) throw new Error('private bucket detail'); return ++calls === 1 ? guard : (secondGuard ?? guard); },
        async readIntentsForChild(id: string) { return intentChild === id ? [{ parentId: parent, childId: intentChild,
            activityAt: '2024-01-01T00:00:00.000000Z' } as RetentionIntent] : []; },
        async readResolution() { return resolution; },
    };
    const connection = { async query(query: { sql: string }) { return [query.sql.includes('parent_managed_child_activity')
        ? [{ activityAt }] : [{ databaseName: name, serverUuid: server, readOnly, superReadOnly: 0, nowUtc: sqlNow }], []]; } } as unknown as PoolConnection;
    return { check: createPinnedPrimaryHealth({ database, serverUuid: parent, journal }), connection };
}

test('allows a pinned writable primary only with a stable current active guard and no child intent', async () => {
    const { check, connection } = fixture();
    assert.equal(await check(connection, parent, child), true);
});

test('holds on a restore hold, stale or changed guard, wrong primary or unresolved child intent', async () => {
    for (const options of [
        { guard: { ...base, state: 'hold' as const } }, { guard: { ...base, expiresAt: '2025-12-31T00:00:00.000Z' } },
        { guard: { ...base, expiresAt: '2027-01-01T00:00:00.000Z' } }, { guard: { ...base, generation: '0' } },
        { secondGuard: { ...base, generation: '13' } }, { server: child }, { name: 'other' }, { readOnly: 1 },
        { readOnly: null as unknown as number }, { intentChild: child }, { throwGuard: true }, { sqlNow: 'bad' },
    ]) {
        const { check, connection } = fixture(options);
        assert.equal(await check(connection, parent, child), false, JSON.stringify(options));
    }
});

test('an unrelated child intent does not prevent this child being assessed', async () => {
    const { check, connection } = fixture({ intentChild: epoch });
    assert.equal(await check(connection, parent, child), true);
    assert.equal(await check(connection, parent, parent), false);
});

test('only a kept resolution supported by later current SQL activity can clear an earlier intent', async () => {
    const kept: RetentionResolution = { outcome: 'kept', confirmedAt: '2025-01-02T00:00:00.000000Z',
        observedActivityAt: '2025-01-01T00:00:00.000000Z', proofDigest: 'a'.repeat(64) };
    for (const [resolution, activityAt, expected] of [
        [kept, '2025-01-01T00:00:00.000000Z', true],
        [kept, '2024-01-01T00:00:00.000000Z', false],
        [{ ...kept, observedActivityAt: '2023-01-01T00:00:00.000000Z' }, '2025-01-01T00:00:00.000000Z', false],
        [{ ...kept, outcome: 'deleted', observedActivityAt: null }, '2025-01-01T00:00:00.000000Z', false],
    ] as const) {
        const { check, connection } = fixture({ intentChild: child, resolution, activityAt });
        assert.equal(await check(connection, parent, child), expected);
    }
});
