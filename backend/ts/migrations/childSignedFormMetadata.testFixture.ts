import assert from 'node:assert/strict';
import type { MigrationConnection } from './leaderboardSchema';
import { loadMigrationManifest } from './migrationManifest';
import { runtimeColumnPrivilegeInventory, runtimeTablePrivilegeInventory } from '../security/runtimeGrantManifest';
import type { ChildSignedFormMetadataSettings } from './childSignedFormMetadata';

// Synthetic SQL metadata only: this helper never connects to a database or proves cloud/source identity.
export const settings: ChildSignedFormMetadataSettings = { target: { project: 'synthetic-project', instance: 'local-mysql',
    database: 'mickeyf_migration_test', serverUuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' },
    expectedCurrentUser: 'root@%', expectedServerVersion: '8.0.31', expectedVersionComment: 'MySQL Community Server - GPL' };
export const legacyCheck = "((country_code='US')and(public_approvedin(0,1))and(public_withdrawnin(0,1))and((public_approved=0)or(public_policy_digestisnotnull))and(((status='pending')and(reviewed_atisnull)and(reviewerisnull)and(form_sha256isnull)and(child_uuidisnull)and(public_approved=0))or((statusin('approved','rejected'))and(reviewed_atisnotnull)and(reviewerisnotnull)and(form_sha256isnotnull)and(child_uuidisnull))or((status='used')and(reviewed_atisnotnull)and(reviewerisnotnull)and(form_sha256isnotnull)and(child_uuidisnotnull))))";

export function fixture(extended = true) {
    const identity = { databaseName: settings.target.database, currentUser: settings.expectedCurrentUser,
        serverUuid: settings.target.serverUuid, serverVersion: settings.expectedServerVersion, versionComment: settings.expectedVersionComment };
    const history = loadMigrationManifest().map(migration => ({ version: migration.version, checksum: Buffer.from(migration.checksum) }));
    const inventory = runtimeColumnPrivilegeInventory('google-apple-parent-signed');
    const privileges = (items: readonly object[]) => items.map(item => ({ schemaName: settings.target.database, ...item, isGrantable: 'NO' }));
    const grants: Record<string, unknown> = {
        identity: [{ ...identity, mandatoryRoles: '', activateAllRolesOnLogin: 0, partialRevokes: 0 }],
        account: [{ exactAccountCount: 1, accountNameCount: 1, accountLocked: 'N', passwordExpired: 'N', hasPrivilegeRestrictions: 0 }],
        columns: inventory.map(({ tableName, columnName }) => ({ tableName, columnName })),
        global: [{ privilegeType: 'USAGE', isGrantable: 'NO' }],
        column: privileges(inventory), table: privileges(runtimeTablePrivilegeInventory('google-apple-parent-signed')),
        'maintenance-process-privilege': [{ processPrivilegeProof: 1 }],
        'static-global-columns': [{ columnName: 'Select_priv' }, { columnName: 'Process_priv' }],
        'static-global-values': [{ Select_priv: 'N', Process_priv: 'N' }],
    };
    const col = (name: string, type: string, charset: string | null = null, nullable = 'NO', defaultValue: string | null = null) => ({ name, type, nullable,
        charset, collation: charset === 'ascii' ? 'ascii_bin' : charset === 'utf8mb4' ? 'utf8mb4_unicode_ci' : null,
        defaultValue, extra: '', generation: '' });
    const schema = {
        historyEngine: 'InnoDB',
        historyColumns: [
            { name: 'version', type: 'varchar(128)', nullable: 'NO', characterSet: 'ascii', collation: 'ascii_bin', extra: '', datetimePrecision: null, defaultValue: null, comment: '' },
            { name: 'checksum', type: 'binary(32)', nullable: 'NO', characterSet: null, collation: null, extra: '', datetimePrecision: null, defaultValue: null, comment: '' },
            { name: 'applied_at', type: 'datetime(6)', nullable: 'NO', characterSet: null, collation: null, extra: '', datetimePrecision: 6, defaultValue: null, comment: 'UTC' },
        ],
        nullable: extended ? 'YES' : 'NO',
        check: extended ? legacyCheck.replace("(country_code='US')", "(country_codein('US','BR'))") : legacyCheck,
        columns: [col('reference', 'char(36)', 'ascii'), col('parent_uuid', 'char(36)', 'ascii'), col('country_code', 'char(2)', 'ascii'),
            col('user_name', 'varchar(64)', 'utf8mb4', extended ? 'YES' : 'NO'), col('policy_digest', 'binary(32)'), col('consent_version', 'varchar(64)', 'ascii'),
            col('policy_version', 'varchar(64)', 'ascii'), col('provider', "enum('google','apple')", 'ascii'), col('subject', 'varbinary(255)'),
            col('verified_contact', 'varchar(254)', 'utf8mb4'), col('status', "enum('pending','approved','rejected','used')", 'ascii'),
            col('submitted_at', 'datetime(6)'), col('expires_at', 'datetime(6)'), col('reviewed_at', 'datetime(6)', null, 'YES'),
            col('reviewer', 'varchar(128)', 'ascii', 'YES'), col('form_sha256', 'binary(32)', null, 'YES'),
            col('public_policy_digest', 'binary(32)', null, 'YES'), col('public_approved', 'tinyint unsigned', null, 'NO', '0'),
            col('public_withdrawn', 'tinyint unsigned', null, 'NO', '0'), col('child_uuid', 'char(36)', 'ascii', 'YES')],
    };
    const calls: { sql: string; values?: unknown[] }[] = [];
    let identities = 0;
    let onSecondPass: (() => void) | undefined;
    const connection: MigrationConnection = { async query(sql, values) {
        calls.push({ sql, values });
        assert.match(sql.trim(), /^(?:SELECT|SHOW CREATE TABLE)\b/u, 'observer must never issue mutations, locks or SET');
        const tag = /runtime-grants:([a-z-]+)/u.exec(sql)?.[1];
        if (tag) {
            if (['account', 'dynamic-global', 'static-global-values', 'routine', 'assigned-roles', 'default-roles', 'proxy', 'inbound-proxy', 'outgoing-roles'].includes(tag)) {
                assert(values?.includes('cms_mickeyf'), 'privilege inspection must target the runtime account, not the observer');
            }
            return [grants[tag] ?? [], []];
        }
        if (sql.includes('DATABASE() AS databaseName')) {
            if (++identities === 3) onSecondPass?.();
            return [[{ ...identity }], []];
        }
        if (sql.startsWith('SELECT version, checksum')) return [history, []];
        if (values?.[0] === 'schema_migrations') {
            if (sql.includes('information_schema.TABLES')) return [[{ engine: schema.historyEngine, tableCollation: 'utf8mb4_unicode_ci' }], []];
            if (sql.includes('information_schema.COLUMNS')) return [schema.historyColumns, []];
            if (sql.includes('information_schema.STATISTICS')) return [[{ name: 'PRIMARY', nonUnique: 0, sequence: 1,
                columnName: 'version', indexOrder: 'A', subPart: null, visible: 'YES', indexType: 'BTREE' }], []];
            return [[], []];
        }
        if (sql.includes('SELECT IS_NULLABLE')) return [[{ nullable: schema.nullable }], []];
        if (sql.includes('information_schema.TABLES')) return [[{ engine: 'InnoDB', collation: 'utf8mb4_unicode_ci', type: 'BASE TABLE' }], []];
        if (sql.includes('information_schema.COLUMNS')) return [schema.columns, []];
        if (sql.includes('information_schema.STATISTICS')) return [[
            { name: 'idx_signed_form_child', column: 'child_uuid', nonUnique: 0, sequence: 1, subPart: null, visible: 'YES' },
            { name: 'idx_signed_form_expiry', column: 'expires_at', nonUnique: 1, sequence: 1, subPart: null, visible: 'YES' },
            { name: 'idx_signed_form_parent', column: 'parent_uuid', nonUnique: 1, sequence: 1, subPart: null, visible: 'YES' },
            { name: 'PRIMARY', column: 'reference', nonUnique: 0, sequence: 1, subPart: null, visible: 'YES' }], []];
        if (sql.includes('information_schema.KEY_COLUMN_USAGE')) return [['child', 'parent'].map(which => ({ name: `fk_signed_form_${which}`,
            col: `${which}_uuid`, refTable: 'users', refColumn: 'account_uuid', sameSchema: 1, deletion: 'CASCADE', updateRule: 'RESTRICT' })), []];
        if (sql.includes('information_schema.TABLE_CONSTRAINTS')) return [[{ name: 'chk_signed_form_status', enforced: 'YES' }], []];
        if (sql.includes('information_schema.CHECK_CONSTRAINTS')) return [[{ clause: schema.check }], []];
        if (sql.includes('information_schema.TRIGGERS')) return [[], []];
        throw new Error('Unexpected fixture query');
    } };
    return { connection, identity, history, schema, grants, calls, onSecondPass(callback: () => void) { onSecondPass = callback; } };
}
