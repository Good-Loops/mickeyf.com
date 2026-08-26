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
    p4VegaBackfillChunkSize: number;
    p4VegaOperationTimeoutMs: number;
}>;

const DEFAULT_ADVISORY_LOCK_TIMEOUT_SECONDS = 5;
const MAX_ADVISORY_LOCK_TIMEOUT_SECONDS = 30;
const DEFAULT_LOCK_WAIT_TIMEOUT_SECONDS = 10;
const MAX_LOCK_WAIT_TIMEOUT_SECONDS = 60;
const DEFAULT_OPERATION_TIMEOUT_MS = 30_000;
const MIN_OPERATION_TIMEOUT_MS = 1_000;
const MAX_OPERATION_TIMEOUT_MS = 120_000;
const DEFAULT_P4_VEGA_BACKFILL_CHUNK_SIZE = 500;
const MAX_P4_VEGA_BACKFILL_CHUNK_SIZE = 5_000;
const DEFAULT_P4_VEGA_OPERATION_TIMEOUT_MS = 900_000;
const MIN_P4_VEGA_OPERATION_TIMEOUT_MS = 30_000;
const MAX_P4_VEGA_OPERATION_TIMEOUT_MS = 21_600_000;

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
        p4VegaBackfillChunkSize: parseBoundedInteger(
            env.MIGRATION_P4_VEGA_BACKFILL_CHUNK_SIZE,
            'MIGRATION_P4_VEGA_BACKFILL_CHUNK_SIZE',
            1,
            MAX_P4_VEGA_BACKFILL_CHUNK_SIZE,
            DEFAULT_P4_VEGA_BACKFILL_CHUNK_SIZE
        ),
        p4VegaOperationTimeoutMs: parseBoundedInteger(
            env.MIGRATION_P4_VEGA_OPERATION_TIMEOUT_MS,
            'MIGRATION_P4_VEGA_OPERATION_TIMEOUT_MS',
            MIN_P4_VEGA_OPERATION_TIMEOUT_MS,
            MAX_P4_VEGA_OPERATION_TIMEOUT_MS,
            DEFAULT_P4_VEGA_OPERATION_TIMEOUT_MS
        ),
    });
}

export function loadMigrationAccountConfirmation(
    env: Environment = process.env
): string {
    const confirmedAccount = requiredValue(env, 'MIGRATION_CONFIRM_ACCOUNT', true);
    const accountSeparator = confirmedAccount.lastIndexOf('@');
    if (
        confirmedAccount !== confirmedAccount.trim()
        || confirmedAccount.length > 288
        || accountSeparator <= 0
        || accountSeparator === confirmedAccount.length - 1
        || /[\u0000-\u001f\u007f]/u.test(confirmedAccount)
    ) {
        throw new Error(
            'MIGRATION_CONFIRM_ACCOUNT must be the exact CURRENT_USER() account'
        );
    }
    return confirmedAccount;
}

export function assertDatabaseConfirmation(
    config: Pick<MigrationConfig, 'database'>,
    confirmedDatabase: string | undefined
): void {
    if (!confirmedDatabase || confirmedDatabase.trim() === '') {
        throw new Error('MIGRATION_CONFIRM_DATABASE is required for privileged migration actions');
    }

    if (confirmedDatabase !== config.database) {
        throw new Error('MIGRATION_CONFIRM_DATABASE must exactly match MIGRATION_DB_NAME');
    }
}

export type MutatingMigrationAction = 'apply' | 'rollback-empty';

export type P4VegaDataOperation = 'backfill-p4-vega' | 'reconcile-p4-vega';

export type RuntimeGrantCommand = 'plan' | 'verify' | 'apply';

export type P4GrantRetirementCommand = 'plan' | 'verify' | 'apply';

export type P4ScoreDropCommand = 'plan' | 'verify' | 'apply';

function assertTargetConfirmed(
    config: Pick<MigrationConfig, 'host' | 'port' | 'database'>,
    env: Environment
): void {
    assertDatabaseConfirmation(config, env.MIGRATION_CONFIRM_DATABASE);

    const expectedTarget = `${config.host}:${config.port}/${config.database}`;
    if (env.MIGRATION_CONFIRM_TARGET !== expectedTarget) {
        throw new Error(
            'MIGRATION_CONFIRM_TARGET must exactly match MIGRATION_DB_HOST:PORT/NAME'
        );
    }
}

