import { isDeepStrictEqual } from 'node:util';
import type { MigrationConnection } from './leaderboardSchema';

export type RegistrationTable = 'registration_authorizations' | 'account_registration_profiles';
export const REGISTRATION_MIGRATIONS = ['0019_create_registration_authorizations', '0020_create_account_registration_profiles'] as const;

/** Exact transactional schema: primary keys prevent replay/profile replacement and deletion cascades profile data. */
export async function verifyRegistrationSchema(connection: MigrationConnection, table: RegistrationTable): Promise<void> {
    async function exact(label: string, sql: string, expected: object[]) {
        const [result] = await connection.query(sql, [table]);
        if (!Array.isArray(result) || !isDeepStrictEqual(result.map(row => ({ ...row })), expected)) {
            throw new Error(`Registration ${label} does not match the reviewed schema`);
        }
    }
    await exact('table', `SELECT ENGINE AS engine, TABLE_COLLATION AS collation, TABLE_TYPE AS tableType
        FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [{ engine: 'InnoDB', collation: 'utf8mb4_unicode_ci', tableType: 'BASE TABLE' }]);
    const column = (name: string, type: string, text = false, nullable = 'NO', datetimePrecision: number | null = null) => ({
        name, type, nullable, characterSet: text ? 'ascii' : null, collation: text ? 'ascii_bin' : null,
        defaultValue: null, extra: '', datetimePrecision, comment: datetimePrecision === 6 ? 'UTC' : '', generationExpression: '',
    });
    const grant = table === 'registration_authorizations';
    await exact('columns', `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable,
        CHARACTER_SET_NAME AS characterSet, COLLATION_NAME AS collation, COLUMN_DEFAULT AS defaultValue, EXTRA AS extra,
        DATETIME_PRECISION AS datetimePrecision, COLUMN_COMMENT AS comment, GENERATION_EXPRESSION AS generationExpression
        FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
    grant ? [column('binding_hash', 'binary(32)'), column('policy_digest', 'binary(32)'), column('country_code', 'char(2)', true),
        column('age_band', "enum('minor','adult')", true), column('expires_at', 'datetime(6)', false, 'NO', 6),
        column('consumed_at', 'datetime(6)', false, 'YES', 6)]
        : [column('account_uuid', 'char(36)', true), column('country_code', 'char(2)', true),
            column('age_band', "enum('minor','adult')", true), column('policy_version', 'varchar(64)', true),
            column('score_visibility', "enum('private','public')", true)]);
    const index = (name: string, columnName: string, nonUnique: number) => ({
        name, sequence: 1, columnName, nonUnique, indexOrder: 'A', subPart: null, visible: 'YES', indexType: 'BTREE',
    });
    await exact('indexes', `SELECT INDEX_NAME AS name, SEQ_IN_INDEX AS sequence, COLUMN_NAME AS columnName,
        NON_UNIQUE AS nonUnique, COLLATION AS indexOrder, SUB_PART AS subPart, IS_VISIBLE AS visible, INDEX_TYPE AS indexType
        FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
    grant ? [index('idx_registration_expiry', 'expires_at', 1), index('PRIMARY', 'binding_hash', 0)]
        : [index('PRIMARY', 'account_uuid', 0)]);
    await exact('foreign keys', `SELECT k.CONSTRAINT_NAME AS name, k.COLUMN_NAME AS columnName,
        k.REFERENCED_TABLE_NAME AS referencedTable, k.REFERENCED_COLUMN_NAME AS referencedColumn,
        k.REFERENCED_TABLE_SCHEMA = DATABASE() AS sameSchema, r.DELETE_RULE AS deleteRule, r.UPDATE_RULE AS updateRule
        FROM information_schema.KEY_COLUMN_USAGE AS k INNER JOIN information_schema.REFERENTIAL_CONSTRAINTS AS r
        ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.TABLE_NAME = k.TABLE_NAME AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
        WHERE k.TABLE_SCHEMA = DATABASE() AND k.TABLE_NAME = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL
        ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION`, grant ? [] : [{ name: 'fk_registration_profile_account',
        columnName: 'account_uuid', referencedTable: 'users', referencedColumn: 'account_uuid', sameSchema: 1,
        deleteRule: 'CASCADE', updateRule: 'RESTRICT' }]);
    const [checks] = await connection.query(`SELECT c.CONSTRAINT_NAME AS name, c.ENFORCED AS enforced, k.CHECK_CLAUSE AS clause
        FROM information_schema.TABLE_CONSTRAINTS AS c INNER JOIN information_schema.CHECK_CONSTRAINTS AS k
        ON k.CONSTRAINT_SCHEMA = c.CONSTRAINT_SCHEMA AND k.CONSTRAINT_NAME = c.CONSTRAINT_NAME
        WHERE c.TABLE_SCHEMA = DATABASE() AND c.TABLE_NAME = ? AND c.CONSTRAINT_TYPE = 'CHECK' ORDER BY c.CONSTRAINT_NAME`, [table]);
    const reviewedCheck = "age_band='adult'orscore_visibility='private'";
    const normalized = Array.isArray(checks) ? checks.map(row => {
        let clause: unknown = row.clause;
        if (typeof clause === 'string') {
            clause = clause.replace(/[`()\s]/gu, '');
            // MySQL 8.0.31's metadata can escape literal delimiters twice. Accept only this complete reviewed expression.
            for (const charset of ['', '_ascii', '_utf8mb4']) for (const escape of ['', '\\', '\\\\']) {
                const expected = reviewedCheck.replace(/'(adult|private)'/gu, (_match, value: string) => `${charset}${escape}'${value}${escape}'`);
                if (clause === expected) clause = reviewedCheck;
            }
        }
        return { ...row, clause };
    }) : null;
    if (!isDeepStrictEqual(normalized, grant ? [] : [{ name: 'chk_registration_minor_private', enforced: 'YES',
        clause: "age_band='adult'orscore_visibility='private'" }])) throw new Error('Registration privacy constraint differs from the reviewed schema');
    await exact('triggers', `SELECT TRIGGER_NAME AS name FROM information_schema.TRIGGERS
        WHERE TRIGGER_SCHEMA = DATABASE() AND EVENT_OBJECT_TABLE = ? ORDER BY TRIGGER_NAME`, []);
}

export async function verifyRegistrationReadiness(connection: MigrationConnection): Promise<void> {
    const [rows] = await connection.query('SELECT version FROM schema_migrations WHERE version IN (?, ?) ORDER BY version', [...REGISTRATION_MIGRATIONS]);
    if (!Array.isArray(rows) || !isDeepStrictEqual(rows.map(row => row.version), [...REGISTRATION_MIGRATIONS])) {
        throw new Error('Registration and private scores require both recorded migrations');
    }
    await verifyRegistrationSchema(connection, 'registration_authorizations');
    await verifyRegistrationSchema(connection, 'account_registration_profiles');
}
