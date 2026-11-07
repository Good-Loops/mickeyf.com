import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'mysql2/promise';
import {
    createPasswordAccount,
    findPasswordLoginAccount,
    isAccountIdentifierTaken,
} from './passwordAccountRepository';

type Query = (options: { sql: string; timeout: number }, values: unknown[]) => Promise<unknown>;
const databaseWith = (query: Query) => ({ query }) as unknown as Pick<Pool, 'query'>;
const signup = { userName: 'player', email: 'player@example.test', passwordHash: 'already-hashed' };

test('signup preflight binds both identifiers and preserves the query timeout', async () => {
    for (const taken of [false, true]) {
        const database = databaseWith(async (options, values) => {
            assert.equal(options.sql, 'SELECT 1 FROM users WHERE user_name = ? OR email = ? LIMIT 1');
            assert.equal(options.timeout, 10_000);
            assert.deepEqual(values, [signup.userName, signup.email]);
            return [taken ? [{ '1': 1 }] : [], []];
        });
        assert.equal(await isAccountIdentifierTaken(database, signup), taken);
    }
});

test('account creation stores only the supplied identity and password hash', async () => {
    const database = databaseWith(async (options, values) => {
        assert.equal(options.sql, 'INSERT INTO users (user_name, email, user_password) VALUES (?, ?, ?)');
        assert.equal(options.timeout, 10_000);
        assert.deepEqual(values, [signup.userName, signup.email, signup.passwordHash]);
        return [{ affectedRows: 1 }, []];
    });
    assert.equal(await createPasswordAccount(database, signup), 'created');
});

test('account creation translates a unique-key race into a duplicate result', async () => {
    const database = databaseWith(async () => {
        throw Object.assign(new Error('synthetic conflict'), { errno: 1062 });
    });
    assert.equal(await createPasswordAccount(database, signup), 'duplicate');
});

test('login lookup projects database rows without leaking incidental fields', async () => {
    for (const passwordHash of ['stored-hash', null]) {
        const database = databaseWith(async (options, values) => {
            assert.match(options.sql.replace(/\s+/g, ' '),
                /SELECT user_id, account_uuid, user_name, user_password FROM users WHERE user_name = \? LIMIT 1/);
            assert.equal(options.timeout, 10_000);
            assert.deepEqual(values, ['player']);
            return [[{ user_id: 42, account_uuid: 'account-id', user_name: 'player',
                user_password: passwordHash, email: 'not-requested@example.test' }], []];
        });
        assert.deepEqual(await findPasswordLoginAccount(database, 'player'), {
            userId: 42, accountId: 'account-id', userName: 'player', passwordHash,
        });
    }
});

test('login lookup distinguishes a missing account from a passwordless account', async () => {
    assert.equal(await findPasswordLoginAccount(databaseWith(async () => [[], []]), 'missing'), undefined);
});

for (const operation of ['preflight', 'create', 'login'] as const) {
    test(`${operation} preserves unexpected database errors for the caller`, async () => {
        const failure = new Error('synthetic unavailable database');
        const database = databaseWith(async () => { throw failure; });
        const pending = operation === 'preflight' ? isAccountIdentifierTaken(database, signup)
            : operation === 'create' ? createPasswordAccount(database, signup)
                : findPasswordLoginAccount(database, signup.userName);
        await assert.rejects(pending, error => error === failure);
    });
}
