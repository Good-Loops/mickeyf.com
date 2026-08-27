import assert from 'node:assert/strict';
import test from 'node:test';
import {
    applyRuntimeGrants,
    createRuntimeGrantPlan,
    planRuntimeGrants,
    RuntimeGrantIndeterminateError,
    runtimeGrantLockName,
    type RuntimeGrantConnection,
    type RuntimeGrantSettings,
    type RuntimeGrantSnapshot,
} from './runtimeGrantOperations';
import {
    runtimeColumnPrivilegeInventory,
    type RuntimeDatabaseAccount,
} from './runtimeGrantManifest';

const DATABASE = 'migration_test';
const RUNTIME_ACCOUNT: RuntimeDatabaseAccount = Object.freeze({
    user: 'runtime_test',
    host: '%',
});
const APPROVED_ROLE: RuntimeDatabaseAccount = Object.freeze({
    user: 'cloudsqlsuperuser',
    host: '%',
});
const SERVER_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const SETTINGS: RuntimeGrantSettings = Object.freeze({
    database: DATABASE,
    expectedServerUuid: SERVER_UUID,
    maintenanceAccount: Object.freeze({ user: 'migration_admin', host: '%' }),
    approvedRole: APPROVED_ROLE,
    roleRemovalProvider: 'test-role-remover',
    roleRemovalTarget: 'local-test',
    advisoryLockTimeoutSeconds: 1,
    lockWaitTimeoutSeconds: 1,
});

function exactSnapshot(): RuntimeGrantSnapshot {
    const inventory = runtimeColumnPrivilegeInventory();
    return {
        databaseName: DATABASE,
        currentUser: 'migration_admin@%',
        serverUuid: SERVER_UUID,
        serverVersion: '8.0.31',
        versionComment: 'MySQL Community Server - GPL',
        mandatoryRoles: '',
        activateAllRolesOnLogin: false,
        partialRevokes: false,
        maintenanceHasProcessPrivilege: true,
        exactAccountCount: 1,
        accountNameCount: 1,
        accountLocked: false,
        passwordExpired: false,
        hasPrivilegeRestrictions: false,
        staticGlobalPrivileges: [],
        availableColumns: inventory.map(({ tableName, columnName }) => ({
            tableName,
            columnName,
        })),
        globalPrivileges: [{ privilegeType: 'USAGE', isGrantable: 'NO' }],
        dynamicGlobalPrivileges: [],
        schemaPrivileges: [],
        tablePrivileges: [],
        columnPrivileges: inventory.map((privilege) => ({
            schemaName: DATABASE,
            tableName: privilege.tableName,
            columnName: privilege.columnName,
            privilegeType: privilege.privilegeType,
            isGrantable: 'NO',
        })),
        routinePrivileges: [],
        assignedRoles: [],
        defaultRoles: [],
        proxyPrivileges: [],
        inboundProxyPrivileges: [],
        outgoingRoleEdges: [],
    };
}

test('exact runtime grants produce a stable reduced no-op plan', () => {
    const snapshot = exactSnapshot();
    const first = createRuntimeGrantPlan(snapshot, SETTINGS, RUNTIME_ACCOUNT);
    const second = createRuntimeGrantPlan(snapshot, SETTINGS, RUNTIME_ACCOUNT);

    assert.equal(first.state, 'reduced');
    assert.equal(first.compliant, true);
    assert.deepEqual(first.blockers, []);
    assert.equal(first.sha256, second.sha256);
    assert.match(first.sha256, /^[a-f0-9]{64}$/u);
    assert.deepEqual(first.operations, {
        ensureRequiredPrivileges: [],
        clearDefaultRoles: [],
        removeApprovedRole: null,
    });
});

test('the exact broad role produces only additive grants and one reviewed removal', () => {
    const snapshot: RuntimeGrantSnapshot = {
        ...exactSnapshot(),
        columnPrivileges: [],
        assignedRoles: [{
            user: APPROVED_ROLE.user,
            host: APPROVED_ROLE.host,
            withAdminOption: false,
        }],
        defaultRoles: [{ user: APPROVED_ROLE.user, host: APPROVED_ROLE.host }],
    };

    const plan = createRuntimeGrantPlan(snapshot, SETTINGS, RUNTIME_ACCOUNT);

    assert.equal(plan.state, 'broad');
    assert.equal(plan.compliant, false);
    assert.deepEqual(plan.blockers, []);
    assert.equal(plan.operations.ensureRequiredPrivileges.length, 3);
    assert.deepEqual(plan.operations.clearDefaultRoles, [
        "SET DEFAULT ROLE NONE TO 'runtime_test'@'%'",
    ]);
    assert.deepEqual(plan.operations.removeApprovedRole, {
        provider: SETTINGS.roleRemovalProvider,
        target: SETTINGS.roleRemovalTarget,
        runtimeAccount: 'runtime_test@%',
        approvedRole: 'cloudsqlsuperuser@%',
        resultingDatabaseRoles: [],
    });
    assert.equal(
        plan.operations.ensureRequiredPrivileges.some((statement) => /REVOKE/iu.test(statement)),
        false
    );
});

