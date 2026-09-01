import { createHash } from 'node:crypto';
import {
    renderRuntimeDatabaseAccount,
    renderRuntimeGrantStatements,
    runtimeColumnPrivilegeInventory,
    runtimeDatabaseAccountName,
    type RuntimeDatabaseAccount,
} from './runtimeGrantManifest';

export interface RuntimeGrantConnection {
    query(sql: string, values?: readonly unknown[]): Promise<[unknown, unknown]>;
    destroy(): void;
}

export type RuntimeGrantSettings = Readonly<{
    database: string;
    expectedServerUuid: string;
    maintenanceAccount: RuntimeDatabaseAccount;
    approvedRole: RuntimeDatabaseAccount;
    roleRemovalProvider: string;
    roleRemovalTarget: string;
    advisoryLockTimeoutSeconds: number;
    lockWaitTimeoutSeconds: number;
}>;

type Grantability = 'YES' | 'NO';

export type GlobalPrivilege = Readonly<{
    privilegeType: string;
    isGrantable: Grantability;
}>;

export type SchemaPrivilege = GlobalPrivilege & Readonly<{
    schemaName: string;
}>;

export type TablePrivilege = SchemaPrivilege & Readonly<{
    tableName: string;
}>;

export type ColumnPrivilege = TablePrivilege & Readonly<{
    columnName: string;
}>;

export type RoutinePrivilege = Readonly<{
    schemaName: string;
    routineName: string;
    routineType: 'FUNCTION' | 'PROCEDURE';
    privilegeTypes: readonly string[];
    isGrantable: Grantability;
}>;

export type DatabaseRole = Readonly<{
    user: string;
    host: string;
    withAdminOption: boolean;
}>;

export type DefaultDatabaseRole = Readonly<{
    user: string;
    host: string;
}>;

export type ProxyPrivilege = Readonly<{
    proxiedUser: string;
    proxiedHost: string;
    withGrant: boolean;
}>;

export type InboundProxyPrivilege = Readonly<{
    user: string;
    host: string;
    withGrant: boolean;
}>;

export type OutgoingRoleEdge = Readonly<{
    granteeUser: string;
    granteeHost: string;
    withAdminOption: boolean;
}>;

export type RuntimeGrantSnapshot = Readonly<{
    databaseName: string | null;
    currentUser: string;
    serverUuid: string;
    serverVersion: string;
    versionComment: string;
    mandatoryRoles: string;
    activateAllRolesOnLogin: boolean;
    partialRevokes: boolean;
    maintenanceHasProcessPrivilege: boolean;
    exactAccountCount: number;
    accountNameCount: number;
    accountLocked: boolean;
    passwordExpired: boolean;
    hasPrivilegeRestrictions: boolean;
    staticGlobalPrivileges: readonly string[];
    availableColumns: readonly Readonly<{
        tableName: string;
        columnName: string;
    }>[];
    globalPrivileges: readonly GlobalPrivilege[];
    dynamicGlobalPrivileges: readonly GlobalPrivilege[];
    schemaPrivileges: readonly SchemaPrivilege[];
    tablePrivileges: readonly TablePrivilege[];
    columnPrivileges: readonly ColumnPrivilege[];
    routinePrivileges: readonly RoutinePrivilege[];
    assignedRoles: readonly DatabaseRole[];
    defaultRoles: readonly DefaultDatabaseRole[];
    proxyPrivileges: readonly ProxyPrivilege[];
    inboundProxyPrivileges: readonly InboundProxyPrivilege[];
    outgoingRoleEdges: readonly OutgoingRoleEdge[];
}>;

export type RuntimeGrantState =
    | 'blocked'
    | 'broad'
    | 'prepared'
    | 'repair'
    | 'reduced';

export type RuntimeRoleRemovalOperation = Readonly<{
    provider: string;
    target: string;
    runtimeAccount: string;
    approvedRole: string;
    resultingDatabaseRoles: readonly string[];
}>;

export type RuntimeGrantOperationPhases = Readonly<{
    ensureRequiredPrivileges: readonly string[];
    clearDefaultRoles: readonly string[];
    removeApprovedRole: RuntimeRoleRemovalOperation | null;
}>;

type RuntimeGrantPlanPayload = Readonly<{
    formatVersion: 3;
    database: string;
    runtimeAccount: string;
    approvedRole: string;
    state: RuntimeGrantState;
    server: Readonly<{
        uuid: string;
        version: string;
        versionComment: string;
        currentUser: string;
        activateAllRolesOnLogin: boolean;
        partialRevokes: boolean;
    }>;
    expectedColumnPrivileges: readonly ColumnPrivilege[];
    observed: RuntimeGrantSnapshot;
    blockers: readonly string[];
    compliant: boolean;
    operations: RuntimeGrantOperationPhases;
}>;

type RuntimeGrantDigestSnapshot = Readonly<
    Omit<RuntimeGrantSnapshot, 'passwordExpired'> & {
        credentialExpiryState: 'current' | 'expired';
    }
>;

export type RuntimeGrantPlan = RuntimeGrantPlanPayload & Readonly<{
    sha256: string;
}>;

export type RuntimeRoleRemovalContext = Readonly<{
    provider: string;
    target: string;
    runtimeAccount: RuntimeDatabaseAccount;
    approvedRole: RuntimeDatabaseAccount;
}>;

export type RuntimeRoleRemover = (
    context: RuntimeRoleRemovalContext
) => Promise<void>;

export class RuntimeGrantDriftError extends Error {
    readonly plan: RuntimeGrantPlan;

    constructor(plan: RuntimeGrantPlan) {
        super('Runtime database privileges do not exactly match the reviewed manifest');
        this.name = 'RuntimeGrantDriftError';
        this.plan = plan;
    }
}

export class RuntimeGrantIndeterminateError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'RuntimeGrantIndeterminateError';
    }
}

const SUPPORTED_SERVER_VERSION = /^8\.0\.31(?:[-.]|$)/u;
const SERVER_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const PRIVILEGE_NAME = /^[A-Z][A-Z0-9_ ]{0,63}$/u;

