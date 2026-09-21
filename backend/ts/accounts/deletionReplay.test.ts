import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool, PoolConnection } from 'mysql2/promise';
import type { DeletionReplaySettings } from '../config/deletionReplayConfig';
import type { DeletionIntent, DeletionJournalReader, DeletionJournalSnapshot } from './deletionJournal';
import { applyDeletionReplay, planDeletionReplay } from './deletionReplay';

const FIRST_ID = '123e4567-e89b-42d3-a456-426614174000';
const SECOND_ID = '123e4567-e89b-42d3-a456-426614174001';
const SETTINGS: DeletionReplaySettings = {
    mode: 'recovery', database: 'isolated_recovery', expectedCurrentUser: 'recovery_operator@%',
    expectedServerUuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    sourceServerUuid: 'aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff',
    expectedIdentityEpoch: '2026-09-11 12:13:14.123456', maxIntents: 100, maxDurationMs: 60000,
};
const INTENT: DeletionIntent = { version: 1, action: 'delete-account', accountId: FIRST_ID, requestedAt: '2026-09-11T12:15:00.000Z' };

type FakeOptions = {
    initialIntents?: readonly DeletionIntent[];
    onJournalRead?: (count: number) => DeletionJournalSnapshot | undefined;
    wrongEpoch?: boolean;
    missingIdentity?: boolean;
    unsafeSchema?: boolean;
    providerTable?: 'absent' | 'malformed';
    providerMigrationRecorded?: boolean;
    attemptTable?: 'absent' | 'malformed';
    attemptMigrationRecorded?: boolean;
    sessionTable?: 'absent' | 'malformed';
    sessionMigrationRecorded?: boolean;
    appleMigrationRecorded?: boolean;
    appleRevocationMigrationRecorded?: boolean;
    wrongTarget?: boolean;
    changeIdentityUnderLock?: boolean;
    failAt?: string;
    rollbackFails?: boolean;
};

