import assert from 'node:assert/strict';
import test from 'node:test';
import type { PoolConnection } from 'mysql2/promise';
import { verifyDeletedAccountEffects } from './verifiedDeletionEffects';

const account = '42a23d28-40cf-4d69-9fdb-74206ef3fa70';
function fixture(options: { remaining?: string; handoff?: boolean; recorded?: boolean; fail?: boolean } = {}) {
    const connection = { async query(query: { sql: string }) {
        if (options.fail) throw new Error('private database detail');
        const sql = query.sql;
        if (sql.includes('information_schema.TABLES')) return [[{ count: options.handoff ? 1 : 0 }], []];
        if (sql.includes('schema_migrations')) return [options.recorded ? [{ version: '0027_create_apple_android_handoffs' }] : [], []];
        return [options.remaining && sql.includes(options.remaining) ? [{}] : [], []];
    } } as unknown as PoolConnection;
    return connection;
}

test('only an absent account without remaining token or linked transient rows qualifies as observed deleted', async () => {
    assert.equal(await verifyDeletedAccountEffects(fixture(), [account]), true);
    assert.equal(await verifyDeletedAccountEffects(fixture({ handoff: true, recorded: true }), [account]), true);
    for (const remaining of ['FROM users', 'FROM apple_provider_tokens', 'FROM parent_registration_attempts', 'FROM apple_android_handoffs']) {
        assert.equal(await verifyDeletedAccountEffects(fixture({ remaining, handoff: true, recorded: true }), [account]), false);
    }
});

test('missing or inconsistent schema and untrusted account inventories fail closed', async () => {
    for (const options of [{ handoff: true }, { recorded: true }]) {
        assert.equal(await verifyDeletedAccountEffects(fixture(options), [account]), false);
    }
    await assert.rejects(verifyDeletedAccountEffects(fixture({ fail: true }), [account]), /could not be checked/);
    assert.equal(await verifyDeletedAccountEffects(fixture(), []), false);
    assert.equal(await verifyDeletedAccountEffects(fixture(), [account, account]), false);
    assert.equal(await verifyDeletedAccountEffects(fixture(), ['not-an-id']), false);
});
