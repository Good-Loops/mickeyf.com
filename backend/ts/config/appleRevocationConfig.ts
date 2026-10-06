import type { PoolOptions } from 'mysql2/promise';
import { PRODUCTION_RUNTIME_DATABASE_ACCOUNT } from '../security/runtimeGrantManifest';
import { loadAppleTokenConfig, type AppleTokenLifecycle } from './appleTokenConfig';

type Environment = Readonly<Record<string, string | undefined>>;
export type AppleRevocationConfig = Readonly<{
    databaseOptions: PoolOptions;
    expectedAccount: string;
    expectedServerUuid: string;
}>;
const CONNECTION_NAME = 'noted-reef-387021:us-central1:cms-mickeyf';

function required(env: Environment, name: string): string {
    const value = env[name];
    if (!value || !value.trim()) throw new Error('Apple revocation requires explicit maintenance configuration.');
    return value;
}

/** No dotenv, local fallback, isolated replay or implicit provider activation. */
export function loadAppleRevocationConfig(args: readonly string[], env: Environment = process.env): AppleRevocationConfig {
    if (args.length !== 1 || args[0] !== 'apply') throw new Error('Usage: runAppleTokenRevocation.ts apply');
    if (env.APPLE_REVOCATION_RUN_ENABLED !== 'true' || env.NODE_ENV !== 'production'
        || (env.LUDOLUME_ISOLATED_RUNTIME !== undefined && env.LUDOLUME_ISOLATED_RUNTIME !== 'false')) {
        throw new Error('Apple revocation requires explicit production maintenance activation.');
    }
    const user = required(env, 'APPLE_REVOCATION_DB_USER');
    const password = required(env, 'APPLE_REVOCATION_DB_PASS');
    const database = required(env, 'APPLE_REVOCATION_DB_NAME');
    const connectionName = required(env, 'APPLE_REVOCATION_CLOUD_SQL_CONNECTION_NAME');
    const expectedAccount = required(env, 'APPLE_REVOCATION_EXPECTED_ACCOUNT');
    const expectedServerUuid = required(env, 'APPLE_REVOCATION_EXPECTED_SERVER_UUID');
    const runtime = PRODUCTION_RUNTIME_DATABASE_ACCOUNT;
    if (user !== runtime.user || expectedAccount !== `${runtime.user}@${runtime.host}` || database !== 'cms'
        || connectionName !== CONNECTION_NAME || expectedServerUuid.length !== 36
        || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u.test(expectedServerUuid)
        || env.APPLE_REVOCATION_DB_HOST !== undefined || env.APPLE_REVOCATION_DB_PORT !== undefined) {
        throw new Error('Apple revocation requires the reviewed production socket, database and runtime identity.');
    }
    return Object.freeze({
        databaseOptions: Object.freeze({ user, password, database, socketPath: `/cloudsql/${connectionName}`,
            connectionLimit: 1, waitForConnections: false, queueLimit: 0, connectTimeout: 10_000,
            multipleStatements: false, timezone: 'Z', dateStrings: true }),
        expectedAccount, expectedServerUuid,
    });
}

/** Parse retry credentials only after verified DB-only expiry cleanup has completed. */
export function loadAppleRevocationLifecycle(env: Environment = process.env): AppleTokenLifecycle {
    const lifecycle = loadAppleTokenConfig(env);
    if (!lifecycle) throw new Error('Apple revocation requires explicit token lifecycle activation.');
    return lifecycle;
}
