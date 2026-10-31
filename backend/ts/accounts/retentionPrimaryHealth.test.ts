import assert from 'node:assert/strict';
import test from 'node:test';
import type { PoolConnection } from 'mysql2/promise';
import { createPinnedPrimaryHealth } from './retentionPrimaryHealth';
import type { ObservedRestoreGuard } from './gcsRetentionJournal';
import type { RetentionIntent } from './childInactivityWorkflow';

const parent = '42a23d28-40cf-4d69-9fdb-74206ef3fa70';
const child = '42a23d28-40cf-4d69-9fdb-74206ef3fa71';
const epoch = '42a23d28-40cf-4d69-9fdb-74206ef3fa72';
const database = 'synthetic';
const now = '2026-01-01T00:00:00.000000Z';
const base: ObservedRestoreGuard = { state: 'active', database, serverUuid: parent, epoch,
    expiresAt: '2026-01-10T00:00:00.000Z', generation: '12' };

function fixture({ guard = base, secondGuard, server = parent, name = database, readOnly = 0,
    intentChild = '', throwGuard = false, sqlNow = now }: { guard?: ObservedRestoreGuard; secondGuard?: ObservedRestoreGuard;
        server?: string; name?: string; readOnly?: number; intentChild?: string; throwGuard?: boolean; sqlNow?: string } = {}) {
    let calls = 0;
    const journal = {
        async readRestoreGuard() { if (throwGuard) throw new Error('private bucket detail'); return ++calls === 1 ? guard : (secondGuard ?? guard); },
        async readIntentsForChild(id: string) { return intentChild === id ? [{ childId: intentChild } as RetentionIntent] : []; },
    };
    const connection = { async query() { return [[{ databaseName: name, serverUuid: server, readOnly,
        superReadOnly: 0, nowUtc: sqlNow }], []]; } } as unknown as PoolConnection;
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
