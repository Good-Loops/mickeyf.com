import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { PoolConnection } from 'mysql2/promise';
import * as sessions from '../migrations/accountSessionSchema';
import * as attempts from '../migrations/providerAttemptSchema';
import * as handoffs from '../migrations/appleAndroidHandoffSchema';
import { resetRestoredAuthentication, restoredAuthenticationState } from './restoredAuthentication';

const original = '11111111-1111-4111-8111-111111111111';
const target = '22222222-2222-4222-8222-222222222222';
const pins = { database: 'synthetic', serverUuid: target, originalServerUuid: original, currentUser: 'admin@localhost' };
const tables = ['account_sessions', 'provider_auth_attempts', 'apple_android_handoffs'] as const;
function fixture(options: { commitLost?: boolean; denied?: boolean; oldCheckpoint?: boolean; writers?: number; identity?: string; notHeld?: boolean } = {}) {
    const rows = new Map<string, number>(tables.map(table => [table, 1]));
    const queries: string[] = [];
    let destroyed = 0;
    const guard = { state: 'hold' as const, database: pins.database, serverUuid: original, epoch: target,
        expiresAt: '2027-01-01T00:00:00.000Z', generation: '1', ...(options.oldCheckpoint ? {
            recoveryCheckpoint: { lineage: target, minimumEpoch: '3', keySha256: 'a'.repeat(64) } } : {}) };
    const journal = { async readRestoreGuard() { return { ...guard, state: options.notHeld ? 'active' as const : 'hold' as const }; } };
    const connection = () => ({ destroy() { destroyed++; }, async query(input: { sql: string }) {
        const sql = input.sql; queries.push(sql);
        if (sql.includes('FROM account_recovery_checkpoint')) return [[{ databaseName: pins.database, currentUser: pins.currentUser,
            serverUuid: target, lineageId: target, checkpointEpoch: '2' }], []];
        if (sql.includes('USER_PRIVILEGES')) return [[{ count: 1 }], []];
        if (sql.includes('PROCESSLIST')) return [[{ count: options.writers ?? 0 }], []];
        if (sql.includes('CURRENT_USER')) return [[{ db: pins.database, user: pins.currentUser, serverUuid: options.identity ?? target }], []];
        const read = /^SELECT 1 AS present FROM (\w+) LIMIT 1$/u.exec(sql);
        if (read) {
            if (options.denied) throw Object.assign(new Error('denied'), { code: 'ER_TABLEACCESS_DENIED_ERROR' });
            return [rows.get(read[1]) ? [{ present: 1 }] : [], []];
        }
        if (sql === 'DELETE FROM account_sessions') rows.set('account_sessions', 0);
        else if (sql === 'DELETE FROM provider_auth_attempts') {
            rows.set('provider_auth_attempts', 0); rows.set('apple_android_handoffs', 0);
        } else if (sql === 'COMMIT' && options.commitLost) throw new Error('synthetic acknowledgement lost');
        else if (sql !== 'COMMIT' && sql !== 'START TRANSACTION') throw new Error('Unexpected SQL');
        return [[], []];
    } }) as unknown as PoolConnection;
    return { rows, queries, journal, connection, get destroyed() { return destroyed; } };
}
function reviewedSchema(t: TestContext) {
    t.mock.method(sessions, 'verifyOptionalAccountSessionSchema', async () => {});
    t.mock.method(attempts, 'verifyOptionalProviderAttemptSchema', async () => {});
    t.mock.method(handoffs, 'verifyAppleAndroidHandoffSchema', async () => {});
}

test('reset clears restored sessions and provider returns in one transaction; repeated reset is safe', async t => {
    reviewedSchema(t);
    const f = fixture();
    await resetRestoredAuthentication(f.connection(), f.journal, pins);
    assert.equal(await restoredAuthenticationState(f.connection()), 'clear');
    assert.deepEqual(f.queries.filter(query => /^(DELETE|START|COMMIT)/u.test(query)),
        ['START TRANSACTION', 'DELETE FROM account_sessions', 'DELETE FROM provider_auth_attempts', 'COMMIT']);
    await resetRestoredAuthentication(f.connection(), f.journal, pins);
    assert.equal(f.destroyed, 0);
});
test('original identity, active writers and an older checkpoint cannot start cleanup', async () => {
    const originalTarget = fixture();
    await assert.rejects(resetRestoredAuthentication(originalTarget.connection(), originalTarget.journal,
        { ...pins, originalServerUuid: target }));
    assert.equal(originalTarget.queries.length, 0);
    for (const options of [{ oldCheckpoint: true }, { writers: 1 }, { identity: original }, { notHeld: true }]) {
        const f = fixture(options);
        await assert.rejects(resetRestoredAuthentication(f.connection(), f.journal, pins));
        assert.equal(f.queries.some(sql => /^(DELETE|START)/u.test(sql)), false);
    }
});
test('permissions and schema drift fail before deletion', async t => {
    const denied = fixture({ denied: true });
    await assert.rejects(resetRestoredAuthentication(denied.connection(), denied.journal, pins));
    assert.equal(denied.queries.some(sql => sql.startsWith('DELETE')), false);
    t.mock.method(sessions, 'verifyOptionalAccountSessionSchema', async () => { throw new Error('schema drift'); });
    const drift = fixture();
    await assert.rejects(resetRestoredAuthentication(drift.connection(), drift.journal, pins));
    assert.equal(drift.queries.some(sql => /^(DELETE|START)/u.test(sql)), false);
});
test('a guard change before deletion keeps authentication intact', async t => {
    reviewedSchema(t);
    const f = fixture(); let reads = 0;
    const guard = await f.journal.readRestoreGuard();
    f.journal.readRestoreGuard = async () => ({ ...guard, generation: ++reads === 1 ? '1' : '2' });
    await assert.rejects(resetRestoredAuthentication(f.connection(), f.journal, pins));
    assert.equal(f.queries.some(sql => /^(DELETE|START)/u.test(sql)), false);
});
test('lost COMMIT acknowledgement remains unconfirmed and can be reconciled by a fresh held-target read', async t => {
    reviewedSchema(t);
    const f = fixture({ commitLost: true });
    await assert.rejects(resetRestoredAuthentication(f.connection(), f.journal, pins), /unconfirmed/u);
    assert.equal(f.destroyed, 1);
    assert.equal((await f.journal.readRestoreGuard()).state, 'hold');
    assert.equal(await restoredAuthenticationState(f.connection()), 'clear');
});
