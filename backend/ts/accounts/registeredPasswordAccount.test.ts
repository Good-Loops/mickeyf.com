import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'mysql2/promise';
import { createRegisteredPasswordAccount } from './registeredPasswordAccount';
import { RegistrationRequiredError } from './registrationAuthorization';

const accountId = '123e4567-e89b-42d3-a456-426614174000';
const input = { userName: 'synthetic', email: 'synthetic@example.test', passwordHash: 'synthetic-hash' };
function fixture(fail?: string, duplicate = false) {
    const events: string[] = [];
    const connection = { async query({ sql }: { sql: string }) {
        const event = sql.startsWith('INSERT') ? 'insert' : sql.startsWith('SELECT') ? 'account' : sql;
        events.push(event);
        if (event === fail) throw new Error('sensitive synthetic failure');
        if (event === 'insert' && duplicate) throw { errno: 1062 };
        return event === 'account' ? [[{ accountId }]] : [{ affectedRows: 1 }];
    }, release() { events.push('release'); }, destroy() { events.push('destroy'); } };
    return { events, database: { getConnection: async () => connection } as unknown as Pick<Pool, 'getConnection'> };
}
test('password creation commits only after the new account registration writer succeeds', async () => {
    const f = fixture();
    assert.equal(await createRegisteredPasswordAccount(f.database, input, async (_connection, id) => {
        assert.equal(id, accountId); f.events.push('registration');
    }), 'created');
    assert.deepEqual(f.events, ['START TRANSACTION', 'insert', 'account', 'registration', 'COMMIT', 'release']);
});
test('expired or replayed authorization rolls back the password account and retains the typed rejection', async () => {
    const f = fixture();
    await assert.rejects(createRegisteredPasswordAccount(f.database, input, async () => { throw new RegistrationRequiredError(); }), RegistrationRequiredError);
    assert.deepEqual(f.events, ['START TRANSACTION', 'insert', 'account', 'ROLLBACK', 'release']);
});
test('duplicate account rolls back without consuming an authorization', async () => {
    const f = fixture(undefined, true);
    assert.equal(await createRegisteredPasswordAccount(f.database, input, async () => assert.fail('must not consume')), 'duplicate');
    assert.deepEqual(f.events, ['START TRANSACTION', 'insert', 'ROLLBACK', 'release']);
});
test('uncertain begin, commit and failed rollback discard the connection and never claim success', async () => {
    for (const failure of ['START TRANSACTION', 'COMMIT', 'ROLLBACK']) {
        const f = fixture(failure);
        await assert.rejects(createRegisteredPasswordAccount(f.database, input, async () => {
            if (failure === 'ROLLBACK') throw new RegistrationRequiredError();
        }), /^Error: Password account creation could not be confirmed\.$/u);
        assert.equal(f.events.at(-1), 'destroy');
        if (failure !== 'ROLLBACK') assert(!f.events.includes('ROLLBACK'));
    }
});