function fakeReplay(options: FakeOptions = {}) {
    const accounts = new Map([[42, FIRST_ID], [99, SECOND_ID]]);
    const events: string[] = [];
    const queries: Array<{ sql: string; values?: unknown[]; timeout: number }> = [];
    let pendingDelete: number | undefined;
    let journalReads = 0;
    const failure = new Error('synthetic replay failure');
    const connection = {
        async query(input: { sql: string; timeout: number }, values?: unknown[]) {
            const sql = input.sql.replace(/\s+/gu, ' ').trim();
            queries.push({ ...input, sql, values });
            events.push(sql);
            if (options.failAt === sql) throw failure;
            if (sql === 'ROLLBACK' && options.rollbackFails) throw new Error('synthetic rollback failure');
            if (sql.startsWith('SET SESSION')) return [[], []];
            if (sql.startsWith('SELECT DATABASE()')) return [[{
                databaseName: SETTINGS.database, currentUser: SETTINGS.expectedCurrentUser,
                serverUuid: options.wrongTarget ? 'wrong' : SETTINGS.expectedServerUuid,
            }], []];
            if (sql.includes('DATE_FORMAT(applied_at')) return [[{ epoch: options.wrongEpoch ? 'old' : SETTINGS.expectedIdentityEpoch }], []];
            if (sql.startsWith('SELECT version FROM schema_migrations')) {
                const recorded = values?.[0] === '0017_create_apple_auth_revocations' ? options.appleRevocationMigrationRecorded
                    : values?.[0] === '0016_create_apple_provider_tokens' ? options.appleMigrationRecorded
                    : values?.[0] === '0011_create_account_sessions' ? options.sessionMigrationRecorded
                    : values?.[0] === '0010_create_provider_auth_attempts'
                        ? options.attemptMigrationRecorded : options.providerMigrationRecorded;
                return [recorded ? [{ version: values?.[0] }] : [], []];
            }
            if (values?.[0] === 'account_provider_identities') {
                return [sql.includes('COUNT(*)')
                    ? [{ tableCount: options.providerTable === 'malformed' ? 1 : 0 }]
                    : [{ engine: 'MyISAM', collation: 'utf8mb4_unicode_ci', tableType: 'BASE TABLE' }], []];
            }
            if (values?.[0] === 'provider_auth_attempts') {
                return [sql.includes('COUNT(*)')
                    ? [{ tableCount: options.attemptTable === 'malformed' ? 1 : 0 }]
                    : [{ engine: 'MyISAM', collation: 'utf8mb4_unicode_ci', tableType: 'BASE TABLE' }], []];
            }
            if (values?.[0] === 'account_sessions') {
                return [sql.includes('COUNT(*)')
                    ? [{ tableCount: options.sessionTable === 'malformed' ? 1 : 0 }]
                    : [{ engine: 'MyISAM', collation: 'utf8mb4_unicode_ci', tableType: 'BASE TABLE' }], []];
            }
            if (values?.[0] === 'apple_provider_tokens') return [[{ tableCount: 0 }], []];
            if (values?.[0] === 'apple_auth_revocations') return [[{ tableCount: 0 }], []];
            if (sql.startsWith('UPDATE apple_provider_tokens')) return [{ affectedRows: 1 }, []];
            if (sql.includes('information_schema.COLUMNS')) return [options.missingIdentity ? [] : [{
                type: 'char(36)', nullable: 'NO', characterSet: 'ascii', collation: 'ascii_bin',
                defaultValue: 'uuid()', extra: 'DEFAULT_GENERATED', generationExpression: '',
            }], []];
            if (sql.includes('information_schema.STATISTICS')) return [[{
                columnName: 'account_uuid', nonUnique: 0, sequence: 1, subPart: null, visible: 'YES', indexType: 'BTREE',
            }], []];
            if (sql.includes('COUNT(*) AS invalidCount')) return [[{ invalidCount: 0 }], []];
            if (sql.includes('information_schema.TABLES') && sql.endsWith("TABLE_NAME = 'users'")) {
                return [[{ engine: options.unsafeSchema ? 'MyISAM' : 'InnoDB' }], []];
            }
            if (sql.includes('information_schema.TABLES')) return [[
                { tableName: 'users', engine: options.unsafeSchema ? 'MyISAM' : 'InnoDB' },
                { tableName: 'game_personal_bests', engine: 'InnoDB' },
                { tableName: 'game_submission_receipts', engine: 'InnoDB' },
            ], []];
            if (sql.startsWith('SELECT user_id AS userId')) {
                const account = [...accounts].find(([, accountId]) => accountId === values?.[0]);
                return [account ? [{ userId: account[0] }] : [], []];
            }
            if (sql.includes('GET_LOCK')) {
                if (options.changeIdentityUnderLock) accounts.set(42, SECOND_ID);
                return [[{ lockResult: 1 }], []];
            }
            if (sql.includes('RELEASE_LOCK')) return [[{ lockResult: 1 }], []];
            if (sql === 'START TRANSACTION') { pendingDelete = undefined; return [[], []]; }
            if (sql.startsWith('SELECT account_uuid AS accountId')) {
                const accountId = accounts.get(values?.[0] as number);
                return [accountId ? [{ accountId }] : [], []];
            }
            if (sql.startsWith('DELETE FROM')) {
                if (sql.startsWith('DELETE FROM users')) pendingDelete = values?.[0] as number;
                return [{ affectedRows: 1 }, []];
            }
            if (sql === 'COMMIT') {
                if (pendingDelete !== undefined) accounts.delete(pendingDelete);
                pendingDelete = undefined;
                return [[], []];
            }
            if (sql === 'ROLLBACK') { pendingDelete = undefined; return [[], []]; }
            throw new Error(`Unmodelled test query: ${sql}`);
        },
        release() { events.push('release'); },
        destroy() { events.push('destroy'); },
    } as unknown as PoolConnection;
    const database = { async getConnection() { return connection; } } as Pick<Pool, 'getConnection'>;
    const reader: DeletionJournalReader = {
        async readDeletionIntents() {
            journalReads++;
            return options.onJournalRead?.(journalReads)
                ?? { intents: options.initialIntents ?? [INTENT], digest: 'a'.repeat(64) };
        },
    };
    return { database, reader, accounts, events, queries, failure };
}

test('plan is read-only, binds complete intents and target, and contains no account identifiers', async () => {
    const fake = fakeReplay();
    const plan = await planDeletionReplay(fake.database, fake.reader, SETTINGS);
    assert.match(plan.sha256, /^[0-9a-f]{64}$/u);
    assert.equal(plan.intentCount, 1);
    assert.equal(plan.accountCount, 1);
    assert.equal(JSON.stringify(plan).includes(FIRST_ID), false);
    assert.equal(fake.events.some(sql => sql.startsWith('DELETE') || sql === 'START TRANSACTION'), false);
    const changed = fakeReplay({ initialIntents: [{ ...INTENT, requestedAt: '2026-09-11T12:16:00.000Z' }] });
    assert.notEqual((await planDeletionReplay(changed.database, changed.reader, SETTINGS)).sha256, plan.sha256);
});

