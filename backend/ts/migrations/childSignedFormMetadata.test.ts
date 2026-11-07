import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { observeChildSignedFormMetadata, createChildSignedFormSchemaReceipt } from './childSignedFormMetadata';
import { fixture, settings, legacyCheck } from './childSignedFormMetadata.testFixture';

const sqlSha256 = createHash('sha256').update(readFileSync(path.resolve(__dirname,
    '../../migrations/pending/0028_extend_child_signed_parent_forms.sql'))).digest('hex');
const source = { sourceCommit: 'a'.repeat(40), sqlSha256 };
test('actual metadata-only verifiers distinguish exact legacy and extended schema with stable immutable digests', async () => {
    const digests: { grants: string; schema: string }[] = [];
    for (const extended of [false, true]) {
        const f = fixture(extended);
        const first = await observeChildSignedFormMetadata(f.connection, settings);
        const second = await observeChildSignedFormMetadata(f.connection, settings);
        assert.equal(first.capability, extended ? 'nullable-parent-request-us-br' : 'legacy-us');
        assert.equal(first.history.length, 26); assert.equal(first.identity.currentUser, 'root@%');
        assert.equal(first.schemaSha256, second.schemaSha256); assert.equal(first.grantsSha256, second.grantsSha256);
        assert.match(first.schemaSha256, /^[a-f0-9]{64}$/u); assert.match(first.grantsSha256, /^[a-f0-9]{64}$/u);
        assert.equal(first.grants.credentialExpiryState, 'current'); assert.equal('passwordExpired' in first.grants, false);
        digests.push({ grants: first.grantsSha256, schema: first.schemaSha256 });
        assert.throws(() => Object.assign(first.target, { database: 'other' }), TypeError);
        assert(f.calls.every(call => !/\bFROM (?:users|parent_signed_forms|account_sessions|account_provider_identities)\b/iu.test(call.sql)));
        assert(f.calls.every(call => !/authentication_string|encrypted_token|verified_contact\s+FROM/iu.test(call.sql)));
        if (extended) {
            const receipt = createChildSignedFormSchemaReceipt(first, source);
            assert.deepEqual(Object.keys(receipt).sort(), ['capability', 'grantsSha256', 'operation', 'runtimeGrantProfile', 'schemaSha256', 'schemaVersion', 'sourceCommit', 'sqlSha256', 'target', 'verifiedAt']);
            assert.equal(receipt.verifiedAt, first.observedAt); assert.equal(receipt.runtimeGrantProfile, 'google-apple-parent-signed');
        } else assert.throws(() => createChildSignedFormSchemaReceipt(first, source), /does not match/u);
    }
    assert.equal(digests[0].grants, digests[1].grants, 'nullability and BR check extension do not change runtime privileges');
    assert.notEqual(digests[0].schema, digests[1].schema);
});

