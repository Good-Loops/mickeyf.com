import { verifyParentRegistrationReadiness } from './parentRegistrationSchema';
import { isDeepStrictEqual } from 'node:util';
import type { MigrationConnection } from './leaderboardSchema';

export const SCORE_PARTICIPATION_MIGRATION = '0025_create_score_participation';
const table = 'account_score_permissions';
export async function verifyScoreParticipationSchema(connection: MigrationConnection): Promise<void> {
    async function exact(sql: string, expected: unknown) {
        const [rows] = await connection.query(sql, [table]);
        if (!Array.isArray(rows) || !isDeepStrictEqual(rows.map(row => ({ ...row })), expected)) {
            throw new Error('Score permission schema differs from its reviewed definition.');
        }
    }
    await exact(`SELECT ENGINE AS engine, TABLE_COLLATION AS collation, TABLE_TYPE AS type FROM information_schema.TABLES
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?`, [{ engine: 'InnoDB', collation: 'utf8mb4_unicode_ci', type: 'BASE TABLE' }]);
    const col = (name: string, type: string, text = true, nullable = 'YES', comment = '') => ({ name, type, nullable,
        charset: text ? 'ascii' : null, collation: text ? 'ascii_bin' : null, defaultValue: null, extra: '', comment, generation: '' });
    await exact(`SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, CHARACTER_SET_NAME AS charset,
        COLLATION_NAME AS collation, COLUMN_DEFAULT AS defaultValue, EXTRA AS extra, COLUMN_COMMENT AS comment,
        GENERATION_EXPRESSION AS generation FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()
        AND TABLE_NAME=? ORDER BY ORDINAL_POSITION`, [col('account_uuid', 'char(36)', true, 'NO'),
        col('visibility', "enum('private','public')", true, 'NO'), col('policy_digest', 'binary(32)', false),
        col('registration_policy_version', 'varchar(64)'), col('country_code', 'char(2)'), col('age_band', "enum('minor','adult')"),
        col('authorizer_uuid', 'char(36)'), col('confirmed_at', 'datetime(6)', false, 'NO', 'UTC')]);
    await exact(`SELECT INDEX_NAME AS name, COLUMN_NAME AS col, NON_UNIQUE AS nonUnique, SEQ_IN_INDEX AS sequence,
        SUB_PART AS subPart, IS_VISIBLE AS visible, INDEX_TYPE AS type, COLLATION AS ordering FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
    [{ name: 'PRIMARY', col: 'account_uuid', nonUnique: 0, sequence: 1, subPart: null, visible: 'YES', type: 'BTREE', ordering: 'A' }]);
    await exact(`SELECT k.CONSTRAINT_NAME AS name, k.COLUMN_NAME AS col, k.REFERENCED_TABLE_NAME AS refTable,
        k.REFERENCED_COLUMN_NAME AS refColumn, k.REFERENCED_TABLE_SCHEMA=DATABASE() AS sameSchema,
        r.DELETE_RULE AS deletion, r.UPDATE_RULE AS updateRule FROM information_schema.KEY_COLUMN_USAGE k
        INNER JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA
        AND r.TABLE_NAME=k.TABLE_NAME AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME
        WHERE k.TABLE_SCHEMA=DATABASE() AND k.TABLE_NAME=? AND k.REFERENCED_TABLE_NAME IS NOT NULL ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
    [{ name: 'fk_score_permission_account', col: 'account_uuid', refTable: 'users', refColumn: 'account_uuid', sameSchema: 1, deletion: 'CASCADE', updateRule: 'RESTRICT' }]);
    const [checks] = await connection.query(`SELECT t.CONSTRAINT_NAME AS name, t.ENFORCED AS enforced, c.CHECK_CLAUSE AS clause
        FROM information_schema.TABLE_CONSTRAINTS t INNER JOIN information_schema.CHECK_CONSTRAINTS c
        ON c.CONSTRAINT_SCHEMA=t.CONSTRAINT_SCHEMA AND c.CONSTRAINT_NAME=t.CONSTRAINT_NAME
        WHERE t.TABLE_SCHEMA=DATABASE() AND t.TABLE_NAME=? AND t.CONSTRAINT_TYPE='CHECK' ORDER BY t.CONSTRAINT_NAME`, [table]);
    const normalized = Array.isArray(checks) ? checks.map(row => ({ ...row,
        clause: String(row.clause).replace(/[`\s\\]/gu, '').replace(/_(?:ascii|utf8mb4)/gu, '') })) : null;
    if (!isDeepStrictEqual(normalized, [{ name: 'chk_score_permission_choice', enforced: 'YES',
        clause: "(((visibility='private')and(policy_digestisnull)and(registration_policy_versionisnull)and(country_codeisnull)and(age_bandisnull)and(authorizer_uuidisnull))or((visibility='public')and(policy_digestisnotnull)and(registration_policy_versionisnotnull)and(country_codeisnotnull)and(age_bandisnotnull)and(authorizer_uuidisnotnull)))" }])) {
        throw new Error('Score permission constraint differs from its reviewed definition.');
    }
    await exact('SELECT TRIGGER_NAME AS name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE=?', []);
}

export async function verifyScoreParticipationReadiness(connection: MigrationConnection): Promise<void> {
    await verifyParentRegistrationReadiness(connection);
    const [rows] = await connection.query('SELECT version FROM schema_migrations WHERE version=?', [SCORE_PARTICIPATION_MIGRATION]);
    if (!Array.isArray(rows) || rows.length !== 1 || rows[0].version !== SCORE_PARTICIPATION_MIGRATION) throw new Error('Score permission migration is missing.');
    await verifyScoreParticipationSchema(connection);
}
