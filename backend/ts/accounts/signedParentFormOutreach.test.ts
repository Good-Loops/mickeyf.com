import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'mysql2/promise';
import { pendingParentFormOutreach } from './signedParentFormOutreach';

const reference = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const row = (n: number) => ({ reference: reference(n), verified_contact: `parent${n}@example.test`,
    country_code: 'US', provider: 'apple', provider_linked: 1, policy_digest: 'A'.repeat(64),
    policy_version: 'synthetic-policy', consent_version: 'synthetic-consent',
    submitted_at: '2026-11-01T01:02:03.000000Z', expires_at: '2026-11-15T01:02:03.000000Z' });
function fixture(rows: unknown) {
    const calls: Array<{ sql: string; values: unknown }> = [];
    const database = { async query(options: { sql: string }, values: unknown) {
        calls.push({ sql: options.sql, values }); return [rows, []];
    } } as unknown as Pick<Pool, 'query'>;
    return { database, calls };
}

test('returns a bounded pending page and a cursor without approving or sending', async () => {
    const f = fixture(Array.from({ length: 51 }, (_, index) => row(index + 2)));
    const result = await pendingParentFormOutreach(f.database, reference(1));
    assert.equal(result.requests.length, 50);
    assert.equal(result.nextAfter, reference(51));
    assert.deepEqual(result.requests[0], { reference: reference(2), verifiedContact: 'parent2@example.test',
        providerLinked: true, country: 'US', provider: 'apple', policyDigest: 'A'.repeat(64), policyVersion: 'synthetic-policy',
        consentVersion: 'synthetic-consent', submittedAt: '2026-11-01T01:02:03.000000Z', expiresAt: '2026-11-15T01:02:03.000000Z' });
    assert.deepEqual(f.calls[0].values, [reference(1), reference(1)]);
    assert.match(f.calls[0].sql, /status='pending'[\s\S]*expires_at>UTC_TIMESTAMP\(6\)/u);
    assert.doesNotMatch(f.calls[0].sql, /\b(UPDATE|INSERT|DELETE)\b/iu);
});

test('empty pages are distinct from failed and malformed inventories', async () => {
    assert.deepEqual(await pendingParentFormOutreach(fixture([]).database, null), { requests: [], nextAfter: null });
    for (const rows of [[row(2), row(1)], [{ ...row(1), verified_contact: 'bad\u0000@example.test' }],
        [{ ...row(1), expires_at: '2020-11-15T01:02:03.000000Z' }], [{ ...row(1), policy_digest: 'bad' }],
        [row(1), row(1)], 'not rows']) {
        await assert.rejects(pendingParentFormOutreach(fixture(rows).database, null));
    }
    const f = fixture([]);
    await assert.rejects(pendingParentFormOutreach(f.database, 'not-a-reference'));
    assert.equal(f.calls.length, 0);
});

test('a no-longer-linked provider is a hold and the address is not disclosed', async () => {
    const result = await pendingParentFormOutreach(fixture([{ ...row(1), provider_linked: 0 }]).database, null);
    assert.equal(result.requests[0].providerLinked, false);
    assert.equal(result.requests[0].verifiedContact, null);
    await assert.rejects(pendingParentFormOutreach(fixture([{ ...row(1), provider_linked: null }]).database, null));
});
