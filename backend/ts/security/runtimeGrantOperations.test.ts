import assert from 'node:assert/strict';
import test from 'node:test';
import {
    applyP4GrantRetirement,
    applyRuntimeGrants,
    createP4GrantRetirementPlan,
    createRuntimeGrantPlan,
    planP4GrantRetirement,
    planRuntimeGrants,
    P4GrantRetirementDriftError,
    RuntimeGrantIndeterminateError,
    runtimeGrantLockName,
    type RuntimeGrantConnection,
    type RuntimeGrantSettings,
    type RuntimeGrantSnapshot,
    verifyP4GrantRetirement,
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

function snapshotWithLegacyP4Grants(
    privileges: readonly ('SELECT' | 'UPDATE')[] = ['SELECT', 'UPDATE'],
    isGrantable: 'YES' | 'NO' = 'NO'
): RuntimeGrantSnapshot {
    const current = exactSnapshot();
    return {
        ...current,
        availableColumns: [
            ...current.availableColumns,
            { tableName: 'users', columnName: 'p4_score' },
        ],
        columnPrivileges: [
            ...current.columnPrivileges,
            ...privileges.map((privilegeType) => ({
                schemaName: DATABASE,
                tableName: 'users',
                columnName: 'p4_score',
                privilegeType,
                isGrantable,
            })),
        ],
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

test('stale p4_score grants fail closed without rendering a revoke', () => {
    const current = exactSnapshot();
    const snapshot: RuntimeGrantSnapshot = {
        ...current,
        availableColumns: [
            ...current.availableColumns,
            { tableName: 'users', columnName: 'p4_score' },
        ],
        columnPrivileges: [
            ...current.columnPrivileges,
            {
                schemaName: DATABASE,
                tableName: 'users',
                columnName: 'p4_score',
                privilegeType: 'SELECT',
                isGrantable: 'NO',
            },
            {
                schemaName: DATABASE,
                tableName: 'users',
                columnName: 'p4_score',
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

test('p4 retirement plans only the exact two-grant atomic revoke', () => {
    const snapshot = snapshotWithLegacyP4Grants();
    const first = createP4GrantRetirementPlan(
        snapshot,
        SETTINGS,
        RUNTIME_ACCOUNT
    );
    const second = createP4GrantRetirementPlan(
        snapshot,
        SETTINGS,
        RUNTIME_ACCOUNT
    );

    assert.equal(first.state, 'ready');
    assert.equal(first.compliant, false);
    assert.deepEqual(first.blockers, []);
    assert.equal(
        first.operation,
        "REVOKE SELECT (`p4_score`), UPDATE (`p4_score`) ON `migration_test`.`users` FROM 'runtime_test'@'%'"
    );
    assert.equal(first.sha256, second.sha256);
    assert.match(first.sha256, /^[a-f0-9]{64}$/u);

    const normalPlan = createRuntimeGrantPlan(snapshot, SETTINGS, RUNTIME_ACCOUNT);
    assert.equal(normalPlan.state, 'blocked');
    assert.deepEqual(normalPlan.operations, {
        ensureRequiredPrivileges: [],
        clearDefaultRoles: [],
        removeApprovedRole: null,
    });
});

test('p4 retirement is a stable no-op after both grants are absent', () => {
    const plan = createP4GrantRetirementPlan(
        exactSnapshot(),
        SETTINGS,
        RUNTIME_ACCOUNT
    );

    assert.equal(plan.state, 'retired');
    assert.equal(plan.compliant, true);
    assert.deepEqual(plan.blockers, []);
    assert.equal(plan.operation, null);
});

test('partial, grantable, role-bearing, and underprivileged retirement states block', () => {
    const partial = createP4GrantRetirementPlan(
        snapshotWithLegacyP4Grants(['SELECT']),
        SETTINGS,
        RUNTIME_ACCOUNT
    );
    assert.equal(partial.state, 'blocked');
    assert.match(partial.blockers.join(' '), /exactly non-grantable SELECT and UPDATE/u);
    assert.equal(partial.operation, null);

    const grantable = createP4GrantRetirementPlan(
        snapshotWithLegacyP4Grants(['SELECT', 'UPDATE'], 'YES'),
        SETTINGS,
        RUNTIME_ACCOUNT
    );
    assert.equal(grantable.state, 'blocked');
    assert.match(grantable.blockers.join(' '), /grantable column privileges/u);

    const withRole: RuntimeGrantSnapshot = {
        ...snapshotWithLegacyP4Grants(),
        assignedRoles: [{
            user: APPROVED_ROLE.user,
            host: APPROVED_ROLE.host,
            withAdminOption: false,
        }],
    };
    const rolePlan = createP4GrantRetirementPlan(
        withRole,
        SETTINGS,
        RUNTIME_ACCOUNT
    );
    assert.equal(rolePlan.state, 'blocked');
    assert.match(rolePlan.blockers.join(' '), /no assigned or default roles/u);

    const missingRequired = snapshotWithLegacyP4Grants();
    const underprivileged: RuntimeGrantSnapshot = {
        ...missingRequired,
        columnPrivileges: missingRequired.columnPrivileges.slice(1),
    };
    const underprivilegedPlan = createP4GrantRetirementPlan(
        underprivileged,
        SETTINGS,
        RUNTIME_ACCOUNT
    );
    assert.equal(underprivilegedPlan.state, 'blocked');
    assert.match(underprivilegedPlan.blockers.join(' '), /generic-only.*missing/u);
    assert.equal(underprivilegedPlan.operation, null);
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

class P4RetirementConnection extends SnapshotConnection {
    legacyGrantsPresent = true;
    activeSessions = 0;
    failRevoke = false;

    override async query(sql: string): Promise<[unknown, unknown]> {
        if (/^REVOKE SELECT \(`p4_score`\), UPDATE \(`p4_score`\)/u.test(sql)) {
            this.calls.push(sql);
            if (this.failRevoke) throw new Error('synthetic revoke connection loss');
            this.legacyGrantsPresent = false;
            return [[], []];
        }
        if (sql.includes('runtime-grants:active-sessions')) {
            this.calls.push(sql);
            return [[{
                sessionCount: this.activeSessions,
                processPrivilegeProof: 1,
            }], []];
        }
        if (sql.includes('runtime-grants:columns')) {
            this.calls.push(sql);
            return [[
                ...exactSnapshot().availableColumns,
                { tableName: 'users', columnName: 'p4_score' },
            ], []];
        }
        if (sql.includes('runtime-grants:column')) {
            this.calls.push(sql);
            return [this.legacyGrantsPresent
                ? snapshotWithLegacyP4Grants().columnPrivileges
                : exactSnapshot().columnPrivileges, []];
        }
        return super.query(sql);
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

test('p4 retirement applies with existing sessions, verifies, and stays idempotent', async () => {
    const connection = new P4RetirementConnection();
    const readyPlan = await planP4GrantRetirement(
        connection,
        SETTINGS,
        RUNTIME_ACCOUNT
    );
    assert.equal(readyPlan.state, 'ready');
    await assert.rejects(
        () => verifyP4GrantRetirement(connection, SETTINGS, RUNTIME_ACCOUNT),
        P4GrantRetirementDriftError
    );

    connection.activeSessions = 1;
    const retired = await applyP4GrantRetirement(
        connection,
        SETTINGS,
        RUNTIME_ACCOUNT,
        readyPlan.sha256,
        SERVER_UUID
    );
    assert.equal(retired.state, 'retired');
    assert.equal(retired.compliant, true);
    assert.equal(connection.legacyGrantsPresent, false);
    assert.equal(
        connection.calls.filter((sql) => /^REVOKE SELECT/u.test(sql)).length,
        1
    );

    const verified = await verifyP4GrantRetirement(
        connection,
        SETTINGS,
        RUNTIME_ACCOUNT
    );
    const secondApply = await applyP4GrantRetirement(
        connection,
        SETTINGS,
        RUNTIME_ACCOUNT,
        verified.sha256,
        SERVER_UUID
    );
    assert.equal(secondApply.sha256, verified.sha256);
    assert.equal(
        connection.calls.filter((sql) => /^REVOKE SELECT/u.test(sql)).length,
        1
    );
});

test('p4 retirement refuses stale approval and treats an invoked revoke failure as indeterminate', async () => {
    const wrongTargetConnection = new P4RetirementConnection();
    const targetPlan = await planP4GrantRetirement(
        wrongTargetConnection,
        SETTINGS,
        RUNTIME_ACCOUNT
    );
    await assert.rejects(
        () => applyP4GrantRetirement(
            wrongTargetConnection,
            SETTINGS,
            RUNTIME_ACCOUNT,
            targetPlan.sha256,
            'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'
        ),
        /server UUID/u
    );
    assert.equal(
        wrongTargetConnection.calls.some((sql) => /^REVOKE SELECT/u.test(sql)),
        false
    );

    const staleConnection = new P4RetirementConnection();
    await assert.rejects(
        () => applyP4GrantRetirement(
            staleConnection,
            SETTINGS,
            RUNTIME_ACCOUNT,
            '0'.repeat(64),
            SERVER_UUID
        ),
        /state changed/
    );
    assert.equal(
        staleConnection.calls.some((sql) => /^REVOKE SELECT/u.test(sql)),
        false
    );

    const failingConnection = new P4RetirementConnection();
    const readyPlan = await planP4GrantRetirement(
        failingConnection,
        SETTINGS,
        RUNTIME_ACCOUNT
    );
    failingConnection.failRevoke = true;
    await assert.rejects(
        () => applyP4GrantRetirement(
            failingConnection,
            SETTINGS,
            RUNTIME_ACCOUNT,
            readyPlan.sha256,
            SERVER_UUID
        ),
        RuntimeGrantIndeterminateError
    );
    assert.equal(failingConnection.legacyGrantsPresent, true);
    assert.equal(
        failingConnection.calls.filter((sql) => /^REVOKE SELECT/u.test(sql)).length,
        1
    );
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
