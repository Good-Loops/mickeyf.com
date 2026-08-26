import assert from 'node:assert/strict';
import test from 'node:test';
import {
    assertDatabaseConfirmation,
    assertMutationAuthorized,
    assertP4GrantRetirementCommandConfirmed,
    assertP4ScoreDropCommandConfirmed,
    assertP4VegaDataOperationAuthorized,
    assertRuntimeGrantCommandConfirmed,
    loadMigrationConfig,
    loadMigrationAccountConfirmation,
} from './migrationConfig';

const migrationEnvironment = {
    MIGRATION_DB_HOST: '127.0.0.1',
    MIGRATION_DB_PORT: '3306',
    MIGRATION_DB_USER: 'migration-user',
    MIGRATION_DB_PASS: ' migration password ',
    MIGRATION_DB_NAME: 'migration_test',
};

const runtimeGrantCloudSqlTarget = Object.freeze({
    project: 'noted-reef-387021',
    instance: 'cms-mickeyf',
    connectionName: 'noted-reef-387021:us-central1:cms-mickeyf',
    serverUuid: 'd1e6865c-ecad-11ee-a6b0-42010a400002',
});

function confirmRuntimeGrant(
    command: 'plan' | 'verify' | 'apply',
    config: ReturnType<typeof loadMigrationConfig>,
    environment: Readonly<Record<string, string | undefined>>
) {
    return assertRuntimeGrantCommandConfirmed(
        command,
        config,
        'cms_mickeyf@%',
        'cloudsqlsuperuser@%',
        runtimeGrantCloudSqlTarget,
        environment
    );
}

function confirmP4GrantRetirement(
    command: 'plan' | 'verify' | 'apply',
    config: ReturnType<typeof loadMigrationConfig>,
    environment: Readonly<Record<string, string | undefined>>
) {
    return assertP4GrantRetirementCommandConfirmed(
        command,
        config,
        'cms_mickeyf@%',
        runtimeGrantCloudSqlTarget,
        environment
    );
}

function confirmP4ScoreDrop(
    command: 'plan' | 'verify' | 'apply',
    config: ReturnType<typeof loadMigrationConfig>,
    environment: Readonly<Record<string, string | undefined>>
) {
    return assertP4ScoreDropCommandConfirmed(
        command,
        config,
        runtimeGrantCloudSqlTarget,
        environment
    );
}

test('migration configuration uses dedicated credentials and safe timeout defaults', () => {
    const config = loadMigrationConfig(migrationEnvironment);

    assert.deepEqual(config, {
        host: '127.0.0.1',
        port: 3306,
        user: 'migration-user',
        password: ' migration password ',
        database: 'migration_test',
        advisoryLockTimeoutSeconds: 5,
        lockWaitTimeoutSeconds: 10,
        operationTimeoutMs: 30_000,
        p4VegaBackfillChunkSize: 500,
        p4VegaOperationTimeoutMs: 900_000,
    });
    assert.equal(Object.isFrozen(config), true);
});

test('migration configuration never falls back to runtime database credentials', () => {
    assert.throws(
        () => loadMigrationConfig({
            DB_HOST: 'runtime-host',
            DB_PORT: '3306',
            DB_USER: 'runtime-user',
            DB_PASS: 'runtime-password',
            DB_NAME: 'runtime-database',
        }),
        /MIGRATION_DB_HOST/
    );
});

test('migration account confirmation requires the exact resolved MySQL account', () => {
    assert.equal(
        loadMigrationAccountConfirmation({ MIGRATION_CONFIRM_ACCOUNT: 'migration-user@%' }),
        'migration-user@%'
    );

    for (const value of [
        undefined,
        '',
        ' migration-user@%',
        'migration-user@% ',
        'migration-user',
        '@%',
        'migration-user@',
        'migration-user@%\n',
        `${'u'.repeat(33)}@${'h'.repeat(255)}`,
    ]) {
        assert.throws(
            () => loadMigrationAccountConfirmation({ MIGRATION_CONFIRM_ACCOUNT: value }),
            /MIGRATION_CONFIRM_ACCOUNT/
        );
    }
});

test('migration configuration permits only the loopback Cloud SQL proxy target', () => {
    assert.throws(
        () => loadMigrationConfig({
            ...migrationEnvironment,
            MIGRATION_DB_HOST: 'database.example.test',
        }),
        /must be 127\.0\.0\.1/
    );
});

