import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { PRODUCTION_CLOUD_SQL_TARGET } from '../security/cloudSqlRuntimeRoleRemover';
import { runSignedParentFormRetention, readSignedParentFormRetentionInput } from './runSignedParentFormRetention';
import { SIGNED_FORM_RETENTION_FAILURE, type SignedParentFormRetentionReport } from './signedParentFormRetention';

const reference = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', sourceCommit = 'a'.repeat(40);
const environment = { MIGRATION_DB_HOST: '127.0.0.1', MIGRATION_DB_PORT: '13307', MIGRATION_DB_NAME: 'cms',
    MIGRATION_DB_USER: 'reviewed_owner', MIGRATION_DB_PASS: 'synthetic-private-value',
    MIGRATION_CONFIRM_DATABASE: 'cms', MIGRATION_CONFIRM_TARGET: '127.0.0.1:13307/cms',
    MIGRATION_CONFIRM_ACCOUNT: 'reviewed_owner@%', MIGRATION_CONFIRM_SERVER_UUID: PRODUCTION_CLOUD_SQL_TARGET.serverUuid,
    MIGRATION_CONFIRM_CLOUD_SQL_PROJECT: PRODUCTION_CLOUD_SQL_TARGET.project,
    MIGRATION_CONFIRM_CLOUD_SQL_INSTANCE: PRODUCTION_CLOUD_SQL_TARGET.instance,
    MIGRATION_CONFIRM_CLOUD_SQL_CONNECTION_NAME: PRODUCTION_CLOUD_SQL_TARGET.connectionName,
    MIGRATION_CONFIRM_SERVER_VERSION: '8.0.31-google', MIGRATION_CONFIRM_VERSION_COMMENT: 'Synthetic test only',
    CHILD_SIGNED_FORM_SOURCE_COMMIT: sourceCommit };
const input = () => Readable.from([JSON.stringify({ references: [reference] })]);
const report: SignedParentFormRetentionReport = { schemaVersion: 1, operation: 'observe-signed-parent-form-retention',
    sourceCommit, observedAt: '2026-10-21T12:00:00.000Z', target: { project: PRODUCTION_CLOUD_SQL_TARGET.project,
        instance: PRODUCTION_CLOUD_SQL_TARGET.instance, database: 'cms', serverUuid: PRODUCTION_CLOUD_SQL_TARGET.serverUuid },
    schemaSha256: 'b'.repeat(64), grantsSha256: 'c'.repeat(64), requests: [{ reference, state: 'not-found', expiresAt: null }] };

test('CLI has no filesystem/SQL/target/mutation argument and validates stdin before connecting', async () => {
    for (const args of [['inspect'], ['--input', 'private.csv'], ['--output', 'report.json'], ['apply'], ['--target', 'local'], ['SELECT 1']]) {
        await assert.rejects(runSignedParentFormRetention(args, {}, { input: input(), connect() { assert.fail('must not connect'); } }),
            { message: SIGNED_FORM_RETENTION_FAILURE });
    }
    for (const content of ['', '{', '[]', '{"references":[],"ledger":"private"}', 'x'.repeat(8193)]) {
        await assert.rejects(runSignedParentFormRetention([], {}, { input: Readable.from([content]), connect() { assert.fail('must not connect'); } }),
            { message: SIGNED_FORM_RETENTION_FAILURE });
    }
    const failed = (async function* () { throw new Error('private stream information'); })();
    await assert.rejects(readSignedParentFormRetentionInput(failed), { message: SIGNED_FORM_RETENTION_FAILURE });
});

test('real settings parser rejects missing/foreign production confirmations before a connection', async () => {
    for (const env of [{}, { ...environment, MIGRATION_DB_NAME: 'test' },
        { ...environment, MIGRATION_CONFIRM_SERVER_UUID: 'wrong' }, { ...environment, MIGRATION_DB_HOST: 'remote' },
        { ...environment, MIGRATION_CONFIRM_ACCOUNT: 'other@%' }, { ...environment, CHILD_SIGNED_FORM_SOURCE_COMMIT: 'main' }]) {
        await assert.rejects(runSignedParentFormRetention([], env, { input: input(), connect() { assert.fail('must not connect'); } }),
            { message: SIGNED_FORM_RETENTION_FAILURE });
    }
});

test('fixed source/account/target settings reach observer; dedicated session closes before the sole complete stdout write', async () => {
    const events: string[] = [];
    let output = '';
    await runSignedParentFormRetention([], environment, { input: input(),
        assertSource(expected, _run, env) {
            events.push('source'); assert.equal(expected, sourceCommit); assert.equal(env, environment);
        }, connect(config) {
            events.push('connect'); assert.equal(config.host, '127.0.0.1'); assert.equal(config.database, 'cms');
            assert.equal(config.operationTimeoutMs, 30_000);
            return { connection: { async query() { assert.fail('synthetic observer owns fixture'); } }, async close() { events.push('close'); } };
        }, async observe(deps, refs) {
            events.push('observe'); assert.deepEqual(refs, [reference]); assert.deepEqual(deps.settings.target, report.target);
            assert.equal(deps.settings.expectedCurrentUser, 'reviewed_owner@%'); assert.equal(deps.source.sourceCommit, sourceCommit);
            deps.assertSource?.(); return report;
        }, write(text) { events.push('stdout'); output += text; } });
    assert.deepEqual(events, ['source', 'connect', 'observe', 'source', 'close', 'stdout']);
    assert.deepEqual(JSON.parse(output), report);
    assert.doesNotMatch(output, /synthetic-private-value|reviewed_owner|verified_contact|parent_uuid|child_uuid/u);
});

test('failed lookup, clean-source check or session close never emits a partial/absence report or private errors', async () => {
    for (const failure of ['source', 'lookup', 'close']) {
        let writes = 0, closes = 0;
        await assert.rejects(runSignedParentFormRetention([], environment, { input: input(),
            assertSource() { if (failure === 'source') throw new Error('private git details'); },
            connect() { return { connection: { async query() { return [[], []]; } }, async close() {
                closes++; if (failure === 'close') throw new Error('private driver details');
            } }; }, async observe() {
                if (failure === 'lookup') throw new Error('private contact and partial rows'); return report;
            }, write() { writes++; } }), { message: SIGNED_FORM_RETENTION_FAILURE });
        assert.equal(writes, 0); assert.equal(closes, failure === 'source' ? 0 : 1);
    }
});
