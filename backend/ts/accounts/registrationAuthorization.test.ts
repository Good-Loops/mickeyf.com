import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool, PoolConnection } from 'mysql2/promise';
import type { ProviderAuthContext } from '../auth/providerAuthContext';
import { loadRegistrationPolicy } from '../config/registrationPolicy';
import { createRegistrationAuthorization, RegistrationRequiredError, cleanupRegistrationAuthorizations } from './registrationAuthorization';

const policy = loadRegistrationPolicy({ REGISTRATION_ENABLED: 'true', REGISTRATION_POLICY_REVIEWED: 'true',
    REGISTRATION_POLICY_VERSION: 'synthetic', REGISTRATION_COUNTRY_RULES: '{"ZZ":{"parentRequiredBelow":15}}' })!;
const context = () => ({ bindingHash: Buffer.alloc(32, 7), account: null, session: null,
    bindingExpiresAt: Date.now() + 300_000, anonymousCookie: null }) as ProviderAuthContext;
const accountId = '123e4567-e89b-42d3-a456-426614174000';

function fixture(ageBand: 'minor' | 'adult' = 'minor', failProfile = false, missing = false) {
    const calls: { sql: string; values?: unknown[] }[] = [];
    const database = { async query(options: { sql: string; timeout: number }, values?: unknown[]) {
        assert.equal(options.timeout, 10_000);
        const sql = options.sql.replace(/\s+/gu, ' ').trim();
        calls.push({ sql, values });
        if (sql.startsWith('SELECT')) return [missing ? [] : [{ country: 'ZZ', ageBand }]];
        if (sql.startsWith('INSERT INTO account_registration_profiles') && failProfile) throw new Error('synthetic profile conflict');
        return [{ affectedRows: 1 }];
    } } as unknown as Pick<Pool, 'query'>;
    return { calls, database, connection: database as PoolConnection, service: createRegistrationAuthorization(database, policy) };
}

test('closed and parent-required preflight touch neither SQL nor account credentials', async () => {
    const f = fixture();
    assert.deepEqual(await createRegistrationAuthorization(f.database).begin(null, {}), { allowed: false, reason: 'REGISTRATION_CLOSED' });
    assert.deepEqual(await f.service.begin(null, { country: 'ZZ', ageBand: 'parent-required', policyVersion: 'synthetic' }),
        { allowed: false, reason: 'PARENT_REQUIRED' });
    assert.deepEqual(f.calls, []);
});

test('grant issuance stores only reviewed coarse data and hash with bounded expiration and cleanup', async () => {
    const f = fixture();
    await f.service.begin(context(), { country: 'ZZ', ageBand: 'minor', policyVersion: 'synthetic' });
    assert.equal(f.calls.length, 2);
    assert.match(f.calls[0].sql, /expires_at <= UTC_TIMESTAMP\(6\) LIMIT 100$/u);
    assert.deepEqual(f.calls[1].values?.slice(0, 4), [Buffer.alloc(32, 7), policy.digest, 'ZZ', 'minor']);
    assert.match(f.calls[1].sql, /LEAST\(\?, UTC_TIMESTAMP\(6\) \+ INTERVAL 5 MINUTE\)/u);
});

test('invalid, authenticated and expired contexts cannot issue or consume grants', async () => {
    const f = fixture();
    for (const invalid of [null, { ...context(), account: { userId: 1, accountId } },
        { ...context(), session: { accountId, sessionId: 'untrusted' } }, { ...context(), bindingHash: Buffer.alloc(1) },
        { ...context(), bindingExpiresAt: 0 }]) {
        await assert.rejects(f.service.assertAvailable(invalid as ProviderAuthContext), RegistrationRequiredError);
    }
    assert.deepEqual(f.calls, []);
});

test('consumption locks the current unused grant and always assigns private scores to a new minor', async () => {
    for (const band of ['minor', 'adult'] as const) {
        const f = fixture(band);
        await f.service.consume(f.connection, context(), accountId);
        assert.equal(f.calls.length, 3);
        assert.match(f.calls[0].sql, /policy_digest = \? AND consumed_at IS NULL AND expires_at > UTC_TIMESTAMP\(6\) LIMIT 2 FOR UPDATE$/u);
        assert.deepEqual(f.calls[1].values, [accountId, 'ZZ', band, 'synthetic', band === 'minor' ? 'private' : 'public']);
        assert.match(f.calls[2].sql, /consumed_at IS NULL AND expires_at > UTC_TIMESTAMP\(6\)$/u);
    }
});

test('missing/replayed authorization fails before profile writes and profile failure cannot consume a grant', async () => {
    const missing = fixture('minor', false, true);
    await assert.rejects(missing.service.consume(missing.connection, context(), accountId), RegistrationRequiredError);
    assert.equal(missing.calls.length, 1);
    const conflict = fixture('minor', true);
    await assert.rejects(conflict.service.consume(conflict.connection, context(), accountId), /synthetic profile conflict/);
    assert.equal(conflict.calls.length, 2);
});


test('bounded maintenance removes expired grants only and reports a saturated backlog', async () => {
    let calls = 0;
    const database = { async query({ sql, timeout }: { sql: string; timeout: number }) {
        calls++; assert.equal(timeout, 10_000);
        assert.match(sql, /expires_at <= UTC_TIMESTAMP\(6\)/u);
        return sql.startsWith('DELETE') ? [{ affectedRows: 100 }] : [[{ binding_hash: Buffer.alloc(32) }]];
    } } as unknown as Pick<Pool, 'query'>;
    assert.deepEqual(await cleanupRegistrationAuthorizations(database), { deleted: 1000, backlog: true });
    assert.equal(calls, 11);
    calls = 0;
    const empty = { async query() { calls++; return [{ affectedRows: 0 }]; } } as unknown as Pick<Pool, 'query'>;
    assert.deepEqual(await cleanupRegistrationAuthorizations(empty), { deleted: 0, backlog: false });
    assert.equal(calls, 1);
});

test('cancellation targets only the trusted anonymous unconsumed binding', async () => {
    const f = fixture();
    await f.service.cancel(context());
    assert.equal(f.calls.length, 1);
    assert.match(f.calls[0].sql, /WHERE binding_hash = \? AND consumed_at IS NULL$/u);
    assert.deepEqual(f.calls[0].values, [context().bindingHash]);
});