function compareRecords(left: object, right: object): number {
    const leftJson = JSON.stringify(left);
    const rightJson = JSON.stringify(right);
    if (leftJson < rightJson) return -1;
    if (leftJson > rightJson) return 1;
    return 0;
}

function sorted<T extends object>(values: readonly T[]): T[] {
    return [...values].sort(compareRecords);
}

function unique(values: readonly string[]): string[] {
    return [...new Set(values)].sort();
}

function sameRecords(left: readonly object[], right: readonly object[]): boolean {
    return JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
}

function normalizeGrantability(value: unknown): Grantability {
    if (value === 'YES' || value === 'NO') return value;
    throw new Error('Privilege metadata returned an unsupported grantability value');
}

function normalizeMysqlBoolean(value: unknown, label: string): boolean {
    if (value === true || value === 1 || value === '1' || value === 'Y') return true;
    if (value === false || value === 0 || value === '0' || value === 'N') return false;
    throw new Error(`${label} returned an unsupported boolean value`);
}

function rowsFromResult<T extends object>(rows: unknown, label: string): T[] {
    if (!Array.isArray(rows)) {
        throw new Error(`${label} returned an unsupported metadata result`);
    }
    return rows as T[];
}

async function queryRows<T extends object>(
    connection: RuntimeGrantConnection,
    sql: string,
    values: readonly unknown[],
    label: string
): Promise<T[]> {
    const [rows] = await connection.query(sql, values);
    return rowsFromResult<T>(rows, label);
}

function quoteIdentifier(value: string, label: string): string {
    if (value.length < 1 || value.length > 64 || value.includes('\u0000')) {
        throw new Error(`${label} contains an unsupported MySQL identifier`);
    }
    return `\`${value.replace(/`/gu, '``')}\``;
}

function quoteAccountPart(value: string, label: string): string {
    if (value.length < 1 || value.length > 255 || /[\u0000\r\n]/u.test(value)) {
        throw new Error(`${label} contains an unsupported MySQL account part`);
    }
    return `'${value.replace(/'/gu, "''")}'`;
}

function renderDatabaseAccount(account: { user: string; host: string }): string {
    return `${quoteAccountPart(account.user, 'Role user')}@${
        quoteAccountPart(account.host, 'Role host')
    }`;
}

function renderPrivilegeName(value: string): string {
    const normalized = value.toUpperCase();
    if (!PRIVILEGE_NAME.test(normalized)) {
        throw new Error('Privilege metadata contains an unsupported privilege name');
    }
    return normalized;
}

function expectedColumnPrivileges(database: string): ColumnPrivilege[] {
    return sorted(runtimeColumnPrivilegeInventory().map((privilege) => ({
        schemaName: database,
        tableName: privilege.tableName,
        columnName: privilege.columnName,
        privilegeType: privilege.privilegeType,
        isGrantable: 'NO' as const,
    })));
}

function columnPrivilegeKey(
    privilege: Pick<ColumnPrivilege, 'schemaName' | 'tableName' | 'columnName' | 'privilegeType'>
): string {
    return [
        privilege.schemaName,
        privilege.tableName,
        privilege.columnName,
        privilege.privilegeType,
    ].join('\u0000');
}

function parseRoutinePrivileges(row: {
    schemaName: string;
    routineName: string;
    routineType: string;
    privilegeSet: string;
}): RoutinePrivilege {
    if (row.routineType !== 'FUNCTION' && row.routineType !== 'PROCEDURE') {
        throw new Error('Routine privilege metadata returned an unsupported routine type');
    }
    const tokens = String(row.privilegeSet)
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
    return {
        schemaName: row.schemaName,
        routineName: row.routineName,
        routineType: row.routineType,
        privilegeTypes: unique(tokens
            .filter((value) => value.toUpperCase() !== 'GRANT')
            .map(renderPrivilegeName)),
        isGrantable: tokens.some((value) => value.toUpperCase() === 'GRANT')
            ? 'YES'
            : 'NO',
    };
}

async function inspectStaticGlobalPrivileges(
    connection: RuntimeGrantConnection,
    account: RuntimeDatabaseAccount
): Promise<string[]> {
    const privilegeColumns = await queryRows<{ columnName: string }>(connection, `
        SELECT COLUMN_NAME AS columnName
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = 'mysql'
          AND TABLE_NAME = 'user'
          AND RIGHT(COLUMN_NAME, 5) = '_priv'
        ORDER BY ORDINAL_POSITION
        /* runtime-grants:static-global-columns */
    `, [], 'Static global privilege-column inspection');
    if (privilegeColumns.length === 0) {
        throw new Error('Static global privilege metadata returned no columns');
    }
    const columnNames = privilegeColumns.map(({ columnName }) => columnName);
    const [row] = await queryRows<Record<string, unknown>>(connection, `
        SELECT ${columnNames.map((name) => quoteIdentifier(
            name,
            'mysql.user privilege column'
        )).join(', ')}
        FROM mysql.user
        WHERE User = ? AND Host = ?
        /* runtime-grants:static-global-values */
    `, [account.user, account.host], 'Static global privilege inspection');
    if (!row) return [];
    return unique(columnNames.flatMap((columnName) => {
        const enabled = normalizeMysqlBoolean(
            row[columnName],
            `mysql.user.${columnName}`
        );
        return enabled
            ? [renderPrivilegeName(columnName.replace(/_priv$/u, '').replace(/_/gu, ' '))]
            : [];
    }));
}

async function inspectMaintenanceProcessPrivilege(
    connection: RuntimeGrantConnection
): Promise<boolean> {
    try {
        const [row] = await queryRows<{ processPrivilegeProof: number | string }>(
            connection,
            `SELECT COUNT(*) AS processPrivilegeProof
             FROM information_schema.INNODB_BUFFER_POOL_STATS
             /* runtime-grants:maintenance-process-privilege */`,
            [],
            'Maintenance PROCESS privilege inspection'
        );
        if (!row || !Number.isFinite(Number(row.processPrivilegeProof))) {
            throw new Error('PROCESS capability probe returned no count');
        }
        return true;
    } catch {
        throw new Error(
            'Maintenance account cannot prove effective PROCESS privilege'
        );
    }
}

