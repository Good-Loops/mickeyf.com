/**
 * Validated MySQL pool configuration shared by the backend.
 *
 * The pool is deliberately bounded. Startup performs a connection check before
 * the HTTP listener is opened so a misconfigured instance never accepts traffic.
 */
import mysql from 'mysql2/promise';
import { loadDatabaseConfig } from '../config/runtimeConfig';

const databaseConfig = loadDatabaseConfig();

const base: mysql.PoolOptions = {
    user: databaseConfig.user,
    password: databaseConfig.password,
    database: databaseConfig.database,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 100,
    connectTimeout: 10_000,
};

const productionOptions: mysql.PoolOptions = {
    ...base,
    socketPath: `/cloudsql/${databaseConfig.cloudSqlConnectionName}`,
};

const localOptions: mysql.PoolOptions = {
    ...base,
    host: databaseConfig.host,
    port: databaseConfig.port,
};

export const pool = mysql.createPool(
    databaseConfig.isProduction ? productionOptions : localOptions
);

export async function verifyDatabaseConnection(): Promise<void> {
    const connection = await pool.getConnection();
    connection.release();
}

export async function closeDatabasePool(): Promise<void> {
    await pool.end();
}