test('migration configuration requires every connection input', () => {
    const requiredNames = [
        'MIGRATION_DB_HOST',
        'MIGRATION_DB_PORT',
        'MIGRATION_DB_USER',
        'MIGRATION_DB_PASS',
        'MIGRATION_DB_NAME',
    ] as const;

    for (const name of requiredNames) {
        assert.throws(
            () => loadMigrationConfig({ ...migrationEnvironment, [name]: '  ' }),
            new RegExp(name)
        );
    }
});

test('migration configuration rejects malformed ports without exposing credentials', () => {
    for (const port of ['0', '65536', '3306.5', 'not-a-number']) {
        assert.throws(
            () => loadMigrationConfig({
                ...migrationEnvironment,
                MIGRATION_DB_PORT: port,
                MIGRATION_DB_PASS: 'do-not-print-this-password',
            }),
            (error: unknown) => {
                assert.ok(error instanceof Error);
                assert.match(error.message, /MIGRATION_DB_PORT/);
                assert.doesNotMatch(error.message, /do-not-print-this-password/);
                return true;
            }
        );
    }
});

test('migration configuration accepts bounded timeout overrides', () => {
    const config = loadMigrationConfig({
        ...migrationEnvironment,
        MIGRATION_ADVISORY_LOCK_TIMEOUT_SECONDS: '0',
        MIGRATION_LOCK_WAIT_TIMEOUT_SECONDS: '60',
        MIGRATION_OPERATION_TIMEOUT_MS: '120000',
        MIGRATION_P4_VEGA_BACKFILL_CHUNK_SIZE: '5000',
        MIGRATION_P4_VEGA_OPERATION_TIMEOUT_MS: '21600000',
    });

    assert.equal(config.advisoryLockTimeoutSeconds, 0);
    assert.equal(config.lockWaitTimeoutSeconds, 60);
    assert.equal(config.operationTimeoutMs, 120_000);
    assert.equal(config.p4VegaBackfillChunkSize, 5_000);
    assert.equal(config.p4VegaOperationTimeoutMs, 21_600_000);
});

test('migration configuration rejects timeout overrides outside safe bounds', () => {
    const invalidOverrides = [
        ['MIGRATION_ADVISORY_LOCK_TIMEOUT_SECONDS', '-1'],
        ['MIGRATION_ADVISORY_LOCK_TIMEOUT_SECONDS', '31'],
        ['MIGRATION_LOCK_WAIT_TIMEOUT_SECONDS', '0'],
        ['MIGRATION_LOCK_WAIT_TIMEOUT_SECONDS', '61'],
        ['MIGRATION_OPERATION_TIMEOUT_MS', '999'],
        ['MIGRATION_OPERATION_TIMEOUT_MS', '120001'],
        ['MIGRATION_OPERATION_TIMEOUT_MS', '30000.5'],
        ['MIGRATION_P4_VEGA_BACKFILL_CHUNK_SIZE', '0'],
        ['MIGRATION_P4_VEGA_BACKFILL_CHUNK_SIZE', '5001'],
        ['MIGRATION_P4_VEGA_OPERATION_TIMEOUT_MS', '29999'],
        ['MIGRATION_P4_VEGA_OPERATION_TIMEOUT_MS', '21600001'],
    ] as const;

    for (const [name, value] of invalidOverrides) {
        assert.throws(
            () => loadMigrationConfig({ ...migrationEnvironment, [name]: value }),
            new RegExp(name)
        );
    }
});

