import {
    buildMigrationPrincipalGrantStatements,
    getMigrationPrincipalProfile,
    MIGRATION_PRINCIPAL_HOST,
    type MigrationPrincipalProfileName,
} from './migrationPrincipalProfiles';

export interface MigrationPrincipalAdminConnection {
    query(sql: string, values?: unknown[]): Promise<[unknown, unknown]>;
}

type ActiveConnectionRow = Readonly<{
    activeConnectionCount: number | string;
}>;

type MandatoryRolesRow = Readonly<{
    mandatoryRoles: string | null;
}>;

type TriggerCountRow = Readonly<{
    unexpectedTriggerCount: number | string;
}>;

const REVIEWED_TRIGGER_TABLES = Object.freeze([
    'schema_migrations',
    'game_runs',
    'game_personal_bests',
] as const);

export class ActiveMigrationPrincipalConnectionsError extends Error {
    constructor(accountName: string, activeConnectionCount: number) {
        super(
            `Temporary migration account ${accountName}@${MIGRATION_PRINCIPAL_HOST} `
                + `is locked but still has ${activeConnectionCount} active connection(s); `
                + 'close them and retry revocation'
        );
        this.name = 'ActiveMigrationPrincipalConnectionsError';
    }
}

export class MandatoryMigrationRoleError extends Error {
    constructor() {
        super(
            'Temporary migration accounts require @@GLOBAL.mandatory_roles to be empty'
        );
        this.name = 'MandatoryMigrationRoleError';
    }
}

export class UnexpectedMigrationTriggerError extends Error {
    constructor(unexpectedTriggerCount: number) {
        super(
            `Temporary migration account is locked and revoked, but ${unexpectedTriggerCount} `
                + 'unexpected reviewed-table trigger(s) prevent account removal'
        );
        this.name = 'UnexpectedMigrationTriggerError';
    }
}

export class MigrationPrincipalProvisioningError extends Error {
    readonly provisioningErrorCode: string | undefined;
    readonly cleanupErrorCode: string | undefined;

    constructor(
        profileName: MigrationPrincipalProfileName,
        provisioningCause: unknown,
        accountWasCreated: boolean,
        cleanupCause?: unknown
    ) {
        super(
            !accountWasCreated
                ? `Temporary ${profileName} account provisioning failed before account creation`
                : cleanupCause === undefined
                    ? `Temporary ${profileName} account provisioning failed and was removed`
                    : `Temporary ${profileName} account provisioning failed; `
                        + 'automatic account removal could not be confirmed'
        );
        this.name = 'MigrationPrincipalProvisioningError';
        // mysql2 errors can retain the fully formatted CREATE USER statement,
        // including its password, in `sql`. Preserve only non-secret codes.
        this.provisioningErrorCode = mysqlErrorCode(provisioningCause);
        this.cleanupErrorCode = mysqlErrorCode(cleanupCause);
    }
}

function mysqlErrorCode(error: unknown): string | undefined {
    if (!error || typeof error !== 'object') return undefined;
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' && /^ER_[A-Z0-9_]+$/u.test(code)
        ? code
        : undefined;
}

function assertPrincipalPassword(password: string): void {
    if (password.length < 32 || password.length > 128 || password.includes('\0')) {
        throw new Error(
            'Temporary migration-principal password must contain 32 through 128 '
                + 'characters and no NUL byte'
        );
    }
}

async function activeConnectionCount(
    connection: MigrationPrincipalAdminConnection,
    accountName: string
): Promise<number> {
    const [result] = await connection.query(`
        SELECT COUNT(*) AS activeConnectionCount
        FROM information_schema.PROCESSLIST
        WHERE USER = ?
    `, [accountName]);
    if (!Array.isArray(result) || result.length !== 1) {
        throw new Error('Could not verify temporary migration-account connections');
    }

    const count = Number((result[0] as ActiveConnectionRow).activeConnectionCount);
    if (!Number.isSafeInteger(count) || count < 0) {
        throw new Error('Temporary migration-account connection count was invalid');
    }
    return count;
}

async function assertNoMandatoryRoles(
    connection: MigrationPrincipalAdminConnection
): Promise<void> {
    const [result] = await connection.query(
        'SELECT @@GLOBAL.mandatory_roles AS mandatoryRoles'
    );
    if (!Array.isArray(result) || result.length !== 1) {
        throw new Error('Could not verify MySQL mandatory roles');
    }
    const value = (result[0] as MandatoryRolesRow).mandatoryRoles;
    if (value !== null && value.trim() !== '' && value.trim().toUpperCase() !== 'NONE') {
        throw new MandatoryMigrationRoleError();
    }
}