export async function inspectRuntimeGrantState(
    connection: RuntimeGrantConnection,
    database: string,
    account: RuntimeDatabaseAccount
): Promise<RuntimeGrantSnapshot> {
    const grantee = renderRuntimeDatabaseAccount(account);
    const [identity] = await queryRows<{
        databaseName: string | null;
        currentUser: string;
        serverUuid: string;
        serverVersion: string;
        versionComment: string;
        mandatoryRoles: string | null;
        activateAllRolesOnLogin: unknown;
        partialRevokes: unknown;
    }>(connection, `
        SELECT
            DATABASE() AS databaseName,
            CURRENT_USER() AS currentUser,
            @@GLOBAL.server_uuid AS serverUuid,
            @@version AS serverVersion,
            @@version_comment AS versionComment,
            @@GLOBAL.mandatory_roles AS mandatoryRoles,
            @@GLOBAL.activate_all_roles_on_login AS activateAllRolesOnLogin,
            @@GLOBAL.partial_revokes AS partialRevokes
        /* runtime-grants:identity */
    `, [], 'Runtime grant identity inspection');
    if (!identity) throw new Error('Runtime grant identity inspection returned no row');

    const [accountRow] = await queryRows<{
        exactAccountCount: number | string;
        accountNameCount: number | string;
        accountLocked: unknown;
        passwordExpired: unknown;
        hasPrivilegeRestrictions: unknown;
    }>(connection, `
        SELECT
            SUM(CASE WHEN Host = ? THEN 1 ELSE 0 END) AS exactAccountCount,
            COUNT(*) AS accountNameCount,
            COALESCE(MAX(CASE WHEN Host = ? THEN account_locked END), 'N') AS accountLocked,
            COALESCE(MAX(CASE WHEN Host = ? THEN password_expired END), 'N') AS passwordExpired,
            COALESCE(MAX(CASE WHEN Host = ? THEN
                JSON_CONTAINS_PATH(User_attributes, 'one', '$.Restrictions')
            END), 0) AS hasPrivilegeRestrictions
        FROM mysql.user
        WHERE User = ?
        /* runtime-grants:account */
    `, [
        account.host,
        account.host,
        account.host,
        account.host,
        account.user,
    ], 'Runtime account inspection');
    if (!accountRow) throw new Error('Runtime account inspection returned no row');

    const availableColumns = await queryRows<{ tableName: string; columnName: string }>(
        connection,
        `SELECT TABLE_NAME AS tableName, COLUMN_NAME AS columnName
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = ?
           AND TABLE_NAME IN ('users', 'game_runs', 'game_personal_bests')
         /* runtime-grants:columns */`,
        [database],
        'Runtime table-column inspection'
    );
    const globalRows = await queryRows<{ privilegeType: string; isGrantable: unknown }>(
        connection,
        `SELECT PRIVILEGE_TYPE AS privilegeType, IS_GRANTABLE AS isGrantable
         FROM information_schema.USER_PRIVILEGES
         WHERE GRANTEE = ?
         /* runtime-grants:global */`,
        [grantee],
        'Global privilege inspection'
    );
    const dynamicGlobalRows = await queryRows<{
        privilegeType: string;
        isGrantable: unknown;
    }>(connection, `
        SELECT PRIV AS privilegeType,
               CASE WITH_GRANT_OPTION WHEN 'Y' THEN 'YES' ELSE 'NO' END AS isGrantable
        FROM mysql.global_grants
        WHERE USER = ? AND HOST = ?
        /* runtime-grants:dynamic-global */
    `, [account.user, account.host], 'Dynamic global privilege inspection');
    const schemaRows = await queryRows<{
        schemaName: string;
        privilegeType: string;
        isGrantable: unknown;
    }>(connection, `
        SELECT TABLE_SCHEMA AS schemaName,
               PRIVILEGE_TYPE AS privilegeType,
               IS_GRANTABLE AS isGrantable
        FROM information_schema.SCHEMA_PRIVILEGES
        WHERE GRANTEE = ?
        /* runtime-grants:schema */
    `, [grantee], 'Schema privilege inspection');
    const tableRows = await queryRows<{
        schemaName: string;
        tableName: string;
        privilegeType: string;
        isGrantable: unknown;
    }>(connection, `
        SELECT TABLE_SCHEMA AS schemaName,
               TABLE_NAME AS tableName,
               PRIVILEGE_TYPE AS privilegeType,
               IS_GRANTABLE AS isGrantable
        FROM information_schema.TABLE_PRIVILEGES
        WHERE GRANTEE = ?
        /* runtime-grants:table */
    `, [grantee], 'Table privilege inspection');
    const columnRows = await queryRows<{
        schemaName: string;
        tableName: string;
        columnName: string;
        privilegeType: string;
        isGrantable: unknown;
    }>(connection, `
        SELECT TABLE_SCHEMA AS schemaName,
               TABLE_NAME AS tableName,
               COLUMN_NAME AS columnName,
               PRIVILEGE_TYPE AS privilegeType,
               IS_GRANTABLE AS isGrantable
        FROM information_schema.COLUMN_PRIVILEGES
        WHERE GRANTEE = ?
        /* runtime-grants:column */
    `, [grantee], 'Column privilege inspection');
    const routineRows = await queryRows<{
        schemaName: string;
        routineName: string;
        routineType: string;
        privilegeSet: string;
    }>(connection, `
        SELECT Db AS schemaName,
               Routine_name AS routineName,
               Routine_type AS routineType,
               Proc_priv AS privilegeSet
        FROM mysql.procs_priv
        WHERE User = ? AND Host = ?
        /* runtime-grants:routine */
    `, [account.user, account.host], 'Routine privilege inspection');
    const assignedRoleRows = await queryRows<{
        user: string;
        host: string;
        withAdminOption: unknown;
    }>(connection, `
        SELECT FROM_USER AS user,
               FROM_HOST AS host,
               WITH_ADMIN_OPTION AS withAdminOption
        FROM mysql.role_edges
        WHERE TO_USER = ? AND TO_HOST = ?
        /* runtime-grants:assigned-roles */
    `, [account.user, account.host], 'Assigned-role inspection');
    const defaultRoleRows = await queryRows<{ user: string; host: string }>(connection, `
        SELECT DEFAULT_ROLE_USER AS user, DEFAULT_ROLE_HOST AS host
        FROM mysql.default_roles
        WHERE USER = ? AND HOST = ?
        /* runtime-grants:default-roles */
    `, [account.user, account.host], 'Default-role inspection');
    const proxyRows = await queryRows<{
        proxiedUser: string;
        proxiedHost: string;
        withGrant: unknown;
    }>(connection, `
        SELECT Proxied_user AS proxiedUser,
               Proxied_host AS proxiedHost,
               With_grant AS withGrant
        FROM mysql.proxies_priv
        WHERE User = ? AND Host = ?
        /* runtime-grants:proxy */
    `, [account.user, account.host], 'Proxy privilege inspection');
    const inboundProxyRows = await queryRows<{
        user: string;
        host: string;
        withGrant: unknown;
    }>(connection, `
        SELECT User AS user, Host AS host, With_grant AS withGrant
        FROM mysql.proxies_priv
        WHERE Proxied_user = ? AND Proxied_host = ?
        /* runtime-grants:inbound-proxy */
    `, [account.user, account.host], 'Inbound proxy privilege inspection');
    const outgoingRoleRows = await queryRows<{
        granteeUser: string;
        granteeHost: string;
        withAdminOption: unknown;
    }>(connection, `
        SELECT TO_USER AS granteeUser,
               TO_HOST AS granteeHost,
               WITH_ADMIN_OPTION AS withAdminOption
        FROM mysql.role_edges
        WHERE FROM_USER = ? AND FROM_HOST = ?
        /* runtime-grants:outgoing-roles */
    `, [account.user, account.host], 'Outgoing-role inspection');

    return {
        databaseName: identity.databaseName,
        currentUser: String(identity.currentUser),
        serverUuid: String(identity.serverUuid).toLowerCase(),
        serverVersion: String(identity.serverVersion),
        versionComment: String(identity.versionComment),
        mandatoryRoles: String(identity.mandatoryRoles ?? ''),
        activateAllRolesOnLogin: normalizeMysqlBoolean(
            identity.activateAllRolesOnLogin,
            'activate_all_roles_on_login'
        ),
        partialRevokes: normalizeMysqlBoolean(identity.partialRevokes, 'partial_revokes'),
        maintenanceHasProcessPrivilege: await inspectMaintenanceProcessPrivilege(
            connection
        ),
        exactAccountCount: Number(accountRow.exactAccountCount),
        accountNameCount: Number(accountRow.accountNameCount),
        accountLocked: normalizeMysqlBoolean(accountRow.accountLocked, 'account_locked'),
        passwordExpired: normalizeMysqlBoolean(accountRow.passwordExpired, 'password_expired'),
        hasPrivilegeRestrictions: normalizeMysqlBoolean(
            accountRow.hasPrivilegeRestrictions,
            'User_attributes Restrictions'
        ),
        staticGlobalPrivileges: await inspectStaticGlobalPrivileges(connection, account),
        availableColumns: sorted(availableColumns.map((row) => ({ ...row }))),
        globalPrivileges: sorted(globalRows.map((row) => ({
            privilegeType: String(row.privilegeType).toUpperCase(),
            isGrantable: normalizeGrantability(row.isGrantable),
        }))),
        dynamicGlobalPrivileges: sorted(dynamicGlobalRows.map((row) => ({
            privilegeType: String(row.privilegeType).toUpperCase(),
            isGrantable: normalizeGrantability(row.isGrantable),
        }))),
        schemaPrivileges: sorted(schemaRows.map((row) => ({
            schemaName: row.schemaName,
            privilegeType: String(row.privilegeType).toUpperCase(),
            isGrantable: normalizeGrantability(row.isGrantable),
        }))),
        tablePrivileges: sorted(tableRows.map((row) => ({
            schemaName: row.schemaName,
            tableName: row.tableName,
            privilegeType: String(row.privilegeType).toUpperCase(),
            isGrantable: normalizeGrantability(row.isGrantable),
        }))),
        columnPrivileges: sorted(columnRows.map((row) => ({
            schemaName: row.schemaName,
            tableName: row.tableName,
            columnName: row.columnName,
            privilegeType: String(row.privilegeType).toUpperCase(),
            isGrantable: normalizeGrantability(row.isGrantable),
        }))),
        routinePrivileges: sorted(routineRows.map(parseRoutinePrivileges)),
        assignedRoles: sorted(assignedRoleRows.map((row) => ({
            user: row.user,
            host: row.host,
            withAdminOption: normalizeMysqlBoolean(row.withAdminOption, 'Role admin option'),
        }))),
        defaultRoles: sorted(defaultRoleRows.map((row) => ({ ...row }))),
        proxyPrivileges: sorted(proxyRows.map((row) => ({
            proxiedUser: row.proxiedUser,
            proxiedHost: row.proxiedHost,
            withGrant: normalizeMysqlBoolean(row.withGrant, 'Proxy grant option'),
        }))),
        inboundProxyPrivileges: sorted(inboundProxyRows.map((row) => ({
            user: row.user,
            host: row.host,
            withGrant: normalizeMysqlBoolean(row.withGrant, 'Inbound proxy grant option'),
        }))),
        outgoingRoleEdges: sorted(outgoingRoleRows.map((row) => ({
            granteeUser: row.granteeUser,
            granteeHost: row.granteeHost,
            withAdminOption: normalizeMysqlBoolean(
                row.withAdminOption,
                'Outgoing role admin option'
            ),
        }))),
    };
}

