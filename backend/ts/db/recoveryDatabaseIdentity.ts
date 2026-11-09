import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { RecoveryDatabaseTarget } from '../config/recoveryDatabaseTarget';

/** Check the actual restored database before the HTTP listener can accept traffic. */
export async function verifyRecoveryDatabaseIdentity(connection: Pick<PoolConnection, 'query'>,
    target: RecoveryDatabaseTarget): Promise<void> {
    const [rows] = await connection.query<RowDataPacket[]>({ sql: `SELECT DATABASE() AS databaseName,
        CURRENT_USER() AS currentUser, @@GLOBAL.server_uuid AS serverUuid`, timeout: 10_000 });
    if (!Array.isArray(rows) || rows.length !== 1 || rows[0].databaseName !== 'cms'
        || rows[0].currentUser !== 'cms_mickeyf@%' || rows[0].serverUuid !== target.serverUuid) {
        throw new Error('Restored runtime database identity differs from its reviewed target.');
    }
}