test('p4-Vega data operations require separate explicit authorizations', () => {
    const config = loadMigrationConfig(migrationEnvironment);
    const confirmedEnvironment = {
        MIGRATION_CONFIRM_DATABASE: migrationEnvironment.MIGRATION_DB_NAME,
        MIGRATION_CONFIRM_TARGET: '127.0.0.1:3306/migration_test',
    };

    assert.doesNotThrow(() => assertP4VegaDataOperationAuthorized(
        'backfill-p4-vega',
        config,
        { ...confirmedEnvironment, MIGRATION_ALLOW_P4_VEGA_BACKFILL: '1' }
    ));
    assert.throws(
        () => assertP4VegaDataOperationAuthorized('backfill-p4-vega', config, {
            ...confirmedEnvironment,
            MIGRATION_ALLOW_APPLY: '1',
            MIGRATION_ALLOW_P4_VEGA_RECONCILE: '1',
        }),
        /MIGRATION_ALLOW_P4_VEGA_BACKFILL=1/
    );

    assert.doesNotThrow(() => assertP4VegaDataOperationAuthorized(
        'reconcile-p4-vega',
        config,
        { ...confirmedEnvironment, MIGRATION_ALLOW_P4_VEGA_RECONCILE: '1' }
    ));
    assert.throws(
        () => assertP4VegaDataOperationAuthorized('reconcile-p4-vega', config, {
            ...confirmedEnvironment,
            MIGRATION_ALLOW_P4_VEGA_BACKFILL: '1',
        }),
        /MIGRATION_ALLOW_P4_VEGA_RECONCILE=1/
    );
    assert.throws(
        () => assertP4VegaDataOperationAuthorized('reconcile-p4-vega', config, {
            MIGRATION_ALLOW_P4_VEGA_RECONCILE: '1',
        }),
        /MIGRATION_CONFIRM_DATABASE/
    );
});

test('database confirmation must exactly match the configured migration database', () => {
    const config = loadMigrationConfig(migrationEnvironment);

    assert.doesNotThrow(() => assertDatabaseConfirmation(config, 'migration_test'));
    assert.throws(
        () => assertDatabaseConfirmation(config, undefined),
        /MIGRATION_CONFIRM_DATABASE/
    );
    assert.throws(
        () => assertDatabaseConfirmation(config, '  '),
        /MIGRATION_CONFIRM_DATABASE/
    );
    assert.throws(
        () => assertDatabaseConfirmation(config, 'migration_test '),
        /exactly match MIGRATION_DB_NAME/
    );
    assert.throws(
        () => assertDatabaseConfirmation(config, 'a-secret-wrong-value'),
        (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.doesNotMatch(error.message, /a-secret-wrong-value/);
            return true;
        }
    );
});

test('each mutating action requires its own explicit authorization', () => {
    const config = loadMigrationConfig(migrationEnvironment);
    const confirmedEnvironment = {
        MIGRATION_CONFIRM_DATABASE: migrationEnvironment.MIGRATION_DB_NAME,
        MIGRATION_CONFIRM_TARGET: '127.0.0.1:3306/migration_test',
    };

    assert.doesNotThrow(() => assertMutationAuthorized('apply', config, {
        ...confirmedEnvironment,
        MIGRATION_ALLOW_APPLY: '1',
    }));
    assert.throws(
        () => assertMutationAuthorized('apply', config, {
            ...confirmedEnvironment,
            MIGRATION_ALLOW_ROLLBACK_EMPTY: '1',
        }),
        /MIGRATION_ALLOW_APPLY=1/
    );

    assert.doesNotThrow(() => assertMutationAuthorized('rollback-empty', config, {
        ...confirmedEnvironment,
        MIGRATION_ALLOW_ROLLBACK_EMPTY: '1',
    }));
    assert.throws(
        () => assertMutationAuthorized('rollback-empty', config, {
            ...confirmedEnvironment,
            MIGRATION_ALLOW_APPLY: '1',
        }),
        /MIGRATION_ALLOW_ROLLBACK_EMPTY=1/
    );
    assert.throws(
        () => assertMutationAuthorized('apply', config, {
            MIGRATION_ALLOW_APPLY: '1',
        }),
        /MIGRATION_CONFIRM_DATABASE/
    );
    assert.throws(
        () => assertMutationAuthorized('apply', config, {
            MIGRATION_CONFIRM_DATABASE: migrationEnvironment.MIGRATION_DB_NAME,
            MIGRATION_CONFIRM_TARGET: '127.0.0.1:3307/migration_test',
            MIGRATION_ALLOW_APPLY: '1',
        }),
        /MIGRATION_CONFIRM_TARGET/
    );
});