test('unexpected direct privileges and privilege relationships block every mutation', () => {
    const snapshot: RuntimeGrantSnapshot = {
        ...exactSnapshot(),
        staticGlobalPrivileges: ['PROCESS'],
        dynamicGlobalPrivileges: [{ privilegeType: 'CONNECTION_ADMIN', isGrantable: 'NO' }],
        schemaPrivileges: [{
            schemaName: 'other_schema',
            privilegeType: 'SELECT',
            isGrantable: 'NO',
        }],
        tablePrivileges: [{
            schemaName: DATABASE,
            tableName: 'users',
            privilegeType: 'DELETE',
            isGrantable: 'NO',
        }],
        proxyPrivileges: [{
            proxiedUser: 'another_user',
            proxiedHost: '%',
            withGrant: false,
        }],
        inboundProxyPrivileges: [{
            user: 'proxy_user',
            host: '%',
            withGrant: false,
        }],
        assignedRoles: [
            { user: APPROVED_ROLE.user, host: APPROVED_ROLE.host, withAdminOption: false },
            { user: 'unexpected_role', host: '%', withAdminOption: false },
        ],
    };
    const plan = createRuntimeGrantPlan(snapshot, SETTINGS, RUNTIME_ACCOUNT);

    assert.equal(plan.state, 'blocked');
    assert.match(plan.blockers.join(' '), /static global privileges/u);
    assert.match(plan.blockers.join(' '), /unexpected role assignment/u);
    assert.match(plan.blockers.join(' '), /proxy/u);
    assert.deepEqual(plan.operations, {
        ensureRequiredPrivileges: [],
        clearDefaultRoles: [],
        removeApprovedRole: null,
    });
});

test('unexpected column grants fail closed without rendering a revoke', () => {
    const current = exactSnapshot();
    const snapshot: RuntimeGrantSnapshot = {
        ...current,
        columnPrivileges: [
            ...current.columnPrivileges,
            {
                schemaName: DATABASE,
                tableName: 'users',
                columnName: 'email',
                privilegeType: 'UPDATE',
                isGrantable: 'NO',
            },
        ],
    };

    const plan = createRuntimeGrantPlan(snapshot, SETTINGS, RUNTIME_ACCOUNT);

    assert.equal(plan.state, 'blocked');
    assert.match(plan.blockers.join(' '), /unexpected or grantable column privileges/u);
    assert.deepEqual(plan.operations, {
        ensureRequiredPrivileges: [],
        clearDefaultRoles: [],
        removeApprovedRole: null,
    });
});

test('unexpected role admin option, account flags, and global role settings block', () => {
    const snapshot: RuntimeGrantSnapshot = {
        ...exactSnapshot(),
        accountLocked: true,
        passwordExpired: true,
        hasPrivilegeRestrictions: true,
        mandatoryRoles: "'mandatory_admin'@'%'",
        activateAllRolesOnLogin: true,
        assignedRoles: [{
            user: APPROVED_ROLE.user,
            host: APPROVED_ROLE.host,
            withAdminOption: true,
        }],
    };
    const plan = createRuntimeGrantPlan(snapshot, SETTINGS, RUNTIME_ACCOUNT);

    assert.equal(plan.state, 'blocked');
    assert.match(plan.blockers.join(' '), /locked/u);
    assert.match(plan.blockers.join(' '), /password is expired/u);
    assert.match(plan.blockers.join(' '), /partial-revoke restrictions/u);
    assert.match(plan.blockers.join(' '), /mandatory_roles/u);
    assert.match(plan.blockers.join(' '), /activate_all_roles_on_login/u);
    assert.match(plan.blockers.join(' '), /unexpected role assignment/u);
});

test('wrong server, maintenance identity, or PROCESS capability blocks every operation', () => {
    const snapshot: RuntimeGrantSnapshot = {
        ...exactSnapshot(),
        serverUuid: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
        currentUser: 'another_admin@%',
        maintenanceHasProcessPrivilege: false,
    };
    const plan = createRuntimeGrantPlan(snapshot, SETTINGS, RUNTIME_ACCOUNT);

    assert.equal(plan.state, 'blocked');
    assert.match(plan.blockers.join(' '), /independently pinned target/u);
    assert.match(plan.blockers.join(' '), /maintenance account mismatch/u);
    assert.match(plan.blockers.join(' '), /PROCESS visibility/u);
    assert.deepEqual(plan.operations, {
        ensureRequiredPrivileges: [],
        clearDefaultRoles: [],
        removeApprovedRole: null,
    });
});

