import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool, PoolConnection } from 'mysql2/promise';
import type { ProviderAuthContext } from '../auth/providerAuthContext';
import { createProviderAttempt } from '../auth/providerAttemptRepository';
import { loadRegistrationPolicy } from '../config/registrationPolicy';
import { createRegistrationAuthorization, RegistrationRequiredError } from './registrationAuthorization';
import { createRegisteredPasswordAccount } from './registeredPasswordAccount';

const environment = { REGISTRATION_ENABLED: 'true', REGISTRATION_POLICY_REVIEWED: 'true',
    REGISTRATION_POLICY_VERSION: 'synthetic-legacy', REGISTRATION_COUNTRY_RULES: '{"ZZ":{"parentRequiredBelow":15}}',
    REGISTRATION_GENERAL_AUDIENCE_ENABLED: 'true', REGISTRATION_GENERAL_AUDIENCE_POLICY_REVIEWED: 'true',
    REGISTRATION_GENERAL_AUDIENCE_POLICY_VERSION: 'synthetic-general' };
const policy = loadRegistrationPolicy(environment)!;
const accountId = '123e4567-e89b-42d3-a456-426614174000';
const context = () => ({ bindingHash: Buffer.alloc(32, 7), account: null, session: null,
    bindingExpiresAt: Date.now() + 300_000, anonymousCookie: null }) as ProviderAuthContext;
type Attempt = { state: Buffer; binding: Buffer; nonce: string; client: string; action: string;
    userId: number | null; accountId: string | null; expiresAt: number };

/** In-memory SQL boundary; exercises the real repository creation and caller transaction. */
function fixture(failPrivate = false) {
    const calls: { sql: string; values: unknown[] }[] = [];
    let attempts: Attempt[] = [];
    let privateAccounts: string[] = [];
    let users = 0;
    let snapshot: { attempts: Attempt[]; privateAccounts: string[]; users: number } | undefined;
    let acquisitions = 0;
    const same = (left: Buffer, right: unknown) => Buffer.isBuffer(right) && left.equals(right);
    async function query(options: { sql: string; timeout: number }, values: unknown[] = []) {
        assert.equal(options.timeout, 10_000);
        const sql = options.sql.replace(/\s+/gu, ' ').trim();
        calls.push({ sql, values });
        if (sql.includes('GET_LOCK')) return [[{ acquired: 1 }]];
        if (sql.includes('RELEASE_LOCK')) return [[{ released: 1 }]];
        if (sql === 'START TRANSACTION') {
            assert.equal(snapshot, undefined);
            snapshot = { attempts: [...attempts], privateAccounts: [...privateAccounts], users };
            return [[]];
        }
        if (sql === 'COMMIT') { snapshot = undefined; return [[]]; }
        if (sql === 'ROLLBACK') {
            assert(snapshot);
            ({ attempts, privateAccounts, users } = snapshot); snapshot = undefined;
            return [[]];
        }
        if (sql.startsWith('SELECT COUNT(*)')) return [[{ pendingCount: attempts.length }]];
        if (sql.startsWith('INSERT INTO provider_auth_attempts')) {
            attempts.push({ state: values[0] as Buffer, binding: values[1] as Buffer, nonce: values[2] as string,
                client: values[3] as string, action: values[4] as string, userId: values[5] as null,
                accountId: values[6] as null, expiresAt: Date.now() + 300_000 });
            return [{ affectedRows: 1 }];
        }
        if (sql.startsWith('DELETE FROM provider_auth_attempts WHERE expires_at <=')) {
            const before = attempts.length;
            attempts = attempts.filter(attempt => attempt.expiresAt > Date.now());
            return [{ affectedRows: before - attempts.length }];
        }
        if (sql.startsWith('DELETE FROM provider_auth_attempts WHERE binding_hash')) {
            const before = attempts.length;
            attempts = attempts.filter(attempt => !same(attempt.binding, values[0])
                || (values.length > 1 && (attempt.client !== values[1] || attempt.action !== 'signup')));
            return [{ affectedRows: before - attempts.length }];
        }
        const matches = (attempt: Attempt) => same(attempt.state, values[0]) && same(attempt.binding, values[1])
            && attempt.client === values[2] && attempt.action === 'signup'
            && attempt.userId === null && attempt.accountId === null && attempt.expiresAt > Date.now();
        if (sql.startsWith('SELECT nonce')) return [attempts.filter(matches).map(attempt => ({ nonce: attempt.nonce }))];
        if (sql.startsWith('DELETE FROM provider_auth_attempts WHERE state_hash')) {
            const before = attempts.length;
            attempts = attempts.filter(attempt => !matches(attempt) || attempt.nonce !== values[3]);
            return [{ affectedRows: before - attempts.length }];
        }
        if (sql.startsWith('INSERT INTO account_score_permissions')) {
            if (failPrivate) throw new Error('synthetic private permission failure');
            privateAccounts.push(values[0] as string); return [{ affectedRows: 1 }];
        }
        if (sql.startsWith('INSERT INTO users')) { users++; return [{ affectedRows: 1 }]; }
        if (sql.startsWith('SELECT account_uuid AS accountId FROM users')) return [[{ accountId }]];
        throw new Error(`Unexpected synthetic SQL: ${sql}`);
    }
    const connection = { query, release() {}, destroy() {} } as unknown as PoolConnection;
    const database = { query, async getConnection() { acquisitions++; return connection; } } as unknown as Pool;
    return { calls, database, connection, service: createRegistrationAuthorization(database, policy),
        state: () => ({ attempts, privateAccounts, users, acquisitions }) };
}

