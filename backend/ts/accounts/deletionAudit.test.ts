import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool, PoolConnection } from 'mysql2/promise';
import type { DeletionAuditSettings } from '../config/deletionAuditConfig';
import { auditPendingDeletions, DeletionAuditError } from './deletionAudit';
import type { DeletionIntent, DeletionJournalReader } from './deletionJournal';

const FIRST_ID = '123e4567-e89b-42d3-a456-426614174000';
const SECOND_ID = '123e4567-e89b-42d3-a456-426614174001';
const NOW = Date.parse('2026-09-14T15:00:00.000Z');
const SETTINGS: DeletionAuditSettings = {
    database: 'cms', expectedCurrentUser: 'deletion_audit@cloudsqlproxy~%',
    expectedServerUuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    expectedIdentityEpoch: '2026-09-12 00:15:39.954172',
    graceMs: 900_000, maxIntents: 1000, maxDurationMs: 60_000,
};
const intent = (accountId = FIRST_ID, ageMs = 1_800_000): DeletionIntent => ({
    version: 1, action: 'delete-account', accountId, requestedAt: new Date(NOW - ageMs).toISOString(),
});

function fixture(options: {
    intents?: unknown[]; accounts?: string[]; wrongPin?: 'databaseName' | 'currentUser' | 'serverUuid' | 'epoch';
    journalError?: boolean;
} = {}) {
    const queries: Array<{ sql: string; timeout: number; values?: unknown[] }> = [];
    let released = false;
    let destroyed = false;
    const connection = {
        async query(input: { sql: string; timeout: number }, values?: unknown[]) {
            queries.push({ ...input, values });
            const sql = input.sql;
            if (sql.startsWith('SET SESSION')) return [[], []];
            if (sql.startsWith('SELECT DATABASE()')) return [[{
                databaseName: SETTINGS.database, currentUser: SETTINGS.expectedCurrentUser,
                serverUuid: SETTINGS.expectedServerUuid, nowMs: String(NOW),
                ...(options.wrongPin ? { [options.wrongPin]: 'wrong' } : {}),
            }], []];
            if (sql.includes('DATE_FORMAT(applied_at')) return [[{
                epoch: options.wrongPin === 'epoch' ? 'wrong' : SETTINGS.expectedIdentityEpoch,
            }], []];
            if (sql.startsWith('SELECT account_uuid')) return [(options.accounts ?? [FIRST_ID])
                .filter(accountId => values?.includes(accountId)).map(accountId => ({ accountId })), []];
            throw new Error('Unexpected audit query');
        },
        release() { released = true; }, destroy() { destroyed = true; },
    } as unknown as PoolConnection;
    const database = { async getConnection() { return connection; } } as Pick<Pool, 'getConnection'>;
    const reader = {
        async readDeletionIntents() {
            if (options.journalError) throw new Error(`private SDK payload ${FIRST_ID}`);
            return { intents: options.intents ?? [intent()], digest: 'a'.repeat(64) };
        },
    } as DeletionJournalReader;
    return { database, reader, queries, released: () => released, destroyed: () => destroyed };
}

test('detects a durable old intent whose account remains even without a controller error log', async () => {
    const fake = fixture({ intents: [intent(), intent(FIRST_ID, 60_000)] });
    const result = await auditPendingDeletions(fake.database, fake.reader, SETTINGS);
    assert.deepEqual(result, { status: 'pending', intentCount: 2, accountCount: 1,
        checkedAccounts: 1, pendingAccounts: 1, oldestPendingSeconds: 1800 });
    assert.equal(JSON.stringify(result).includes(FIRST_ID), false);
    assert.ok(fake.queries.every(query => query.sql.trimStart().startsWith('SELECT') || query.sql.startsWith('SET SESSION time_zone')));
    assert.ok(fake.queries.every(query => query.timeout > 0 && query.timeout <= 10_000));
    assert.ok(fake.released());
});

test('old already-deleted accounts do not become a historical false backlog', async () => {
    const fake = fixture({ accounts: [] });
    const result = await auditPendingDeletions(fake.database, fake.reader, SETTINGS);
    assert.equal(result.status, 'clear');
    assert.equal(result.checkedAccounts, 1);
    assert.equal(result.pendingAccounts, 0);
    assert.equal(result.oldestPendingSeconds, 0);
});

test('recent in-flight intents are skipped; exact grace boundary is eligible', async () => {
    const fake = fixture({ intents: [intent(FIRST_ID, 899_999), intent(SECOND_ID, 900_000)], accounts: [FIRST_ID, SECOND_ID] });
    const result = await auditPendingDeletions(fake.database, fake.reader, SETTINGS);
    assert.equal(result.checkedAccounts, 1);
    assert.equal(result.pendingAccounts, 1);
    assert.equal(result.oldestPendingSeconds, 900);
    assert.deepEqual(fake.queries.find(query => query.sql.startsWith('SELECT account_uuid'))?.values, [SECOND_ID]);
});

test('malformed or unavailable journals fail closed before querying account data', async () => {
    for (const options of [{ journalError: true }, { intents: [intent(), { ...intent(), extra: 'private' }] }]) {
        const fake = fixture(options);
        await assert.rejects(auditPendingDeletions(fake.database, fake.reader, SETTINGS), error => {
            assert.ok(error instanceof DeletionAuditError);
            assert.equal(error.message.includes(FIRST_ID), false);
            return true;
        });
        assert.equal(fake.queries.some(query => query.sql.startsWith('SELECT account_uuid')), false);
        assert.ok(fake.destroyed());
    }
});

test('database, current account, server UUID and original identity epoch pins are exact', async () => {
    for (const wrongPin of ['databaseName', 'currentUser', 'serverUuid', 'epoch'] as const) {
        const fake = fixture({ wrongPin });
        await assert.rejects(auditPendingDeletions(fake.database, fake.reader, SETTINGS), DeletionAuditError);
        assert.equal(fake.queries.some(query => query.sql.startsWith('SELECT account_uuid')), false);
    }
});

test('journal limits and an unresolved connection acquisition respect the operation deadline', async () => {
    const fake = fixture({ intents: [intent(), intent(SECOND_ID)] });
    await assert.rejects(auditPendingDeletions(fake.database, fake.reader, { ...SETTINGS, maxIntents: 1 }), DeletionAuditError);
    const database = { getConnection: () => new Promise<PoolConnection>(() => {}) } as Pick<Pool, 'getConnection'>;
    await assert.rejects(auditPendingDeletions(database, fake.reader, { ...SETTINGS, maxDurationMs: 5 }), DeletionAuditError);
});
