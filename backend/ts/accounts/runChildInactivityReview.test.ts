import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import type { MigrationConnection } from '../migrations/leaderboardSchema';
import type { childSchemaCommandSettings } from '../migrations/runChildSignedFormSchema';
import { runChildInactivityReview } from './runChildInactivityReview';

const id = (n: number) => `aaaaaaaa-bbbb-4ccc-8ddd-${n.toString(16).padStart(12, '0')}`;
const time = '2026-10-31T12:00:00.000000Z';
const identity = { databaseName: 'cms', currentUser: 'migration@localhost', serverUuid: id(1),
    serverVersion: '8.0.31-test', versionComment: 'synthetic', observedAt: time };
const settings = { config: {}, source: { sourceCommit: 'a'.repeat(40) },
    settings: { target: { database: identity.databaseName, serverUuid: identity.serverUuid },
        expectedCurrentUser: identity.currentUser, expectedServerVersion: identity.serverVersion, expectedVersionComment: identity.versionComment } } as unknown as ReturnType<typeof childSchemaCommandSettings>;

function fixture(data: unknown = [], changedIdentity = false, closeFails = false) {
    const statements: { sql: string; values?: unknown[] }[] = []; let identities = 0, output = '', checks = 0;
    const connection: MigrationConnection = { async query(sql, values) {
        statements.push({ sql, values });
        if (sql.startsWith('SELECT DATABASE()')) {
            identities++;
            return [[identities === 2 && changedIdentity ? { ...identity, serverUuid: id(3) } : identity], []];
        }
        if (sql.includes('FROM parent_child_consents c LEFT JOIN')) return [data, []];
        return [[], []];
    } };
    const deps = { settings: () => settings, assertSource() { checks++; },
        connect: () => ({ connection, async close() { if (closeFails) throw new Error('private error'); } }),
        write(value: string) { output = value; } };
    return { deps, statements, get output() { return output; }, get checks() { return checks; } };
}

test('prints only private review information after pinned source, target, query and close succeed', async () => {
    const f = fixture([{ parentId: id(9), childId: id(1), activityAt: '2020-01-01T00:00:00.000001Z' },
        { parentId: id(8), childId: id(2), activityAt: null }]);
    await runChildInactivityReview([], {}, { ...f.deps, input: Readable.from(['{"afterChildId":null}']) });
    const report = JSON.parse(f.output);
    assert.equal(report.draftOnly, true); assert.equal(report.nextAfterChildId, null);
    assert.deepEqual(report.candidates.map((row: { review: string }) => row.review), ['potentially-approaching-warning', 'missing-activity']);
    assert.match(report.warning, /does not establish eligibility or authorize contact, warning or deletion/u);
    assert.match(report.warning, /obsolete, unsendable draft/u);
    assert.match(report.draft.en, /If you acknowledge/u);
    assert.equal(f.checks, 2);
    assert.deepEqual(f.statements.map(({ sql }) => sql.trim().split(/\s+/u)[0]), ['START', 'SELECT', 'SELECT', 'SELECT', 'ROLLBACK']);
    assert.deepEqual(f.statements[2].values, [null, null]);
    assert.doesNotMatch(f.output, /@|verifiedContact|recipient|password/u);
});

test('bounded paging returns a cursor and validates every row before writing', async () => {
    const rows = Array.from({ length: 101 }, (_, i) => ({ parentId: id(1000), childId: id(i + 1), activityAt: time }));
    const f = fixture(rows);
    await runChildInactivityReview([], {}, { ...f.deps, input: Readable.from(['{"afterChildId":null}']) });
    const report = JSON.parse(f.output);
    assert.equal(report.candidates.length, 100); assert.equal(report.nextAfterChildId, id(100));
    rows[100] = { ...rows[100], childId: 'not-valid' };
    const invalid = fixture(rows);
    await assert.rejects(runChildInactivityReview([], {}, { ...invalid.deps, input: Readable.from(['{"afterChildId":null}']) }));
    assert.equal(invalid.output, '');
});

test('invalid input, unexpected private fields, target drift and close failure withhold the complete page', async () => {
    for (const scenario of ['input', 'row', 'drift', 'close']) {
        const f = fixture(scenario === 'row' ? [{ parentId: id(9), childId: id(1), activityAt: null, email: 'private@example.test' }] : [], scenario === 'drift', scenario === 'close');
        await assert.rejects(runChildInactivityReview([], {}, { ...f.deps, input: Readable.from([scenario === 'input' ? '{"afterChildId":null,"email":"x"}' : '{"afterChildId":null}']) }),
            { message: 'Inactivity review unavailable; no complete page was produced.' });
        assert.equal(f.output, '');
        if (scenario === 'input') assert.equal(f.statements.length, 0);
    }
});