function missingExpectedColumns(
    snapshot: RuntimeGrantSnapshot,
    expected: readonly ColumnPrivilege[]
): string[] {
    const available = new Set(snapshot.availableColumns.map(({ tableName, columnName }) =>
        `${tableName}\u0000${columnName}`));
    return unique(expected
        .filter(({ tableName, columnName }) =>
            !available.has(`${tableName}\u0000${columnName}`))
        .map(({ tableName, columnName }) => `${tableName}.${columnName}`));
}

function roleMatches(
    role: Pick<DatabaseRole, 'user' | 'host'>,
    approvedRole: RuntimeDatabaseAccount
): boolean {
    return role.user === approvedRole.user && role.host === approvedRole.host;
}

function unexpectedColumnPrivileges(
    snapshot: RuntimeGrantSnapshot,
    expected: readonly ColumnPrivilege[]
): ColumnPrivilege[] {
    const expectedKeys = new Set(expected.map(columnPrivilegeKey));
    return snapshot.columnPrivileges.filter((privilege) =>
        privilege.isGrantable === 'YES'
        || !expectedKeys.has(columnPrivilegeKey(privilege)));
}

function validateObservedSqlValues(snapshot: RuntimeGrantSnapshot): void {
    for (const privilege of [
        ...snapshot.globalPrivileges,
        ...snapshot.dynamicGlobalPrivileges,
        ...snapshot.schemaPrivileges,
        ...snapshot.tablePrivileges,
        ...snapshot.columnPrivileges,
    ]) renderPrivilegeName(privilege.privilegeType);
    for (const privilege of snapshot.staticGlobalPrivileges) renderPrivilegeName(privilege);
    for (const privilege of snapshot.schemaPrivileges) {
        quoteIdentifier(privilege.schemaName, 'Schema name');
    }
    for (const privilege of [...snapshot.tablePrivileges, ...snapshot.columnPrivileges]) {
        quoteIdentifier(privilege.schemaName, 'Schema name');
        quoteIdentifier(privilege.tableName, 'Table name');
    }
    for (const privilege of snapshot.columnPrivileges) {
        quoteIdentifier(privilege.columnName, 'Column name');
    }
    for (const routine of snapshot.routinePrivileges) {
        quoteIdentifier(routine.schemaName, 'Routine schema');
        quoteIdentifier(routine.routineName, 'Routine name');
        for (const privilege of routine.privilegeTypes) renderPrivilegeName(privilege);
    }
    for (const role of snapshot.assignedRoles) renderDatabaseAccount(role);
    for (const role of snapshot.defaultRoles) renderDatabaseAccount(role);
    for (const proxy of snapshot.proxyPrivileges) {
        renderDatabaseAccount({ user: proxy.proxiedUser, host: proxy.proxiedHost });
    }
    for (const proxy of snapshot.inboundProxyPrivileges) renderDatabaseAccount(proxy);
}

