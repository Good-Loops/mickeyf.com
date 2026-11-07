import assert from 'node:assert/strict';
import test from 'node:test';
import type { PoolConnection } from 'mysql2/promise';
import { previewRetirementCandidates } from './previewRetirementCandidates';
import type { DeletionJournalEntry } from './gcsDeletionJournal';

const live = '572ed45a-c57d-4c82-9b50-d4585331bcec', deleted = 'b5612c48-c0ba-4324-b055-e6c2f79af10d';
const pins = { database: 'synthetic', currentUser: 'operator@localhost', serverUuid: live };
const entry = (accountId: string, generation: string): DeletionJournalEntry => ({ name: `synthetic-${generation}`, generation,
    contentSha256: 'a'.repeat(64), intent: { version: 1, action: 'delete-account', accountId, requestedAt: '2026-01-01T00:00:00.000Z' } });
function fixture(changed = false) {
    let reads = 0, destroyed = false;
    const connection = { async beginTransaction() {}, async rollback() {}, destroy() { destroyed = true; },
        async query(input: { sql: string }, values?: unknown[]) {
            const sql = input.sql;
            if (sql.includes('USER_PRIVILEGES')) return [[{ count: 1 }], []];
            if (sql.includes('CURRENT_USER()')) return [[{ db: pins.database, user: pins.currentUser, uuid: pins.serverUuid }], []];
            if (sql.includes('PROCESSLIST') || sql.includes('information_schema.TABLES')) return [[{ count: 0 }], []];
            if (sql.includes('FROM users') && Array.isArray(values?.[0]) && values[0].includes(live)) return [[{}], []];
            return [[], []];
        } } as unknown as PoolConnection;
    const journal = { async readDeletionEntries() { return { entries: [entry(live, '1'), entry(deleted, '2')],
        digest: (changed && ++reads > 1 ? 'b' : 'a').repeat(64) }; } };
    const guard = { async readRestoreGuard() { return { state: 'hold' as const, database: pins.database, serverUuid: pins.serverUuid,
        epoch: live, expiresAt: '2027-01-01T00:00:00.000Z', generation: '1' }; } };
    return { options: { connection, pins, journal, guard, async verifySchema() {}, confirmation: 'ORIGINAL PRIMARY AND ALL WRITERS FENCED' },
        get destroyed() { return destroyed; } };
}
test('preview holds an active account and selects a deleted account without persisting a receipt', async () => {
    const f = fixture();
    assert.deepEqual(await previewRetirementCandidates(f.options), { candidates: [{ name: 'synthetic-2', generation: '2',
        contentSha256: 'a'.repeat(64) }], held: 1, total: 2, nextOffset: null });
});
test('preview rejects a changed journal inventory', async () => {
    await assert.rejects(previewRetirementCandidates(fixture(true).options));
});