test('runtime grant commands require exact target and account confirmations', () => {
    const config = loadMigrationConfig(migrationEnvironment);
    const confirmedEnvironment = {
        MIGRATION_CONFIRM_DATABASE: migrationEnvironment.MIGRATION_DB_NAME,
        MIGRATION_CONFIRM_TARGET: '127.0.0.1:3306/migration_test',
        MIGRATION_CONFIRM_RUNTIME_ACCOUNT: 'cms_mickeyf@%',
    };

    assert.deepEqual(confirmRuntimeGrant('plan', config, confirmedEnvironment), {});
    assert.deepEqual(confirmRuntimeGrant('verify', config, confirmedEnvironment), {});
    assert.throws(
        () => confirmRuntimeGrant('plan', config, {
            ...confirmedEnvironment,
            MIGRATION_CONFIRM_RUNTIME_ACCOUNT: 'other@%',
        }),
        /MIGRATION_CONFIRM_RUNTIME_ACCOUNT/
    );
    assert.throws(
        () => confirmRuntimeGrant('verify', config, {
            ...confirmedEnvironment,
            MIGRATION_CONFIRM_TARGET: '127.0.0.1:3307/migration_test',
        }),
        /MIGRATION_CONFIRM_TARGET/
    );
});

test('runtime grant apply has a separate gate, plan digest, and server UUID', () => {
    const config = loadMigrationConfig(migrationEnvironment);
    const confirmedEnvironment = {
        MIGRATION_CONFIRM_DATABASE: migrationEnvironment.MIGRATION_DB_NAME,
        MIGRATION_CONFIRM_TARGET: '127.0.0.1:3306/migration_test',
        MIGRATION_CONFIRM_RUNTIME_ACCOUNT: 'cms_mickeyf@%',
        MIGRATION_CONFIRM_RUNTIME_ROLE: 'cloudsqlsuperuser@%',
        MIGRATION_CONFIRM_CLOUD_SQL_PROJECT: runtimeGrantCloudSqlTarget.project,
        MIGRATION_CONFIRM_CLOUD_SQL_INSTANCE: runtimeGrantCloudSqlTarget.instance,
        MIGRATION_CONFIRM_CLOUD_SQL_CONNECTION_NAME:
            runtimeGrantCloudSqlTarget.connectionName,
        MIGRATION_CONFIRM_RUNTIME_ROLE_REPLACEMENT:
            'cloudsqlsuperuser@% -> no database roles',
        MIGRATION_CONFIRM_RUNTIME_TRAFFIC_DRAINED: '1',
        MIGRATION_ALLOW_RUNTIME_GRANTS: '1',
        MIGRATION_CONFIRM_RUNTIME_GRANT_PLAN_SHA256: 'a'.repeat(64),
        MIGRATION_CONFIRM_SERVER_UUID: runtimeGrantCloudSqlTarget.serverUuid,
    };

    assert.deepEqual(confirmRuntimeGrant('apply', config, confirmedEnvironment), {
        approvedPlanSha256: 'a'.repeat(64),
        confirmedServerUuid: runtimeGrantCloudSqlTarget.serverUuid,
    });

    for (const [name, value] of [
        ['MIGRATION_ALLOW_RUNTIME_GRANTS', undefined],
        ['MIGRATION_CONFIRM_RUNTIME_ROLE', 'unexpected@%'],
        ['MIGRATION_CONFIRM_CLOUD_SQL_PROJECT', 'another-project'],
        ['MIGRATION_CONFIRM_CLOUD_SQL_INSTANCE', 'another-instance'],
        ['MIGRATION_CONFIRM_CLOUD_SQL_CONNECTION_NAME', 'another:region:instance'],
        ['MIGRATION_CONFIRM_RUNTIME_ROLE_REPLACEMENT', 'remove something'],
        ['MIGRATION_CONFIRM_RUNTIME_TRAFFIC_DRAINED', undefined],
        ['MIGRATION_CONFIRM_RUNTIME_GRANT_PLAN_SHA256', 'A'.repeat(64)],
        ['MIGRATION_CONFIRM_RUNTIME_GRANT_PLAN_SHA256', 'short'],
        ['MIGRATION_CONFIRM_SERVER_UUID', 'not-a-uuid'],
        ['MIGRATION_CONFIRM_SERVER_UUID', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'],
    ] as const) {
        assert.throws(
            () => confirmRuntimeGrant('apply', config, {
                ...confirmedEnvironment,
                [name]: value,
            }),
            new RegExp(name)
        );
    }

    assert.throws(
        () => confirmRuntimeGrant('apply', config, {
            ...confirmedEnvironment,
            MIGRATION_ALLOW_APPLY: '1',
            MIGRATION_ALLOW_RUNTIME_GRANTS: undefined,
        }),
        /MIGRATION_ALLOW_RUNTIME_GRANTS=1/
    );
});

test('p4 grant-retirement plan and verify require only the exact target and account', () => {
    const config = loadMigrationConfig(migrationEnvironment);
    const confirmedEnvironment = {
        MIGRATION_CONFIRM_DATABASE: migrationEnvironment.MIGRATION_DB_NAME,
        MIGRATION_CONFIRM_TARGET: '127.0.0.1:3306/migration_test',
        MIGRATION_CONFIRM_RUNTIME_ACCOUNT: 'cms_mickeyf@%',
    };

    assert.deepEqual(
        confirmP4GrantRetirement('plan', config, confirmedEnvironment),
        {}
    );
    assert.deepEqual(
        confirmP4GrantRetirement('verify', config, confirmedEnvironment),
        {}
    );
    assert.throws(
        () => confirmP4GrantRetirement('plan', config, {
            ...confirmedEnvironment,
            MIGRATION_CONFIRM_RUNTIME_ACCOUNT: 'other@%',
        }),
        /MIGRATION_CONFIRM_RUNTIME_ACCOUNT/
    );
});

test('p4 grant-retirement apply has isolated fail-closed confirmations', () => {
    const config = loadMigrationConfig(migrationEnvironment);
    const confirmedEnvironment = {
        MIGRATION_CONFIRM_DATABASE: migrationEnvironment.MIGRATION_DB_NAME,
        MIGRATION_CONFIRM_TARGET: '127.0.0.1:3306/migration_test',
        MIGRATION_CONFIRM_RUNTIME_ACCOUNT: 'cms_mickeyf@%',
        MIGRATION_CONFIRM_CLOUD_SQL_PROJECT: runtimeGrantCloudSqlTarget.project,
        MIGRATION_CONFIRM_CLOUD_SQL_INSTANCE: runtimeGrantCloudSqlTarget.instance,
        MIGRATION_CONFIRM_CLOUD_SQL_CONNECTION_NAME:
            runtimeGrantCloudSqlTarget.connectionName,
        MIGRATION_CONFIRM_GENERIC_ONLY_FROZEN: '1',
        MIGRATION_CONFIRM_P4_GRANT_RETIREMENT:
            'users.p4_score SELECT,UPDATE -> no runtime access',
        MIGRATION_ALLOW_P4_GRANT_RETIREMENT: '1',
        MIGRATION_CONFIRM_P4_GRANT_RETIREMENT_PLAN_SHA256: 'b'.repeat(64),
        MIGRATION_CONFIRM_SERVER_UUID: runtimeGrantCloudSqlTarget.serverUuid,
    };

    assert.deepEqual(
        confirmP4GrantRetirement('apply', config, confirmedEnvironment),
        {
            approvedPlanSha256: 'b'.repeat(64),
            confirmedServerUuid: runtimeGrantCloudSqlTarget.serverUuid,
        }
    );

    for (const [name, value] of [
        ['MIGRATION_CONFIRM_CLOUD_SQL_PROJECT', 'another-project'],
        ['MIGRATION_CONFIRM_CLOUD_SQL_INSTANCE', 'another-instance'],
        ['MIGRATION_CONFIRM_CLOUD_SQL_CONNECTION_NAME', 'another:region:instance'],
        ['MIGRATION_CONFIRM_GENERIC_ONLY_FROZEN', undefined],
        ['MIGRATION_CONFIRM_P4_GRANT_RETIREMENT', 'remove p4_score'],
        ['MIGRATION_ALLOW_P4_GRANT_RETIREMENT', undefined],
        ['MIGRATION_CONFIRM_P4_GRANT_RETIREMENT_PLAN_SHA256', 'B'.repeat(64)],
        ['MIGRATION_CONFIRM_P4_GRANT_RETIREMENT_PLAN_SHA256', 'short'],
        ['MIGRATION_CONFIRM_SERVER_UUID', 'not-a-uuid'],
        ['MIGRATION_CONFIRM_SERVER_UUID', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'],
    ] as const) {
        assert.throws(
            () => confirmP4GrantRetirement('apply', config, {
                ...confirmedEnvironment,
                [name]: value,
            }),
            new RegExp(name)
        );
    }

    assert.throws(
        () => confirmP4GrantRetirement('apply', config, {
            ...confirmedEnvironment,
            MIGRATION_ALLOW_RUNTIME_GRANTS: '1',
            MIGRATION_ALLOW_P4_GRANT_RETIREMENT: undefined,
        }),
        /MIGRATION_ALLOW_P4_GRANT_RETIREMENT=1/
    );
    assert.throws(
        () => confirmRuntimeGrant('apply', config, {
            ...confirmedEnvironment,
            MIGRATION_CONFIRM_RUNTIME_ROLE: 'cloudsqlsuperuser@%',
            MIGRATION_CONFIRM_RUNTIME_ROLE_REPLACEMENT:
                'cloudsqlsuperuser@% -> no database roles',
            MIGRATION_CONFIRM_RUNTIME_TRAFFIC_DRAINED: '1',
            MIGRATION_ALLOW_RUNTIME_GRANTS: undefined,
            MIGRATION_CONFIRM_RUNTIME_GRANT_PLAN_SHA256: 'a'.repeat(64),
        }),
        /MIGRATION_ALLOW_RUNTIME_GRANTS=1/
    );
});

test('p4_score drop apply requires its exact destructive confirmations', () => {
    const config = loadMigrationConfig(migrationEnvironment);
    const baseEnvironment = {
        MIGRATION_CONFIRM_DATABASE: migrationEnvironment.MIGRATION_DB_NAME,
        MIGRATION_CONFIRM_TARGET: '127.0.0.1:3306/migration_test',
    };
    const confirmedEnvironment = {
        ...baseEnvironment,
        MIGRATION_CONFIRM_CLOUD_SQL_PROJECT: runtimeGrantCloudSqlTarget.project,
        MIGRATION_CONFIRM_CLOUD_SQL_INSTANCE: runtimeGrantCloudSqlTarget.instance,
        MIGRATION_CONFIRM_CLOUD_SQL_CONNECTION_NAME:
            runtimeGrantCloudSqlTarget.connectionName,
        MIGRATION_CONFIRM_GENERIC_ONLY_FROZEN: '1',
        MIGRATION_CONFIRM_MAIN_TRIGGER_DISABLED: 'main-push-mickeyf-com -> disabled',
        MIGRATION_CONFIRM_P4_SCORE_DROP: 'users.p4_score -> dropped',
        MIGRATION_ALLOW_P4_SCORE_DROP: '1',
        MIGRATION_CONFIRM_P4_SCORE_DROP_PLAN_SHA256: 'c'.repeat(64),
        MIGRATION_CONFIRM_SERVER_UUID: runtimeGrantCloudSqlTarget.serverUuid,
    };

    assert.deepEqual(confirmP4ScoreDrop('plan', config, baseEnvironment), {});
    assert.deepEqual(confirmP4ScoreDrop('verify', config, baseEnvironment), {});
    assert.deepEqual(confirmP4ScoreDrop('apply', config, confirmedEnvironment), {
        approvedPlanSha256: 'c'.repeat(64),
        confirmedServerUuid: runtimeGrantCloudSqlTarget.serverUuid,
    });

    for (const [name, value] of [
        ['MIGRATION_CONFIRM_CLOUD_SQL_PROJECT', 'another-project'],
        ['MIGRATION_CONFIRM_CLOUD_SQL_INSTANCE', 'another-instance'],
        ['MIGRATION_CONFIRM_CLOUD_SQL_CONNECTION_NAME', 'another:region:instance'],
        ['MIGRATION_CONFIRM_GENERIC_ONLY_FROZEN', undefined],
        ['MIGRATION_CONFIRM_MAIN_TRIGGER_DISABLED', 'still enabled'],
        ['MIGRATION_CONFIRM_P4_SCORE_DROP', 'drop something'],
        ['MIGRATION_ALLOW_P4_SCORE_DROP', undefined],
        ['MIGRATION_CONFIRM_P4_SCORE_DROP_PLAN_SHA256', 'C'.repeat(64)],
        ['MIGRATION_CONFIRM_SERVER_UUID', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'],
    ] as const) {
        assert.throws(
            () => confirmP4ScoreDrop('apply', config, {
                ...confirmedEnvironment,
                [name]: value,
            }),
            new RegExp(name)
        );
    }
});