function blockersFor(
    snapshot: RuntimeGrantSnapshot,
    settings: RuntimeGrantSettings,
    account: RuntimeDatabaseAccount,
    expected: readonly ColumnPrivilege[]
): string[] {
    const blockers: string[] = [];
    if (snapshot.databaseName !== settings.database) {
        blockers.push('connected database mismatch');
    }
    if (!SUPPORTED_SERVER_VERSION.test(snapshot.serverVersion)) {
        blockers.push('server version is not the reviewed MySQL 8.0.31 release');
    }
    if (!SERVER_UUID.test(snapshot.serverUuid)) blockers.push('server UUID is unavailable');
    if (snapshot.serverUuid !== settings.expectedServerUuid) {
        blockers.push('connected server UUID is not the independently pinned target');
    }
    if (
        snapshot.currentUser
            !== runtimeDatabaseAccountName(settings.maintenanceAccount)
    ) blockers.push('connected maintenance account mismatch');
    if (!snapshot.maintenanceHasProcessPrivilege) {
        blockers.push('maintenance account lacks effective PROCESS visibility');
    }
    if (snapshot.currentUser === runtimeDatabaseAccountName(account)) {
        blockers.push('maintenance and runtime accounts must be different');
    }
    if (snapshot.exactAccountCount !== 1 || snapshot.accountNameCount !== 1) {
        blockers.push('runtime account does not exist exactly once across all hosts');
    }
    if (snapshot.accountLocked) blockers.push('runtime account is locked');
    if (snapshot.passwordExpired) blockers.push('runtime account password is expired');
    if (snapshot.hasPrivilegeRestrictions) {
        blockers.push('runtime account has unreviewed partial-revoke restrictions');
    }
    const missingColumns = missingExpectedColumns(snapshot, expected);
    if (missingColumns.length > 0) {
        blockers.push(`required runtime columns are missing: ${missingColumns.join(', ')}`);
    }
    if (snapshot.mandatoryRoles.trim() !== '') {
        blockers.push('mandatory_roles is not empty and cannot be removed per account');
    }
    if (snapshot.activateAllRolesOnLogin) {
        blockers.push('activate_all_roles_on_login is enabled');
    }
    if (snapshot.outgoingRoleEdges.length > 0) {
        blockers.push('runtime account is used as a role by another account');
    }
    if (snapshot.proxyPrivileges.length > 0) {
        blockers.push('runtime account has an unexpected proxy privilege');
    }
    if (snapshot.inboundProxyPrivileges.length > 0) {
        blockers.push('another account can proxy as the runtime account');
    }
    if (!sameRecords(snapshot.globalPrivileges, [{
        privilegeType: 'USAGE',
        isGrantable: 'NO',
    }])) blockers.push('runtime account has unexpected direct global privileges');
    if (snapshot.staticGlobalPrivileges.length > 0) {
        blockers.push('runtime account has unexpected static global privileges');
    }
    if (snapshot.dynamicGlobalPrivileges.length > 0) {
        blockers.push('runtime account has unexpected dynamic global privileges');
    }
    if (snapshot.schemaPrivileges.length > 0) {
        blockers.push('runtime account has unexpected schema privileges');
    }
    if (snapshot.tablePrivileges.length > 0) {
        blockers.push('runtime account has unexpected table privileges');
    }
    if (snapshot.routinePrivileges.length > 0) {
        blockers.push('runtime account has unexpected routine privileges');
    }
    if (
        unexpectedColumnPrivileges(
            snapshot,
            expected
        ).length > 0
    ) {
        blockers.push('runtime account has unexpected or grantable column privileges');
    }
    if (
        snapshot.assignedRoles.length > 1
        || snapshot.assignedRoles.some((role) =>
            !roleMatches(role, settings.approvedRole) || role.withAdminOption)
    ) blockers.push('runtime account has an unexpected role assignment');
    if (
        snapshot.defaultRoles.length > 1
        || snapshot.defaultRoles.some((role) => !roleMatches(role, settings.approvedRole))
        || (snapshot.defaultRoles.length > 0 && snapshot.assignedRoles.length === 0)
    ) blockers.push('runtime account has an unexpected default role');
    try {
        validateObservedSqlValues(snapshot);
    } catch (error) {
        blockers.push(error instanceof Error ? error.message : 'unsupported privilege metadata');
    }
    return unique(blockers);
}

