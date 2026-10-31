import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'mysql2/promise';
import { executeRetentionReconciliation, parseRetentionKeyBundle } from './runRetentionReconciliation';
import type { createGcsRetentionJournal } from './gcsRetentionJournal';

const serverUuid = '11111111-1111-4111-8111-111111111111';
const epoch = '22222222-2222-4222-8222-222222222222';
const pins = { database: 'synthetic', serverUuid, originalServerUuid: serverUuid, currentUser: 'admin@localhost' };

function fixture({ identity = serverUuid } = {}) {
    const guard = { state: 'active' as const, database: pins.database, serverUuid, epoch,
        expiresAt: '2026-12-01T00:00:00.000Z', generation: '123' };
    let writes = 0;
    const journal = { async readRestoreGuard() { return guard; }, async readIntents() { return []; },
        async readResolution() { return null; }, async writeRestoreGuard(value: { state: string }, generation: string) {
            assert.equal(value.state, 'hold'); assert.equal(generation, '123'); writes++; return '124';
        } } as unknown as ReturnType<typeof createGcsRetentionJournal>;
    const database = { async query() { return [[{ db: pins.database, user: pins.currentUser, serverUuid: identity }], []]; },
        async getConnection() { throw new Error('not needed'); } } as unknown as Pick<Pool, 'query' | 'getConnection'>;
    return { journal, database, get writes() { return writes; } };
}

test('inventory is read-only and a precise hold uses the observed generation', async () => {
    const f = fixture();
    assert.deepEqual(await executeRetentionReconciliation('inventory', {}, pins, f.journal, f.database, Buffer.alloc(32, 1)),
        { guard: await f.journal.readRestoreGuard(), records: [] });
    assert.equal(f.writes, 0);
    assert.deepEqual(await executeRetentionReconciliation('hold', { confirmation: 'HOLD RETENTION FOR RESTORE' },
        pins, f.journal, f.database, Buffer.alloc(32, 1)), { state: 'hold', generation: '124' });
    assert.equal(f.writes, 1);
});
test('wrong SQL identity, unexpected inputs and wrong original server never mutate the guard', async () => {
    const f = fixture();
    await assert.rejects(executeRetentionReconciliation('hold', { confirmation: 'yes' }, pins, f.journal, f.database, Buffer.alloc(32, 1)));
    await assert.rejects(executeRetentionReconciliation('hold', { confirmation: 'HOLD RETENTION FOR RESTORE', extra: true },
        pins, f.journal, f.database, Buffer.alloc(32, 1)));
    await assert.rejects(executeRetentionReconciliation('hold', { confirmation: 'HOLD RETENTION FOR RESTORE' },
        { ...pins, originalServerUuid: epoch }, f.journal, f.database, Buffer.alloc(32, 1)));
    const wrong = fixture({ identity: epoch });
    await assert.rejects(executeRetentionReconciliation('hold', { confirmation: 'HOLD RETENTION FOR RESTORE' },
        pins, wrong.journal, wrong.database, Buffer.alloc(32, 1)));
    assert.equal(f.writes, 0); assert.equal(wrong.writes, 0);
});
test('first guard can only be initialized on the pinned original with an empty journal and create-only generation', async () => {
    let writes = 0, existing = false;
    const journal = { async readIntents() { return existing ? [{}] : []; }, async writeRestoreGuard(value: { state: string; database: string },
        generation: string) { assert.equal(value.state, 'hold'); assert.equal(value.database, pins.database); assert.equal(generation, '0'); writes++; return '1'; },
    } as unknown as ReturnType<typeof createGcsRetentionJournal>;
    const database = { async query() { return [[{ db: pins.database, user: pins.currentUser, serverUuid,
        nowUtc: '2026-01-01T00:00:00.000000Z' }], []]; }, async getConnection() { throw new Error('not needed'); } } as unknown as Pick<Pool, 'query' | 'getConnection'>;
    assert.deepEqual(await executeRetentionReconciliation('initialize-hold', { confirmation: 'INITIALIZE RETENTION HOLD' },
        pins, journal, database, Buffer.alloc(32, 1)), { state: 'hold', generation: '1' });
    existing = true;
    await assert.rejects(executeRetentionReconciliation('initialize-hold', { confirmation: 'INITIALIZE RETENTION HOLD' },
        pins, journal, database, Buffer.alloc(32, 1)));
    assert.equal(writes, 1);
});
test('operator reads the same three independent key values as the runtime', () => {
    const keys = parseRetentionKeyBundle(`${'11'.repeat(32)}:${'22'.repeat(32)}:${'33'.repeat(32)}`);
    assert.deepEqual(keys.journalKey, Buffer.alloc(32, 0x11)); assert.deepEqual(keys.auditKey, Buffer.alloc(32, 0x33));
    for (const bad of ['', 'not-a-key', `${'11'.repeat(32)}:${'22'.repeat(32)}:${'11'.repeat(32)}`]) {
        assert.throws(() => parseRetentionKeyBundle(bad));
    }
});
