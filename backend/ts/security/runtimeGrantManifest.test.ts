import assert from 'node:assert/strict';
import test from 'node:test';
import {
    PRODUCTION_RUNTIME_DATABASE_ACCOUNT,
    PRODUCTION_RUNTIME_DATABASE_ROLE,
    renderRuntimeGrantStatements,
    RUNTIME_GRANT_MANIFEST,
    runtimeColumnPrivilegeInventory,
    runtimeTablePrivilegeInventory,
} from './runtimeGrantManifest';

test('defines only runtime DML and read-only identity-epoch metadata', () => {
    assert.deepEqual(PRODUCTION_RUNTIME_DATABASE_ROLE, {
        user: 'cloudsqlsuperuser',
        host: '%',
    });
    assert.deepEqual(
        RUNTIME_GRANT_MANIFEST.map(({ table }) => table),
        ['account_sessions', 'schema_migrations', 'users', 'game_submission_receipts', 'game_personal_bests']
    );
    assert.deepEqual(runtimeColumnPrivilegeInventory().filter(({ tableName }) => tableName === 'schema_migrations'), [
        { tableName: 'schema_migrations', columnName: 'version', privilegeType: 'SELECT' },
        { tableName: 'schema_migrations', columnName: 'applied_at', privilegeType: 'SELECT' },
    ]);
    assert.deepEqual(
        [...new Set(runtimeColumnPrivilegeInventory().map(({ privilegeType }) =>
            privilegeType))].sort(),
        ['INSERT', 'SELECT', 'UPDATE']
    );
    assert.equal(
        runtimeColumnPrivilegeInventory().some(({ tableName, privilegeType }) =>
            tableName === 'game_submission_receipts' && privilegeType === 'UPDATE'),
        false
    );
    assert.deepEqual(runtimeTablePrivilegeInventory(), [
        { tableName: 'account_sessions', privilegeType: 'DELETE' },
        { tableName: 'users', privilegeType: 'DELETE' },
        { tableName: 'game_submission_receipts', privilegeType: 'DELETE' },
        { tableName: 'game_personal_bests', privilegeType: 'DELETE' },
    ]);
});

test('account identity is readable but cannot be inserted or rewritten by runtime', () => {
    assert.deepEqual(
        runtimeColumnPrivilegeInventory().filter(({ tableName, columnName }) => tableName === 'users' && columnName === 'account_uuid'),
        [{ tableName: 'users', columnName: 'account_uuid', privilegeType: 'SELECT' }]
    );
});

test('device sessions permit only scoped create/read/delete, never extending an existing expiry', () => {
    const privileges = runtimeColumnPrivilegeInventory().filter(({ tableName }) => tableName === 'account_sessions');
    assert.deepEqual([...new Set(privileges.map(({ privilegeType }) => privilegeType))], ['SELECT', 'INSERT']);
    assert.deepEqual(privileges.map(({ columnName }) => columnName), [
        'session_hash', 'account_uuid', 'created_at', 'expires_at',
        'session_hash', 'account_uuid', 'created_at', 'expires_at',
    ]);
});

test('renders the exact production grant statements without applying them', () => {
    assert.deepEqual(
        renderRuntimeGrantStatements(
            'cms',
            PRODUCTION_RUNTIME_DATABASE_ACCOUNT
        ),
        [
            "GRANT SELECT (`session_hash`, `account_uuid`, `created_at`, `expires_at`), INSERT (`session_hash`, `account_uuid`, `created_at`, `expires_at`), DELETE ON `cms`.`account_sessions` TO 'cms_mickeyf'@'%';",
            "GRANT SELECT (`version`, `applied_at`) ON `cms`.`schema_migrations` TO 'cms_mickeyf'@'%';",
            "GRANT SELECT (`user_id`, `account_uuid`, `user_name`, `email`, `user_password`), INSERT (`user_name`, `email`, `user_password`), DELETE ON `cms`.`users` TO 'cms_mickeyf'@'%';",
            "GRANT SELECT (`game_id`, `rules_version`, `user_id`, `run_id`, `score`, `completion_time_ms`, `payload_fingerprint`, `improved_personal_best`, `submitted_at`), INSERT (`game_id`, `rules_version`, `user_id`, `run_id`, `score`, `completion_time_ms`, `payload_fingerprint`, `improved_personal_best`, `submitted_at`), DELETE ON `cms`.`game_submission_receipts` TO 'cms_mickeyf'@'%';",
            "GRANT SELECT (`game_id`, `rules_version`, `user_id`, `score`, `completion_time_ms`, `recorded_at`), INSERT (`game_id`, `rules_version`, `user_id`, `score`, `completion_time_ms`, `recorded_at`), UPDATE (`score`, `completion_time_ms`, `recorded_at`), DELETE ON `cms`.`game_personal_bests` TO 'cms_mickeyf'@'%';",
        ]
    );
});

test('rejects unsafe database and account values before rendering SQL', () => {
    assert.throws(
        () => renderRuntimeGrantStatements(
            'cms`; DROP DATABASE cms; --',
            PRODUCTION_RUNTIME_DATABASE_ACCOUNT
        ),
        /simple MySQL identifier/
    );
    assert.throws(
        () => renderRuntimeGrantStatements('cms', {
            user: "runtime'@'%' IDENTIFIED BY 'bad",
            host: '%',
        }),
        /unsupported characters/
    );
});
