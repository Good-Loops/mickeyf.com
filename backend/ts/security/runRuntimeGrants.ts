import mysql, { type Connection, type RowDataPacket } from 'mysql2/promise';
import {
    assertRuntimeGrantCommandConfirmed,
    loadMigrationAccountConfirmation,
    loadMigrationConfig,
    type MigrationConfig,
    type RuntimeGrantCommand,
} from '../config/migrationConfig';
import {
    CLOUD_SQL_ROLE_REMOVAL_PROVIDER,
    createProductionCloudSqlRoleRemover,
    PRODUCTION_CLOUD_SQL_TARGET,
    verifyNoCloudSqlOperationsInFlight,
    verifyProductionCloudSqlTarget,
} from './cloudSqlRuntimeRoleRemover';
import {
    applyRuntimeGrants,
    planRuntimeGrants,
    RuntimeGrantDriftError,
    RuntimeGrantIndeterminateError,
    type RuntimeGrantConnection,
    type RuntimeGrantPlan,
    verifyRuntimeGrants,
} from './runtimeGrantOperations';
import {
    PRODUCTION_RUNTIME_DATABASE_ACCOUNT,
    PRODUCTION_RUNTIME_DATABASE_ROLE,
    runtimeDatabaseAccountName,
    type RuntimeDatabaseAccount,
} from './runtimeGrantManifest';

let activeCommand: RuntimeGrantCommand | undefined;

function parseCommand(args: readonly string[]): RuntimeGrantCommand {
    if (args.length !== 1) {
        throw new Error('Usage: runRuntimeGrants.ts <plan|verify|apply>');
    }
    const [command] = args;
    if (command !== 'plan' && command !== 'verify' && command !== 'apply') {
        throw new Error('Unknown runtime grant command');
    }
    return command;
}

function asRuntimeGrantConnection(connection: Connection): RuntimeGrantConnection {
    return connection as unknown as RuntimeGrantConnection;
}

function parseConfirmedDatabaseAccount(value: string): RuntimeDatabaseAccount {
    const separator = value.lastIndexOf('@');
    if (separator <= 0 || separator === value.length - 1) {
        throw new Error('Confirmed maintenance account is not a valid MySQL account');
    }
    return Object.freeze({
        user: value.slice(0, separator),
        host: value.slice(separator + 1),
    });
}

async function assertConnectedTarget(
    connection: Connection,
    expectedDatabase: string,
    expectedAccount: string
): Promise<void> {
    const [rows] = await connection.query<Array<RowDataPacket & {
        databaseName: string | null;
        currentUser: string;
    }>>('SELECT DATABASE() AS databaseName, CURRENT_USER() AS currentUser');
    const [identity] = rows;
    if (
        rows.length !== 1
        || identity.databaseName !== expectedDatabase
        || identity.currentUser !== expectedAccount
    ) {
        throw new Error(
            'Connected database or account does not match runtime grant confirmations'
        );
    }
}

async function withOperationDeadline<T>(
    connection: Connection,
    timeoutMs: number,
    indeterminateOnTimeout: boolean,
    operation: (signal: AbortSignal) => Promise<T>
): Promise<T> {
    let timeout: NodeJS.Timeout | undefined;
    const controller = new AbortController();
    const deadline = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
            controller.abort();
            connection.destroy();
            const message = `Runtime grant operation exceeded ${timeoutMs}ms and was disconnected`;
            reject(indeterminateOnTimeout
                ? new RuntimeGrantIndeterminateError(
                    `${message}. A Cloud SQL role change may have completed; `
                    + 'inspect Cloud SQL operations, then run a fresh plan and '
                    + 'verification before retrying.'
                )
                : new Error(message));
        }, timeoutMs);
        timeout.unref();
    });

    try {
        return await Promise.race([operation(controller.signal), deadline]);
    } finally {
        if (timeout) clearTimeout(timeout);
    }
}