test('general grant issuance stores only hashes, policy nonce and a bounded anonymous purpose', async () => {
    const f = fixture();
    assert.deepEqual(await f.service.begin(context(), { policyVersion: policy.version }),
        { allowed: true, country: null, ageBand: null });
    const [grant] = f.state().attempts;
    assert.equal(grant.client, 'registration-general');
    assert.equal(grant.action, 'signup');
    assert.equal(grant.nonce, policy.digest.toString('base64url'));
    assert.equal(grant.userId, null); assert.equal(grant.accountId, null);
    assert(!grant.binding.equals(context().bindingHash));
    assert(grant.expiresAt > Date.now() && grant.expiresAt <= Date.now() + 300_000);
    assert(!f.calls.some(call => /registration_profiles|registration_authorizations|UPDATE/u.test(call.sql)));
    const acquisitions = f.state().acquisitions;
    await f.service.assertAvailable(context());
    await f.service.assertAvailable(context());
    assert.equal(f.state().attempts.length, 1);
    assert.equal(f.state().acquisitions, acquisitions, 'availability reads never consume or borrow another transaction');
});

test('provider begin, general refresh and cancellation preserve the other purpose on the same browser', async () => {
    const f = fixture();
    const browser = context();
    await f.service.begin(browser, { policyVersion: policy.version });
    await createProviderAttempt(f.database, { stateHash: Buffer.alloc(32, 2), bindingHash: browser.bindingHash,
        nonce: Buffer.alloc(32, 3).toString('base64url'), clientKey: 'google-web', action: 'signup', userId: null, accountId: null });
    await f.service.assertAvailable(browser);
    assert.equal(f.state().attempts.length, 2);
    await f.service.begin(browser, { policyVersion: policy.version });
    assert.equal(f.state().attempts.length, 2);
    await f.service.cancel(browser);
    assert.deepEqual(f.state().attempts.map(attempt => attempt.client), ['google-web']);
    await assert.rejects(f.service.assertAvailable(browser), RegistrationRequiredError);
});

test('country, age and stale versions are rejected before SQL or connection acquisition', async () => {
    const f = fixture();
    for (const input of [{ policyVersion: 'old' }, { policyVersion: policy.version, ageBand: 'adult' },
        { policyVersion: policy.version, country: 'ZZ' }, { policyVersion: policy.version, parentApproved: true }]) {
        assert.deepEqual(await f.service.begin(context(), input), { allowed: false, reason: 'INVALID_REGISTRATION' });
    }
    assert.deepEqual(f.calls, []); assert.equal(f.state().acquisitions, 0);
});

