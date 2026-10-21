import type { PoolOptions } from 'mysql2/promise';

type Environment = Readonly<Record<string, string | undefined>>;

export type DeletionAuditSettings = Readonly<{
    database: string;
    expectedCurrentUser: string;
    expectedServerUuid: string;
    expectedIdentityEpoch: string;
    graceMs: number;
    maxIntents: number;
    maxDurationMs: number;
}>;

export type DeletionAuditConfig = Readonly<{
    databaseOptions: PoolOptions;
    settings: DeletionAuditSettings;
}>;

const PRODUCTION_CONNECTION_NAME = 'noted-reef-387021:us-central1:cms-mickeyf';

function required(env: Environment, name: string): string {
    const value = env[name];
    if (typeof value !== 'string' || value.trim() === '') throw new Error(`Missing ${name}`);
    return value;
}

function positiveInteger(value: string, name: string, maximum: number): number {
    if (!/^[1-9][0-9]*$/u.test(value)) throw new Error(`Invalid ${name}`);
    const result = Number(value);
    if (!Number.isSafeInteger(result) || result > maximum) throw new Error(`Invalid ${name}`);
    return result;
}

function identityEpoch(value: string): string {
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/u.test(value)) {
        throw new Error('DELETION_AUDIT_IDENTITY_EPOCH requires the original UTC timestamp with six fractional digits');
    }
    const date = new Date(`${value.slice(0, 10)}T${value.slice(11, 23)}Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().replace('T', ' ').slice(0, 23) !== value.slice(0, 23)) {
        throw new Error('Invalid DELETION_AUDIT_IDENTITY_EPOCH');
    }
    return value;
}

function databaseEndpoint(env: Environment, user: string, database: string, currentUser: string): PoolOptions {
    if (env.NODE_ENV === 'production') {
        if (required(env, 'DELETION_AUDIT_CLOUD_SQL_CONNECTION_NAME') !== PRODUCTION_CONNECTION_NAME
            || user !== 'deletion_audit' || database !== 'cms'
            || currentUser !== 'deletion_audit@cloudsqlproxy~%') {
            throw new Error('Production deletion audit requires its fixed Cloud SQL target and dedicated proxy-only account');
        }
        if (env.DELETION_AUDIT_DB_HOST !== undefined || env.DELETION_AUDIT_DB_PORT !== undefined) {
            throw new Error('Production deletion audit must use only its Cloud SQL socket');
        }
        return { socketPath: `/cloudsql/${PRODUCTION_CONNECTION_NAME}` };
    }
    if (required(env, 'DELETION_AUDIT_DB_HOST') !== '127.0.0.1'
        || env.DELETION_AUDIT_CLOUD_SQL_CONNECTION_NAME !== undefined) {
        throw new Error('Non-production deletion audit requires an explicit loopback endpoint only');
    }
    return {
        host: '127.0.0.1',
        port: positiveInteger(required(env, 'DELETION_AUDIT_DB_PORT'), 'DELETION_AUDIT_DB_PORT', 65535),
    };
}

/** Read-only auditing uses dedicated credentials, never website/replay defaults or a write-freeze attestation. */
export function loadDeletionAuditConfig(env: Environment = process.env): DeletionAuditConfig {
    if (!['development', 'test', 'production'].includes(env.NODE_ENV ?? '')) {
        throw new Error('Deletion audit requires an explicit NODE_ENV');
    }
    const user = required(env, 'DELETION_AUDIT_DB_USER');
    const password = required(env, 'DELETION_AUDIT_DB_PASSWORD');
    const database = required(env, 'DELETION_AUDIT_DB_NAME');
    if (!/^[A-Za-z0-9_.-]{1,32}$/u.test(user) || !/^[A-Za-z0-9_]{1,64}$/u.test(database)) {
        throw new Error('Invalid deletion audit database or audit user');
    }
    const expectedCurrentUser = required(env, 'DELETION_AUDIT_DB_CURRENT_USER');
    if (!expectedCurrentUser.startsWith(`${user}@`)
        || !/^[A-Za-z0-9_.:%/~\-]{1,255}$/u.test(expectedCurrentUser.slice(user.length + 1))) {
        throw new Error('Deletion audit requires the exact audit CURRENT_USER');
    }
    const expectedServerUuid = required(env, 'DELETION_AUDIT_DB_SERVER_UUID');
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(expectedServerUuid)) {
        throw new Error('Invalid DELETION_AUDIT_DB_SERVER_UUID');
    }
    const settings: DeletionAuditSettings = Object.freeze({
        database, expectedCurrentUser, expectedServerUuid,
        expectedIdentityEpoch: identityEpoch(required(env, 'DELETION_AUDIT_IDENTITY_EPOCH')),
        graceMs: positiveInteger(env.DELETION_AUDIT_GRACE_MS ?? '900000', 'DELETION_AUDIT_GRACE_MS', 86_400_000),
        maxIntents: positiveInteger(env.DELETION_AUDIT_MAX_INTENTS ?? '1000', 'DELETION_AUDIT_MAX_INTENTS', 10_000),
        maxDurationMs: positiveInteger(env.DELETION_AUDIT_MAX_DURATION_MS ?? '60000', 'DELETION_AUDIT_MAX_DURATION_MS', 300_000),
    });
    return Object.freeze({
        settings,
        databaseOptions: Object.freeze({
            ...databaseEndpoint(env, user, database, expectedCurrentUser),
            user, password, database,
            connectionLimit: 1, waitForConnections: false, queueLimit: 0,
            connectTimeout: Math.min(10_000, settings.maxDurationMs),
            timezone: 'Z', dateStrings: true, multipleStatements: false,
        }),
    });
}