function hasRequiredPrivilegeSubset(
    snapshot: RuntimeGrantSnapshot,
    expected: readonly ColumnPrivilege[]
): boolean {
    const observed = new Set(snapshot.columnPrivileges
        .filter(({ isGrantable }) => isGrantable === 'NO')
        .map(columnPrivilegeKey));
    return expected.every((privilege) => observed.has(columnPrivilegeKey(privilege)));
}

function hasExactDirectPrivileges(
    snapshot: RuntimeGrantSnapshot,
    expected: readonly ColumnPrivilege[]
): boolean {
    return sameRecords(snapshot.globalPrivileges, [{
        privilegeType: 'USAGE',
        isGrantable: 'NO',
    }])
        && snapshot.staticGlobalPrivileges.length === 0
        && snapshot.dynamicGlobalPrivileges.length === 0
        && snapshot.schemaPrivileges.length === 0
        && snapshot.tablePrivileges.length === 0
        && sameRecords(snapshot.columnPrivileges, expected)
        && snapshot.routinePrivileges.length === 0
        && snapshot.proxyPrivileges.length === 0
        && snapshot.inboundProxyPrivileges.length === 0;
}

function classifyState(
    snapshot: RuntimeGrantSnapshot,
    expected: readonly ColumnPrivilege[],
    blockers: readonly string[]
): RuntimeGrantState {
    if (blockers.length > 0) return 'blocked';
    const hasRole = snapshot.assignedRoles.length === 1;
    const exactDirect = hasExactDirectPrivileges(snapshot, expected);
    if (exactDirect && !hasRole && snapshot.defaultRoles.length === 0) return 'reduced';
    if (exactDirect && hasRole) return 'prepared';
    return hasRole ? 'broad' : 'repair';
}

function buildOperationPhases(
    state: RuntimeGrantState,
    snapshot: RuntimeGrantSnapshot,
    database: string,
    account: RuntimeDatabaseAccount,
    settings: RuntimeGrantSettings,
    expected: readonly ColumnPrivilege[]
): RuntimeGrantOperationPhases {
    const empty = Object.freeze([]) as readonly string[];
    if (state === 'blocked' || state === 'reduced') {
        return {
            ensureRequiredPrivileges: empty,
            clearDefaultRoles: empty,
            removeApprovedRole: null,
        };
    }
    const target = renderRuntimeDatabaseAccount(account);
    return {
        ensureRequiredPrivileges: hasRequiredPrivilegeSubset(snapshot, expected)
            ? empty
            : renderRuntimeGrantStatements(database, account)
                .map((statement) => statement.replace(/;$/u, '')),
        clearDefaultRoles: snapshot.defaultRoles.length > 0
            ? [`SET DEFAULT ROLE NONE TO ${target}`]
            : empty,
        removeApprovedRole: snapshot.assignedRoles.length === 1
            ? {
                provider: settings.roleRemovalProvider,
                target: settings.roleRemovalTarget,
                runtimeAccount: runtimeDatabaseAccountName(account),
                approvedRole: runtimeDatabaseAccountName(settings.approvedRole),
                resultingDatabaseRoles: empty,
            }
            : null,
    };
}

function runtimeGrantDigestSnapshot(
    snapshot: RuntimeGrantSnapshot
): RuntimeGrantDigestSnapshot {
    const credentialExpired = snapshot.passwordExpired;
    if (credentialExpired !== true && credentialExpired !== false) {
        throw new Error('Runtime account credential-expiry metadata is invalid');
    }
    // This plan contains only inspection metadata. Select a fixed marker for
    // MySQL's misleadingly named `password_expired` boolean so it cannot flow
    // into the integrity hash as though it were credential material.
    return {
        databaseName: snapshot.databaseName,
        currentUser: snapshot.currentUser,
        serverUuid: snapshot.serverUuid,
        serverVersion: snapshot.serverVersion,
        versionComment: snapshot.versionComment,
        mandatoryRoles: snapshot.mandatoryRoles,
        activateAllRolesOnLogin: snapshot.activateAllRolesOnLogin,
        partialRevokes: snapshot.partialRevokes,
        maintenanceHasProcessPrivilege: snapshot.maintenanceHasProcessPrivilege,
        exactAccountCount: snapshot.exactAccountCount,
        accountNameCount: snapshot.accountNameCount,
        accountLocked: snapshot.accountLocked,
        credentialExpiryState: credentialExpired ? 'expired' : 'current',
        hasPrivilegeRestrictions: snapshot.hasPrivilegeRestrictions,
        staticGlobalPrivileges: snapshot.staticGlobalPrivileges,
        availableColumns: snapshot.availableColumns,
        globalPrivileges: snapshot.globalPrivileges,
        dynamicGlobalPrivileges: snapshot.dynamicGlobalPrivileges,
        schemaPrivileges: snapshot.schemaPrivileges,
        tablePrivileges: snapshot.tablePrivileges,
        columnPrivileges: snapshot.columnPrivileges,
        routinePrivileges: snapshot.routinePrivileges,
        assignedRoles: snapshot.assignedRoles,
        defaultRoles: snapshot.defaultRoles,
        proxyPrivileges: snapshot.proxyPrivileges,
        inboundProxyPrivileges: snapshot.inboundProxyPrivileges,
        outgoingRoleEdges: snapshot.outgoingRoleEdges,
    };
}

