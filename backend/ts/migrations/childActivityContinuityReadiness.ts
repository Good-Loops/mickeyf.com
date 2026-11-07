import type { Pool, RowDataPacket } from 'mysql2/promise';
import { isDeepStrictEqual } from 'node:util';
import { verifyChildActivityContinuitySchema } from './childActivityContinuitySchema';
import type { ChildActivityContinuityConfig } from '../config/childActivityContinuity';

/** Read-only capability check before the server can accept tracked activity. */
export async function verifyChildActivityContinuityReadiness(database: Pick<Pool, 'query'>,
    config: Pick<ChildActivityContinuityConfig, 'database' | 'serverUuid'>): Promise<void> {
    const table = 'parent_child_activity_continuity';
    const [identity] = await database.query<RowDataPacket[]>({ sql: 'SELECT DATABASE() AS db,@@GLOBAL.server_uuid AS serverUuid', timeout: 10_000 });
    if (identity.length !== 1 || identity[0].db !== config.database || identity[0].serverUuid !== config.serverUuid) {
        throw new Error('Child activity continuity primary differs.');
    }
    async function exact(sql: string, expected: unknown): Promise<void> {
        const [rows] = await database.query<RowDataPacket[]>({ sql, timeout: 10_000 }, [table]);
        if (!isDeepStrictEqual(rows, expected)) throw new Error('Child activity continuity schema or permissions differ.');
    }
    await exact(`SELECT PRIVILEGE_TYPE AS privilegeName FROM information_schema.TABLE_PRIVILEGES
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND PRIVILEGE_TYPE='SELECT'
        AND GRANTEE=CONCAT("'",SUBSTRING_INDEX(CURRENT_USER(),'@',1),"'@'",SUBSTRING_INDEX(CURRENT_USER(),'@',-1),"'")`,
    [{ privilegeName: 'SELECT' }]);
    await verifyChildActivityContinuitySchema({ query: (sql, values) => database.query({ sql, timeout: 10_000 }, values) });
    await database.query({ sql: `EXPLAIN INSERT INTO parent_child_activity_continuity (child_uuid,head_json,ledger_json)
        VALUES ('00000000-0000-4000-8000-000000000000','{}','[{}]')`, timeout: 10_000 });
    await database.query({ sql: `EXPLAIN UPDATE parent_child_activity_continuity SET head_json=head_json,ledger_json=ledger_json
        WHERE child_uuid='00000000-0000-4000-8000-000000000000'`, timeout: 10_000 });
    const [missing] = await database.query<RowDataPacket[]>({ sql: `SELECT 1 AS missing FROM parent_managed_child_activity a
        LEFT JOIN parent_child_activity_continuity c ON c.child_uuid=a.child_uuid WHERE c.child_uuid IS NULL LIMIT 1`, timeout: 10_000 });
    if (missing.length !== 0) throw new Error('Existing activity requires reviewed continuity reconciliation; automatic backfill is forbidden.');
}