test('replay locks and rechecks UUID, deletes only owned rows, and is repeatable', async () => {
    const fake = fakeReplay({ initialIntents: [INTENT, INTENT] });
    const plan = await planDeletionReplay(fake.database, fake.reader, SETTINGS);
    assert.equal(plan.intentCount, 2);
    assert.equal(plan.accountCount, 1);
    const result = await applyDeletionReplay(fake.database, fake.reader, SETTINGS, plan.sha256);
    assert.equal(result.deletedAccounts, 1);
    assert.deepEqual([...fake.accounts], [[99, SECOND_ID]]);
    const mutations = fake.queries.filter(query => query.sql.startsWith('DELETE') && !query.sql.includes('apple_provider_tokens'));
    assert.equal(mutations.length, 3);
    assert.ok(mutations.every(query => query.values?.[0] === 42));
    const lock = fake.events.findIndex(sql => sql.includes('GET_LOCK'));
    const rowLock = fake.events.findIndex(sql => sql.endsWith('FOR UPDATE'));
    assert.ok(lock >= 0 && rowLock > lock && fake.events.indexOf(mutations[0].sql) > rowLock);
    assert.ok(fake.queries.every(query => query.timeout > 0 && query.timeout <= 10000));
    const repeated = await applyDeletionReplay(fake.database, fake.reader, SETTINGS, plan.sha256);
    assert.equal(repeated.deletedAccounts, 0);
    assert.equal(repeated.absentAccounts, 1);
});

test('every record is validated before any deletion, including malformed trailing records', async () => {
    const fake = fakeReplay({ initialIntents: [INTENT, { ...INTENT, unexpectedEmail: 'must-not-store@example.test' } as DeletionIntent] });
    await assert.rejects(applyDeletionReplay(fake.database, fake.reader, SETTINGS, 'a'.repeat(64)), /Invalid deletion intent/u);
    assert.equal(fake.events.some(sql => sql.startsWith('DELETE')), false);
});

test('replay queues surviving Apple credentials even when the account is absent and never renews the journal deadline', async () => {
    const fake = fakeReplay({ initialIntents: [{ ...INTENT, requestedAt: '2026-09-12T12:15:00.000Z' }, INTENT] });
    fake.accounts.delete(42);
    const plan = await planDeletionReplay(fake.database, fake.reader, SETTINGS);
    for (let run = 0; run < 2; run++) {
        const result = await applyDeletionReplay(fake.database, fake.reader, SETTINGS, plan.sha256);
        assert.equal(result.absentAccounts, 1);
    }
    const transitions = fake.queries.filter(({ sql }) => sql.startsWith('UPDATE apple_provider_tokens'));
    assert.equal(transitions.length, 2);
    for (const transition of transitions) {
        assert.deepEqual(transition.values, [...Array(4).fill('2026-09-11 12:15:00.000'), FIRST_ID]);
    }
    assert.equal(fake.queries.some(({ sql }) => sql.startsWith('DELETE FROM users')), false);
});

test('replay refuses absent Apple token storage when its migration is recorded', async () => {
    const fake = fakeReplay({ appleMigrationRecorded: true });
    await assert.rejects(planDeletionReplay(fake.database, fake.reader, SETTINGS), /missing its table/u);
    assert.equal(fake.queries.some(({ sql }) => /^(?:UPDATE|DELETE)/u.test(sql)), false);
});

test('replay refuses absent Apple revocation storage when its migration is recorded', async () => {
    const fake = fakeReplay({ appleRevocationMigrationRecorded: true });
    await assert.rejects(planDeletionReplay(fake.database, fake.reader, SETTINGS), /missing its table/u);
    assert.equal(fake.queries.some(({ sql }) => /^(?:UPDATE|DELETE)/u.test(sql)), false);
});

