import mysql, { type PoolConnection } from 'mysql2/promise';
import { loadAppleRevocationConfig, type AppleRevocationConfig } from '../config/appleRevocationConfig';
import { verifyAppleTokenReadiness } from '../migrations/appleTokenSchema';
import type { MigrationConnection } from '../migrations/leaderboardSchema';
import { createAppleTokenRevocationWorker } from './appleTokenRevocation';

/** Read-only gate on the exact connection the worker will borrow, never just environment assertions. */
export async function verifyAppleRevocationConnection(connection: PoolConnection, config: AppleRevocationConfig): Promise<void> {
    const inspection: MigrationConnection = {
        query: (sql, values) => connection.query({ sql, timeout: 10_000 }, values),
    };
    try {
        const [rows] = await inspection.query(`SELECT DATABASE() AS databaseName,
            CURRENT_USER() AS currentUser, @@GLOBAL.server_uuid AS serverUuid`);
        const target = Array.isArray(rows) && rows.length === 1 ? rows[0] : undefined;
        if (!target || target.databaseName !== 'cms' || target.currentUser !== config.expectedAccount
            || target.serverUuid !== config.expectedServerUuid) throw new Error();
        await verifyAppleTokenReadiness(inspection);
    } catch {
        throw new Error('Apple revocation target identity or recorded schema could not be verified.');
    }
}

export async function runAppleTokenRevocation(args: readonly string[]): Promise<void> {
    // Reject unsupported commands and missing opt-ins before creating a pool.
    const config = loadAppleRevocationConfig(args);
    const pool = mysql.createPool(config.databaseOptions);
    try {
        const worker = createAppleTokenRevocationWorker({
            clientId: config.lifecycle.clientId, vault: config.lifecycle.repository, appleTokens: config.lifecycle.client,
            database: { async getConnection() {
                const connection = await pool.getConnection();
                try { await verifyAppleRevocationConnection(connection, config); return connection; }
                catch {
                    try { connection.destroy(); } catch { /* Never expose driver teardown details. */ }
                    throw new Error('Apple revocation connection verification failed.');
                }
            } },
        });
        const result = await worker.drain();
        const incomplete = result.status !== 'completed' || result.retried > 0 || result.expired > 0;
        console.log(JSON.stringify({ component: 'apple-token-revocation', severity: incomplete ? 'ERROR' : 'INFO', ...result }));
        if (incomplete) process.exitCode = 2;
    } finally { await pool.end(); }
}

if (require.main === module) {
    runAppleTokenRevocation(process.argv.slice(2)).catch(() => {
        console.error(JSON.stringify({ component: 'apple-token-revocation', severity: 'ERROR', status: 'failed' }));
        process.exitCode = 1;
    });
}
