import assert from 'node:assert/strict';
import test from 'node:test';
import type { PoolConnection } from 'mysql2/promise';
import { applyRecoveryCheckpointSetup, planRecoveryCheckpointSetup } from './recoveryCheckpointSetup';

test('a lost DDL acknowledgement destroys the session and is never retried', async () => {
    const uuid = '572ed45a-c57d-4c82-9b50-d4585331bcec';
    const pins = { database: 'synthetic', currentUser: 'operator@localhost', serverUuid: uuid };
    let created = false, destroyed = false, writes = 0;
    const connection = { destroy() { destroyed = true; }, async query(input: string | { sql: string }) {
        const sql = typeof input === 'string' ? input : input.sql;
        if (sql.includes('GET_LOCK')) return [[{ acquired: 1 }], []];
        if (sql.includes('RELEASE_LOCK')) return [[{ released: 1 }], []];
        if (sql.includes('CURRENT_USER()')) return [[{ db: pins.database, user: pins.currentUser, uuid }], []];
        if (sql.includes('information_schema.TABLES')) return [created ? [{ TABLE_NAME: 'account_recovery_checkpoint' }] : [], []];
        if (sql.includes('CREATE TABLE account_recovery_checkpoint')) { created = true; writes++; throw new Error('lost acknowledgement'); }
        throw new Error('unexpected query');
    } } as unknown as PoolConnection;
    const guard = { async readRestoreGuard() { return { state: 'hold' as const, database: pins.database, serverUuid: uuid,
        epoch: uuid, expiresAt: '2027-01-01T00:00:00.000Z', generation: '1' }; }, async assertRestoreGuardHistory() {} };
    const deps = { connection, pins, guard, sourceCommit: 'a'.repeat(40), verifySource() {},
        async verifyAccountSchema() {}, async verifyWritersFenced() {}, async verifyRecoveryAvailable() {} };
    const plan = await planRecoveryCheckpointSetup(deps);
    await assert.rejects(applyRecoveryCheckpointSetup(deps, plan, { sha256: plan.sha256, writers: 'ORIGINAL PRIMARY AND ALL WRITERS FENCED' }));
    assert.equal(destroyed, true); assert.equal(writes, 1);
    await assert.rejects(planRecoveryCheckpointSetup(deps));
    assert.equal(writes, 1);
});
