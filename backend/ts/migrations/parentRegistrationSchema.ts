import { isDeepStrictEqual } from 'node:util';
import type { MigrationConnection } from './leaderboardSchema';

export const PARENT_MIGRATIONS = ['0021_allow_parent_managed_contact', '0022_create_parent_registration_attempts', '0023_create_parent_child_consents'] as const;
export const FAMILY_MIGRATION = '0024_extend_parent_family_deletion';
export type ParentTable = 'parent_registration_attempts' | 'parent_child_consents';
const ascii = (name: string, type: string, nullable = 'NO') => ({ name, type, nullable, charset: 'ascii', collation: 'ascii_bin', defaultValue: null, extra: '', comment: '' });
const binary = (name: string, type = 'binary(32)', nullable = 'NO') => ({ name, type, nullable, charset: null, collation: null, defaultValue: null, extra: '', comment: '' });
const date = (name: string) => ({ ...binary(name, 'datetime(6)'), comment: 'UTC' });
export const PARENT_COLUMNS = {
    parent_registration_attempts: [binary('state_hash'), binary('binding_hash'), ascii('parent_uuid', 'char(36)'), binary('parent_user_id', 'int'),
        ascii('client_key', 'varchar(32)'), ascii('nonce', 'char(43)'), binary('policy_digest'), ascii('purpose', "enum('create-child','withdraw-child')"),
        ascii('country_code', 'char(2)', 'YES'), ascii('child_uuid', 'char(36)', 'YES'), date('expires_at'),
        ascii('phase', "enum('pending','verifying','approved','cancelled','used')"), binary('grant_hash', 'binary(32)', 'YES'),
        ascii('provider', "enum('google','apple')", 'YES'), binary('subject', 'varbinary(255)', 'YES'),
        ascii('consent_version', 'varchar(64)', 'YES'), ascii('policy_version', 'varchar(64)', 'YES')],
    parent_child_consents: [ascii('child_uuid', 'char(36)'), ascii('parent_uuid', 'char(36)'), ascii('country_code', 'char(2)'),
        binary('policy_digest'), ascii('consent_version', 'varchar(64)'), date('consented_at')],
};
async function read(connection: MigrationConnection, sql: string, values: unknown[] = []) {
    const [result] = await connection.query(sql, values);
    if (!Array.isArray(result)) throw new Error('Parent registration schema metadata unavailable.');
    return result.map(row => ({ ...row }));
}
function exact(actual: unknown, expected: unknown) {
    if (!isDeepStrictEqual(actual, expected)) throw new Error('Parent registration schema differs from the reviewed definition.');
}
export async function inspectParentManagedContact(connection: MigrationConnection): Promise<boolean> {
    const values = await read(connection, `SELECT COLUMN_TYPE AS type, IS_NULLABLE AS nullable, CHARACTER_SET_NAME AS charset,
        COLLATION_NAME AS collation, COLUMN_DEFAULT AS defaultValue, EXTRA AS extra, COLUMN_COMMENT AS comment,
        GENERATION_EXPRESSION AS generationExpression FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'email'`);
    const nullable = values[0]?.nullable;
    if (nullable !== 'YES' && nullable !== 'NO') throw new Error('Reviewed contact column missing.');
    exact(values, [{ type: 'varchar(255)', nullable, charset: 'utf8mb4', collation: 'utf8mb4_unicode_ci', defaultValue: null, extra: '', comment: '', generationExpression: '' }]);
    return nullable === 'YES';
}
export async function inspectFamilyDeletionSchema(connection: MigrationConnection): Promise<boolean> {
    const found = await read(connection, `SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='parent_registration_attempts' AND COLUMN_NAME='family_digest'`);
    exact(found, found.length ? [{ name: 'family_digest' }] : []);
    return found.length === 1;
}
export async function verifyParentRegistrationTable(connection: MigrationConnection, table: ParentTable,
    family = false): Promise<void> {
    exact(await read(connection, `SELECT ENGINE AS engine, TABLE_COLLATION AS collation, TABLE_TYPE AS type FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`, [table]), [{ engine: 'InnoDB', collation: 'utf8mb4_unicode_ci', type: 'BASE TABLE' }]);
    exact(await read(connection, `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, CHARACTER_SET_NAME AS charset,
        COLLATION_NAME AS collation, COLUMN_DEFAULT AS defaultValue, EXTRA AS extra, COLUMN_COMMENT AS comment
        FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`, [table]), family && table === 'parent_registration_attempts'
        ? [...PARENT_COLUMNS[table].map(column => column.name === 'purpose'
            ? ascii('purpose', "enum('create-child','withdraw-child','delete-family','publish-scores')") : column), binary('family_digest', 'binary(32)', 'YES'), binary('profile_digest', 'binary(32)', 'YES')]
        : PARENT_COLUMNS[table]);
    const index = (name: string, column: string, nonUnique: number) => ({ name, column, nonUnique, sequence: 1, subPart: null, visible: 'YES', indexType: 'BTREE', indexOrder: 'A' });
    exact(await read(connection, `SELECT INDEX_NAME AS name, COLUMN_NAME AS \`column\`, NON_UNIQUE AS nonUnique, SEQ_IN_INDEX AS sequence,
        SUB_PART AS subPart, IS_VISIBLE AS visible, INDEX_TYPE AS indexType, COLLATION AS indexOrder FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX`, [table]), table === 'parent_registration_attempts'
        ? [index('idx_parent_attempt_account', 'parent_uuid', 1), index('idx_parent_attempt_expiry', 'expires_at', 1), index('PRIMARY', 'state_hash', 0), index('uq_parent_grant', 'grant_hash', 0)]
        : [index('idx_parent_children', 'parent_uuid', 1), index('PRIMARY', 'child_uuid', 0)]);
    const fk = (name: string, column: string, deletion: string) => ({ name, column, referencedTable: 'users', referencedColumn: 'account_uuid', sameSchema: 1, deletion, updateRule: 'RESTRICT' });
    exact(await read(connection, `SELECT k.CONSTRAINT_NAME AS name, k.COLUMN_NAME AS \`column\`, k.REFERENCED_TABLE_NAME AS referencedTable,
        k.REFERENCED_COLUMN_NAME AS referencedColumn, k.REFERENCED_TABLE_SCHEMA = DATABASE() AS sameSchema, r.DELETE_RULE AS deletion, r.UPDATE_RULE AS updateRule
        FROM information_schema.KEY_COLUMN_USAGE k INNER JOIN information_schema.REFERENTIAL_CONSTRAINTS r
        ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA AND r.TABLE_NAME=k.TABLE_NAME AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME
        WHERE k.TABLE_SCHEMA=DATABASE() AND k.TABLE_NAME=? AND k.REFERENCED_TABLE_NAME IS NOT NULL ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION`, [table]),
    table === 'parent_registration_attempts' ? [fk('fk_parent_attempt_account', 'parent_uuid', 'CASCADE')]
        : [fk('fk_child_consent_account', 'child_uuid', 'CASCADE'), fk('fk_child_consent_parent', 'parent_uuid', 'RESTRICT')]);
    const checks = await read(connection, `SELECT t.CONSTRAINT_NAME AS name, t.ENFORCED AS enforced, c.CHECK_CLAUSE AS clause
        FROM information_schema.TABLE_CONSTRAINTS t INNER JOIN information_schema.CHECK_CONSTRAINTS c
        ON c.CONSTRAINT_SCHEMA=t.CONSTRAINT_SCHEMA AND c.CONSTRAINT_NAME=t.CONSTRAINT_NAME
        WHERE t.TABLE_SCHEMA=DATABASE() AND t.TABLE_NAME=? AND t.CONSTRAINT_TYPE='CHECK' ORDER BY t.CONSTRAINT_NAME`, [table]);
    // Preserve grouping: stripping parentheses would also accept differently grouped AND/OR constraints.
    const normalized = checks.map(row => ({ ...row, clause: String(row.clause).replace(/[`\s\\]/gu, '').replace(/_(?:ascii|utf8mb4)/gu, '') }));
    exact(normalized, table === 'parent_registration_attempts' ? [{ name: 'chk_parent_attempt_purpose', enforced: 'YES',
        clause: family ? "(((purpose='create-child')and(country_codeisnotnull)and(child_uuidisnull)and(family_digestisnull)and(profile_digestisnull))or((purpose='withdraw-child')and(country_codeisnull)and(child_uuidisnotnull)and(family_digestisnull)and(profile_digestisnull))or((purpose='publish-scores')and(country_codeisnull)and(child_uuidisnotnull)and(family_digestisnull)and(profile_digestisnotnull))or((purpose='delete-family')and(country_codeisnull)and(child_uuidisnull)and(family_digestisnotnull)and(profile_digestisnull)))" : "(((purpose='create-child')and(country_codeisnotnull)and(child_uuidisnull))or((purpose='withdraw-child')and(country_codeisnull)and(child_uuidisnotnull)))" }]
        : [{ name: 'chk_distinct_parent_child', enforced: 'YES', clause: '(parent_uuid<>child_uuid)' }]);
    exact(await read(connection, 'SELECT TRIGGER_NAME AS name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE=?', [table]), []);
    exact(await read(connection, `SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()
        AND TABLE_NAME=? AND GENERATION_EXPRESSION <> ''`, [table]), []);
}
export async function verifyParentRegistrationReadiness(connection: MigrationConnection): Promise<void> {
    exact(await read(connection, 'SELECT version FROM schema_migrations WHERE version IN (?, ?, ?) ORDER BY version', [...PARENT_MIGRATIONS]), PARENT_MIGRATIONS.map(version => ({ version })));
    if (!await inspectParentManagedContact(connection)) throw new Error('Parent-managed contact migration is missing.');
    exact(await read(connection, 'SELECT version FROM schema_migrations WHERE version = ?', [FAMILY_MIGRATION]), [{ version: FAMILY_MIGRATION }]);
    await verifyParentRegistrationTable(connection, 'parent_registration_attempts', true);
    await verifyParentRegistrationTable(connection, 'parent_child_consents');
}
