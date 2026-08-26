import assert from 'node:assert/strict';
import test from 'node:test';
import {
    PRODUCTION_RUNTIME_DATABASE_ACCOUNT,
    PRODUCTION_RUNTIME_DATABASE_ROLE,
    renderP4VegaGrantRetirementStatement,
    renderRuntimeGrantStatements,
    RUNTIME_GRANT_MANIFEST,
    runtimeColumnPrivilegeInventory,
} from './runtimeGrantManifest';

test('defines only the three runtime tables and required DML', () => {
    assert.deepEqual(PRODUCTION_RUNTIME_DATABASE_ROLE, {
        user: 'cloudsqlsuperuser',
        host: '%',
    });
    assert.deepEqual(
        RUNTIME_GRANT_MANIFEST.map(({ table }) => table),
        ['users', 'game_runs', 'game_personal_bests']
    );
    assert.equal(
        RUNTIME_GRANT_MANIFEST.some(({ table }) =>
            (table as string) === 'schema_migrations'),
        false
    );
    assert.deepEqual(
        [...new Set(runtimeColumnPrivilegeInventory().map(({ privilegeType }) =>
            privilegeType))].sort(),
        ['INSERT', 'SELECT', 'UPDATE']
    );
    assert.equal(
        runtimeColumnPrivilegeInventory().some(({ tableName, privilegeType }) =>
            tableName === 'game_runs' && privilegeType === 'UPDATE'),
        false
    );
});

test('renders the exact production grant statements without applying them', () => {
    assert.deepEqual(
        renderRuntimeGrantStatements(
            'cms',
            PRODUCTION_RUNTIME_DATABASE_ACCOUNT
        ),
        [
            "GRANT SELECT (`user_id`, `user_name`, `email`, `user_password`), INSERT (`user_name`, `email`, `user_password`) ON `cms`.`users` TO 'cms_mickeyf'@'%';",
            "GRANT SELECT (`game_id`, `rules_version`, `user_id`, `run_id`, `score`, `completion_time_ms`, `payload_fingerprint`, `personal_best`, `submitted_at`), INSERT (`game_id`, `rules_version`, `user_id`, `run_id`, `score`, `completion_time_ms`, `payload_fingerprint`, `personal_best`, `submitted_at`) ON `cms`.`game_runs` TO 'cms_mickeyf'@'%';",
            "GRANT SELECT (`game_id`, `rules_version`, `user_id`, `score`, `completion_time_ms`, `recorded_at`), INSERT (`game_id`, `rules_version`, `user_id`, `score`, `completion_time_ms`, `recorded_at`, `source_game_run_id`), UPDATE (`score`, `completion_time_ms`, `recorded_at`, `source_game_run_id`) ON `cms`.`game_personal_bests` TO 'cms_mickeyf'@'%';",
        ]
    );
});

test('renders only the two legacy p4-Vega column-grant revocations', () => {
    assert.equal(
        renderP4VegaGrantRetirementStatement(
            'cms',
            PRODUCTION_RUNTIME_DATABASE_ACCOUNT
        ),
        "REVOKE SELECT (`p4_score`), UPDATE (`p4_score`) ON `cms`.`users` FROM 'cms_mickeyf'@'%';"
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
    assert.throws(
        () => renderP4VegaGrantRetirementStatement(
            'cms`; DROP DATABASE cms; --',
            PRODUCTION_RUNTIME_DATABASE_ACCOUNT
        ),
        /simple MySQL identifier/
    );
    assert.throws(
        () => renderP4VegaGrantRetirementStatement('cms', {
            user: "runtime'@'%' IDENTIFIED BY 'bad",
            host: '%',
        }),
        /unsupported characters/
    );
});
