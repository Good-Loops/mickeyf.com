import { PoolOptions } from 'mysql2/promise';
import { assertRecoveryDatabaseTarget, loadRecoveryDatabaseTarget } from './recoveryDatabaseTarget';

type Environment = Readonly<Record<string, string | undefined>>;
export type ReceiptCleanupConfig = Readonly<{
    databaseOptions: PoolOptions;
    expectedAccount: string;
    expectedServerUuid: string;
}>;

function required(env: Environment, name: string): string {
    const value = env[name];
    if (!value || !value.trim()) throw new Error(`Missing ${name}.`);
    return value;
}

/** Deliberately does not import dotenv or fall back to the website credentials. */
export function loadReceiptCleanupConfig(env: Environment = process.env): ReceiptCleanupConfig {
    const recoveryTarget = loadRecoveryDatabaseTarget(env);
    if (env.RECEIPT_CLEANUP_ENABLED !== 'true') {
        throw new Error('Receipt cleanup requires explicit activation.');
    }
    if (!['development', 'test', 'production'].includes(env.NODE_ENV ?? '')) {
        throw new Error('Receipt cleanup requires an explicit NODE_ENV.');
    }
    const user = required(env, 'RECEIPT_CLEANUP_DB_USER');
    const password = required(env, 'RECEIPT_CLEANUP_DB_PASS');
    const database = required(env, 'RECEIPT_CLEANUP_DB_NAME');
    const expectedAccount = required(env, 'RECEIPT_CLEANUP_EXPECTED_ACCOUNT');
    const expectedServerUuid = required(env, 'RECEIPT_CLEANUP_EXPECTED_SERVER_UUID');
    if (!/^[a-zA-Z0-9_]+$/.test(database)
        || !/^[a-zA-Z0-9_]+$/.test(user)
        || !expectedAccount.startsWith(`${user}@`)
        || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(expectedServerUuid)) {
        throw new Error('Receipt cleanup target confirmation is invalid.');
    }
    const shared: PoolOptions = {
        user, password, database,
        connectionLimit: 1,
        waitForConnections: false,
        queueLimit: 0,
        connectTimeout: 10_000,
        timezone: 'Z',
        multipleStatements: false,
    };

    if (env.NODE_ENV === 'production') {
        const cloudSql = required(env, 'RECEIPT_CLEANUP_CLOUD_SQL_CONNECTION_NAME');
        assertRecoveryDatabaseTarget(recoveryTarget, cloudSql, expectedServerUuid, database);
        if (!/^[a-z][a-z0-9-]+:[a-z0-9-]+:[a-z0-9-]+$/.test(cloudSql)
            || user !== 'receipt_cleanup'
            || expectedAccount !== 'receipt_cleanup@cloudsqlproxy~%') {
            throw new Error('Production receipt cleanup requires its dedicated proxy-only account.');
        }
        if (env.RECEIPT_CLEANUP_DB_HOST || env.RECEIPT_CLEANUP_DB_PORT) {
            throw new Error('Production receipt cleanup must use the Cloud SQL socket.');
        }
        return Object.freeze({
            databaseOptions: { ...shared, socketPath: `/cloudsql/${cloudSql}` },
            expectedAccount, expectedServerUuid,
        });
    }

    const host = required(env, 'RECEIPT_CLEANUP_DB_HOST');
    const port = Number(required(env, 'RECEIPT_CLEANUP_DB_PORT'));
    if (!['127.0.0.1', '::1', 'localhost'].includes(host)
        || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
        throw new Error('Non-production receipt cleanup requires an explicit loopback endpoint.');
    }
    return Object.freeze({
        databaseOptions: { ...shared, host, port }, expectedAccount, expectedServerUuid,
    });
}
