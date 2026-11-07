import { isDeepStrictEqual } from 'node:util';
import type { MigrationConnection } from './leaderboardSchema';

/** No writes: reject missing, partial or altered storage and insufficient runtime privileges. */
export async function verifyParentManagedChildActivityReadiness(connection: MigrationConnection): Promise<void> {
    async function exact(sql: string, expected: unknown) {
        const [result] = await connection.query(sql);
        if (!Array.isArray(result) || !isDeepStrictEqual(result.map(row => ({ ...row })), expected)) {
            throw new Error('Managed child activity schema or permissions are unavailable.');
        }
    }
    // Column-only SELECT hides ungranted columns in information_schema. Require table-level
    // SELECT so the exact-column check cannot overlook an added or altered column.
    await exact(`SELECT PRIVILEGE_TYPE AS privilegeName FROM information_schema.TABLE_PRIVILEGES
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='parent_managed_child_activity' AND PRIVILEGE_TYPE='SELECT'
        AND GRANTEE=CONCAT("'",SUBSTRING_INDEX(CURRENT_USER(),'@',1),"'@'",SUBSTRING_INDEX(CURRENT_USER(),'@',-1),"'")`,
    [{ privilegeName: 'SELECT' }]);
    await exact(`SELECT ENGINE AS engine, TABLE_COLLATION AS collation, TABLE_TYPE AS type FROM information_schema.TABLES
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='parent_managed_child_activity'`,
    [{ engine: 'InnoDB', collation: 'utf8mb4_unicode_ci', type: 'BASE TABLE' }]);
    await exact(`SELECT COLUMN_NAME AS name,COLUMN_TYPE AS type,IS_NULLABLE AS nullable, CHARACTER_SET_NAME AS charset,
        COLLATION_NAME AS collation,COLUMN_DEFAULT AS defaultValue,EXTRA AS extra,GENERATION_EXPRESSION AS generation
        FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='parent_managed_child_activity' ORDER BY ORDINAL_POSITION`, [
        { name: 'child_uuid', type: 'char(36)', nullable: 'NO', charset: 'ascii', collation: 'ascii_bin', defaultValue: null, extra: '', generation: '' },
        { name: 'retention_activity_at', type: 'datetime(6)', nullable: 'NO', charset: null, collation: null, defaultValue: null, extra: '', generation: '' },
    ]);
    await exact(`SELECT INDEX_NAME AS name,COLUMN_NAME AS col,NON_UNIQUE AS nonUnique,SEQ_IN_INDEX AS seq
        FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='parent_managed_child_activity'
        ORDER BY INDEX_NAME,SEQ_IN_INDEX`, [{ name: 'PRIMARY', col: 'child_uuid', nonUnique: 0, seq: 1 }]);
    await exact(`SELECT k.CONSTRAINT_NAME AS name,k.COLUMN_NAME AS col,k.REFERENCED_TABLE_NAME AS refTable,
        k.REFERENCED_COLUMN_NAME AS refCol,k.REFERENCED_TABLE_SCHEMA=DATABASE() AS sameSchema,r.DELETE_RULE AS deletion,r.UPDATE_RULE AS updateRule
        FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r
        ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA AND r.TABLE_NAME=k.TABLE_NAME AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME
        WHERE k.TABLE_SCHEMA=DATABASE() AND k.TABLE_NAME='parent_managed_child_activity' AND k.REFERENCED_TABLE_NAME IS NOT NULL`,
    [{ name: 'fk_child_activity_consent', col: 'child_uuid', refTable: 'parent_child_consents', refCol: 'child_uuid', sameSchema: 1, deletion: 'CASCADE', updateRule: 'RESTRICT' }]);
    await exact(`SELECT TRIGGER_NAME AS name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE()
        AND EVENT_OBJECT_TABLE='parent_managed_child_activity'`, []);
    await exact(`SELECT CONSTRAINT_NAME AS name FROM information_schema.TABLE_CONSTRAINTS
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='parent_managed_child_activity' AND CONSTRAINT_TYPE='CHECK'`, []);
    await connection.query('SELECT child_uuid, retention_activity_at FROM parent_managed_child_activity LIMIT 0');
    await connection.query(`EXPLAIN UPDATE parent_managed_child_activity
        SET retention_activity_at=GREATEST(retention_activity_at + INTERVAL 1 MICROSECOND, UTC_TIMESTAMP(6)) WHERE child_uuid='00000000-0000-4000-8000-000000000000'`);
    await connection.query(`EXPLAIN INSERT INTO parent_managed_child_activity (child_uuid, retention_activity_at)
        SELECT child_uuid, UTC_TIMESTAMP(6) FROM parent_child_consents WHERE child_uuid='00000000-0000-4000-8000-000000000000'`);
}
