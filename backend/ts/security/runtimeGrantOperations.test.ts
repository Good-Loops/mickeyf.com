import assert from 'node:assert/strict';
import test from 'node:test';
import {
    applyRuntimeGrants,
    createRuntimeGrantPlan,
    planRuntimeGrants,
    verifyRuntimeGrants,
    RuntimeGrantIndeterminateError,
    runtimeGrantLockName,
    type RuntimeGrantConnection,
    type RuntimeGrantSettings,
    type RuntimeGrantSnapshot,
} from './runtimeGrantOperations';
import {
    renderRuntimeGrantStatements,
    runtimeColumnPrivilegeInventory,
    runtimeTablePrivilegeInventory,
    type RuntimeDatabaseAccount,
    type RuntimeGrantProfile,
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

function exactSnapshot(profile?: RuntimeGrantProfile): RuntimeGrantSnapshot {
    const inventory = runtimeColumnPrivilegeInventory(profile);
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
        tablePrivileges: runtimeTablePrivilegeInventory(profile).map((privilege) => ({
            schemaName: DATABASE,
            ...privilege,
            isGrantable: 'NO',
        })),
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
    assert.equal(first.formatVersion, 5);
    assert.equal(first.profile, 'google-apple');
    assert.deepEqual(first.expectedTablePrivileges, [...snapshot.tablePrivileges].sort((left, right) =>
        left.tableName.localeCompare(right.tableName)));
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

test('Google-only grants accept schema through signup without requiring Apple storage', () => {
    const snapshot = exactSnapshot('google');
    const plan = createRuntimeGrantPlan(snapshot, { ...SETTINGS, profile: 'google' }, RUNTIME_ACCOUNT);

    assert.equal(plan.profile, 'google');
    assert.equal(plan.state, 'reduced');
    assert.equal(plan.compliant, true);
    assert.deepEqual(plan.blockers, []);
    assert.deepEqual(plan.operations.ensureRequiredPrivileges, []);
    assert.equal(plan.expectedColumnPrivileges.some(({ tableName, columnName }) =>
        tableName.startsWith('apple_') || columnName.startsWith('apple_')), false);
    assert.equal(plan.expectedTablePrivileges.some(({ tableName }) => tableName.startsWith('apple_')), false);

    const fullPlan = createRuntimeGrantPlan(snapshot, SETTINGS, RUNTIME_ACCOUNT);
    assert.equal(fullPlan.profile, 'google-apple');
    assert.equal(fullPlan.state, 'blocked');
    assert.match(fullPlan.blockers.join(' '), /required runtime columns are missing:.*apple_/u);
    assert.deepEqual(fullPlan.operations.ensureRequiredPrivileges, []);
});

test('Google-only repair renders only its exact selected manifest', () => {
    const snapshot = { ...exactSnapshot('google'), columnPrivileges: [], tablePrivileges: [] };
    const plan = createRuntimeGrantPlan(snapshot, { ...SETTINGS, profile: 'google' }, RUNTIME_ACCOUNT);

    assert.equal(plan.state, 'repair');
    assert.deepEqual(plan.blockers, []);
    assert.deepEqual(plan.operations.ensureRequiredPrivileges,
        renderRuntimeGrantStatements(DATABASE, RUNTIME_ACCOUNT, 'google')
            .map((statement) => statement.replace(/;$/u, '')));
    assert.equal(plan.operations.ensureRequiredPrivileges.some(sql => /apple_|^REVOKE/iu.test(sql)), false);
});

test('selecting Google does not automatically revoke existing Apple permissions', () => {
    const google = exactSnapshot('google');
    const full = exactSnapshot();
    const appleColumns = full.columnPrivileges.filter(({ tableName, columnName }) =>
        tableName.startsWith('apple_') || columnName.startsWith('apple_'));
    const appleTables = full.tablePrivileges.filter(({ tableName }) => tableName.startsWith('apple_'));
    for (const extra of [
        { columnPrivileges: [...google.columnPrivileges, ...appleColumns] },
        { tablePrivileges: [...google.tablePrivileges, ...appleTables] },
    ]) {
        const plan = createRuntimeGrantPlan({ ...google, ...extra },
            { ...SETTINGS, profile: 'google' }, RUNTIME_ACCOUNT);
        assert.equal(plan.state, 'blocked');
        assert.match(plan.blockers.join(' '), /unexpected or grantable (?:column|table) privileges/u);
        assert.deepEqual(plan.operations, {
            ensureRequiredPrivileges: [], clearDefaultRoles: [], removeApprovedRole: null,
        });
    }
});

test('Google-only grants refuse existing Apple schema even without Apple privileges', () => {
    const google = exactSnapshot('google');
    for (const appleColumn of [
        { tableName: 'apple_provider_tokens', columnName: 'provider_subject' },
        { tableName: 'apple_auth_revocations', columnName: 'subject_hash' },
        { tableName: 'account_sessions', columnName: 'apple_subject_hash' },
        { tableName: 'account_sessions', columnName: 'apple_authenticated_at' },
    ]) {
        const plan = createRuntimeGrantPlan({ ...google,
            availableColumns: [...google.availableColumns, appleColumn],
        }, { ...SETTINGS, profile: 'google' }, RUNTIME_ACCOUNT);
        assert.equal(plan.state, 'blocked');
        assert.match(plan.blockers.join(' '), /require pre-Apple schema/u);
        assert.deepEqual(plan.operations, {
            ensureRequiredPrivileges: [], clearDefaultRoles: [], removeApprovedRole: null,
        });
    }
});

test('the normalized profile is explicit and bound to the plan digest', () => {
    const snapshot = exactSnapshot();
    const implicit = createRuntimeGrantPlan(snapshot, SETTINGS, RUNTIME_ACCOUNT);
    const explicit = createRuntimeGrantPlan(snapshot, { ...SETTINGS, profile: 'google-apple' }, RUNTIME_ACCOUNT);
    const google = createRuntimeGrantPlan(snapshot, { ...SETTINGS, profile: 'google' }, RUNTIME_ACCOUNT);

    assert.equal(implicit.profile, 'google-apple');
    assert.equal(implicit.sha256, explicit.sha256);
    assert.notEqual(google.sha256, explicit.sha256);
});

test('missing account deletion grants produce an additive repair plan, not compliance', () => {
    const current = exactSnapshot();
    for (const tablePrivileges of [[], current.tablePrivileges.slice(1)]) {
        const plan = createRuntimeGrantPlan({ ...current, tablePrivileges }, SETTINGS, RUNTIME_ACCOUNT);
        assert.equal(plan.state, 'repair');
        assert.equal(plan.compliant, false);
        assert.deepEqual(plan.blockers, []);
        assert.equal(plan.operations.ensureRequiredPrivileges.length, 9);
        assert.equal(plan.operations.ensureRequiredPrivileges.filter((sql) => /, DELETE ON /u.test(sql)).length, 7);
        assert.equal(plan.operations.removeApprovedRole, null);
    }
});

test('account identity grants require its schema migration and fresh approval', () => {
    const current = exactSnapshot();
    const withoutIdentity = (column: { columnName: string }) => column.columnName !== 'account_uuid';
    const oldGrants = current.columnPrivileges.filter(withoutIdentity);
    const repair = createRuntimeGrantPlan({ ...current, columnPrivileges: oldGrants }, SETTINGS, RUNTIME_ACCOUNT);
    const complete = createRuntimeGrantPlan(current, SETTINGS, RUNTIME_ACCOUNT);

    assert.equal(repair.state, 'repair');
    assert.equal(repair.compliant, false);
    assert.deepEqual(repair.blockers, []);
    assert.notEqual(repair.sha256, complete.sha256);
    const userGrant = repair.operations.ensureRequiredPrivileges.find(sql => sql.includes('.`users`'))!;
    assert.match(userGrant, /SELECT \([^)]*`account_uuid`/u);
    assert.doesNotMatch(userGrant, /(?:INSERT|UPDATE) \([^)]*`account_uuid`/u);

    const unmigrated = createRuntimeGrantPlan({
        ...current,
        availableColumns: current.availableColumns.filter(withoutIdentity),
        columnPrivileges: oldGrants,
    }, SETTINGS, RUNTIME_ACCOUNT);
    assert.equal(unmigrated.state, 'blocked');
    assert.deepEqual(unmigrated.operations.ensureRequiredPrivileges, []);
});

test('table privileges accept only non-grantable DELETE on the manifest tables', () => {
    const current = exactSnapshot();
    for (const unexpected of [
        { schemaName: DATABASE, tableName: 'users', privilegeType: 'SELECT', isGrantable: 'NO' as const },
        { schemaName: DATABASE, tableName: 'users', privilegeType: 'UPDATE', isGrantable: 'NO' as const },
        { schemaName: DATABASE, tableName: 'users', privilegeType: 'DELETE', isGrantable: 'YES' as const },
        { schemaName: DATABASE, tableName: 'schema_migrations', privilegeType: 'DELETE', isGrantable: 'NO' as const },
        { schemaName: DATABASE, tableName: 'account_provider_identities', privilegeType: 'DELETE', isGrantable: 'NO' as const },
        { schemaName: 'other_schema', tableName: 'users', privilegeType: 'DELETE', isGrantable: 'NO' as const },
    ]) {
        const plan = createRuntimeGrantPlan({
            ...current,
            tablePrivileges: [...current.tablePrivileges, unexpected],
        }, SETTINGS, RUNTIME_ACCOUNT);
        assert.equal(plan.state, 'blocked');
        assert.match(plan.blockers.join(' '), /unexpected or grantable table privileges/u);
        assert.deepEqual(plan.operations.ensureRequiredPrivileges, []);
    }
});

test('session privileges require migrated renewal storage and forbid immutable-column UPDATE grants', () => {
    const current = exactSnapshot();
    const withoutSessions = (column: { tableName: string }) => column.tableName !== 'account_sessions';
    const oldGrants = current.columnPrivileges.filter(withoutSessions);
    const repair = createRuntimeGrantPlan({ ...current, columnPrivileges: oldGrants }, SETTINGS, RUNTIME_ACCOUNT);
    assert.equal(repair.state, 'repair');
    assert.equal(repair.blockers.length, 0);
    assert.match(repair.operations.ensureRequiredPrivileges.find(sql => sql.includes('.`account_sessions`'))!, /, DELETE ON/u);
    const unmigrated = createRuntimeGrantPlan({ ...current, availableColumns: current.availableColumns.filter(withoutSessions),
        columnPrivileges: oldGrants }, SETTINGS, RUNTIME_ACCOUNT);
    assert.equal(unmigrated.state, 'blocked');
    assert.deepEqual(unmigrated.operations.ensureRequiredPrivileges, []);
    const unsafe = createRuntimeGrantPlan({ ...current, columnPrivileges: [...current.columnPrivileges, {
        schemaName: DATABASE, tableName: 'account_sessions', columnName: 'remembered',
        privilegeType: 'UPDATE', isGrantable: 'NO',
    }] }, SETTINGS, RUNTIME_ACCOUNT);
    assert.equal(unsafe.state, 'blocked');
});

test('DELETE remains forbidden at schema and global scope', () => {
    const current = exactSnapshot();
    for (const extra of [
        { schemaPrivileges: [{ schemaName: DATABASE, privilegeType: 'DELETE', isGrantable: 'NO' as const }] },
        { globalPrivileges: [...current.globalPrivileges, { privilegeType: 'DELETE', isGrantable: 'NO' as const }] },
    ]) {
        const plan = createRuntimeGrantPlan({ ...current, ...extra }, SETTINGS, RUNTIME_ACCOUNT);
        assert.equal(plan.state, 'blocked');
        assert.deepEqual(plan.operations.ensureRequiredPrivileges, []);
    }
});

test('provider grants require both migrated tables and cannot permit identity reassignment', () => {
    const current = exactSnapshot();
    for (const tableName of ['account_provider_identities', 'provider_auth_attempts']) {
        const withoutTable = (column: { tableName: string }) => column.tableName !== tableName;
        const oldGrants = current.columnPrivileges.filter(withoutTable);
        const repair = createRuntimeGrantPlan({ ...current, columnPrivileges: oldGrants }, SETTINGS, RUNTIME_ACCOUNT);
        assert.equal(repair.state, 'repair');
        assert.deepEqual(repair.blockers, []);
        assert.equal(repair.operations.ensureRequiredPrivileges.length, 9);
        const unmigrated = createRuntimeGrantPlan({ ...current,
            availableColumns: current.availableColumns.filter(withoutTable), columnPrivileges: oldGrants,
        }, SETTINGS, RUNTIME_ACCOUNT);
        assert.equal(unmigrated.state, 'blocked');
        assert.deepEqual(unmigrated.operations.ensureRequiredPrivileges, []);
    }
    for (const columnName of ['provider', 'subject', 'account_uuid']) {
        const unsafe = createRuntimeGrantPlan({ ...current, columnPrivileges: [...current.columnPrivileges, {
            schemaName: DATABASE, tableName: 'account_provider_identities', columnName,
            privilegeType: 'UPDATE', isGrantable: 'NO',
        }] }, SETTINGS, RUNTIME_ACCOUNT);
        assert.equal(unsafe.state, 'blocked');
        assert.deepEqual(unsafe.operations.ensureRequiredPrivileges, []);
    }
});

test('the plan digest binds the non-secret account credential-expiry state', () => {
    const currentPlan = createRuntimeGrantPlan(exactSnapshot(), SETTINGS, RUNTIME_ACCOUNT);
    const expiredPlan = createRuntimeGrantPlan({
        ...exactSnapshot(),
        passwordExpired: true,
    }, SETTINGS, RUNTIME_ACCOUNT);

    assert.equal(currentPlan.observed.passwordExpired, false);
    assert.equal(expiredPlan.observed.passwordExpired, true);
    assert.notEqual(currentPlan.sha256, expiredPlan.sha256);
});

test('legacy or mixed schemas refuse receipt grants before any mutation', () => {
    const current = exactSnapshot();
    const legacy = current.availableColumns.map(({ tableName, columnName }) => ({
        tableName: tableName === 'game_submission_receipts' ? 'game_runs' : tableName,
        columnName: columnName === 'improved_personal_best' ? 'personal_best' : columnName,
    }));
    for (const availableColumns of [
        legacy,
        [...current.availableColumns, { tableName: 'game_runs', columnName: 'game_run_id' }],
        [...current.availableColumns, { tableName: 'game_personal_bests', columnName: 'source_game_run_id' }],
    ]) {
        const plan = createRuntimeGrantPlan({ ...current, availableColumns }, SETTINGS, RUNTIME_ACCOUNT);
        assert.equal(plan.state, 'blocked');
        assert.match(plan.blockers.join(' '), /schema cutover is incomplete/u);
        assert.deepEqual(plan.operations, {
            ensureRequiredPrivileges: [], clearDefaultRoles: [], removeApprovedRole: null,
        });
    }
});

test('the plan digest rejects malformed account credential-expiry metadata', () => {
    const malformedSnapshot = {
        ...exactSnapshot(),
        passwordExpired: 'N',
    } as unknown as RuntimeGrantSnapshot;

    assert.throws(
        () => createRuntimeGrantPlan(malformedSnapshot, SETTINGS, RUNTIME_ACCOUNT),
        /credential-expiry metadata is invalid/u
    );
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
    assert.equal(plan.operations.ensureRequiredPrivileges.length, 9);
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
        plan.operations.ensureRequiredPrivileges.some((statement) => /^REVOKE\b/iu.test(statement)),
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
            privilegeType: 'ALTER',
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
    readonly lockNames: unknown[] = [];
    readonly googleGuardBindings: { sql: string; values: readonly unknown[] | undefined }[] = [];
    schemaSelectCount = 1;
    maintenanceCurrentUser = 'migration_admin@%';
    recordedAppleVersions: string[] = [];
    destroyed = false;

    constructor(readonly snapshot = exactSnapshot()) {}

    async query(sql: string, values?: readonly unknown[]): Promise<[unknown, unknown]> {
        this.calls.push(sql);
        if (sql.includes('GET_LOCK')) {
            this.lockNames.push(values?.[0]);
            return [[{ acquired: 1 }], []];
        }
        if (sql.includes('RELEASE_LOCK')) return [[{ released: 1 }], []];
        if (sql.includes('runtime-grants:google-schema-visibility')) {
            this.googleGuardBindings.push({ sql, values });
            return [[{ currentUser: this.maintenanceCurrentUser, schemaSelectCount: this.schemaSelectCount }], []];
        }
        if (sql.includes('runtime-grants:google-apple-history')) {
            this.googleGuardBindings.push({ sql, values });
            return [this.recordedAppleVersions.map(version => ({ version })), []];
        }
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
            return [this.snapshot.availableColumns, []];
        }
        if (sql.includes('runtime-grants:global')) {
            return [[{ privilegeType: 'USAGE', isGrantable: 'NO' }], []];
        }
        if (sql.includes('runtime-grants:column')) {
            return [this.snapshot.columnPrivileges, []];
        }
        if (sql.includes('runtime-grants:table')) {
            return [this.snapshot.tablePrivileges, []];
        }
        if (sql.includes('runtime-grants:active-sessions')) {
            return [[{ sessionCount: 0, processPrivilegeProof: 1 }], []];
        }
        return [[], []];
    }

    destroy(): void {
        this.destroyed = true;
    }
}

class MissingDeleteConnection extends SnapshotConnection {
    grantsInstalled = false;

    override async query(sql: string, values?: readonly unknown[]): Promise<[unknown, unknown]> {
        if (/^GRANT /u.test(sql)) {
            this.calls.push(sql);
            this.grantsInstalled = true;
            return [[], []];
        }
        if (sql.includes('runtime-grants:table') && !this.grantsInstalled) {
            this.calls.push(sql);
            return [[], []];
        }
        return super.query(sql, values);
    }
}

test('verification fails without DELETE and an approved fake apply installs the exact manifest', async () => {
    const connection = new MissingDeleteConnection();
    await assert.rejects(
        () => verifyRuntimeGrants(connection, SETTINGS, RUNTIME_ACCOUNT),
        /do not exactly match/u
    );
    const approved = await planRuntimeGrants(connection, SETTINGS, RUNTIME_ACCOUNT);
    const applied = await applyRuntimeGrants(
        connection, SETTINGS, RUNTIME_ACCOUNT, approved.sha256, SERVER_UUID
    );
    assert.equal(applied.compliant, true);
    assert.equal(connection.calls.filter((sql) => /^GRANT /u.test(sql)).length, 9);
    const verified = await verifyRuntimeGrants(connection, SETTINGS, RUNTIME_ACCOUNT);
    assert.equal(verified.compliant, true);
    assert.equal(connection.calls.some((sql) => /^REVOKE|^SET DEFAULT ROLE/u.test(sql)), false);
});

test('Google-only apply and verification keep the selected schema and permissions throughout', async () => {
    const settings: RuntimeGrantSettings = { ...SETTINGS, profile: 'google' };
    const connection = new MissingDeleteConnection(exactSnapshot('google'));
    await assert.rejects(() => verifyRuntimeGrants(connection, settings, RUNTIME_ACCOUNT), /do not exactly match/u);
    const approved = await planRuntimeGrants(connection, settings, RUNTIME_ACCOUNT);
    const applied = await applyRuntimeGrants(connection, settings, RUNTIME_ACCOUNT, approved.sha256, SERVER_UUID);
    assert.equal(applied.profile, 'google');
    assert.equal(applied.compliant, true);
    assert.deepEqual(connection.calls.filter(sql => /^GRANT /u.test(sql)),
        renderRuntimeGrantStatements(DATABASE, RUNTIME_ACCOUNT, 'google')
            .map(statement => statement.replace(/;$/u, '')));
    const verified = await verifyRuntimeGrants(connection, settings, RUNTIME_ACCOUNT);
    assert.equal(verified.profile, 'google');
    assert.equal(verified.compliant, true);
    const visibilityProofs = connection.googleGuardBindings.filter(({ sql }) =>
        sql.includes('google-schema-visibility'));
    assert.ok(visibilityProofs.length > 3);
    for (const { values } of visibilityProofs) assert.deepEqual(values, ["'migration_admin'@'%'", DATABASE]);
    const historyProofs = connection.googleGuardBindings.filter(({ sql }) => sql.includes('google-apple-history'));
    assert.equal(historyProofs.length, visibilityProofs.length);
    for (const { sql, values } of historyProofs) {
        assert.match(sql, /FROM `migration_test`\.schema_migrations/u);
        assert.deepEqual(values, ['0016_create_apple_provider_tokens', '0017_create_apple_auth_revocations',
            '0018_add_apple_session_provenance']);
    }
    await assert.rejects(() => verifyRuntimeGrants(connection, SETTINGS, RUNTIME_ACCOUNT), /do not exactly match/u);
    assert.equal(connection.calls.some(sql => /^REVOKE|^SET DEFAULT ROLE/u.test(sql)), false);
});

test('Google-only plan, verification and apply refuse unproven maintenance schema visibility', async () => {
    const settings = { ...SETTINGS, profile: 'google' } as const;
    for (const visibility of [
        { schemaSelectCount: 0, maintenanceCurrentUser: 'migration_admin@%' },
        { schemaSelectCount: 1, maintenanceCurrentUser: 'other_admin@%' },
    ]) {
        const connection = new SnapshotConnection(exactSnapshot('google'));
        const approved = await planRuntimeGrants(connection, settings, RUNTIME_ACCOUNT);
        Object.assign(connection, visibility);
        connection.calls.length = 0;
        for (const operation of [
            () => planRuntimeGrants(connection, settings, RUNTIME_ACCOUNT),
            () => verifyRuntimeGrants(connection, settings, RUNTIME_ACCOUNT),
            () => applyRuntimeGrants(connection, settings, RUNTIME_ACCOUNT, approved.sha256, SERVER_UUID),
        ]) await assert.rejects(operation, /confirmed maintenance account.*direct schema-wide SELECT/u);
        assert.equal(connection.calls.some(sql => /google-apple-history|runtime-grants:identity/u.test(sql)), false);
        assert.equal(connection.calls.some(sql => /^\s*(?:GRANT|REVOKE|SET DEFAULT ROLE)/iu.test(sql)), false);
        assert.equal(connection.calls.some(sql => sql.includes('RELEASE_LOCK')), true);
    }
});

test('recorded Apple migrations block Google grants even when no Apple objects are visible', async () => {
    const settings = { ...SETTINGS, profile: 'google' } as const;
    for (const version of ['0016_create_apple_provider_tokens', '0017_create_apple_auth_revocations',
        '0018_add_apple_session_provenance']) {
        const connection = new SnapshotConnection(exactSnapshot('google'));
        const approved = await planRuntimeGrants(connection, settings, RUNTIME_ACCOUNT);
        connection.recordedAppleVersions = [version];
        connection.calls.length = 0;
        for (const operation of [
            () => planRuntimeGrants(connection, settings, RUNTIME_ACCOUNT),
            () => verifyRuntimeGrants(connection, settings, RUNTIME_ACCOUNT),
            () => applyRuntimeGrants(connection, settings, RUNTIME_ACCOUNT, approved.sha256, SERVER_UUID),
        ]) await assert.rejects(operation, /Apple migration history is recorded/u);
        assert.equal(connection.calls.some(sql => sql.includes('runtime-grants:identity')), false);
        assert.equal(connection.calls.some(sql => /^\s*(?:GRANT|REVOKE|SET DEFAULT ROLE)/iu.test(sql)), false);
    }
});

test('full-profile planning does not require the additional Google schema gate', async () => {
    const connection = new SnapshotConnection();
    connection.schemaSelectCount = 0;
    connection.recordedAppleVersions = ['0016_create_apple_provider_tokens'];
    const plan = await planRuntimeGrants(connection, SETTINGS, RUNTIME_ACCOUNT);
    assert.equal(plan.compliant, true);
    assert.deepEqual(connection.googleGuardBindings, []);
});

test('changing the approved profile refuses apply before any privilege mutation', async () => {
    for (const profile of ['google', 'google-apple'] as const) {
        const connection = new SnapshotConnection({ ...exactSnapshot(profile), tablePrivileges: [] });
        const settings = { ...SETTINGS, profile };
        const changedSettings = { ...SETTINGS, profile: profile === 'google' ? 'google-apple' : 'google' } as const;
        const approved = await planRuntimeGrants(connection, settings, RUNTIME_ACCOUNT);
        const changed = await planRuntimeGrants(connection, changedSettings, RUNTIME_ACCOUNT);
        assert.equal(approved.state, 'repair');
        assert.notEqual(approved.sha256, changed.sha256);
        await assert.rejects(() => applyRuntimeGrants(connection, changedSettings, RUNTIME_ACCOUNT, approved.sha256, SERVER_UUID),
            /state changed/u);
        assert.equal(connection.calls.some(sql => /^\s*(?:GRANT|REVOKE|SET DEFAULT ROLE)/iu.test(sql)), false);
        assert.equal(new Set(connection.lockNames).size, 1);
        assert.equal(connection.lockNames[0], runtimeGrantLockName(DATABASE, RUNTIME_ACCOUNT));
    }
});

test('invalid runtime grant profiles are rejected before any database inspection', async () => {
    const settings = { ...SETTINGS, profile: 'unknown' as RuntimeGrantProfile };
    const connection = new SnapshotConnection();
    assert.throws(() => createRuntimeGrantPlan(exactSnapshot(), settings, RUNTIME_ACCOUNT), /profile/iu);
    await assert.rejects(() => planRuntimeGrants(connection, settings, RUNTIME_ACCOUNT), /profile/iu);
    await assert.rejects(() => verifyRuntimeGrants(connection, settings, RUNTIME_ACCOUNT), /profile/iu);
    await assert.rejects(() => applyRuntimeGrants(connection, settings, RUNTIME_ACCOUNT, '0'.repeat(64), SERVER_UUID), /profile/iu);
    assert.deepEqual(connection.calls, []);
});

test('runtime schema inspection includes both provider tables', async () => {
    const connection = new SnapshotConnection();
    const plan = await planRuntimeGrants(connection, SETTINGS, RUNTIME_ACCOUNT);
    assert.equal(plan.compliant, true);
    const inspection = connection.calls.find(sql => sql.includes('runtime-grants:columns'))!;
    assert.match(inspection, /'account_provider_identities'/u);
    assert.match(inspection, /'provider_auth_attempts'/u);
    assert.match(inspection, /'apple_auth_revocations'/u);
});

test('Apple revocation grants fail closed until watermark and both provenance columns exist', () => {
    const current = exactSnapshot();
    for (const missing of ['subject_hash', 'apple_subject_hash', 'apple_authenticated_at']) {
        const plan = createRuntimeGrantPlan({ ...current,
            availableColumns: current.availableColumns.filter(({ columnName }) => columnName !== missing),
        }, SETTINGS, RUNTIME_ACCOUNT);
        assert.equal(plan.state, 'blocked');
        assert.deepEqual(plan.operations.ensureRequiredPrivileges, []);
    }
});

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
