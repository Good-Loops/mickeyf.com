import assert from 'node:assert/strict';
import test from 'node:test';
import type { MigrationConnection } from '../migrations/leaderboardSchema';
import { fixture, settings, legacyCheck } from '../migrations/childSignedFormMetadata.testFixture';
import { CHILD_SIGNED_FORM_SQL_SHA256 } from '../migrations/childSignedFormOperation';
import { observeSignedParentFormRetention, parseSignedParentFormRetentionInput, SIGNED_FORM_RETENTION_FAILURE } from './signedParentFormRetention';

const id = (n: number) => `aaaaaaaa-bbbb-4ccc-8ddd-${n.toString(16).padStart(12, '0')}`;
const source = { sourceCommit: 'a'.repeat(40), sqlSha256: CHILD_SIGNED_FORM_SQL_SHA256 };
const future = '2030-01-01T00:00:00.000001Z', past = '2020-01-01T00:00:00.000001Z';
const row = (n: number, status: string, expired = 0) => ({ reference: id(n), status, expiresAt: expired ? past : future, expired });
function reportFixture(extended = true) {
    const f = fixture(extended);
    const lookups: { sql: string; values?: unknown[] }[] = [];
    let result: unknown = [];
    let lookup: (() => void) | undefined;
    const connection: MigrationConnection = { async query(sql, values) {
        if (sql.includes('FROM parent_signed_forms WHERE reference IN')) {
            lookups.push({ sql, values }); lookup?.();
            return [result, []];
        }
        return f.connection.query(sql, values);
    } };
    return { f, lookups, deps: { connection, settings, source }, setRows(value: unknown) { result = value; },
        onLookup(action: () => void) { lookup = action; } };
}

test('all requested references are reported in input order, with server expiry and minimal immutable output on both schemas', async () => {
    for (const extended of [false, true]) {
        const f = reportFixture(extended);
        f.setRows([row(1, 'pending'), row(2, 'approved'), row(3, 'rejected', 1), row(4, 'approved', 1), row(5, 'used', 1), row(7, 'pending', 1)]);
        const input = [id(5), id(1), id(6), id(4), id(3), id(2), id(7)];
        const report = await observeSignedParentFormRetention(f.deps, input);
        assert.deepEqual(report.requests.map(item => item.reference), input);
        assert.deepEqual(report.requests.map(item => item.state), ['used', 'pending', 'not-found', 'expired-unused', 'rejected', 'approved', 'expired-unused']);
        assert.equal(report.requests[0].expiresAt, past); assert.equal(report.requests[2].expiresAt, null);
        assert.equal(report.sourceCommit, source.sourceCommit); assert.deepEqual(report.target, settings.target);
        assert.deepEqual(Object.keys(report).sort(), ['grantsSha256', 'observedAt', 'operation', 'requests', 'schemaSha256', 'schemaVersion', 'sourceCommit', 'target']);
        for (const item of report.requests) assert.deepEqual(Object.keys(item).sort(), ['expiresAt', 'reference', 'state']);
        assert.throws(() => Object.assign(report.requests[0], { state: 'not-found' }), TypeError);
        assert.equal(f.lookups.length, 1); assert.deepEqual(f.lookups[0].values, input);
        assert.match(f.lookups[0].sql, /expires_at <= UTC_TIMESTAMP\(6\)/u);
        assert.match(f.lookups[0].sql, /LIMIT 101/u);
        assert.doesNotMatch(f.lookups[0].sql, /user_name|verified_contact|parent_uuid|child_uuid|subject|reviewer|form_sha256|password/iu);
        assert(f.f.calls.every(call => /^(?:SELECT|SHOW CREATE TABLE)\b/u.test(call.sql.trim())));
        assert.doesNotMatch(JSON.stringify(report), /userName|verifiedContact|parentAccountId|childAccountId|password|provider|signature|attachment/iu);
    }
});

