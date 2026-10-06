import { isDeepStrictEqual } from 'node:util';
import type { MigrationConnection } from './leaderboardSchema';

export const SIGNED_FORM_MIGRATION = '0026_create_signed_parent_forms';
type ColumnMetadata = Readonly<{ name: string; type: string; nullable: string; charset: string | null;
    collation: string | null; defaultValue: string | null; extra: string; generation: string }>;

const reviewColumnDefinitions: Readonly<Record<string, string>> = Object.freeze({
    reviewed_at: "datetime(6) DEFAULT NULL COMMENT 'UTC'",
    reviewer: 'varchar(128) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL',
    form_sha256: 'binary(32) DEFAULT NULL',
});

async function verifyColumns(connection: MigrationConnection, expected: readonly ColumnMetadata[]): Promise<void> {
    const [rows] = await connection.query(`SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, CHARACTER_SET_NAME AS charset,
        COLLATION_NAME AS collation, COLUMN_DEFAULT AS defaultValue, EXTRA AS extra, GENERATION_EXPRESSION AS generation
        FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION`, ['parent_signed_forms']);
    if (!Array.isArray(rows)) throw new Error('Signed parent form column metadata is unavailable.');
    const observed = rows.map(row => ({ ...row }));
    if (isDeepStrictEqual(observed, expected)) return;
    const visibleNames = new Set(observed.map(row => row.name));
    const hidden = expected.filter(column => !visibleNames.has(column.name));
    if (hidden.length === 0 || hidden.some(column => !Object.prototype.hasOwnProperty.call(reviewColumnDefinitions, column.name))
        || !isDeepStrictEqual(observed, expected.filter(column => visibleNames.has(column.name)))) {
        throw new Error('Signed parent form columns differ from their reviewed definition.');
    }
    // Column-scoped runtime grants hide the owner review fields from COLUMNS.
    // SHOW CREATE exposes their schema without permitting reads of review data.
    const [definitions] = await connection.query('SHOW CREATE TABLE parent_signed_forms');
    const ddl = Array.isArray(definitions) && definitions.length === 1 ? definitions[0]['Create Table'] : undefined;
    if (typeof ddl !== 'string') throw new Error('Signed parent form table definition is unavailable.');
    const columns = ddl.split('\n').flatMap(line => {
        const match = /^\s*`([^`]+)`\s+(.+?)(?:,)?$/u.exec(line);
        return match ? [{ name: match[1], definition: match[2] }] : [];
    });
    if (!isDeepStrictEqual(columns.map(column => column.name), expected.map(column => column.name))
        || hidden.some(column => columns.find(item => item.name === column.name)?.definition !== reviewColumnDefinitions[column.name])) {
        throw new Error('Signed parent form hidden review columns differ from their reviewed definition.');
    }
}

export async function verifySignedParentFormSchema(connection: MigrationConnection): Promise<void> {
    const table = 'parent_signed_forms';
    async function exact(sql: string, expected: unknown) {
        const [rows] = await connection.query(sql, [table]);
        if (!Array.isArray(rows) || !isDeepStrictEqual(rows.map(row => ({ ...row })), expected)) throw new Error('Signed parent form schema differs from its reviewed definition.');
    }
    await exact(`SELECT ENGINE AS engine, TABLE_COLLATION AS collation, TABLE_TYPE AS type FROM information_schema.TABLES
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?`, [{ engine: 'InnoDB', collation: 'utf8mb4_unicode_ci', type: 'BASE TABLE' }]);
    const col = (name: string, type: string, charset: string | null = null, nullable = 'NO', defaultValue: string | null = null) => ({ name, type, nullable,
        charset, collation: charset === 'ascii' ? 'ascii_bin' : charset === 'utf8mb4' ? 'utf8mb4_unicode_ci' : null, defaultValue, extra: '', generation: '' });
    await verifyColumns(connection, [
        col('reference', 'char(36)', 'ascii'), col('parent_uuid', 'char(36)', 'ascii'), col('country_code', 'char(2)', 'ascii'),
        col('user_name', 'varchar(64)', 'utf8mb4'), col('policy_digest', 'binary(32)'), col('consent_version', 'varchar(64)', 'ascii'),
        col('policy_version', 'varchar(64)', 'ascii'), col('provider', "enum('google','apple')", 'ascii'), col('subject', 'varbinary(255)'),
        col('verified_contact', 'varchar(254)', 'utf8mb4'), col('status', "enum('pending','approved','rejected','used')", 'ascii'),
        col('submitted_at', 'datetime(6)'), col('expires_at', 'datetime(6)'), col('reviewed_at', 'datetime(6)', null, 'YES'),
        col('reviewer', 'varchar(128)', 'ascii', 'YES'), col('form_sha256', 'binary(32)', null, 'YES'),
        col('public_policy_digest', 'binary(32)', null, 'YES'), col('public_approved', 'tinyint unsigned', null, 'NO', '0'),
        col('public_withdrawn', 'tinyint unsigned', null, 'NO', '0'),
        col('child_uuid', 'char(36)', 'ascii', 'YES'),
    ]);
    const index = (name: string, column: string, nonUnique: number) => ({ name, column, nonUnique, sequence: 1, subPart: null, visible: 'YES' });
    await exact(`SELECT INDEX_NAME AS name, COLUMN_NAME AS \`column\`, NON_UNIQUE AS nonUnique, SEQ_IN_INDEX AS sequence,
        SUB_PART AS subPart, IS_VISIBLE AS visible FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE()
        AND TABLE_NAME=? ORDER BY INDEX_NAME, SEQ_IN_INDEX`, [index('idx_signed_form_child', 'child_uuid', 0),
        index('idx_signed_form_expiry', 'expires_at', 1), index('idx_signed_form_parent', 'parent_uuid', 1), index('PRIMARY', 'reference', 0)]);
    await exact(`SELECT k.CONSTRAINT_NAME AS name, k.COLUMN_NAME AS col, k.REFERENCED_TABLE_NAME AS refTable,
        k.REFERENCED_COLUMN_NAME AS refColumn, k.REFERENCED_TABLE_SCHEMA=DATABASE() AS sameSchema, r.DELETE_RULE AS deletion, r.UPDATE_RULE AS updateRule
        FROM information_schema.KEY_COLUMN_USAGE k INNER JOIN information_schema.REFERENTIAL_CONSTRAINTS r
        ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA AND r.TABLE_NAME=k.TABLE_NAME AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME
        WHERE k.TABLE_SCHEMA=DATABASE() AND k.TABLE_NAME=? AND k.REFERENCED_TABLE_NAME IS NOT NULL ORDER BY k.CONSTRAINT_NAME`,
    ['child', 'parent'].map(which => ({ name: `fk_signed_form_${which}`, col: `${which}_uuid`, refTable: 'users', refColumn: 'account_uuid', sameSchema: 1, deletion: 'CASCADE', updateRule: 'RESTRICT' })));
    await exact(`SELECT CONSTRAINT_NAME AS name, ENFORCED AS enforced FROM information_schema.TABLE_CONSTRAINTS
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND CONSTRAINT_TYPE='CHECK'`, [{ name: 'chk_signed_form_status', enforced: 'YES' }]);
    const [checks] = await connection.query(`SELECT CHECK_CLAUSE AS clause FROM information_schema.CHECK_CONSTRAINTS
        WHERE CONSTRAINT_SCHEMA=DATABASE() AND CONSTRAINT_NAME='chk_signed_form_status'`);
    const normalized = Array.isArray(checks) ? checks.map(row => String(row.clause).replace(/[`\s\\]/gu, '').replace(/_(?:ascii|utf8mb4)/gu, '')) : null;
    const expected = "((country_code='US')and(public_approvedin(0,1))and(public_withdrawnin(0,1))and((public_approved=0)or(public_policy_digestisnotnull))and(((status='pending')and(reviewed_atisnull)and(reviewerisnull)and(form_sha256isnull)and(child_uuidisnull)and(public_approved=0))or((statusin('approved','rejected'))and(reviewed_atisnotnull)and(reviewerisnotnull)and(form_sha256isnotnull)and(child_uuidisnull))or((status='used')and(reviewed_atisnotnull)and(reviewerisnotnull)and(form_sha256isnotnull)and(child_uuidisnotnull))))";
    if (!isDeepStrictEqual(normalized, [expected])) throw new Error('Signed parent form constraint differs from its reviewed definition.');
    await exact('SELECT TRIGGER_NAME AS name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE=?', []);
}
export async function verifySignedParentFormReadiness(connection: MigrationConnection): Promise<void> {
    const [rows] = await connection.query('SELECT version FROM schema_migrations WHERE version=?', [SIGNED_FORM_MIGRATION]);
    if (!Array.isArray(rows) || rows.length !== 1 || rows[0].version !== SIGNED_FORM_MIGRATION) throw new Error('Signed parent form migration is missing.');
    await verifySignedParentFormSchema(connection);
}