class SnapshotConnection implements RuntimeGrantConnection {
    readonly calls: string[] = [];
    destroyed = false;

    async query(sql: string): Promise<[unknown, unknown]> {
        this.calls.push(sql);
        if (sql.includes('GET_LOCK')) return [[{ acquired: 1 }], []];
        if (sql.includes('RELEASE_LOCK')) return [[{ released: 1 }], []];
        if (sql.includes('runtime-grants:identity')) return [[{
            databaseName: DATABASE,
            currentUser: 'migration_admin@%',
            serverUuid: SERVER_UUID,
            serverVersion: '8.0.31',
            versionComment: 'MySQL Community Server - GPL',
            mandatoryRoles: '',
            activateAllRolesOnLogin: 0,
            partialRevokes: 0,
        }], []];
        if (sql.includes('runtime-grants:account')) return [[{
            exactAccountCount: 1,
            accountNameCount: 1,
            accountLocked: 'N',
            passwordExpired: 'N',
            hasPrivilegeRestrictions: 0,
        }], []];
        if (sql.includes('runtime-grants:maintenance-process-privilege')) {
            return [[{ processPrivilegeProof: 1 }], []];
        }
        if (sql.includes('runtime-grants:static-global-columns')) {
            return [[{ columnName: 'Select_priv' }, { columnName: 'Process_priv' }], []];
        }
        if (sql.includes('runtime-grants:static-global-values')) {
            return [[{ Select_priv: 'N', Process_priv: 'N' }], []];
        }
        if (sql.includes('runtime-grants:columns')) {
            return [exactSnapshot().availableColumns, []];
        }
        if (sql.includes('runtime-grants:global')) {
            return [[{ privilegeType: 'USAGE', isGrantable: 'NO' }], []];
        }
        if (sql.includes('runtime-grants:column')) {
            return [exactSnapshot().columnPrivileges, []];
        }
        return [[], []];
    }

    destroy(): void {
        this.destroyed = true;
    }
}

class PostProviderVerificationFailureConnection extends SnapshotConnection {
    roleRemovalInvoked = false;

    override async query(sql: string): Promise<[unknown, unknown]> {
        if (this.roleRemovalInvoked && sql.includes('runtime-grants:identity')) {
            this.calls.push(sql);
            throw new Error('synthetic lost verification connection');
        }
        if (sql.includes('runtime-grants:assigned-roles')) {
            this.calls.push(sql);
            return [[{
                user: APPROVED_ROLE.user,
                host: APPROVED_ROLE.host,
                withAdminOption: 0,
            }], []];
        }
        if (sql.includes('runtime-grants:active-sessions')) {
            this.calls.push(sql);
            return [[{ sessionCount: 0, processPrivilegeProof: 1 }], []];
        }
        return super.query(sql);
    }
}

test('stale apply digest refuses before its first privilege mutation', async () => {
    const connection = new SnapshotConnection();
    await assert.rejects(
        () => applyRuntimeGrants(
            connection,
            SETTINGS,
            RUNTIME_ACCOUNT,
            '0'.repeat(64),
            SERVER_UUID
        ),
        /state changed/
    );

    assert.equal(
        connection.calls.some((sql) => /^\s*(?:GRANT|REVOKE|SET DEFAULT ROLE)/iu.test(sql)),
        false
    );
    assert.equal(connection.calls.some((sql) => sql.includes('RELEASE_LOCK')), true);
});

test('post-provider verification failures remain explicitly indeterminate', async () => {
    const connection = new PostProviderVerificationFailureConnection();
    const approvedPlan = await planRuntimeGrants(
        connection,
        SETTINGS,
        RUNTIME_ACCOUNT
    );

    let caught: unknown;
    try {
        await applyRuntimeGrants(
            connection,
            SETTINGS,
            RUNTIME_ACCOUNT,
            approvedPlan.sha256,
            SERVER_UUID,
            async () => { connection.roleRemovalInvoked = true; }
        );
    } catch (error) {
        caught = error;
    }
    assert.ok(
        caught instanceof RuntimeGrantIndeterminateError,
        caught instanceof Error ? caught.message : 'no error was thrown'
    );
    assert.match(caught.message, /role change may have completed/u);
    assert.match(caught.message, /fresh plan and verification/u);
    assert.equal(connection.calls.some((sql) => sql.includes('RELEASE_LOCK')), true);
});

test('runtime grant lock is stable, scoped, and within MySQL limits', () => {
    const name = runtimeGrantLockName(DATABASE, RUNTIME_ACCOUNT);
    assert.equal(name, runtimeGrantLockName(DATABASE, RUNTIME_ACCOUNT));
    assert.notEqual(name, runtimeGrantLockName('another_database', RUNTIME_ACCOUNT));
    assert.match(name, /^mickeyf:runtime-grants:[a-f0-9]{24}$/u);
    assert.ok(name.length <= 64);
});
