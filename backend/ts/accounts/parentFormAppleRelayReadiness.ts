import { isDeepStrictEqual } from 'node:util';
import type { Pool, RowDataPacket } from 'mysql2/promise';

/** Read-only schema qualification. This does not verify event coverage or recovery. */
export async function verifyParentFormAppleRelayReadiness(database: Pick<Pool, 'query'>): Promise<void> {
    const table = 'parent_form_apple_relay_state';
    async function exact(sql: string, expected: unknown): Promise<void> {
        const [rows] = await database.query<RowDataPacket[]>({ sql, timeout: 10_000 }, [table]);
        if (!Array.isArray(rows) || !isDeepStrictEqual(rows.map(row => ({ ...row })), expected)) {
            throw new Error('Parent relay schema is unavailable or differs from the reviewed definition.');
        }
    }
    await exact(`SELECT ENGINE AS engine, TABLE_COLLATION AS collation, TABLE_TYPE AS type
        FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?`,
    [{ engine: 'InnoDB', collation: 'utf8mb4_unicode_ci', type: 'BASE TABLE' }]);
    await exact(`SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable,
        CHARACTER_SET_NAME AS charset, COLLATION_NAME AS collation, COLUMN_DEFAULT AS defaultValue,
        EXTRA AS extra, GENERATION_EXPRESSION AS generation FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION`, [
        { name: 'reference', type: 'char(36)', nullable: 'NO', charset: 'ascii', collation: 'ascii_bin', defaultValue: null, extra: '', generation: '' },
        { name: 'last_event_at', type: 'bigint unsigned', nullable: 'NO', charset: null, collation: null, defaultValue: null, extra: '', generation: '' },
        { name: 'forwarding_disabled', type: 'tinyint unsigned', nullable: 'NO', charset: null, collation: null, defaultValue: null, extra: '', generation: '' },
    ]);
    await exact(`SELECT INDEX_NAME AS name, COLUMN_NAME AS \`column\`, NON_UNIQUE AS nonUnique,
        SEQ_IN_INDEX AS sequence, SUB_PART AS subPart, IS_VISIBLE AS visible FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY INDEX_NAME,SEQ_IN_INDEX`,
    [{ name: 'PRIMARY', column: 'reference', nonUnique: 0, sequence: 1, subPart: null, visible: 'YES' }]);
    await exact(`SELECT k.CONSTRAINT_NAME AS name, k.COLUMN_NAME AS col, k.REFERENCED_TABLE_NAME AS refTable,
        k.REFERENCED_COLUMN_NAME AS refColumn, k.REFERENCED_TABLE_SCHEMA=DATABASE() AS sameSchema,
        r.DELETE_RULE AS deletion, r.UPDATE_RULE AS updateRule FROM information_schema.KEY_COLUMN_USAGE k
        INNER JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA
        AND r.TABLE_NAME=k.TABLE_NAME AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME
        WHERE k.TABLE_SCHEMA=DATABASE() AND k.TABLE_NAME=? AND k.REFERENCED_TABLE_NAME IS NOT NULL ORDER BY k.CONSTRAINT_NAME`,
    [{ name: 'fk_parent_form_relay_reference', col: 'reference', refTable: 'parent_signed_forms', refColumn: 'reference',
        sameSchema: 1, deletion: 'CASCADE', updateRule: 'RESTRICT' }]);
    await exact(`SELECT CONSTRAINT_NAME AS name, ENFORCED AS enforced FROM information_schema.TABLE_CONSTRAINTS
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND CONSTRAINT_TYPE='CHECK'`,
    [{ name: 'chk_parent_form_relay_disabled', enforced: 'YES' }]);
    const [checks] = await database.query<RowDataPacket[]>({ sql: `SELECT CHECK_CLAUSE AS clause
        FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE()
        AND CONSTRAINT_NAME='chk_parent_form_relay_disabled'`, timeout: 10_000 });
    if (!Array.isArray(checks) || checks.length !== 1 || typeof checks[0].clause !== 'string'
        || checks[0].clause.replace(/[\s`()]/gu, '').toLowerCase() !== 'forwarding_disabledin0,1') {
        throw new Error('Parent relay constraint differs from the reviewed definition.');
    }
    await exact(`SELECT TRIGGER_NAME AS name FROM information_schema.TRIGGERS
        WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE=?`, []);
    // Ensures the current principal can read the state without exposing rows.
    await database.query({ sql: 'EXPLAIN SELECT reference,last_event_at,forwarding_disabled FROM parent_form_apple_relay_state WHERE reference=?', timeout: 10_000 },
        ['00000000-0000-4000-8000-000000000000']);
}
