import assert from 'node:assert/strict';
import test from 'node:test';
import bcrypt from 'bcryptjs';
import type { Pool, PoolConnection } from 'mysql2/promise';
import type { VerifiedProviderIdentity } from '../auth/providerIdentity';
import { findProviderAccount, linkProviderAccount, ProviderAccountUnavailableError } from './providerAccountRepository';

const accountId = '123e4567-e89b-42d3-a456-426614174000';
const otherId = '123e4567-e89b-42d3-a456-426614174001';
const target = { userId: 7, accountId };
const password = 'existing-test-password';
const passwordHash = bcrypt.hashSync(password, 4);
// The verifier has separate signed-token tests. This fixture represents its trusted output.
const identity = { provider: 'google', subject: 'CaseSensitiveSubject' } as VerifiedProviderIdentity;

function fixture(options: {
    accountId?: string; absent?: boolean; duplicate?: { accountId: string; subject: Buffer }[];
    fail?: 'begin' | 'insert' | 'commit' | 'unlock'; rollbackFails?: boolean;
} = {}) {
    const events: string[] = [];
    const queries: Array<{ sql: string; values?: unknown[]; timeout: number }> = [];
    const failure = new Error('sensitive database credentials/provider subject must not escape');
    function step(name: string) { events.push(name); if (options.fail === name) throw failure; }
    const connection = {
        async beginTransaction() { step('begin'); },
        async commit() { step('commit'); },
        async rollback() { step('rollback'); if (options.rollbackFails) throw failure; },
        release() { step('release'); }, destroy() { step('destroy'); },
        async query(query: { sql: string; timeout: number }, values: unknown[]) {
            const sql = query.sql.replace(/\s+/g, ' ').trim();
            queries.push({ ...query, sql, values });
            if (sql.includes('GET_LOCK')) { step('lock'); return [[{ lockResult: 1 }]]; }
            if (sql.includes('RELEASE_LOCK')) { step('unlock'); return [[{ lockResult: 1 }]]; }
            if (sql.startsWith('SELECT user_password')) {
                step('password'); return [options.absent ? [] : [{ accountId: options.accountId ?? accountId, passwordHash }]];
            }
            if (sql.startsWith('INSERT')) {
                step('insert'); if (options.duplicate) throw { errno: 1062, sqlMessage: 'sensitive owner details' };
                return [{ affectedRows: 1 }];
            }
            if (sql.startsWith('SELECT account_uuid')) { step('existing'); return [options.duplicate]; }
            throw new Error('Unexpected query');
        },
    } as unknown as PoolConnection;
    return { events, queries, database: { getConnection: async () => connection } as Pick<Pool, 'getConnection'> };
}

test('links only a password-proven matching incarnation under the existing user lock and transaction', async () => {
    const f = fixture();
    assert.equal(await linkProviderAccount(f.database, target, password, identity), 'linked');
    assert.deepEqual(f.events, ['lock', 'begin', 'password', 'insert', 'commit', 'unlock', 'release']);
    assert(f.queries.every(q => q.timeout === 10000 && !q.values?.includes(password)));
    const insert = f.queries.find(q => q.sql.startsWith('INSERT'))!;
    assert.deepEqual(insert.values, ['google', Buffer.from('CaseSensitiveSubject'), accountId]);
    assert(f.queries.every(q => !/email|game_personal_bests|^\s*(?:UPDATE|DELETE)\b|ON DUPLICATE/i.test(q.sql)));
});

test('wrong password, removed account and reused numeric ID never create links', async () => {
    for (const [options, suppliedPassword, expected] of [
        [{}, 'wrong-password', 'invalid-password'],
        [{ absent: true }, password, 'not-found'],
        [{ accountId: otherId }, password, 'not-found'],
    ] as const) {
        const f = fixture(options);
        assert.equal(await linkProviderAccount(f.database, target, suppliedPassword, identity), expected);
        assert(!f.events.includes('insert'));
    }
    for (const invalid of ['', 'x'.repeat(73), 'test\u0000password']) {
        const f = fixture();
        assert.equal(await linkProviderAccount(f.database, target, invalid, identity), 'invalid-password');
        assert.deepEqual(f.events, []);
    }
});

test('identical retry is idempotent; competing account or another identity is never reassigned', async () => {
    for (const [owner, subject, expected] of [
        [accountId, identity.subject, 'already-linked'],
        [otherId, identity.subject, 'link-conflict'],
        [accountId, 'AnotherSubject', 'link-conflict'],
    ] as const) {
        const f = fixture({ duplicate: [{ accountId: owner, subject: Buffer.from(subject) }] });
        assert.equal(await linkProviderAccount(f.database, target, password, identity), expected);
        assert.deepEqual(f.events.slice(-4), ['existing', 'commit', 'unlock', 'release']);
        assert(f.queries.every(q => !q.sql.startsWith('UPDATE')));
    }
});

test('uncertain transaction or lock outcome is sanitized and never reported as a successful link', async () => {
    for (const fail of ['begin', 'insert', 'commit', 'unlock'] as const) {
        const f = fixture({ fail });
        await assert.rejects(linkProviderAccount(f.database, target, password, identity), error => {
            assert(error instanceof ProviderAccountUnavailableError);
            assert.doesNotMatch(String(error), /sensitive|credentials|CaseSensitiveSubject/);
            assert.equal('cause' in error, false);
            return true;
        });
        if (fail !== 'insert') assert(f.events.includes('destroy'));
    }
    const rollback = fixture({ fail: 'insert', rollbackFails: true });
    await assert.rejects(linkProviderAccount(rollback.database, target, password, identity), ProviderAccountUnavailableError);
    assert(rollback.events.includes('destroy'));
});

test('lookup is UUID-bound and byte-exact, and returns only account identity or null', async () => {
    let seenSql = '';
    let seenValues: unknown[] = [];
    const database = { query: async (query: { sql: string }, values: unknown[]) => {
        seenSql = query.sql; seenValues = values;
        return [[{ userId: 7, userName: 'existing', accountId }]];
    } } as unknown as Pick<Pool, 'query'>;
    assert.deepEqual(await findProviderAccount(database, identity), { userId: 7, userName: 'existing', accountId });
    assert.match(seenSql, /u\.account_uuid = p\.account_uuid/);
    assert.doesNotMatch(seenSql, /email|user_password|INSERT|UPDATE/);
    assert.deepEqual(seenValues, ['google', Buffer.from(identity.subject)]);
    const absent = { query: async () => [[]] } as unknown as Pick<Pool, 'query'>;
    assert.equal(await findProviderAccount(absent, identity), null);
    const broken = { query: async () => { throw new Error('raw secret'); } } as unknown as Pick<Pool, 'query'>;
    await assert.rejects(findProviderAccount(broken, identity), ProviderAccountUnavailableError);
});

test('malformed identities and target UUIDs fail before database use', async () => {
    for (const malformed of [{ provider: 'other', subject: 'valid' }, { provider: 'google', subject: '' },
        { provider: 'apple', subject: 'Ünicode' }, { provider: 'google', subject: 'trailing ' }]) {
        const f = fixture();
        await assert.rejects(linkProviderAccount(f.database, target, password, malformed as VerifiedProviderIdentity));
        assert.deepEqual(f.events, []);
    }
    const f = fixture();
    await assert.rejects(linkProviderAccount(f.database, { userId: 7, accountId: 'invalid' }, password, identity));
    assert.deepEqual(f.events, []);
});
