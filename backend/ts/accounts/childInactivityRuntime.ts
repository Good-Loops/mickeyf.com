import { timingSafeEqual } from 'node:crypto';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { createChildInactivitySqlStore } from './childInactivitySqlStore';
import { createInAppInactivityQualityResolver } from './childInactivityInAppTarget';
import { createChildInactivityParentService } from './childInactivityParentService';

type Database = Pick<Pool, 'query' | 'getConnection'>;
type Health = (connection: PoolConnection, parentId: string, childId: string) => Promise<boolean>;

/** Run before mounting routes. This verifies storage without modifying records. */
export async function verifyChildInactivityWarningReadiness(database: Pick<Pool, 'query'>): Promise<void> {
    const [tables] = await database.query<RowDataPacket[]>(`SELECT ENGINE AS engine, TABLE_COLLATION AS collation, TABLE_TYPE AS type
        FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='parent_child_inactivity_warnings'`);
    if (tables.length !== 1 || tables[0].engine !== 'InnoDB' || tables[0].collation !== 'utf8mb4_unicode_ci'
        || tables[0].type !== 'BASE TABLE') throw new Error('Inactivity warning storage is unavailable.');
    // Table-level SELECT is required: column-level grants can hide unexpected columns.
    const [grants] = await database.query<RowDataPacket[]>(`SELECT PRIVILEGE_TYPE AS privilegeName FROM information_schema.TABLE_PRIVILEGES
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='parent_child_inactivity_warnings' AND PRIVILEGE_TYPE='SELECT'
        AND GRANTEE=CONCAT("'",SUBSTRING_INDEX(CURRENT_USER(),'@',1),"'@'",SUBSTRING_INDEX(CURRENT_USER(),'@',-1),"'")`);
    if (grants.length !== 1 || grants[0].privilegeName !== 'SELECT') throw new Error('Inactivity warning permissions are unavailable.');
    const [columns] = await database.query<RowDataPacket[]>(`SELECT COLUMN_NAME AS name,COLUMN_TYPE AS type,IS_NULLABLE AS nullable,
        CHARACTER_SET_NAME AS charset,COLLATION_NAME AS collation,EXTRA AS extra,GENERATION_EXPRESSION AS generation
        FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='parent_child_inactivity_warnings' ORDER BY ORDINAL_POSITION`);
    const expected = [
        ['child_uuid','char(36)','NO'], ['parent_uuid','char(36)','NO'], ['warning_uuid','char(36)','NO'],
        ['activity_at','datetime(6)','NO'], ['channel',"enum('in-app','email')",'NO'], ['target_digest','binary(32)','NO'],
        ['notice_digest','binary(32)','NO'], ['prepared_at','datetime(6)','NO'], ['delivered_at','datetime(6)','YES'],
        ['receipt_digest','binary(32)','YES'],
    ];
    if (columns.length !== expected.length || columns.some((row, index) => row.name !== expected[index][0]
        || row.type !== expected[index][1] || row.nullable !== expected[index][2]
        || row.charset !== (index < 3 ? 'ascii' : index === 4 ? 'utf8mb4' : null)
        || row.collation !== (index < 3 ? 'ascii_bin' : index === 4 ? 'utf8mb4_unicode_ci' : null)
        || row.extra !== '' || row.generation !== '')) throw new Error('Inactivity warning schema differs.');
    const [indexes] = await database.query<RowDataPacket[]>(`SELECT INDEX_NAME AS name,COLUMN_NAME AS col,NON_UNIQUE AS nonUnique,SEQ_IN_INDEX AS seq
        FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='parent_child_inactivity_warnings'
        ORDER BY INDEX_NAME,SEQ_IN_INDEX`);
    if (indexes.length !== 2 || indexes[0].name !== 'idx_inactivity_warning_id' || indexes[0].col !== 'warning_uuid'
        || indexes[0].nonUnique !== 0 || indexes[0].seq !== 1 || indexes[1].name !== 'PRIMARY'
        || indexes[1].col !== 'child_uuid' || indexes[1].nonUnique !== 0 || indexes[1].seq !== 1) {
        throw new Error('Inactivity warning indexes differ.');
    }
    const [foreign] = await database.query<RowDataPacket[]>(`SELECT k.COLUMN_NAME AS col,k.REFERENCED_TABLE_SCHEMA=DATABASE() AS sameSchema,k.REFERENCED_TABLE_NAME AS refTable,
        k.REFERENCED_COLUMN_NAME AS refCol,r.DELETE_RULE AS deletion,r.UPDATE_RULE AS updateRule
        FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r
        ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA AND r.TABLE_NAME=k.TABLE_NAME AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME
        WHERE k.TABLE_SCHEMA=DATABASE() AND k.TABLE_NAME='parent_child_inactivity_warnings' AND k.REFERENCED_TABLE_NAME IS NOT NULL`);
    if (foreign.length !== 1 || foreign[0].col !== 'child_uuid' || foreign[0].sameSchema !== 1 || foreign[0].refTable !== 'parent_managed_child_activity'
        || foreign[0].refCol !== 'child_uuid' || foreign[0].deletion !== 'CASCADE' || foreign[0].updateRule !== 'RESTRICT') {
        throw new Error('Inactivity warning relationship differs.');
    }
    const [triggers] = await database.query<RowDataPacket[]>(`SELECT TRIGGER_NAME FROM information_schema.TRIGGERS
        WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE='parent_child_inactivity_warnings'`);
    if (triggers.length !== 0) throw new Error('Inactivity warning storage has unexpected triggers.');
    // Check the actual write privileges using the same columns as the service, without performing a write.
    await database.query(`EXPLAIN INSERT INTO parent_child_inactivity_warnings
        (child_uuid,parent_uuid,warning_uuid,activity_at,channel,target_digest,notice_digest,prepared_at)
        VALUES ('00000000-0000-4000-8000-000000000000','00000000-0000-4000-8000-000000000000',
        '00000000-0000-4000-8000-000000000000',UTC_TIMESTAMP(6),'in-app',UNHEX(REPEAT('00',32)),UNHEX(REPEAT('00',32)),UTC_TIMESTAMP(6))`);
    await database.query(`EXPLAIN UPDATE parent_child_inactivity_warnings SET parent_uuid=parent_uuid,warning_uuid=warning_uuid,
        activity_at=activity_at,channel=channel,target_digest=target_digest,notice_digest=notice_digest,
        prepared_at=prepared_at,delivered_at=delivered_at,receipt_digest=receipt_digest
        WHERE child_uuid='00000000-0000-4000-8000-000000000000'`);
}

/** The caller supplies independently established tracking health; no fallback assumes coverage. */
export async function prepareChildInactivityRuntime(database: Database, targetKey: Buffer, receiptKey: Buffer, health: Health) {
    if (!Buffer.isBuffer(targetKey) || !Buffer.isBuffer(receiptKey) || targetKey.length < 32 || receiptKey.length < 32
        || (targetKey.length === receiptKey.length && timingSafeEqual(targetKey, receiptKey)) || typeof health !== 'function') {
        throw new TypeError('Distinct independent inactivity keys and a tracking health verifier are required.');
    }
    await verifyChildInactivityWarningReadiness(database);
    const store = createChildInactivitySqlStore(database, createInAppInactivityQualityResolver(targetKey, health));
    return createChildInactivityParentService(store, receiptKey, async parentId => {
        const [rows] = await database.query<RowDataPacket[]>({ sql: `SELECT child_uuid AS childId FROM parent_child_consents
            WHERE parent_uuid=? ORDER BY child_uuid LIMIT 51`, timeout: 10_000 }, [parentId]);
        if (!Array.isArray(rows) || rows.length > 50) throw new Error('Parent warning discovery unavailable.');
        return rows.map(row => row.childId as string);
    });
}
