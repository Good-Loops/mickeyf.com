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

test('device sessions permit renewal without rewriting their account, creation time or remembered choice', () => {
    const privileges = runtimeColumnPrivilegeInventory().filter(({ tableName }) => tableName === 'account_sessions');
    const columns = (privilege: string) => privileges.filter(({ privilegeType }) => privilegeType === privilege)
        .map(({ columnName }) => columnName);
    assert.deepEqual(columns('SELECT'), ['session_hash', 'account_uuid', 'created_at', 'expires_at',
        'remembered', 'renewed_at', 'previous_session_hash', 'previous_valid_until']);
    assert.deepEqual(columns('INSERT'), ['session_hash', 'account_uuid', 'created_at', 'expires_at', 'remembered', 'renewed_at']);
    assert.deepEqual(columns('UPDATE'), ['session_hash', 'expires_at', 'renewed_at', 'previous_session_hash', 'previous_valid_until']);
    assert.ok(['account_uuid', 'created_at', 'remembered'].every(column => !columns('UPDATE').includes(column)));
});

test('renders the exact production grant statements without applying them', () => {
    assert.deepEqual(
        renderRuntimeGrantStatements(
            'cms',
            PRODUCTION_RUNTIME_DATABASE_ACCOUNT
        ),
        [
            "GRANT SELECT (`session_hash`, `account_uuid`, `created_at`, `expires_at`, `remembered`, `renewed_at`, `previous_session_hash`, `previous_valid_until`), INSERT (`session_hash`, `account_uuid`, `created_at`, `expires_at`, `remembered`, `renewed_at`), UPDATE (`session_hash`, `expires_at`, `renewed_at`, `previous_session_hash`, `previous_valid_until`), DELETE ON `cms`.`account_sessions` TO 'cms_mickeyf'@'%';",
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
