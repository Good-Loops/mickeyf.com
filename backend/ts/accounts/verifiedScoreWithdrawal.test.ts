import assert from 'node:assert/strict';
import test from 'node:test';
import type { PoolConnection } from 'mysql2/promise';
import { verifyScoreWithdrawal } from './verifiedScoreWithdrawal';

const accountId = '42a23d28-40cf-4d69-9fdb-74206ef3fa70';
function fixture(options: { public?: boolean; oldPermission?: boolean; unwithdrawnForm?: boolean; liveGrant?: boolean } = {}) {
    const connection = { async query(input: { sql: string }) {
        if (input.sql.includes('FROM users')) return [[{ account_uuid: accountId }], []];
        if (input.sql.includes('FROM account_score_permissions')) return [[{ visibility: options.public ? 'public' : 'private',
            policy_digest: options.oldPermission ? Buffer.alloc(32) : null, registration_policy_version: null,
            country_code: null, age_band: null, authorizer_uuid: null }], []];
        if (input.sql.includes('FROM parent_signed_forms')) return [options.unwithdrawnForm ? [{ reference: 'synthetic' }] : [], []];
        if (input.sql.includes('FROM parent_registration_attempts')) return [options.liveGrant ? [{ state_hash: 'synthetic' }] : [], []];
        throw new Error('Unexpected withdrawal check');
    } } as unknown as PoolConnection;
    return connection;
}

test('a withdrawal requires private visibility, cleared permission, revoked form and no live grant', async () => {
    assert.equal(await verifyScoreWithdrawal(fixture(), accountId), true);
    for (const option of [{ public: true }, { oldPermission: true }, { unwithdrawnForm: true }, { liveGrant: true }]) {
        assert.equal(await verifyScoreWithdrawal(fixture(option), accountId), false);
    }
});
