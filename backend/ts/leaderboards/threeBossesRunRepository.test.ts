import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { Pool, PoolConnection } from 'mysql2/promise';
import {
    createThreeBossesPayloadFingerprint,
    readThreeBossesLeaderboard,
    submitThreeBossesRun,
} from './threeBossesRunRepository';

const ACCOUNT_ID = '4bbaec47-5516-47fe-b13e-366bc6ec9814';
const SESSION_ID = Buffer.alloc(32, 1).toString('base64url');
const SESSION_HASH = createHash('sha256').update(SESSION_ID, 'ascii').digest();
const SESSION = { accountId: ACCOUNT_ID, sessionId: SESSION_ID };
const RUN_ID = '123e4567-e89b-42d3-a456-426614174000';

function submissionDatabase(sessionExists = true) {
    const events: string[] = [];
    const queries: Array<{ sql: string; values?: unknown[] }> = [];
    const connection = {
        async beginTransaction() { events.push('begin'); },
        async commit() { events.push('commit'); },
        async rollback() { events.push('rollback'); },
        release() { events.push('release'); },
        destroy() { events.push('destroy'); },
        async query(options: { sql: string }, values?: unknown[]) {
            const sql = options.sql.replace(/\s+/g, ' ').trim();
            queries.push({ sql, values });
            events.push(`query:${queries.length}`);
            if (sql.includes('GET_LOCK') || sql.includes('RELEASE_LOCK')) return [[{ lockResult: 1 }], []];
            if (sql.includes('FROM account_sessions AS s')) {
                const matches = sessionExists && values?.[0] === 42 && values?.[1] === ACCOUNT_ID
                    && Buffer.isBuffer(values?.[2]) && values[2].equals(SESSION_HASH);
                return [matches ? [{ userName: 'player' }] : [], []];
            }
            if (sql.startsWith('SELECT user_id FROM users')) return [[{ user_id: 42 }], []];
            if (sql.startsWith('SELECT COUNT(*)')) return [[{ acceptedRunCount: 0 }], []];
            if (sql.startsWith('SELECT')) return [[], []];
            return [{ affectedRows: 1 }, []];
        },
    } as unknown as PoolConnection;
    const database = { async getConnection() { return connection; } } as Pick<Pool, 'getConnection'>;
    return { database, events, queries };
}

test('builds the reviewed canonical payload fingerprint byte-for-byte', () => {
    assert.equal(
        createThreeBossesPayloadFingerprint(
            42,
            '123e4567-e89b-42d3-a456-426614174000',
            50_000
        ).toString('hex'),
        'e5ae8fca38b1ba6ef814b2fd210d64decd682a5642717ff5d551141fe664a369'
    );
});

test('reads only current Three Bosses rows in deterministic ascending order', async () => {
    let queryOptions: { sql?: string; timeout?: number } | undefined;
    let queryValues: unknown[] | undefined;
    const database = {
        async query(options: { sql?: string; timeout?: number }, values?: unknown[]) {
            queryOptions = options;
            queryValues = values;
            return [[
                {
                    userName: 'fast-player',
                    score: 200_000,
                    completionTimeMs: 50_000,
                    internalUserId: 42,
                },
            ], []];
        },
    } as unknown as Pick<Pool, 'query'>;

    assert.deepEqual(await readThreeBossesLeaderboard(database), [{
        userName: 'fast-player',
        score: 200_000,
        completionTimeMs: 50_000,
    }]);
    assert.deepEqual(queryValues, ['three-bosses', 1]);
    assert.equal(queryOptions?.timeout, 10_000);
    assert.equal(
        queryOptions?.sql?.replace(/\s+/g, ' ').trim(),
        'SELECT users.user_name AS userName, game_personal_bests.score AS score, game_personal_bests.completion_time_ms AS completionTimeMs FROM game_personal_bests INNER JOIN users ON users.user_id = game_personal_bests.user_id WHERE game_personal_bests.game_id = ? AND game_personal_bests.rules_version = ? AND game_personal_bests.completion_time_ms IS NOT NULL ORDER BY game_personal_bests.completion_time_ms ASC, game_personal_bests.recorded_at ASC, game_personal_bests.user_id ASC LIMIT 10'
    );
});

test('checks UUID and live session under the user lock before receipt replay or writes', async () => {
    for (const expectedSession of [SESSION,
        { ...SESSION, accountId: '4bbaec47-5516-47fe-b13e-366bc6ec9815' },
        { ...SESSION, sessionId: Buffer.alloc(32, 2).toString('base64url') }]) {
        const fake = submissionDatabase();
        const matches = expectedSession === SESSION;
        const result = await submitThreeBossesRun(fake.database, 42, RUN_ID, 50_000, expectedSession);
        assert.equal(result.kind, matches ? 'accepted' : 'user-not-found');
        assert.match(fake.queries[0].sql, /GET_LOCK/);
        assert.match(fake.queries[1].sql, /FROM account_sessions AS s/);
        assert.deepEqual(fake.queries[1].values, [42, expectedSession.accountId,
            createHash('sha256').update(expectedSession.sessionId, 'ascii').digest()]);
        assert.equal(fake.queries.some(({ sql }) => sql.includes('FROM game_submission_receipts')), matches);
        assert.equal(fake.queries.some(({ sql }) => sql.startsWith('INSERT')), matches);
        assert.deepEqual(fake.events.slice(0, 3), ['query:1', 'begin', 'query:2']);
    }
});

test('revoked or expired sessions cannot submit and malformed proofs fail closed', async () => {
    const missing = submissionDatabase(false);
    assert.deepEqual(await submitThreeBossesRun(missing.database, 42, RUN_ID, 50_000, SESSION),
        { kind: 'user-not-found' });
    assert.equal(missing.queries.some(({ sql }) => sql.includes('game_submission_receipts')), false);
    const invalid = submissionDatabase();
    await assert.rejects(() => submitThreeBossesRun(invalid.database, 42, RUN_ID, 50_000,
        { ...SESSION, accountId: 'invalid-uuid' }), TypeError);
    assert.equal(invalid.queries.some(({ sql }) => sql.includes('account_sessions') || sql.startsWith('INSERT')), false);
});