test('a successful zero-row lookup means not-found, while query or post-lookup metadata failure yields no report', async () => {
    const f = reportFixture();
    assert.equal((await observeSignedParentFormRetention(f.deps, [id(1)])).requests[0].state, 'not-found');
    for (const failure of ['lookup', 'metadata']) {
        const next = reportFixture(); next.setRows([row(1, 'approved')]);
        next.onLookup(() => {
            if (failure === 'lookup') throw new Error('private driver message and contact');
            next.f.identity.databaseName = 'wrong';
        });
        await assert.rejects(observeSignedParentFormRetention(next.deps, [id(1), id(2)]), { message: SIGNED_FORM_RETENTION_FAILURE });
    }
});

test('unknown states, malformed expiry/flags, duplicates, unrequested references and extra personal fields reject the entire batch', async () => {
    for (const rows of [
        [row(1, 'unexpected')], [row(1, 'approved'), row(1, 'approved')], [row(2, 'pending')],
        [{ ...row(1, 'pending'), expiresAt: '2030-02-30T00:00:00.000000Z' }],
        [{ ...row(1, 'pending'), expiresAt: new Date() }], [{ ...row(1, 'pending'), expired: '0' }],
        [{ ...row(1, 'pending'), expired: 2 }], [{ ...row(1, 'pending'), verified_contact: 'private@example.test' }], null,
    ]) {
        const f = reportFixture(); f.setRows(rows);
        await assert.rejects(observeSignedParentFormRetention(f.deps, [id(1)]), { message: SIGNED_FORM_RETENTION_FAILURE });
    }
});

test('exact reference-only input is bounded, unique, lowercase and validated before any source/SQL operation', async () => {
    for (const input of [null, [], { references: [] }, { references: [id(1)], filename: 'private.csv' },
        { references: [id(1), id(1)] }, { references: [id(1).toUpperCase()] }, { references: ['../private.csv'] },
        { references: ['00000000-0000-0000-0000-000000000000'] }, { references: [null] },
        { references: Array.from({ length: 101 }, (_, index) => id(index + 1)) }]) {
        assert.throws(() => parseSignedParentFormRetentionInput(input), { message: SIGNED_FORM_RETENTION_FAILURE });
    }
    const f = reportFixture();
    await assert.rejects(observeSignedParentFormRetention(f.deps, [id(1), id(1)]));
    assert.equal(f.lookups.length, 0); assert.equal(f.f.calls.length, 0);
    const maximum = Array.from({ length: 100 }, (_, index) => id(index + 1));
    const parsed = parseSignedParentFormRetentionInput({ references: maximum });
    assert.deepEqual(parsed, maximum);
    const report = await observeSignedParentFormRetention(f.deps, parsed);
    assert.equal(report.requests.length, 100); assert.equal(f.lookups[0].values?.length, 100);
});

test('source/SQL mismatch blocks before lookup, and source drift after lookup withholds the complete report', async () => {
    for (const changedSource of [{ ...source, sourceCommit: 'main' }, { ...source, sqlSha256: 'b'.repeat(64) }]) {
        const f = reportFixture();
        await assert.rejects(observeSignedParentFormRetention({ ...f.deps, source: changedSource }, [id(1)]));
        assert.equal(f.f.calls.length, 0); assert.equal(f.lookups.length, 0);
    }
    const f = reportFixture(); let checks = 0;
    await assert.rejects(observeSignedParentFormRetention({ ...f.deps, assertSource() {
        if (++checks === 2) throw new Error('source changed');
    } }, [id(1)]), { message: SIGNED_FORM_RETENTION_FAILURE });
    assert.equal(checks, 2); assert.equal(f.lookups.length, 1);
});

test('otherwise-valid schema capability or grant metadata drift between observations rejects the report', async () => {
    for (const change of ['schema', 'grants']) {
        const f = reportFixture(false);
        f.onLookup(() => {
            if (change === 'schema') {
                f.f.schema.nullable = 'YES'; f.f.schema.columns[3].nullable = 'YES';
                f.f.schema.check = legacyCheck.replace("(country_code='US')", "(country_codein('US','BR'))");
            } else (f.f.grants.columns as object[]).push({ tableName: 'users', columnName: 'unexpected_metadata' });
        });
        await assert.rejects(observeSignedParentFormRetention(f.deps, [id(1)]), { message: SIGNED_FORM_RETENTION_FAILURE });
    }
});