test('target, epoch, schema and review limits fail closed', async () => {
    for (const options of [{ wrongTarget: true }, { wrongEpoch: true }, { missingIdentity: true }, { unsafeSchema: true }]) {
        const fake = fakeReplay(options);
        await assert.rejects(planDeletionReplay(fake.database, fake.reader, SETTINGS));
        assert.equal(fake.events.some(sql => sql.startsWith('DELETE')), false);
    }
    const fake = fakeReplay({ initialIntents: [INTENT, INTENT] });
    await assert.rejects(planDeletionReplay(fake.database, fake.reader, { ...SETTINGS, maxIntents: 1 }), /exceeds/u);
    await assert.rejects(planDeletionReplay(fake.database, fake.reader, { ...SETTINGS, sourceServerUuid: SETTINGS.expectedServerUuid }), /distinct/u);
});

test('replay supports pre-provider backups but refuses missing recorded or malformed provider tables', async () => {
    const legacy = fakeReplay();
    await planDeletionReplay(legacy.database, legacy.reader, SETTINGS);
    assert.ok(legacy.events.some(sql => sql.startsWith('SELECT version FROM schema_migrations')));
    for (const options of [
        { providerMigrationRecorded: true }, { providerTable: 'malformed' as const },
    ]) {
        const fake = fakeReplay(options);
        await assert.rejects(planDeletionReplay(fake.database, fake.reader, SETTINGS), /provider identity|Provider identity/u);
        assert.equal(fake.events.some(sql => sql.startsWith('DELETE') || sql === 'START TRANSACTION'), false);
        assert.ok(fake.events.includes('destroy'));
        assert.equal(fake.accounts.get(42), FIRST_ID);
    }
});

test('replay supports pre-0010 backups and refuses unsafe attempt storage before planning or deleting', async () => {
    const legacy = fakeReplay({ attemptTable: 'absent' });
    const plan = await planDeletionReplay(legacy.database, legacy.reader, SETTINGS);
    assert.ok(legacy.queries.some(({ sql, values }) => sql.startsWith('SELECT version FROM schema_migrations')
        && values?.[0] === '0010_create_provider_auth_attempts'));
    assert.equal((await applyDeletionReplay(legacy.database, legacy.reader, SETTINGS, plan.sha256)).deletedAccounts, 1);
    for (const options of [
        { attemptMigrationRecorded: true }, { attemptTable: 'malformed' as const },
    ]) {
        const fake = fakeReplay(options);
        await assert.rejects(planDeletionReplay(fake.database, fake.reader, SETTINGS), /[Pp]rovider attempt/u);
        await assert.rejects(applyDeletionReplay(fake.database, fake.reader, SETTINGS, plan.sha256), /[Pp]rovider attempt/u);
        assert.equal(fake.events.some(sql => sql.startsWith('DELETE') || sql === 'START TRANSACTION'), false);
        assert.ok(fake.events.includes('destroy'));
        assert.equal(fake.accounts.get(42), FIRST_ID);
    }
});

test('attempt schema changes after plan approval are rechecked before replay writes', async () => {
    const options: FakeOptions = {};
    const fake = fakeReplay(options);
    const plan = await planDeletionReplay(fake.database, fake.reader, SETTINGS);
    options.attemptMigrationRecorded = true;
    await assert.rejects(applyDeletionReplay(fake.database, fake.reader, SETTINGS, plan.sha256), /missing its table/u);
    assert.equal(fake.events.some(sql => sql.startsWith('DELETE') || sql === 'START TRANSACTION'), false);
    assert.equal(fake.accounts.get(42), FIRST_ID);
});

test('replay permits pre-0011 backups but rejects missing recorded or malformed sessions', async () => {
    const legacy = fakeReplay();
    const plan = await planDeletionReplay(legacy.database, legacy.reader, SETTINGS);
    assert.ok(legacy.queries.some(({ values }) => values?.[0] === '0011_create_account_sessions'));
    for (const options of [{ sessionMigrationRecorded: true }, { sessionTable: 'malformed' as const }]) {
        const fake = fakeReplay(options);
        await assert.rejects(planDeletionReplay(fake.database, fake.reader, SETTINGS), /[Aa]ccount session/u);
        await assert.rejects(applyDeletionReplay(fake.database, fake.reader, SETTINGS, plan.sha256), /[Aa]ccount session/u);
        assert.equal(fake.events.some(sql => sql.startsWith('DELETE') || sql === 'START TRANSACTION'), false);
        assert.equal(fake.accounts.get(42), FIRST_ID);
    }
    const changed: FakeOptions = {};
    const fake = fakeReplay(changed);
    const approved = await planDeletionReplay(fake.database, fake.reader, SETTINGS);
    changed.sessionMigrationRecorded = true;
    await assert.rejects(applyDeletionReplay(fake.database, fake.reader, SETTINGS, approved.sha256), /missing its table/u);
    assert.equal(fake.events.some(sql => sql.startsWith('DELETE') || sql === 'START TRANSACTION'), false);
});

