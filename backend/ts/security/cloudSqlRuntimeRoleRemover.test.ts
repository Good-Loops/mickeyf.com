import assert from 'node:assert/strict';
import test from 'node:test';
import {
    buildCloudSqlDescribeArgs,
    buildCloudSqlOperationsListArgs,
    buildCloudSqlRoleRemovalArgs,
    buildGcloudCommand,
    CLOUD_SQL_ROLE_REMOVAL_PROVIDER,
    CloudSqlRoleRemovalIndeterminateError,
    createProductionCloudSqlRoleRemover,
    PRODUCTION_CLOUD_SQL_TARGET,
    verifyProductionCloudSqlTarget,
    verifyNoCloudSqlOperationsInFlight,
    type ExternalCommand,
    type ExternalCommandRunner,
} from './cloudSqlRuntimeRoleRemover';
import type { RuntimeDatabaseAccount } from './runtimeGrantManifest';

const RUNTIME_ACCOUNT: RuntimeDatabaseAccount = Object.freeze({
    user: 'cms_mickeyf',
    host: '%',
});
const APPROVED_ROLE: RuntimeDatabaseAccount = Object.freeze({
    user: 'cloudsqlsuperuser',
    host: '%',
});

function logicalGcloudArgs(command: ExternalCommand): readonly string[] {
    return process.platform === 'win32' ? command.args.slice(5) : command.args;
}

test('Cloud SQL role removal has an exact shell-free synchronous command', () => {
    const args = buildCloudSqlRoleRemovalArgs(RUNTIME_ACCOUNT);
    const command = buildGcloudCommand(args);

    assert.equal(command.shell, false);
    assert.equal(command.windowsHide, true);
    assert.deepEqual(logicalGcloudArgs(command), [
        'sql',
        'users',
        'assign-roles',
        'cms_mickeyf',
        '--project=noted-reef-387021',
        '--instance=cms-mickeyf',
        '--type=BUILT_IN',
        '--host=%',
        '--database-roles=',
        '--revoke-existing-roles',
        '--quiet',
    ]);
    assert.equal(args.includes('--async'), false);
});

test('Cloud SQL target verification requires all exact instance identifiers', async () => {
    const calls: ExternalCommand[] = [];
    const runner: ExternalCommandRunner = async (command, options) => {
        calls.push(command);
        assert.equal(options.timeoutMs, 1_000);
        return JSON.stringify({
            connectionName: PRODUCTION_CLOUD_SQL_TARGET.connectionName,
            region: PRODUCTION_CLOUD_SQL_TARGET.region,
            name: PRODUCTION_CLOUD_SQL_TARGET.instance,
            project: PRODUCTION_CLOUD_SQL_TARGET.project,
        });
    };

    await verifyProductionCloudSqlTarget(1_000, undefined, runner);
    assert.deepEqual(logicalGcloudArgs(calls[0]), buildCloudSqlDescribeArgs());

    await assert.rejects(
        () => verifyProductionCloudSqlTarget(
            1_000,
            undefined,
            async () => JSON.stringify({
                connectionName: 'another-project:us-central1:cms-mickeyf',
                region: PRODUCTION_CLOUD_SQL_TARGET.region,
                name: PRODUCTION_CLOUD_SQL_TARGET.instance,
                project: 'another-project',
            })
        ),
        /different Cloud SQL instance/
    );
});

test('Cloud SQL apply preflight blocks unfinished operations', async () => {
    const calls: ExternalCommand[] = [];
    await verifyNoCloudSqlOperationsInFlight(
        1_000,
        undefined,
        async (command) => {
            calls.push(command);
            return '[]';
        }
    );
    assert.deepEqual(
        logicalGcloudArgs(calls[0]),
        buildCloudSqlOperationsListArgs()
    );
    assert.ok(buildCloudSqlOperationsListArgs().includes('--filter=status!=DONE'));

    await assert.rejects(
        () => verifyNoCloudSqlOperationsInFlight(
            1_000,
            undefined,
            async () => JSON.stringify([{ status: 'RUNNING' }])
        ),
        /unfinished operation/
    );
    await assert.rejects(
        () => verifyNoCloudSqlOperationsInFlight(
            1_000,
            undefined,
            async () => '{}'
        ),
        /unsupported Cloud SQL operation metadata/
    );
});

test('role remover validates the hashed context before invoking gcloud', async () => {
    const calls: ExternalCommand[] = [];
    const runner: ExternalCommandRunner = async (command, options) => {
        calls.push(command);
        assert.equal(options.timeoutMs, 2_000);
        return logicalGcloudArgs(command)[1] === 'operations' ? '[]' : '';
    };
    const remover = createProductionCloudSqlRoleRemover(
        RUNTIME_ACCOUNT,
        APPROVED_ROLE,
        2_000,
        undefined,
        runner
    );

    await remover({
        provider: CLOUD_SQL_ROLE_REMOVAL_PROVIDER,
        target: PRODUCTION_CLOUD_SQL_TARGET.connectionName,
        runtimeAccount: RUNTIME_ACCOUNT,
        approvedRole: APPROVED_ROLE,
    });
    assert.equal(calls.length, 2);
    assert.deepEqual(
        logicalGcloudArgs(calls[0]),
        buildCloudSqlOperationsListArgs()
    );
    assert.deepEqual(
        logicalGcloudArgs(calls[1]),
        buildCloudSqlRoleRemovalArgs(RUNTIME_ACCOUNT)
    );

    await assert.rejects(
        () => remover({
            provider: CLOUD_SQL_ROLE_REMOVAL_PROVIDER,
            target: 'wrong-project:us-central1:cms-mickeyf',
            runtimeAccount: RUNTIME_ACCOUNT,
            approvedRole: APPROVED_ROLE,
        }),
        /differs from the approved Cloud SQL target/
    );
    assert.equal(calls.length, 2);
});

test('role-remover command failures are explicitly indeterminate', async () => {
    let calls = 0;
    const remover = createProductionCloudSqlRoleRemover(
        RUNTIME_ACCOUNT,
        APPROVED_ROLE,
        2_000,
        undefined,
        async () => {
            calls += 1;
            if (calls === 1) return '[]';
            throw new Error('synthetic timeout');
        }
    );

    await assert.rejects(
        () => remover({
            provider: CLOUD_SQL_ROLE_REMOVAL_PROVIDER,
            target: PRODUCTION_CLOUD_SQL_TARGET.connectionName,
            runtimeAccount: RUNTIME_ACCOUNT,
            approvedRole: APPROVED_ROLE,
        }),
        (error: unknown) => {
            assert.ok(error instanceof CloudSqlRoleRemovalIndeterminateError);
            assert.match(error.message, /inspect Cloud SQL operations before retrying/);
            return true;
        }
    );
    assert.equal(calls, 2);
});
