import {
    getMigrationPrincipalProfile,
    MIGRATION_PRINCIPAL_BOOTSTRAP_ACCOUNT,
    MIGRATION_PRINCIPAL_HOST,
    MIGRATION_PRINCIPAL_WATCHDOG_ARMER_ACCOUNT,
    type MigrationPrincipalProfileName,
} from '../migrations/migrationPrincipalProfiles';
import {
    assertMigrationPrincipalWatchdogDelay,
    assertMigrationPrincipalWatchdogDefiner,
    getMigrationPrincipalWatchdogEventName,
} from '../migrations/migrationPrincipalWatchdog';

type Environment = Readonly<Record<string, string | undefined>>;

export type MigrationPrincipalAction =
    | 'create'
    | 'revoke'
    | 'watchdog-arm'
    | 'watchdog-disarm';

export type MigrationPrincipalAdminConfig = Readonly<{
    action: MigrationPrincipalAction;
    profileName: MigrationPrincipalProfileName;
    host: '127.0.0.1';
    port: number;
    user: string;
    password: string;
    database: string;
    principalPassword?: string;
    watchdogDefiner?: string;
    watchdogDelaySeconds?: number;
}>;

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

function parsePort(value: string): number {
    const port = Number(value);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
        throw new Error('MIGRATION_PRINCIPAL_ADMIN_PORT must be an integer from 1 through 65535');
    }
    return port;
}

function parseWatchdogDelay(value: string): number {
    const delaySeconds = Number(value);
    assertMigrationPrincipalWatchdogDelay(delaySeconds);
    return delaySeconds;
}

export function loadMigrationPrincipalAdminConfig(
    action: MigrationPrincipalAction,
    profileName: MigrationPrincipalProfileName,
    env: Environment = process.env
): MigrationPrincipalAdminConfig {
    const host = requiredValue(env, 'MIGRATION_PRINCIPAL_ADMIN_HOST');
    if (host !== '127.0.0.1') {
        throw new Error(
            'MIGRATION_PRINCIPAL_ADMIN_HOST must be 127.0.0.1; '
                + 'use the authenticated Cloud SQL proxy'
        );
    }

    const port = parsePort(requiredValue(env, 'MIGRATION_PRINCIPAL_ADMIN_PORT'));
    const database = requiredValue(env, 'MIGRATION_PRINCIPAL_ADMIN_DATABASE');
    const user = requiredValue(env, 'MIGRATION_PRINCIPAL_ADMIN_USER');
    const profile = getMigrationPrincipalProfile(profileName);
    if (user === profile.accountName) {
        throw new Error('Provisioning administrator must differ from the temporary account');
    }
    const expectedAdminUser = action === 'watchdog-arm'
        ? MIGRATION_PRINCIPAL_WATCHDOG_ARMER_ACCOUNT
        : MIGRATION_PRINCIPAL_BOOTSTRAP_ACCOUNT;
    if (user !== expectedAdminUser) {
        throw new Error(
            `${action} requires the fixed migration administrator ${expectedAdminUser}`
        );
    }

    const expectedTarget = `${host}:${port}/${database}`;
    if (env.MIGRATION_PRINCIPAL_CONFIRM_TARGET !== expectedTarget) {
        throw new Error(
            'MIGRATION_PRINCIPAL_CONFIRM_TARGET must exactly match '
                + 'MIGRATION_PRINCIPAL_ADMIN_HOST:PORT/DATABASE'
        );
    }
    if (env.MIGRATION_PRINCIPAL_CONFIRM_DATABASE !== database) {
        throw new Error(
            'MIGRATION_PRINCIPAL_CONFIRM_DATABASE must exactly match '
                + 'MIGRATION_PRINCIPAL_ADMIN_DATABASE'
        );
    }
    if (env.MIGRATION_PRINCIPAL_CONFIRM_PROFILE !== profileName) {
        throw new Error('MIGRATION_PRINCIPAL_CONFIRM_PROFILE must exactly match the CLI profile');
    }
    const expectedAccount = `${profile.accountName}@${MIGRATION_PRINCIPAL_HOST}`;
    if (env.MIGRATION_PRINCIPAL_CONFIRM_ACCOUNT !== expectedAccount) {
        throw new Error(
            'MIGRATION_PRINCIPAL_CONFIRM_ACCOUNT must exactly match the fixed profile account'
        );
    }

    const authorizationVariable = {
        create: 'MIGRATION_PRINCIPAL_ALLOW_CREATE',
        revoke: 'MIGRATION_PRINCIPAL_ALLOW_REVOKE',
        'watchdog-arm': 'MIGRATION_PRINCIPAL_ALLOW_WATCHDOG_ARM',
        'watchdog-disarm': 'MIGRATION_PRINCIPAL_ALLOW_WATCHDOG_DISARM',
    }[action];
    if (env[authorizationVariable] !== '1') {
        throw new Error(`${authorizationVariable}=1 is required for this account action`);
    }

    const principalPassword = action === 'create'
        ? requiredValue(env, 'MIGRATION_PRINCIPAL_PASSWORD', true)
        : undefined;

    const watchdogAction = action === 'create'
        || action === 'watchdog-arm'
        || action === 'watchdog-disarm';
    const watchdogDefiner = watchdogAction
        ? requiredValue(env, 'MIGRATION_PRINCIPAL_CONFIRM_WATCHDOG_DEFINER')
        : undefined;
    if (watchdogAction) {
        if (watchdogDefiner === undefined) {
            throw new Error('Migration-watchdog definer confirmation was not loaded');
        }
        assertMigrationPrincipalWatchdogDefiner(watchdogDefiner);
        const expectedEvent = getMigrationPrincipalWatchdogEventName(profileName);
        if (env.MIGRATION_PRINCIPAL_CONFIRM_EVENT !== expectedEvent) {
            throw new Error(
                'MIGRATION_PRINCIPAL_CONFIRM_EVENT must exactly match the fixed profile event'
            );
        }
    }
    const watchdogDelaySeconds = action === 'watchdog-arm'
        ? parseWatchdogDelay(requiredValue(
            env,
            'MIGRATION_PRINCIPAL_WATCHDOG_DELAY_SECONDS'
        ))
        : undefined;

    return Object.freeze({
        action,
        profileName,
        host,
        port,
        user,
        password: requiredValue(env, 'MIGRATION_PRINCIPAL_ADMIN_PASS', true),
        database,
        principalPassword,
        watchdogDefiner,
        watchdogDelaySeconds,
    });
}