async function assertReviewedTablesHaveNoTriggers(
    connection: MigrationPrincipalAdminConnection,
    database: string
): Promise<void> {
    const [result] = await connection.query(`
        SELECT COUNT(*) AS unexpectedTriggerCount
        FROM information_schema.TRIGGERS
        WHERE TRIGGER_SCHEMA = ?
          AND EVENT_OBJECT_TABLE IN (?, ?, ?)
    `, [database, ...REVIEWED_TRIGGER_TABLES]);
    if (!Array.isArray(result) || result.length !== 1) {
        throw new Error('Could not verify reviewed-table trigger inventory');
    }
    const count = Number((result[0] as TriggerCountRow).unexpectedTriggerCount);
    if (!Number.isSafeInteger(count) || count < 0) {
        throw new Error('Reviewed-table trigger count was invalid');
    }
    if (count > 0) throw new UnexpectedMigrationTriggerError(count);
}

async function lockPrincipal(
    connection: MigrationPrincipalAdminConnection,
    accountName: string
): Promise<void> {
    await connection.query(
        'ALTER USER ?@? ACCOUNT LOCK',
        [accountName, MIGRATION_PRINCIPAL_HOST]
    );
}

async function revokeAndDropLockedPrincipal(
    connection: MigrationPrincipalAdminConnection,
    database: string,
    accountName: string
): Promise<void> {
    // Table and column revocations affect existing sessions on their next
    // request. Revoke before counting so a leaked session retains no useful
    // grants while the operator closes it and retries this idempotent sequence.
    await connection.query(
        'REVOKE ALL PRIVILEGES, GRANT OPTION FROM ?@?',
        [accountName, MIGRATION_PRINCIPAL_HOST]
    );
    const connections = await activeConnectionCount(connection, accountName);
    if (connections > 0) {
        throw new ActiveMigrationPrincipalConnectionsError(accountName, connections);
    }

    // A trigger survives DROP USER and can retain an orphaned DEFINER. Audit
    // after lock/revoke and before account removal so closeout cannot bless a
    // persistent object created during the temporary privilege window.
    await assertReviewedTablesHaveNoTriggers(connection, database);

    await connection.query(
        'DROP USER ?@?',
        [accountName, MIGRATION_PRINCIPAL_HOST]
    );
}

export async function createTemporaryMigrationPrincipal(
    connection: MigrationPrincipalAdminConnection,
    database: string,
    profileName: MigrationPrincipalProfileName,
    password: string
): Promise<void> {
    assertPrincipalPassword(password);
    const profile = getMigrationPrincipalProfile(profileName);
    const grantStatements = buildMigrationPrincipalGrantStatements(database, profileName);
    await assertNoMandatoryRoles(connection);
    let accountCreated = false;

    try {
        // One connection plus immediate post-operation revocation is the actual
        // lifetime boundary. One-day password expiry is only a last-resort fuse.
        await connection.query(
            `CREATE USER ?@?
             IDENTIFIED BY ?
             WITH MAX_USER_CONNECTIONS 1
             PASSWORD EXPIRE INTERVAL 1 DAY
             ACCOUNT UNLOCK`,
            [profile.accountName, MIGRATION_PRINCIPAL_HOST, password]
        );
        accountCreated = true;

        for (const statement of grantStatements) {
            await connection.query(statement, [profile.accountName, MIGRATION_PRINCIPAL_HOST]);
        }
    } catch (provisioningCause) {
        if (!accountCreated) {
            throw new MigrationPrincipalProvisioningError(
                profileName,
                provisioningCause,
                false
            );
        }

        try {
            await lockPrincipal(connection, profile.accountName);
            await revokeAndDropLockedPrincipal(
                connection,
                database,
                profile.accountName
            );
        } catch (cleanupCause) {
            throw new MigrationPrincipalProvisioningError(
                profileName,
                provisioningCause,
                true,
                cleanupCause
            );
        }
        throw new MigrationPrincipalProvisioningError(
            profileName,
            provisioningCause,
            true
        );
    }
}

export async function revokeTemporaryMigrationPrincipal(
    connection: MigrationPrincipalAdminConnection,
    database: string,
    profileName: MigrationPrincipalProfileName
): Promise<void> {
    const profile = getMigrationPrincipalProfile(profileName);
    // DROP USER does not terminate an already-open MySQL session. Lock first,
    // revoke privileges from existing sessions, refuse while any remains, then
    // drop the account after its sole operation connection has closed.
    await lockPrincipal(connection, profile.accountName);
    await revokeAndDropLockedPrincipal(connection, database, profile.accountName);
}
