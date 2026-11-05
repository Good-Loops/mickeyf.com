import assert from 'node:assert/strict';
import test from 'node:test';
import type { PoolConnection } from 'mysql2/promise';
import type { DeletionJournalEntry } from './gcsDeletionJournal';
import type { RetentionIntent } from './childInactivityWorkflow';
import { readRetirementKnownAccounts } from './retirementKnownAccounts';

const live = '572ed45a-c57d-4c82-9b50-d4585331bcec', deleted = 'b5612c48-c0ba-4324-b055-e6c2f79af10d';
test('combines live child IDs with both authenticated journal sources', async () => {
    const connection = { async query(input: { sql: string }) {
        assert.match(input.sql, /parent_managed_child_activity/u); return [[{ accountId: live }], []];
    } } as unknown as PoolConnection;
    const explicit = { async readDeletionEntries() { return { entries: [{ intent: { accountId: deleted } } as DeletionJournalEntry] }; } };
    const conditional = { async readIntents() { return [{ childId: live } as RetentionIntent]; } };
    assert.deepEqual(await readRetirementKnownAccounts({ connection, explicit, conditional }), [live, deleted].sort());
    await assert.rejects(readRetirementKnownAccounts({ connection, explicit, conditional: { async readIntents() {
        return [{ childId: 'invalid' } as RetentionIntent]; } } }));
});
