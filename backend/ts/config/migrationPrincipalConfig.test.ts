import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    MIGRATION_PRINCIPAL_BOOTSTRAP_ACCOUNT,
    MIGRATION_PRINCIPAL_WATCHDOG_ARMER_ACCOUNT,
} from '../migrations/migrationPrincipalProfiles';
import { loadMigrationPrincipalAdminConfig } from './migrationPrincipalConfig';

const baseEnvironment = Object.freeze({
    MIGRATION_PRINCIPAL_ADMIN_HOST: '127.0.0.1',
    MIGRATION_PRINCIPAL_ADMIN_PORT: '3307',
    MIGRATION_PRINCIPAL_ADMIN_USER: 'mickeyf_migration_bootstrap',
    MIGRATION_PRINCIPAL_ADMIN_PASS: 'admin-test-only',
    MIGRATION_PRINCIPAL_ADMIN_DATABASE: 'mickeyf_migration_test',
    MIGRATION_PRINCIPAL_CONFIRM_TARGET:
        '127.0.0.1:3307/mickeyf_migration_test',
    MIGRATION_PRINCIPAL_CONFIRM_DATABASE: 'mickeyf_migration_test',
    MIGRATION_PRINCIPAL_CONFIRM_PROFILE: 'p4-backfill',
    MIGRATION_PRINCIPAL_CONFIRM_ACCOUNT: 'mickeyf_p4_backfill@%',
    MIGRATION_PRINCIPAL_CONFIRM_WATCHDOG_DEFINER: 'root@%',
    MIGRATION_PRINCIPAL_CONFIRM_EVENT: 'mickeyf_watchdog_p4_backfill',
    MIGRATION_PRINCIPAL_ALLOW_CREATE: '1',
    MIGRATION_PRINCIPAL_PASSWORD: ' temporary password whitespace is preserved ',
});

test('create config keeps bootstrap and temporary credentials isolated', () => {
    const config = loadMigrationPrincipalAdminConfig(
        'create',
        'p4-backfill',
        baseEnvironment
    );
    assert.deepEqual(config, {
        action: 'create',
        profileName: 'p4-backfill',
        host: '127.0.0.1',
        port: 3307,
        user: 'mickeyf_migration_bootstrap',
        password: 'admin-test-only',
        database: 'mickeyf_migration_test',
        principalPassword: ' temporary password whitespace is preserved ',
        watchdogDefiner: 'root@%',
        watchdogDelaySeconds: undefined,
    });
});

test('revoke config does not require or load the temporary password', () => {
    const environment = {
        ...baseEnvironment,
        MIGRATION_PRINCIPAL_CONFIRM_PROFILE: 'p4-reconcile',
        MIGRATION_PRINCIPAL_CONFIRM_ACCOUNT: 'mickeyf_p4_reconcile@%',
        MIGRATION_PRINCIPAL_ALLOW_CREATE: undefined,
        MIGRATION_PRINCIPAL_ALLOW_REVOKE: '1',
        MIGRATION_PRINCIPAL_PASSWORD: undefined,
    };
    const config = loadMigrationPrincipalAdminConfig(
        'revoke',
        'p4-reconcile',
        environment
    );
    assert.equal(config.principalPassword, undefined);
    assert.equal(config.watchdogDefiner, undefined);
});

test('watchdog arm loads an explicitly confirmed definer, event, and bounded delay', () => {
    const config = loadMigrationPrincipalAdminConfig(
        'watchdog-arm',
        'p4-backfill',
        {
            ...baseEnvironment,
            MIGRATION_PRINCIPAL_ADMIN_USER: 'cms_mickeyf',
            MIGRATION_PRINCIPAL_ALLOW_CREATE: undefined,
            MIGRATION_PRINCIPAL_ALLOW_WATCHDOG_ARM: '1',
            MIGRATION_PRINCIPAL_PASSWORD: undefined,
            MIGRATION_PRINCIPAL_WATCHDOG_DELAY_SECONDS: '600',
        }
    );
    assert.equal(config.watchdogDefiner, 'root@%');
    assert.equal(config.watchdogDelaySeconds, 600);
    assert.equal(config.principalPassword, undefined);
});

test('watchdog confirmations and delay fail before a socket can be opened', () => {
    const environment = {
        ...baseEnvironment,
        MIGRATION_PRINCIPAL_ADMIN_USER: 'cms_mickeyf',
        MIGRATION_PRINCIPAL_ALLOW_CREATE: undefined,
        MIGRATION_PRINCIPAL_ALLOW_WATCHDOG_ARM: '1',
        MIGRATION_PRINCIPAL_PASSWORD: undefined,
        MIGRATION_PRINCIPAL_WATCHDOG_DELAY_SECONDS: '600',
    };
    const cases: readonly [Record<string, string | undefined>, RegExp][] = [
        [
            { MIGRATION_PRINCIPAL_CONFIRM_EVENT: 'other' },
            /CONFIRM_EVENT/,
        ],
        [
            { MIGRATION_PRINCIPAL_CONFIRM_WATCHDOG_DEFINER: 'other@%' },
            /allowlist/,
        ],
        [
            { MIGRATION_PRINCIPAL_WATCHDOG_DELAY_SECONDS: '60' },
            /120 through 1800/,
        ],
        [
            { MIGRATION_PRINCIPAL_ALLOW_WATCHDOG_ARM: undefined },
            /ALLOW_WATCHDOG_ARM=1/,
        ],
    ];

    for (const [override, expected] of cases) {
        assert.throws(
            () => loadMigrationPrincipalAdminConfig(
                'watchdog-arm',
                'p4-backfill',
                { ...environment, ...override }
            ),
            expected
        );
    }
});

