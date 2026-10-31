import assert from 'node:assert/strict';
import test from 'node:test';
import { assertAccountIdentityEpoch, verifyAccountIdentityPrecondition } from './accountIdentitySchema';
import type { MigrationConnection } from './leaderboardSchema';

function source(format: string, binaryLogging = 1): MigrationConnection {
    return { async query(sql) {
        if (sql.includes('information_schema.TABLES')) return [[{ engine: 'InnoDB' }], []];
        if (sql.includes('information_schema.COLUMNS')) return [[], []];
        if (sql.includes('@@log_bin')) return [[{ format, binaryLogging }], []];
        throw new Error('Unexpected identity metadata query');
    } };
}

test('identity migration accepts ROW/MIXED and refuses statement-based UUID regeneration', async () => {
    await verifyAccountIdentityPrecondition(source('ROW'));
    await verifyAccountIdentityPrecondition(source('MIXED'));
    await assert.rejects(() => verifyAccountIdentityPrecondition(source('STATEMENT')), /ROW or MIXED/);
    await assert.rejects(() => verifyAccountIdentityPrecondition(source('ROW', Number.NaN)), /ROW or MIXED/);
});

test('identity epoch requires the independently pinned original timestamp, not a later re-backfill', async () => {
    const original = '2026-09-11 19:00:00.123456';
    let queried = false;
    const connection: MigrationConnection = { async query() {
        queried = true;
        return [[{ epoch: original }], []];
    } };
    await assert.rejects(() => assertAccountIdentityEpoch(connection, '2026-09-11'), /six fractional digits/);
    assert.equal(queried, false);
    await assertAccountIdentityEpoch(connection, original);
    await assert.rejects(() => assertAccountIdentityEpoch(connection, '2026-09-12 19:00:00.123456'), /independently approved/);
    await assert.rejects(() => assertAccountIdentityEpoch({ async query() { return [[], []]; } }, original),
        /independently approved/);
});