test('stale approval and changed pre-apply journal prevent every deletion', async () => {
    const fake = fakeReplay({ onJournalRead: count => count === 1 ? undefined : { intents: [INTENT], digest: 'b'.repeat(64) } });
    const plan = await planDeletionReplay(fake.database, fake.reader, SETTINGS);
    await assert.rejects(applyDeletionReplay(fake.database, fake.reader, SETTINGS, plan.sha256), /plan changed/u);
    assert.equal(fake.events.some(sql => sql.startsWith('DELETE')), false);
});

test('journal change after commits refuses cutover without undoing authorized deletions', async () => {
    const fake = fakeReplay({ onJournalRead: count => count < 3 ? undefined : { intents: [INTENT], digest: 'b'.repeat(64) } });
    const plan = await planDeletionReplay(fake.database, fake.reader, SETTINGS);
    await assert.rejects(applyDeletionReplay(fake.database, fake.reader, SETTINGS, plan.sha256), /no cutover/u);
    assert.equal(fake.accounts.has(42), false);
    assert.equal(fake.accounts.get(99), SECOND_ID);
});

test('journal outages fail before writes or after commits without reporting success', async () => {
    for (const failingRead of [2, 3]) {
        const fake = fakeReplay({ onJournalRead: count => {
            if (count === failingRead) throw new Error('journal unavailable');
            return undefined;
        } });
        const plan = await planDeletionReplay(fake.database, fake.reader, SETTINGS);
        await assert.rejects(applyDeletionReplay(fake.database, fake.reader, SETTINGS, plan.sha256), /journal unavailable/u);
        assert.equal(fake.accounts.has(42), failingRead === 2);
        assert.equal(fake.accounts.get(99), SECOND_ID);
    }
});

test('an exhausted time budget cannot start deletions', async () => {
    const fake = fakeReplay();
    const slowReader: DeletionJournalReader = { async readDeletionIntents() {
        await new Promise<void>(resolve => setTimeout(resolve, 10));
        return { intents: [INTENT], digest: 'a'.repeat(64) };
    } };
    await assert.rejects(planDeletionReplay(fake.database, slowReader, { ...SETTINGS, maxDurationMs: 5 }), /time budget/u);
    assert.equal(fake.events.some(sql => sql.startsWith('DELETE')), false);
});

test('numeric ID reuse under the shared lock never deletes the replacement account', async () => {
    const fake = fakeReplay({ changeIdentityUnderLock: true });
    const plan = await planDeletionReplay(fake.database, fake.reader, SETTINGS);
    await assert.rejects(applyDeletionReplay(fake.database, fake.reader, SETTINGS, plan.sha256), /identity changed/u);
    assert.equal(fake.events.some(sql => sql.startsWith('DELETE')), false);
    assert.ok(fake.events.includes('ROLLBACK'));
    assert.equal(fake.accounts.get(42), SECOND_ID);
});

test('partial failure rolls back; uncertain transaction acknowledgements destroy the connection', async () => {
    for (const failAt of ['DELETE FROM game_submission_receipts WHERE user_id = ?', 'START TRANSACTION', 'COMMIT']) {
        const fake = fakeReplay({ failAt });
        const plan = await planDeletionReplay(fake.database, fake.reader, SETTINGS);
        await assert.rejects(applyDeletionReplay(fake.database, fake.reader, SETTINGS, plan.sha256), /synthetic replay failure/u);
        assert.ok(fake.events.includes('ROLLBACK'));
        assert.equal(fake.accounts.get(42), FIRST_ID);
        if (failAt !== 'DELETE FROM game_submission_receipts WHERE user_id = ?') assert.ok(fake.events.includes('destroy'));
    }
    const fake = fakeReplay({ failAt: 'DELETE FROM game_submission_receipts WHERE user_id = ?', rollbackFails: true });
    const plan = await planDeletionReplay(fake.database, fake.reader, SETTINGS);
    await assert.rejects(applyDeletionReplay(fake.database, fake.reader, SETTINGS, plan.sha256), /transaction and its rollback/u);
    assert.ok(fake.events.includes('destroy'));
});