export function assertMutationAuthorized(
    action: MutatingMigrationAction,
    config: Pick<MigrationConfig, 'host' | 'port' | 'database'>,
    env: Environment = process.env
): void {
    assertTargetConfirmed(config, env);

    const authorizationVariable = action === 'apply'
        ? 'MIGRATION_ALLOW_APPLY'
        : 'MIGRATION_ALLOW_ROLLBACK_EMPTY';
    if (env[authorizationVariable] !== '1') {
        throw new Error(`${authorizationVariable}=1 is required for this migration action`);
    }
}

export function assertP4VegaDataOperationAuthorized(
    operation: P4VegaDataOperation,
    config: Pick<MigrationConfig, 'host' | 'port' | 'database'>,
    env: Environment = process.env
): void {
    assertTargetConfirmed(config, env);

    const authorizationVariable = operation === 'backfill-p4-vega'
        ? 'MIGRATION_ALLOW_P4_VEGA_BACKFILL'
        : 'MIGRATION_ALLOW_P4_VEGA_RECONCILE';
    if (env[authorizationVariable] !== '1') {
        throw new Error(`${authorizationVariable}=1 is required for this migration action`);
    }
}

export type RuntimeGrantConfirmation = Readonly<{
    approvedPlanSha256?: string;
    confirmedServerUuid?: string;
}>;

type CloudSqlTarget = Readonly<{
    project: string;
    instance: string;
    connectionName: string;
    serverUuid: string;
}>;

function assertCloudSqlTargetConfirmed(
    expectedCloudSqlTarget: CloudSqlTarget,
    env: Environment
): void {
    if (
        env.MIGRATION_CONFIRM_CLOUD_SQL_PROJECT !== expectedCloudSqlTarget.project
        || env.MIGRATION_CONFIRM_CLOUD_SQL_INSTANCE !== expectedCloudSqlTarget.instance
        || env.MIGRATION_CONFIRM_CLOUD_SQL_CONNECTION_NAME
            !== expectedCloudSqlTarget.connectionName
    ) {
        throw new Error(
            'MIGRATION_CONFIRM_CLOUD_SQL_PROJECT, MIGRATION_CONFIRM_CLOUD_SQL_INSTANCE, and MIGRATION_CONFIRM_CLOUD_SQL_CONNECTION_NAME must exactly match the reviewed target'
        );
    }
}

function loadPlanAndServerConfirmation(
    planVariable: string,
    expectedCloudSqlTarget: CloudSqlTarget,
    env: Environment
): RuntimeGrantConfirmation {
    const approvedPlanSha256 = env[planVariable];
    if (!approvedPlanSha256 || !/^[a-f0-9]{64}$/u.test(approvedPlanSha256)) {
        throw new Error(
            `${planVariable} must be the exact lowercase plan digest`
        );
    }

    const confirmedServerUuid = env.MIGRATION_CONFIRM_SERVER_UUID;
    if (
        !confirmedServerUuid
        || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u
            .test(confirmedServerUuid)
    ) {
        throw new Error(
            'MIGRATION_CONFIRM_SERVER_UUID must be the exact lowercase server UUID from the plan'
        );
    }
    if (confirmedServerUuid !== expectedCloudSqlTarget.serverUuid) {
        throw new Error(
            'MIGRATION_CONFIRM_SERVER_UUID must match the independently pinned Cloud SQL server UUID'
        );
    }

    return Object.freeze({ approvedPlanSha256, confirmedServerUuid });
}

export function assertRuntimeGrantCommandConfirmed(
    command: RuntimeGrantCommand,
    config: Pick<MigrationConfig, 'host' | 'port' | 'database'>,
    expectedRuntimeAccount: string,
    expectedRuntimeRole: string,
    expectedCloudSqlTarget: CloudSqlTarget,
    env: Environment = process.env
): RuntimeGrantConfirmation {
    assertTargetConfirmed(config, env);

    if (env.MIGRATION_CONFIRM_RUNTIME_ACCOUNT !== expectedRuntimeAccount) {
        throw new Error(
            'MIGRATION_CONFIRM_RUNTIME_ACCOUNT must exactly match the reviewed runtime account'
        );
    }

    if (command !== 'apply') return Object.freeze({});

    if (env.MIGRATION_CONFIRM_RUNTIME_ROLE !== expectedRuntimeRole) {
        throw new Error(
            'MIGRATION_CONFIRM_RUNTIME_ROLE must exactly match the reviewed runtime role'
        );
    }
    assertCloudSqlTargetConfirmed(expectedCloudSqlTarget, env);
    if (
        env.MIGRATION_CONFIRM_RUNTIME_ROLE_REPLACEMENT
            !== `${expectedRuntimeRole} -> no database roles`
    ) {
        throw new Error(
            'MIGRATION_CONFIRM_RUNTIME_ROLE_REPLACEMENT must confirm the exact zero-role transition'
        );
    }
    if (env.MIGRATION_CONFIRM_RUNTIME_TRAFFIC_DRAINED !== '1') {
        throw new Error(
            'MIGRATION_CONFIRM_RUNTIME_TRAFFIC_DRAINED=1 is required before runtime role removal'
        );
    }

    if (env.MIGRATION_ALLOW_RUNTIME_GRANTS !== '1') {
        throw new Error(
            'MIGRATION_ALLOW_RUNTIME_GRANTS=1 is required for the runtime grant apply action'
        );
    }

    return loadPlanAndServerConfirmation(
        'MIGRATION_CONFIRM_RUNTIME_GRANT_PLAN_SHA256',
        expectedCloudSqlTarget,
        env
    );
}