export function createRuntimeGrantPlan(
    snapshot: RuntimeGrantSnapshot,
    settings: RuntimeGrantSettings,
    account: RuntimeDatabaseAccount
): RuntimeGrantPlan {
    const expected = expectedColumnPrivileges(settings.database);
    const blockers = blockersFor(
        snapshot,
        settings,
        account,
        expected
    );
    const state = classifyState(snapshot, expected, blockers);
    const payload: RuntimeGrantPlanPayload = {
        formatVersion: 3,
        database: settings.database,
        runtimeAccount: runtimeDatabaseAccountName(account),
        approvedRole: runtimeDatabaseAccountName(settings.approvedRole),
        state,
        server: {
            uuid: snapshot.serverUuid,
            version: snapshot.serverVersion,
            versionComment: snapshot.versionComment,
            currentUser: snapshot.currentUser,
            activateAllRolesOnLogin: snapshot.activateAllRolesOnLogin,
            partialRevokes: snapshot.partialRevokes,
        },
        expectedColumnPrivileges: expected,
        observed: snapshot,
        blockers,
        compliant: state === 'reduced',
        operations: buildOperationPhases(
            state,
            snapshot,
            settings.database,
            account,
            settings,
            expected
        ),
    };
    const digestPayload = {
        formatVersion: payload.formatVersion,
        database: payload.database,
        runtimeAccount: payload.runtimeAccount,
        approvedRole: payload.approvedRole,
        state: payload.state,
        server: payload.server,
        expectedColumnPrivileges: payload.expectedColumnPrivileges,
        observed: runtimeGrantDigestSnapshot(payload.observed),
        blockers: payload.blockers,
        compliant: payload.compliant,
        operations: payload.operations,
    };
    const sha256 = createHash('sha256')
        .update(JSON.stringify(digestPayload), 'utf8')
        .digest('hex');
    return { ...payload, sha256 };
}

function assertRoleStateStable(
    initial: RuntimeGrantSnapshot,
    current: RuntimeGrantSnapshot
): void {
    if (
        !sameRecords(initial.assignedRoles, current.assignedRoles)
        || !sameRecords(initial.defaultRoles, current.defaultRoles)
    ) throw new Error('Runtime role state changed after the approved plan was computed');
}

async function executeStatements(
    connection: RuntimeGrantConnection,
    statements: readonly string[]
): Promise<void> {
    for (const statement of statements) await connection.query(statement);
}

export async function assertRuntimeSessionsDrained(
    connection: RuntimeGrantConnection,
    account: RuntimeDatabaseAccount
): Promise<void> {
    let row: { sessionCount: number | string; processPrivilegeProof: number | string }
        | undefined;
    try {
        [row] = await queryRows<{
            sessionCount: number | string;
            processPrivilegeProof: number | string;
        }>(connection, `
            SELECT
                (SELECT COUNT(*)
                 FROM information_schema.PROCESSLIST
                 WHERE USER = ?) AS sessionCount,
                (SELECT COUNT(*)
                 FROM information_schema.INNODB_BUFFER_POOL_STATS) AS processPrivilegeProof
            /* runtime-grants:active-sessions */
        `, [account.user], 'Runtime session inspection');
    } catch {
        throw new Error(
            'Maintenance account cannot prove effective PROCESS privilege; '
            + 'refusing to trust runtime session inspection'
        );
    }
    if (!row || !Number.isFinite(Number(row.processPrivilegeProof))) {
        throw new Error('Runtime session PROCESS capability probe returned no count');
    }
    if (Number(row.sessionCount) !== 0) {
        throw new Error(
            'Runtime database sessions are still open; drain application traffic before changing runtime privileges'
        );
    }
}

export function runtimeGrantLockName(
    database: string,
    account: RuntimeDatabaseAccount
): string {
    const digest = createHash('sha256')
        .update(`${database}\u0000${runtimeDatabaseAccountName(account)}`, 'utf8')
        .digest('hex')
        .slice(0, 24);
    return `mickeyf:runtime-grants:${digest}`;
}

async function withRuntimeGrantLock<T>(
    connection: RuntimeGrantConnection,
    settings: RuntimeGrantSettings,
    account: RuntimeDatabaseAccount,
    operation: () => Promise<T>
): Promise<T> {
    // Make every assigned maintenance role active before proving effective
    // PROCESS visibility. This changes only the current maintenance session.
    await connection.query('SET ROLE ALL');
    await connection.query('SET SESSION lock_wait_timeout = ?', [
        settings.lockWaitTimeoutSeconds,
    ]);
    await connection.query('SET SESSION autocommit = 1');
    const lockName = runtimeGrantLockName(settings.database, account);
    const [lockResult] = await connection.query(
        'SELECT GET_LOCK(?, ?) AS acquired',
        [lockName, settings.advisoryLockTimeoutSeconds]
    );
    const [lockRow] = rowsFromResult<{ acquired: unknown }>(
        lockResult,
        'Runtime grant advisory lock'
    );
    if (Number(lockRow?.acquired) !== 1) {
        throw new Error('Could not acquire the runtime grant advisory lock');
    }

    let operationError: unknown;
    try {
        return await operation();
    } catch (error) {
        operationError = error;
        throw error;
    } finally {
        try {
            const [releaseResult] = await connection.query(
                'SELECT RELEASE_LOCK(?) AS released',
                [lockName]
            );
            const [releaseRow] = rowsFromResult<{ released: unknown }>(
                releaseResult,
                'Runtime grant advisory lock release'
            );
            if (Number(releaseRow?.released) !== 1) {
                throw new Error('Runtime grant advisory lock was not released');
            }
        } catch (releaseError) {
            connection.destroy();
            if (operationError === undefined) throw releaseError;
        }
    }
}