async function executeCommand(
    command: RuntimeGrantCommand,
    connection: Connection,
    config: MigrationConfig,
    confirmation: Readonly<{
        approvedPlanSha256?: string;
        confirmedServerUuid?: string;
    }>,
    maintenanceAccount: RuntimeDatabaseAccount,
    signal: AbortSignal
): Promise<RuntimeGrantPlan> {
    const settings = {
        database: config.database,
        expectedServerUuid: PRODUCTION_CLOUD_SQL_TARGET.serverUuid,
        maintenanceAccount,
        approvedRole: PRODUCTION_RUNTIME_DATABASE_ROLE,
        roleRemovalProvider: CLOUD_SQL_ROLE_REMOVAL_PROVIDER,
        roleRemovalTarget: PRODUCTION_CLOUD_SQL_TARGET.connectionName,
        advisoryLockTimeoutSeconds: config.advisoryLockTimeoutSeconds,
        lockWaitTimeoutSeconds: config.lockWaitTimeoutSeconds,
    };
    const runtimeConnection = asRuntimeGrantConnection(connection);

    if (command === 'plan') {
        return planRuntimeGrants(
            runtimeConnection,
            settings,
            PRODUCTION_RUNTIME_DATABASE_ACCOUNT
        );
    }
    if (command === 'verify') {
        return verifyRuntimeGrants(
            runtimeConnection,
            settings,
            PRODUCTION_RUNTIME_DATABASE_ACCOUNT
        );
    }
    if (!confirmation.approvedPlanSha256 || !confirmation.confirmedServerUuid) {
        throw new Error('Runtime grant apply confirmations were not loaded');
    }
    return applyRuntimeGrants(
        runtimeConnection,
        settings,
        PRODUCTION_RUNTIME_DATABASE_ACCOUNT,
        confirmation.approvedPlanSha256,
        confirmation.confirmedServerUuid,
        createProductionCloudSqlRoleRemover(
            PRODUCTION_RUNTIME_DATABASE_ACCOUNT,
            PRODUCTION_RUNTIME_DATABASE_ROLE,
            config.operationTimeoutMs,
            signal
        )
    );
}

function safeErrorMessage(error: unknown, password: string): string {
    const message = error instanceof Error
        ? error.message
        : 'Unknown runtime grant failure';
    return password.length > 0 ? message.split(password).join('[REDACTED]') : message;
}

async function main(): Promise<void> {
    const command = parseCommand(process.argv.slice(2));
    activeCommand = command;
    const config = loadMigrationConfig();
    const confirmedMaintenanceAccount = loadMigrationAccountConfirmation();
    const maintenanceAccount = parseConfirmedDatabaseAccount(
        confirmedMaintenanceAccount
    );
    const confirmation = assertRuntimeGrantCommandConfirmed(
        command,
        config,
        runtimeDatabaseAccountName(PRODUCTION_RUNTIME_DATABASE_ACCOUNT),
        runtimeDatabaseAccountName(PRODUCTION_RUNTIME_DATABASE_ROLE),
        PRODUCTION_CLOUD_SQL_TARGET
    );
    if (command === 'apply') {
        await verifyProductionCloudSqlTarget(config.operationTimeoutMs);
        await verifyNoCloudSqlOperationsInFlight(config.operationTimeoutMs);
    }
    const connection = await mysql.createConnection({
        host: config.host,
        port: config.port,
        user: config.user,
        password: config.password,
        database: config.database,
        connectTimeout: Math.min(config.operationTimeoutMs, 10_000),
        multipleStatements: false,
        dateStrings: true,
        supportBigNumbers: true,
        bigNumberStrings: true,
    });

    try {
        await assertConnectedTarget(
            connection,
            config.database,
            confirmedMaintenanceAccount
        );
        const plan = await withOperationDeadline(
            connection,
            command === 'apply'
                ? config.operationTimeoutMs * 2
                : config.operationTimeoutMs,
            command === 'apply',
            (signal) => executeCommand(
                command,
                connection,
                config,
                confirmation,
                maintenanceAccount,
                signal
            )
        );
        console.log(JSON.stringify({ command, plan }, null, 2));
    } finally {
        try {
            await connection.end();
        } catch {
            // A deadline intentionally destroys the connection before cleanup.
        }
    }
}

main().catch((error: unknown) => {
    if (error instanceof RuntimeGrantDriftError) {
        console.log(JSON.stringify({
            command: activeCommand ?? 'unknown',
            plan: error.plan,
        }, null, 2));
    }
    let password = '';
    try {
        password = loadMigrationConfig().password;
    } catch {
        // Configuration errors are already secret-safe.
    }
    console.error(safeErrorMessage(error, password));
    process.exitCode = error instanceof RuntimeGrantDriftError ? 2 : 1;
});