export function assertP4GrantRetirementCommandConfirmed(
    command: P4GrantRetirementCommand,
    config: Pick<MigrationConfig, 'host' | 'port' | 'database'>,
    expectedRuntimeAccount: string,
    expectedCloudSqlTarget: CloudSqlTarget,
    env: Environment = process.env
): RuntimeGrantConfirmation {
    assertTargetConfirmed(config, env);

    if (env.MIGRATION_CONFIRM_RUNTIME_ACCOUNT !== expectedRuntimeAccount) {
        throw new Error(
            'MIGRATION_CONFIRM_RUNTIME_ACCOUNT must exactly match the reviewed runtime account'
        );
    }

    if (command !== 'apply') return Object.freeze({});

    assertCloudSqlTargetConfirmed(expectedCloudSqlTarget, env);
    if (env.MIGRATION_CONFIRM_GENERIC_ONLY_FROZEN !== '1') {
        throw new Error(
            'MIGRATION_CONFIRM_GENERIC_ONLY_FROZEN=1 is required after the frozen generic-only revision is serving'
        );
    }
    if (
        env.MIGRATION_CONFIRM_P4_GRANT_RETIREMENT
            !== 'users.p4_score SELECT,UPDATE -> no runtime access'
    ) {
        throw new Error(
            'MIGRATION_CONFIRM_P4_GRANT_RETIREMENT must confirm the exact two-grant retirement'
        );
    }
    if (env.MIGRATION_ALLOW_P4_GRANT_RETIREMENT !== '1') {
        throw new Error(
            'MIGRATION_ALLOW_P4_GRANT_RETIREMENT=1 is required for the p4_score grant retirement apply action'
        );
    }

    return loadPlanAndServerConfirmation(
        'MIGRATION_CONFIRM_P4_GRANT_RETIREMENT_PLAN_SHA256',
        expectedCloudSqlTarget,
        env
    );
}

export function assertP4ScoreDropCommandConfirmed(
    command: P4ScoreDropCommand,
    config: Pick<MigrationConfig, 'host' | 'port' | 'database'>,
    expectedCloudSqlTarget: CloudSqlTarget,
    env: Environment = process.env
): RuntimeGrantConfirmation {
    assertTargetConfirmed(config, env);
    if (command !== 'apply') return Object.freeze({});

    assertCloudSqlTargetConfirmed(expectedCloudSqlTarget, env);
    if (env.MIGRATION_CONFIRM_GENERIC_ONLY_FROZEN !== '1') {
        throw new Error(
            'MIGRATION_CONFIRM_GENERIC_ONLY_FROZEN=1 is required before dropping p4_score'
        );
    }
    if (
        env.MIGRATION_CONFIRM_MAIN_TRIGGER_DISABLED
            !== 'main-push-mickeyf-com -> disabled'
    ) {
        throw new Error(
            'MIGRATION_CONFIRM_MAIN_TRIGGER_DISABLED must confirm the incompatible main trigger is disabled'
        );
    }
    if (env.MIGRATION_CONFIRM_P4_SCORE_DROP !== 'users.p4_score -> dropped') {
        throw new Error(
            'MIGRATION_CONFIRM_P4_SCORE_DROP must confirm the exact irreversible column removal'
        );
    }
    if (env.MIGRATION_ALLOW_P4_SCORE_DROP !== '1') {
        throw new Error(
            'MIGRATION_ALLOW_P4_SCORE_DROP=1 is required for the p4_score drop apply action'
        );
    }

    return loadPlanAndServerConfirmation(
        'MIGRATION_CONFIRM_P4_SCORE_DROP_PLAN_SHA256',
        expectedCloudSqlTarget,
        env
    );
}