test('expired bindings, wrong policy, nonce, target, purpose and expired rows cannot authorize creation', async () => {
    for (const invalid of ['binding', 'policy', 'nonce', 'user', 'account', 'client', 'action', 'expiry'] as const) {
        const f = fixture();
        await f.service.begin(context(), { policyVersion: policy.version });
        const grant = f.state().attempts[0];
        if (invalid === 'nonce') grant.nonce = Buffer.alloc(32, 9).toString('base64url');
        if (invalid === 'user') grant.userId = 1;
        if (invalid === 'account') grant.accountId = accountId;
        if (invalid === 'client') grant.client = 'google-web';
        if (invalid === 'action') grant.action = 'login';
        if (invalid === 'expiry') grant.expiresAt = Date.now() - 1;
        const service = invalid === 'policy' ? createRegistrationAuthorization(f.database,
            loadRegistrationPolicy({ ...environment, REGISTRATION_GENERAL_AUDIENCE_POLICY_VERSION: 'next-general' })) : f.service;
        const browser = invalid === 'binding' ? { ...context(), bindingExpiresAt: Date.now() - 1 } : context();
        await assert.rejects(service.consume(f.connection, browser, accountId), RegistrationRequiredError);
        assert.deepEqual(f.state().privateAccounts, []);
    }
});

test('password creation atomically consumes a single general grant and explicitly keeps scores private', async () => {
    const f = fixture();
    const browser = context();
    await f.service.begin(browser, { policyVersion: policy.version });
    f.calls.length = 0;
    const acquisitions = f.state().acquisitions;
    assert.equal(await createRegisteredPasswordAccount(f.database,
        { userName: 'synthetic', email: 'synthetic@example.test', passwordHash: 'synthetic-hash' },
        (connection, id) => f.service.consume(connection, browser, id)), 'created');
    assert.equal(f.state().acquisitions, acquisitions + 1, 'grant uses the account transaction connection');
    assert.equal(f.state().users, 1); assert.deepEqual(f.state().privateAccounts, [accountId]);
    assert.deepEqual(f.state().attempts, []);
    const privateInsert = f.calls.find(call => call.sql.startsWith('INSERT INTO account_score_permissions'))!;
    assert.match(privateInsert.sql, /VALUES \(\?, 'private', UTC_TIMESTAMP\(6\)\)/u);
    assert.deepEqual(privateInsert.values, [accountId]);
    assert.match(f.calls.find(call => call.sql.startsWith('SELECT nonce'))!.sql, /FOR UPDATE$/u);
    assert.equal(f.calls.at(-1)!.sql, 'COMMIT');
    assert(!f.calls.some(call => call.sql.includes('account_registration_profiles')));
    await assert.rejects(f.service.consume(f.connection, browser, accountId), RegistrationRequiredError);
    assert.deepEqual(f.state().privateAccounts, [accountId]);
});

test('private permission failure rolls back the new user and leaves the grant unconsumed', async () => {
    const f = fixture(true);
    const browser = context();
    await f.service.begin(browser, { policyVersion: policy.version });
    f.calls.length = 0;
    await assert.rejects(createRegisteredPasswordAccount(f.database,
        { userName: 'synthetic', email: 'synthetic@example.test', passwordHash: 'synthetic-hash' },
        (connection, id) => f.service.consume(connection, browser, id)), /could not be confirmed/u);
    assert.equal(f.calls.at(-1)!.sql, 'ROLLBACK');
    assert.equal(f.state().users, 0); assert.deepEqual(f.state().privateAccounts, []);
    assert.equal(f.state().attempts.length, 1);
    assert(!f.calls.some(call => call.sql.startsWith('DELETE FROM provider_auth_attempts')));
    await f.service.assertAvailable(browser);
});
