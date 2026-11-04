import { isDeepStrictEqual } from 'node:util';
import type { MigrationConnection } from './leaderboardSchema';

/** Shared metadata contract for the administrative operation and bounded runtime check. */
export async function verifyChildActivityContinuitySchema(connection: MigrationConnection): Promise<void> {
    const table = 'parent_child_activity_continuity';
    async function exact(sql: string, expected: unknown): Promise<void> {
        const [rows] = await connection.query(sql, [table]);
        if (!isDeepStrictEqual(rows, expected)) throw new Error('Child activity continuity schema or permissions differ.');
    }
    await exact(`SELECT ENGINE AS engine,TABLE_COLLATION AS collation,TABLE_TYPE AS type
        FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?`,
    [{ engine: 'InnoDB', collation: 'utf8mb4_unicode_ci', type: 'BASE TABLE' }]);
    await exact(`SELECT COLUMN_NAME AS name,COLUMN_TYPE AS type,IS_NULLABLE AS nullable,
        CHARACTER_SET_NAME AS charset,COLLATION_NAME AS collation,COLUMN_DEFAULT AS defaultValue,EXTRA AS extra,GENERATION_EXPRESSION AS generation
        FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION`, [
        { name: 'child_uuid', type: 'char(36)', nullable: 'NO', charset: 'ascii', collation: 'ascii_bin', defaultValue: null, extra: '', generation: '' },
        ...['head_json', 'ledger_json'].map(name => ({ name, type: 'json', nullable: 'NO', charset: null, collation: null, defaultValue: null, extra: '', generation: '' })),
    ]);
    await exact(`SELECT INDEX_NAME AS name,COLUMN_NAME AS col,NON_UNIQUE AS nonUnique,SEQ_IN_INDEX AS seq
        FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY INDEX_NAME,SEQ_IN_INDEX`,
    [{ name: 'PRIMARY', col: 'child_uuid', nonUnique: 0, seq: 1 }]);
    await exact(`SELECT k.CONSTRAINT_NAME AS name,k.COLUMN_NAME AS col,k.REFERENCED_TABLE_NAME AS refTable,
        k.REFERENCED_COLUMN_NAME AS refCol,k.REFERENCED_TABLE_SCHEMA=DATABASE() AS sameSchema,r.DELETE_RULE AS deletion,r.UPDATE_RULE AS updateRule
        FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r
        ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA AND r.TABLE_NAME=k.TABLE_NAME AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME
        WHERE k.TABLE_SCHEMA=DATABASE() AND k.TABLE_NAME=? AND k.REFERENCED_TABLE_NAME IS NOT NULL`,
    [{ name: 'fk_child_continuity_activity', col: 'child_uuid', refTable: 'parent_managed_child_activity', refCol: 'child_uuid',
        sameSchema: 1, deletion: 'CASCADE', updateRule: 'RESTRICT' }]);
    await exact(`SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE=?`, []);
    const [checks] = await connection.query(`SELECT t.CONSTRAINT_NAME AS name,c.CHECK_CLAUSE AS clause,t.ENFORCED AS enforced
        FROM information_schema.TABLE_CONSTRAINTS t JOIN information_schema.CHECK_CONSTRAINTS c
        ON c.CONSTRAINT_SCHEMA=t.CONSTRAINT_SCHEMA AND c.CONSTRAINT_NAME=t.CONSTRAINT_NAME
        WHERE t.TABLE_SCHEMA=DATABASE() AND t.TABLE_NAME=? AND t.CONSTRAINT_TYPE='CHECK' ORDER BY t.CONSTRAINT_NAME`, [table]);
    if (!Array.isArray(checks)) throw new Error('Child activity continuity constraints differ.');
    const normalized = checks.map(row => ({ name: row.name, enforced: row.enforced,
        // MySQL 8.0 metadata may escape literal quotes once or twice. Preserve
        // parentheses: stripping them can accept a differently grouped expression.
        clause: typeof row.clause === 'string' ? row.clause.replace(/_utf8mb[34]/gu, '')
            .replace(/\\{1,2}'/gu, "'").replace(/[\s`]/gu, '').toLowerCase() : '' }));
    if (!isDeepStrictEqual(normalized, [
        { name: 'chk_child_continuity_head', enforced: 'YES', clause: "(json_type(head_json)='object')" },
        { name: 'chk_child_continuity_ledger', enforced: 'YES', clause: "((json_type(ledger_json)='array')and(json_length(ledger_json)between1and2048))" },
    ])) throw new Error('Child activity continuity constraints differ.');
}
