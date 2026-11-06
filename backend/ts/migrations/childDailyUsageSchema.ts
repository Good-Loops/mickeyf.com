import { isDeepStrictEqual } from 'node:util';
import type { MigrationConnection } from './leaderboardSchema';

/** Draft administrative check; the caller must have complete schema/trigger metadata visibility.
 * Callers must not enable the feature until all other gates pass. */
export async function verifyChildDailyUsageSchema(connection: MigrationConnection): Promise<void> {
    const table = 'parent_child_daily_usage';
    const fail = () => { throw new Error('Child daily usage schema differs from the reviewed draft.'); };
    const [flags] = await connection.query('SELECT @@SESSION.foreign_key_checks AS sessionChecks, @@GLOBAL.foreign_key_checks AS globalChecks');
    if (!Array.isArray(flags) || flags.length !== 1 || ![1, '1'].includes(flags[0].sessionChecks)
        || ![1, '1'].includes(flags[0].globalChecks)) fail();
    async function exact(sql: string, expected: unknown): Promise<void> {
        const [rows] = await connection.query(sql, [table]);
        if (!isDeepStrictEqual(rows, expected)) fail();
    }
    await exact(`SELECT ENGINE AS engine,TABLE_COLLATION AS collation,TABLE_TYPE AS type
        FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?`,
    [{ engine: 'InnoDB', collation: 'utf8mb4_unicode_ci', type: 'BASE TABLE' }]);
    const column = (name: string, type: string, nullable: string, charset: string | null, collation: string | null) =>
        ({ name, type, nullable, charset, collation, defaultValue: null, extra: '', generation: '' });
    await exact(`SELECT COLUMN_NAME AS name,COLUMN_TYPE AS type,IS_NULLABLE AS nullable,
        CHARACTER_SET_NAME AS charset,COLLATION_NAME AS collation,COLUMN_DEFAULT AS defaultValue,EXTRA AS extra,GENERATION_EXPRESSION AS generation
        FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION`, [
        column('child_uuid', 'char(36)', 'NO', 'ascii', 'ascii_bin'),
        column('time_zone', 'varchar(100)', 'NO', 'ascii', 'ascii_bin'),
        column('daily_limit_ms', 'int unsigned', 'NO', null, null),
        column('usage_day', 'char(10)', 'NO', 'ascii', 'ascii_bin'),
        column('used_ms', 'int unsigned', 'NO', null, null),
        column('accounted_at_ms', 'bigint unsigned', 'NO', null, null),
        column('active_until_ms', 'bigint unsigned', 'YES', null, null),
        column('notice_version', 'varchar(64)', 'NO', 'ascii', 'ascii_bin'),
        column('consented_at', 'datetime(6)', 'NO', null, null),
    ]);
    await exact(`SELECT INDEX_NAME AS name,COLUMN_NAME AS col,NON_UNIQUE AS nonUnique,SEQ_IN_INDEX AS seq
        FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY INDEX_NAME,SEQ_IN_INDEX`, [
        { name: 'idx_child_daily_usage_accounted_at', col: 'accounted_at_ms', nonUnique: 1, seq: 1 },
        { name: 'PRIMARY', col: 'child_uuid', nonUnique: 0, seq: 1 },
    ]);
    await exact(`SELECT k.CONSTRAINT_NAME AS name,k.COLUMN_NAME AS col,k.REFERENCED_TABLE_NAME AS refTable,
        k.REFERENCED_COLUMN_NAME AS refCol,k.REFERENCED_TABLE_SCHEMA=DATABASE() AS sameSchema,r.DELETE_RULE AS deletion,r.UPDATE_RULE AS updateRule
        FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r
        ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA AND r.TABLE_NAME=k.TABLE_NAME AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME
        WHERE k.TABLE_SCHEMA=DATABASE() AND k.TABLE_NAME=? AND k.REFERENCED_TABLE_NAME IS NOT NULL`, [
        { name: 'fk_child_daily_usage_consent', col: 'child_uuid', refTable: 'parent_child_consents', refCol: 'child_uuid',
            sameSchema: 1, deletion: 'CASCADE', updateRule: 'RESTRICT' },
    ]);
    await exact('SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE=?', []);
    const [checks] = await connection.query(`SELECT t.CONSTRAINT_NAME AS name,c.CHECK_CLAUSE AS clause,t.ENFORCED AS enforced
        FROM information_schema.TABLE_CONSTRAINTS t JOIN information_schema.CHECK_CONSTRAINTS c
        ON c.CONSTRAINT_SCHEMA=t.CONSTRAINT_SCHEMA AND c.CONSTRAINT_NAME=t.CONSTRAINT_NAME
        WHERE t.TABLE_SCHEMA=DATABASE() AND t.TABLE_NAME=? AND t.CONSTRAINT_TYPE='CHECK'`, [table]);
    if (!Array.isArray(checks) || checks.length !== 1 || checks[0].name !== 'chk_child_daily_usage_bounds'
        || checks[0].enforced !== 'YES' || typeof checks[0].clause !== 'string'
        || checks[0].clause.replace(/[\s`]/gu, '').toLowerCase()
            !== '((daily_limit_msbetween60000and86400000)and(used_ms<=86400000)and((active_until_msisnull)or((active_until_ms>=accounted_at_ms)and(active_until_ms<=(accounted_at_ms+30000)))))') fail();
}