test('all confirmations and the action gate fail before a socket can be opened', () => {
    const cases: readonly [string, Record<string, string | undefined>, RegExp][] = [
        [
            'remote host',
            { MIGRATION_PRINCIPAL_ADMIN_HOST: '10.0.0.2' },
            /must be 127\.0\.0\.1/,
        ],
        [
            'target',
            { MIGRATION_PRINCIPAL_CONFIRM_TARGET: '127.0.0.1:3307/other' },
            /CONFIRM_TARGET/,
        ],
        [
            'database',
            { MIGRATION_PRINCIPAL_CONFIRM_DATABASE: 'other' },
            /CONFIRM_DATABASE/,
        ],
        [
            'profile',
            { MIGRATION_PRINCIPAL_CONFIRM_PROFILE: 'p4-reconcile' },
            /CONFIRM_PROFILE/,
        ],
        [
            'account',
            { MIGRATION_PRINCIPAL_CONFIRM_ACCOUNT: 'other@%' },
            /CONFIRM_ACCOUNT/,
        ],
        [
            'action gate',
            { MIGRATION_PRINCIPAL_ALLOW_CREATE: undefined },
            /ALLOW_CREATE=1/,
        ],
        [
            'watchdog event',
            { MIGRATION_PRINCIPAL_CONFIRM_EVENT: 'other' },
            /CONFIRM_EVENT/,
        ],
        [
            'watchdog definer',
            { MIGRATION_PRINCIPAL_CONFIRM_WATCHDOG_DEFINER: 'other@%' },
            /allowlist/,
        ],
    ];

    for (const [label, override, expected] of cases) {
        assert.throws(
            () => loadMigrationPrincipalAdminConfig(
                'create',
                'p4-backfill',
                { ...baseEnvironment, ...override }
            ),
            expected,
            label
        );
    }
});

test('bootstrap administrator cannot be the account it is provisioning', () => {
    assert.throws(
        () => loadMigrationPrincipalAdminConfig('create', 'p4-backfill', {
            ...baseEnvironment,
            MIGRATION_PRINCIPAL_ADMIN_USER: 'mickeyf_p4_backfill',
        }),
        /administrator must differ/
    );
});

test('each lifecycle action requires its fixed separated administrator', () => {
    assert.throws(
        () => loadMigrationPrincipalAdminConfig('watchdog-arm', 'p4-backfill', {
            ...baseEnvironment,
            MIGRATION_PRINCIPAL_ALLOW_CREATE: undefined,
            MIGRATION_PRINCIPAL_ALLOW_WATCHDOG_ARM: '1',
            MIGRATION_PRINCIPAL_PASSWORD: undefined,
            MIGRATION_PRINCIPAL_WATCHDOG_DELAY_SECONDS: '600',
        }),
        /watchdog-arm requires.*cms_mickeyf/
    );
    assert.throws(
        () => loadMigrationPrincipalAdminConfig('create', 'p4-backfill', {
            ...baseEnvironment,
            MIGRATION_PRINCIPAL_ADMIN_USER: 'cms_mickeyf',
        }),
        /create requires.*mickeyf_migration_bootstrap/
    );
});

test('lifecycle configuration uses the shared fixed administrator identities', () => {
    const createConfig = loadMigrationPrincipalAdminConfig(
        'create',
        'p4-backfill',
        baseEnvironment
    );
    const armConfig = loadMigrationPrincipalAdminConfig(
        'watchdog-arm',
        'p4-backfill',
        {
            ...baseEnvironment,
            MIGRATION_PRINCIPAL_ADMIN_USER: MIGRATION_PRINCIPAL_WATCHDOG_ARMER_ACCOUNT,
            MIGRATION_PRINCIPAL_ALLOW_CREATE: undefined,
            MIGRATION_PRINCIPAL_ALLOW_WATCHDOG_ARM: '1',
            MIGRATION_PRINCIPAL_PASSWORD: undefined,
            MIGRATION_PRINCIPAL_WATCHDOG_DELAY_SECONDS: '600',
        }
    );
    assert.equal(createConfig.user, MIGRATION_PRINCIPAL_BOOTSTRAP_ACCOUNT);
    assert.equal(armConfig.user, MIGRATION_PRINCIPAL_WATCHDOG_ARMER_ACCOUNT);
});