test('identity/version/account mismatch stops before history or schema/grant inspection', async () => {
    for (const patch of [{ databaseName: 'other' }, { currentUser: 'cms_mickeyf@%' }, { serverUuid: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff' },
        { serverVersion: '8.0.32' }, { versionComment: 'Unreviewed vendor' }]) {
        const f = fixture(); Object.assign(f.identity, patch);
        await assert.rejects(observeChildSignedFormMetadata(f.connection, settings), /does not match/u); assert.equal(f.calls.length, 1);
    }
});

test('exact0001–0026 history rejects missing, unexpected, duplicate, reordered and mismatched checksum rows', async () => {
    for (const change of [(rows: ReturnType<typeof fixture>['history']) => rows.pop(),
        (rows: ReturnType<typeof fixture>['history']) => rows.push({ version: '0027_unreviewed', checksum: Buffer.alloc(32) }),
        (rows: ReturnType<typeof fixture>['history']) => { rows[25] = rows[24]; },
        (rows: ReturnType<typeof fixture>['history']) => rows.reverse(),
        (rows: ReturnType<typeof fixture>['history']) => { rows[0].checksum = Buffer.alloc(32); }]) {
        const f = fixture(); change(f.history);
        await assert.rejects(observeChildSignedFormMetadata(f.connection, settings), /does not match/u);
        assert.equal(f.calls.some(call => call.sql.includes('SELECT IS_NULLABLE')), false);
    }
});

test('a view or altered history-table definition is rejected before reading otherwise valid checksum rows', async () => {
    for (const change of [(f: ReturnType<typeof fixture>) => { f.schema.historyEngine = 'view'; },
        (f: ReturnType<typeof fixture>) => { f.schema.historyColumns[1].type = 'binary(31)'; }]) {
        const f = fixture(); change(f);
        await assert.rejects(observeChildSignedFormMetadata(f.connection, settings), /schema_migrations/u);
        assert.equal(f.calls.some(call => call.sql.startsWith('SELECT version, checksum')), false);
    }
});

test('partial nullable/country changes or altered schema columns never count as a capability', async () => {
    for (const change of [(f: ReturnType<typeof fixture>) => { f.schema.check = legacyCheck; },
        (f: ReturnType<typeof fixture>) => { f.schema.columns[3].nullable = 'NO'; },
        (f: ReturnType<typeof fixture>) => { f.schema.columns.pop(); }]) {
        const f = fixture(); change(f);
        await assert.rejects(observeChildSignedFormMetadata(f.connection, settings), /schema|columns|constraint/u);
        assert.equal(f.calls.some(call => call.sql.includes('runtime-grants:')), false);
    }
});

test('runtime broad/grantable/role/proxy/global/missing privileges cannot borrow observer privileges', async () => {
    for (const patch of [
        { column: [] }, { table: [] }, { 'static-global-values': [{ Select_priv: 'Y', Process_priv: 'N' }] },
        { global: [{ privilegeType: 'SELECT', isGrantable: 'NO' }] }, { 'dynamic-global': [{ privilegeType: 'SYSTEM_USER', isGrantable: 'NO' }] },
        { schema: [{ schemaName: settings.target.database, privilegeType: 'SELECT', isGrantable: 'NO' }] },
        { 'assigned-roles': [{ user: 'cloudsqlsuperuser', host: '%', withAdminOption: false }] },
        { 'default-roles': [{ user: 'cloudsqlsuperuser', host: '%' }] },
        { proxy: [{ proxiedUser: 'owner', proxiedHost: '%', withGrant: false }] },
        { 'inbound-proxy': [{ user: 'owner', host: '%', withGrant: false }] },
        { 'outgoing-roles': [{ granteeUser: 'owner', granteeHost: '%', withAdminOption: false }] },
        { account: [{ exactAccountCount: 1, accountNameCount: 2, accountLocked: 'N', passwordExpired: 'N', hasPrivilegeRestrictions: 0 }] },
    ]) {
        const f = fixture(); Object.assign(f.grants, patch);
        await assert.rejects(observeChildSignedFormMetadata(f.connection, settings), /does not match/u);
    }
    const f = fixture(); const columns = f.grants.column as { isGrantable: string }[]; columns[0].isGrantable = 'YES';
    await assert.rejects(observeChildSignedFormMetadata(f.connection, settings), /does not match/u);
});

test('otherwise-valid metadata changing between the two passes is rejected', async () => {
    const f = fixture();
    f.onSecondPass(() => (f.grants.columns as object[]).push({ tableName: 'users', columnName: 'unexpected_new_metadata' }));
    await assert.rejects(observeChildSignedFormMetadata(f.connection, settings), /does not match/u);
});

test('receipt cannot be minted from JSON, changed source SQL or a refreshed timestamp without a new observation', async () => {
    const f = fixture(); const snapshot = await observeChildSignedFormMetadata(f.connection, settings);
    assert.throws(() => createChildSignedFormSchemaReceipt(JSON.parse(JSON.stringify(snapshot)), source), /does not match/u);
    assert.throws(() => createChildSignedFormSchemaReceipt(snapshot, { ...source, sqlSha256: 'b'.repeat(64) }), /does not match/u);
    assert.throws(() => createChildSignedFormSchemaReceipt(snapshot, { ...source, sourceCommit: 'main' }), /does not match/u);
    assert.throws(() => createChildSignedFormSchemaReceipt(snapshot, source, new Date(Date.parse(snapshot.observedAt) + 1).toISOString()), /does not match/u);
});
