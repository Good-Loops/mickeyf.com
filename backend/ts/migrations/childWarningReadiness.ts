import type { Pool, RowDataPacket } from 'mysql2/promise';
import { verifyChildWarningHistorySchema } from './childActivityContinuitySchema';

/** Read-only checks of the exact history schema and actual warning writer permissions. */
export async function verifyChildWarningReadiness(database: Pick<Pool, 'query'>): Promise<void> {
    const [grants] = await database.query<RowDataPacket[]>({ sql: `SELECT PRIVILEGE_TYPE AS privilegeName
        FROM information_schema.TABLE_PRIVILEGES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='parent_child_warning_history'
        AND PRIVILEGE_TYPE='SELECT' AND GRANTEE=CONCAT("'",SUBSTRING_INDEX(CURRENT_USER(),'@',1),"'@'",SUBSTRING_INDEX(CURRENT_USER(),'@',-1),"'")`, timeout: 10_000 });
    if (grants.length !== 1 || grants[0].privilegeName !== 'SELECT') throw new Error('Warning history read permission unavailable.');
    await verifyChildWarningHistorySchema({ query: (sql, values) => database.query({ sql, timeout: 10_000 }, values) });
    await database.query({ sql: `EXPLAIN INSERT INTO parent_child_warning_history (child_uuid,state_json,head_json,ledger_json)
        VALUES ('00000000-0000-4000-8000-000000000000','{}','{}','[{}]')`, timeout: 10_000 });
    await database.query({ sql: `EXPLAIN UPDATE parent_child_warning_history SET state_json=state_json,head_json=head_json,ledger_json=ledger_json
        WHERE child_uuid='00000000-0000-4000-8000-000000000000'`, timeout: 10_000 });
}
