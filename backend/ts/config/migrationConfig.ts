type Environment = Readonly<Record<string, string | undefined>>;

export type MigrationConfig = Readonly<{
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
    advisoryLockTimeoutSeconds: number;
    lockWaitTimeoutSeconds: number;
    operationTimeoutMs: number;
}>;

const DEFAULT_ADVISORY_LOCK_TIMEOUT_SECONDS = 5;
const MAX_ADVISORY_LOCK_TIMEOUT_SECONDS = 30;
const DEFAULT_LOCK_WAIT_TIMEOUT_SECONDS = 10;
const MAX_LOCK_WAIT_TIMEOUT_SECONDS = 60;
const DEFAULT_OPERATION_TIMEOUT_MS = 30_000;
const MIN_OPERATION_TIMEOUT_MS = 1_000;
const MAX_OPERATION_TIMEOUT_MS = 120_000;

function requiredValue(
    env: Environment,
    name: string,
    preserveWhitespace = false
): string {
    const rawValue = env[name];
    if (rawValue === undefined || rawValue.trim() === '') {
        throw new Error(`Missing required environment variable: ${name}`);
    }

    return preserveWhitespace ? rawValue : rawValue.trim();
}

function parseBoundedInteger(
    value: string | undefined,
    name: string,
    minimum: number,
    maximum: number,
    fallback?: number
): number {
    if (value === undefined || value.trim() === '') {
        if (fallback !== undefined) return fallback;
        throw new Error(`Missing required environment variable: ${name}`);
    }

    const parsedValue = Number(value);
    if (
        !Number.isSafeInteger(parsedValue)
        || parsedValue < minimum
        || parsedValue > maximum
    ) {
        throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`);
    }

    return parsedValue;
}

export function loadMigrationConfig(env: Environment = process.env): MigrationConfig {
    const host = requiredValue(env, 'MIGRATION_DB_HOST');
    if (host !== '127.0.0.1') {
        throw new Error(
            'MIGRATION_DB_HOST must be 127.0.0.1; use the authenticated Cloud SQL proxy'
        );
    }

    return Object.freeze({
        // Migration credentials are deliberately isolated from runtime DB_* values.
        host,
        port: parseBoundedInteger(env.MIGRATION_DB_PORT, 'MIGRATION_DB_PORT', 1, 65_535),
        user: requiredValue(env, 'MIGRATION_DB_USER'),
        password: requiredValue(env, 'MIGRATION_DB_PASS', true),
        database: requiredValue(env, 'MIGRATION_DB_NAME'),
        advisoryLockTimeoutSeconds: parseBoundedInteger(
            env.MIGRATION_ADVISORY_LOCK_TIMEOUT_SECONDS,
            'MIGRATION_ADVISORY_LOCK_TIMEOUT_SECONDS',
            0,
            MAX_ADVISORY_LOCK_TIMEOUT_SECONDS,
            DEFAULT_ADVISORY_LOCK_TIMEOUT_SECONDS
        ),
        lockWaitTimeoutSeconds: parseBoundedInteger(
            env.MIGRATION_LOCK_WAIT_TIMEOUT_SECONDS,
            'MIGRATION_LOCK_WAIT_TIMEOUT_SECONDS',
            1,
            MAX_LOCK_WAIT_TIMEOUT_SECONDS,
            DEFAULT_LOCK_WAIT_TIMEOUT_SECONDS
        ),
        operationTimeoutMs: parseBoundedInteger(
            env.MIGRATION_OPERATION_TIMEOUT_MS,
            'MIGRATION_OPERATION_TIMEOUT_MS',
            MIN_OPERATION_TIMEOUT_MS,
            MAX_OPERATION_TIMEOUT_MS,
            DEFAULT_OPERATION_TIMEOUT_MS
        ),
    });
}

export function assertDatabaseConfirmation(
    config: Pick<MigrationConfig, 'database'>,
    confirmedDatabase: string | undefined
): void {
    if (!confirmedDatabase || confirmedDatabase.trim() === '') {
        throw new Error('MIGRATION_CONFIRM_DATABASE is required for mutating migration actions');
    }

    if (confirmedDatabase !== config.database) {
        throw new Error('MIGRATION_CONFIRM_DATABASE must exactly match MIGRATION_DB_NAME');
    }
}

export type MutatingMigrationAction = 'apply' | 'rollback-empty';

export function assertMutationAuthorized(
    action: MutatingMigrationAction,
    config: Pick<MigrationConfig, 'host' | 'port' | 'database'>,
    env: Environment = process.env
): void {
    assertDatabaseConfirmation(config, env.MIGRATION_CONFIRM_DATABASE);

    const expectedTarget = `${config.host}:${config.port}/${config.database}`;
    if (env.MIGRATION_CONFIRM_TARGET !== expectedTarget) {
        throw new Error(
            'MIGRATION_CONFIRM_TARGET must exactly match MIGRATION_DB_HOST:PORT/NAME'
        );
    }

    const authorizationVariable = action === 'apply'
        ? 'MIGRATION_ALLOW_APPLY'
        : 'MIGRATION_ALLOW_ROLLBACK_EMPTY';
    if (env[authorizationVariable] !== '1') {
        throw new Error(`${authorizationVariable}=1 is required for this migration action`);
    }
}
