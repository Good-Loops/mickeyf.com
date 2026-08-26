export type RuntimeEnvironment = 'development' | 'test' | 'production';

type Environment = Readonly<Record<string, string | undefined>>;

export type RuntimeConfig = {
    nodeEnv: RuntimeEnvironment;
    isProduction: boolean;
    port: number;
    sessionSecret: string;
    corsOrigins: readonly string[];
    p4VegaScoreSubmissionsEnabled: boolean;
};

export type DatabaseConfig = {
    nodeEnv: RuntimeEnvironment;
    isProduction: boolean;
    user: string;
    password: string;
    database: string;
    host?: string;
    port?: number;
    cloudSqlConnectionName?: string;
};

const PRODUCTION_ORIGINS = Object.freeze([
    'https://mickeyf.com',
    'https://www.mickeyf.com',
]);

const DEVELOPMENT_ORIGINS = Object.freeze([
    'http://localhost:5173',
]);

function requiredValue(env: Environment, name: string): string {
    const value = env[name]?.trim();
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}

function parsePort(value: string | undefined, name: string, fallback?: number): number {
    if (value === undefined || value.trim() === '') {
        if (fallback !== undefined) return fallback;
        throw new Error(`Missing required environment variable: ${name}`);
    }

    const port = Number(value);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
        throw new Error(`${name} must be an integer from 1 through 65535`);
    }
    return port;
}

function isExplicitlyEnabled(value: string | undefined): boolean {
    return value === 'true';
}

export function parseRuntimeEnvironment(env: Environment): RuntimeEnvironment {
    const value = requiredValue(env, 'NODE_ENV');
    if (value !== 'development' && value !== 'test' && value !== 'production') {
        throw new Error('NODE_ENV must be development, test, or production');
    }
    return value;
}

export function loadRuntimeConfig(env: Environment = process.env): RuntimeConfig {
    const nodeEnv = parseRuntimeEnvironment(env);
    const sessionSecret = requiredValue(env, 'SESSION_SECRET');
    const minimumSecretLength = nodeEnv === 'production' ? 32 : 16;

    if (sessionSecret.length < minimumSecretLength) {
        throw new Error(`SESSION_SECRET must contain at least ${minimumSecretLength} characters`);
    }

    return Object.freeze({
        nodeEnv,
        isProduction: nodeEnv === 'production',
        port: parsePort(env.BACKEND_PORT, 'BACKEND_PORT', 8080),
        sessionSecret,
        corsOrigins: nodeEnv === 'production'
            ? PRODUCTION_ORIGINS
            : nodeEnv === 'development'
                ? DEVELOPMENT_ORIGINS
                : Object.freeze([]),
        p4VegaScoreSubmissionsEnabled: isExplicitlyEnabled(
            env.P4_VEGA_SCORE_SUBMISSIONS_ENABLED
        ),
    });
}

export function loadDatabaseConfig(env: Environment = process.env): DatabaseConfig {
    const nodeEnv = parseRuntimeEnvironment(env);
    const base = {
        nodeEnv,
        isProduction: nodeEnv === 'production',
        user: requiredValue(env, 'DB_USER'),
        password: requiredValue(env, 'DB_PASS'),
        database: requiredValue(env, 'DB_NAME'),
    };

    if (base.isProduction) {
        return Object.freeze({
            ...base,
            cloudSqlConnectionName: requiredValue(env, 'CLOUD_SQL_CONNECTION_NAME'),
        });
    }

    return Object.freeze({
        ...base,
        host: env.DB_HOST?.trim() || 'localhost',
        port: parsePort(env.DB_PORT, 'DB_PORT', 3306),
    });
}
