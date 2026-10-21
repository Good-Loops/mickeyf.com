import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { LocalProviderRuntime } from '../config/localProviderRuntime';
import { guardConnectionQueries } from './queryTimeoutConnection';

const TIMEOUT_MS = 10_000;

/** Verify the actual borrowed connection before loading credentials or advertising local real-account actions. */
export async function verifyLocalProviderIdentity(database: Pick<Pool, 'getConnection'>,
    expected: LocalProviderRuntime): Promise<void> {
    let connection: PoolConnection | undefined;
    let expired = false;
    let failed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        await Promise.race([(async () => {
            const acquired = guardConnectionQueries(await database.getConnection());
            if (expired) { acquired.destroy(); throw new Error(); }
            connection = acquired;
            const [rows] = await acquired.query<RowDataPacket[]>({ sql: `SELECT DATABASE() AS databaseName,
                CURRENT_USER() AS currentUser, @@GLOBAL.server_uuid AS serverUuid`, timeout: TIMEOUT_MS });
            if (expired || !Array.isArray(rows) || rows.length !== 1
                || rows[0].databaseName !== 'cms' || rows[0].currentUser !== expected.expectedAccount
                || rows[0].serverUuid !== expected.expectedServerUuid) throw new Error();
        })(), new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => { expired = true; reject(new Error()); }, TIMEOUT_MS);
        })]);
    } catch {
        failed = true;
        throw new Error('Local provider database identity could not be verified.');
    } finally {
        if (timer !== undefined) clearTimeout(timer);
        if (connection) {
            if (expired || failed) connection.destroy();
            else connection.release();
        }
    }
}