export async function planRuntimeGrants(
    connection: RuntimeGrantConnection,
    settings: RuntimeGrantSettings,
    account: RuntimeDatabaseAccount
): Promise<RuntimeGrantPlan> {
    return withRuntimeGrantLock(connection, settings, account, async () =>
        createRuntimeGrantPlan(
            await inspectRuntimeGrantState(
                connection,
                settings.database,
                account
            ),
            settings,
            account
        ));
}

export async function verifyRuntimeGrants(
    connection: RuntimeGrantConnection,
    settings: RuntimeGrantSettings,
    account: RuntimeDatabaseAccount
): Promise<RuntimeGrantPlan> {
    const plan = await planRuntimeGrants(connection, settings, account);
    if (!plan.compliant) throw new RuntimeGrantDriftError(plan);
    return plan;
}

export async function applyRuntimeGrants(
    connection: RuntimeGrantConnection,
    settings: RuntimeGrantSettings,
    account: RuntimeDatabaseAccount,
    approvedPlanSha256: string,
    confirmedServerUuid: string,
    roleRemover?: RuntimeRoleRemover
): Promise<RuntimeGrantPlan> {
    return withRuntimeGrantLock(connection, settings, account, async () => {
        const initialSnapshot = await inspectRuntimeGrantState(
            connection,
            settings.database,
            account
        );
        const approvedPlan = createRuntimeGrantPlan(initialSnapshot, settings, account);
        if (approvedPlan.server.uuid !== confirmedServerUuid) {
            throw new Error('Connected server UUID does not match the approved runtime grant target');
        }
        if (approvedPlan.sha256 !== approvedPlanSha256) {
            throw new Error('Runtime grant state changed after the approved plan was generated');
        }
        if (approvedPlan.blockers.length > 0) {
            throw new Error(`Runtime grant apply is blocked: ${approvedPlan.blockers.join('; ')}`);
        }
        await assertRuntimeSessionsDrained(connection, account);
        if (approvedPlan.compliant) {
            return approvedPlan;
        }
        if (approvedPlan.operations.removeApprovedRole && !roleRemover) {
            throw new Error('The approved runtime role requires its reviewed removal provider');
        }

        await executeStatements(connection, approvedPlan.operations.ensureRequiredPrivileges);
        const preparedSnapshot = await inspectRuntimeGrantState(
            connection,
            settings.database,
            account
        );
        const preparedBlockers = blockersFor(
            preparedSnapshot,
            settings,
            account,
            approvedPlan.expectedColumnPrivileges
        );
        if (
            preparedBlockers.length > 0
            || !hasExactDirectPrivileges(
                preparedSnapshot,
                approvedPlan.expectedColumnPrivileges
            )
        ) {
            throw new Error('Exact direct runtime grants could not be proved before role removal');
        }
        assertRoleStateStable(initialSnapshot, preparedSnapshot);

        await executeStatements(connection, approvedPlan.operations.clearDefaultRoles);
        const defaultClearedSnapshot = await inspectRuntimeGrantState(
            connection,
            settings.database,
            account
        );
        const defaultClearedBlockers = blockersFor(
            defaultClearedSnapshot,
            settings,
            account,
            approvedPlan.expectedColumnPrivileges
        );
        if (
            defaultClearedBlockers.length > 0
            || !sameRecords(
                initialSnapshot.assignedRoles,
                defaultClearedSnapshot.assignedRoles
            )
            || defaultClearedSnapshot.defaultRoles.length > 0
            || !hasExactDirectPrivileges(
                defaultClearedSnapshot,
                approvedPlan.expectedColumnPrivileges
            )
        ) throw new Error('Runtime role preparation did not reach the reviewed state');

        let roleRemovalError: unknown;
        let roleRemovalInvoked = false;
        if (approvedPlan.operations.removeApprovedRole) {
            await assertRuntimeSessionsDrained(connection, account);
            try {
                roleRemovalInvoked = true;
                await roleRemover?.({
                    provider: settings.roleRemovalProvider,
                    target: settings.roleRemovalTarget,
                    runtimeAccount: account,
                    approvedRole: settings.approvedRole,
                });
            } catch (error) {
                roleRemovalError = error;
            }
        }

        let finalPlan: RuntimeGrantPlan;
        try {
            finalPlan = createRuntimeGrantPlan(
                await inspectRuntimeGrantState(
                    connection,
                    settings.database,
                    account
                ),
                settings,
                account
            );
        } catch (error) {
            if (!roleRemovalInvoked) throw error;
            const detail = error instanceof Error
                ? error.message
                : 'unknown final verification failure';
            throw new RuntimeGrantIndeterminateError(
                'Cloud SQL role removal was invoked, but final database '
                + `verification failed: ${detail}. The role change may have `
                + 'completed; inspect Cloud SQL operations, then run a fresh '
                + 'plan and verification before retrying.'
            );
        }
        if (!finalPlan.compliant) {
            if (roleRemovalError instanceof Error) {
                throw new RuntimeGrantIndeterminateError(
                    'Runtime role removal reported an indeterminate outcome and '
                    + `final verification did not pass: ${
                        roleRemovalError.message
                    }. Inspect Cloud SQL operations, then run a fresh plan and verification.`
                );
            }
            if (roleRemovalInvoked) {
                throw new RuntimeGrantIndeterminateError(
                    'Cloud SQL role removal returned, but final runtime privilege '
                    + 'metadata is not compliant. Inspect Cloud SQL operations, '
                    + 'then run a fresh plan and verification.'
                );
            }
            throw new RuntimeGrantDriftError(finalPlan);
        }
        if (roleRemovalError instanceof Error) {
            throw new RuntimeGrantIndeterminateError(
                'Runtime role metadata is compliant, but the external removal command '
                + `reported an indeterminate outcome: ${roleRemovalError.message}. `
                + 'Run a fresh plan and verification before treating the cutover as complete.'
            );
        }
        return finalPlan;
    });
}
