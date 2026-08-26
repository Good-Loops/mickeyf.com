import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadMigrationPrincipalAdminConfig } from './migrationPrincipalConfig';

const baseEnvironment = Object.freeze({
    MIGRATION_PRINCIPAL_ADMIN_HOST: '127.0.0.1',
    MIGRATION_PRINCIPAL_ADMIN_PORT: '3307',
    MIGRATION_PRINCIPAL_ADMIN_USER: 'migration_principal_admin',
    MIGRATION_PRINCIPAL_ADMIN_PASS: 'admin-test-only',
    MIGRATION_PRINCIPAL_ADMIN_DATABASE: 'mickeyf_migration_test',
    MIGRATION_PRINCIPAL_CONFIRM_TARGET:
        '127.0.0.1:3307/mickeyf_migration_test',
    MIGRATION_PRINCIPAL_CONFIRM_DATABASE: 'mickeyf_migration_test',
    MIGRATION_PRINCIPAL_CONFIRM_PROFILE: 'p4-backfill',
    MIGRATION_PRINCIPAL_CONFIRM_ACCOUNT: 'mickeyf_p4_backfill@%',
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
        user: 'migration_principal_admin',
        password: 'admin-test-only',
        database: 'mickeyf_migration_test',
        principalPassword: ' temporary password whitespace is preserved ',
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
