import type { PoolConnection, RowDataPacket } from 'mysql2/promise';

/** Reject altered checkpoint tables before an administrative retirement operation. */
export async function verifyRecoveryCheckpointSchema(connection: Pick<PoolConnection, 'query'>): Promise<void> {
    const query = async (sql: string) => {
        const [rows] = await connection.query<RowDataPacket[]>({ sql, timeout: 10_000 });
        if (!Array.isArray(rows)) throw new Error();
        return rows;
    };
    try {
        const table = await query(`SELECT TABLE_TYPE AS type,ENGINE AS engine FROM information_schema.TABLES
            WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='account_recovery_checkpoint'`);
        if (table.length !== 1 || table[0].type !== 'BASE TABLE' || table[0].engine !== 'InnoDB') throw new Error();
        const columns = await query(`SELECT COLUMN_NAME AS name,COLUMN_TYPE AS type,IS_NULLABLE AS nullable,
            CHARACTER_SET_NAME AS charset,COLLATION_NAME AS collation,EXTRA AS extra,GENERATION_EXPRESSION AS generation
            FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='account_recovery_checkpoint' ORDER BY ORDINAL_POSITION`);
        const expected = [
            ['singleton_id', 'tinyint unsigned', 'NO', null, null],
            ['lineage_id', 'char(36)', 'NO', 'ascii', 'ascii_bin'],
            ['epoch', 'bigint unsigned', 'NO', null, null],
        ];
        if (columns.length !== expected.length || columns.some((row, index) => JSON.stringify([
            row.name, row.type, row.nullable, row.charset, row.collation]) !== JSON.stringify(expected[index])
            || row.extra !== '' || row.generation !== '')) throw new Error();
        const indexes = await query(`SELECT INDEX_NAME AS name,COLUMN_NAME AS col,NON_UNIQUE AS nonUnique,SEQ_IN_INDEX AS seq
            FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='account_recovery_checkpoint'
            ORDER BY INDEX_NAME,SEQ_IN_INDEX`);
        if (indexes.length !== 1 || indexes[0].name !== 'PRIMARY' || indexes[0].col !== 'singleton_id'
            || Number(indexes[0].nonUnique) !== 0 || Number(indexes[0].seq) !== 1) throw new Error();
        const checks = await query(`SELECT t.CONSTRAINT_NAME AS name,t.ENFORCED AS enforced,c.CHECK_CLAUSE AS clause
            FROM information_schema.TABLE_CONSTRAINTS t JOIN information_schema.CHECK_CONSTRAINTS c
            ON c.CONSTRAINT_SCHEMA=t.CONSTRAINT_SCHEMA AND c.CONSTRAINT_NAME=t.CONSTRAINT_NAME
            WHERE t.TABLE_SCHEMA=DATABASE() AND t.TABLE_NAME='account_recovery_checkpoint' AND t.CONSTRAINT_TYPE='CHECK'`);
        const clause = typeof checks[0]?.clause === 'string' ? checks[0].clause.replace(/[\s`()]/gu, '').toLowerCase() : '';
        if (checks.length !== 1 || checks[0].name !== 'chk_account_recovery_checkpoint_singleton'
            || checks[0].enforced !== 'YES' || clause !== 'singleton_id=1') throw new Error();
        const triggers = await query(`SELECT TRIGGER_NAME FROM information_schema.TRIGGERS
            WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE='account_recovery_checkpoint'`);
        if (triggers.length !== 0) throw new Error();
    } catch { throw new Error('Recovery checkpoint schema is unavailable or unverified.'); }
}
