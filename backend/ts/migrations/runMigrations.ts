import mysql, { type Connection, type RowDataPacket } from 'mysql2/promise';
import {
    assertP4VegaDataOperationAuthorized,
    assertMutationAuthorized,
    loadMigrationConfig,
    type MigrationConfig,
} from '../config/migrationConfig';
import type { MigrationConnection } from './leaderboardSchema';
import { loadMigrationManifest } from './migrationManifest';
import {
    backfillP4VegaScores,
    type P4VegaBackfillConnection,
    reconcileP4VegaScores,
} from './p4VegaBackfill';
import {
    applyMigrations,
    planMigrations,
    rollbackEmptyLeaderboardSchema,
    type MigrationPlan,
} from './migrationRunner';

type MigrationCommand =
    | 'plan'
    | 'apply'
    | 'rollback-empty'
    | 'backfill-p4-vega'
    | 'reconcile-p4-vega';

class P4VegaReconciliationDriftError extends Error {
    constructor(command: 'backfill-p4-vega' | 'reconcile-p4-vega') {
        super(`${command} found unresolved aggregate drift`);
        this.name = 'P4VegaReconciliationDriftError';
    }
}

function parseCommand(args: readonly string[]): MigrationCommand {
    if (args.length !== 1) {
        throw new Error(
            'Usage: runMigrations.ts '
            + '<plan|apply|rollback-empty|backfill-p4-vega|reconcile-p4-vega>'
        );
    }
    const [command] = args;
    if (
        command !== 'plan'
        && command !== 'apply'
        && command !== 'rollback-empty'
        && command !== 'backfill-p4-vega'
        && command !== 'reconcile-p4-vega'
    ) {
        throw new Error('Unknown migration command');
    }
    return command;
}

function asMigrationConnection(connection: Connection): MigrationConnection {
    return connection as unknown as MigrationConnection;
}

function asP4VegaBackfillConnection(connection: Connection): P4VegaBackfillConnection {
    return connection as unknown as P4VegaBackfillConnection;
}

async function assertConnectedDatabase(
    connection: Connection,
    expectedDatabase: string
): Promise<void> {
    const [rows] = await connection.query<Array<RowDataPacket & { databaseName: string }>>(
        'SELECT DATABASE() AS databaseName'
    );
    if (rows.length !== 1 || rows[0].databaseName !== expectedDatabase) {
        throw new Error('Connected database does not match MIGRATION_DB_NAME');
    }
}

async function withOperationDeadline<T>(
    connection: Connection,
    timeoutMs: number,
    operation: () => Promise<T>
): Promise<T> {
    let timeout: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
            connection.destroy();
            reject(new Error(`Migration operation exceeded ${timeoutMs}ms and was disconnected`));
        }, timeoutMs);
        timeout.unref();
    });

    try {
        return await Promise.race([operation(), deadline]);
    } finally {
        if (timeout) clearTimeout(timeout);
    }
}

function printPlan(plan: MigrationPlan): void {
    const format = (versions: readonly string[]) =>
        versions.length === 0 ? 'none' : versions.join(', ');

    console.log(`Applied migrations: ${format(plan.applied)}`);
    console.log(`Pending migrations: ${format(plan.pending)}`);
    if (plan.recoverable.length > 0) {
        console.log(`Recoverable unrecorded tables: ${format(plan.recoverable)}`);
    }
}

async function executeCommand(
    command: MigrationCommand,
    connection: Connection,
    config: MigrationConfig
): Promise<void> {
    const migrations = loadMigrationManifest();
    const migrationConnection = asMigrationConnection(connection);

    if (command === 'plan') {
        printPlan(await planMigrations(migrationConnection, migrations, config));
        return;
    }

    if (command === 'apply') {
        printPlan(await applyMigrations(migrationConnection, migrations, config));
        return;
    }

    if (command === 'backfill-p4-vega') {
        const result = await backfillP4VegaScores(
            asP4VegaBackfillConnection(connection),
            migrations,
            config
        );
        console.log(JSON.stringify({ command, ...result }, null, 2));
        if (!result.reconciliation.consistent) {
            throw new P4VegaReconciliationDriftError(command);
        }
        return;
    }

    if (command === 'reconcile-p4-vega') {
        const report = await reconcileP4VegaScores(
            asP4VegaBackfillConnection(connection),
            migrations,
            config
        );
        console.log(JSON.stringify({ command, report }, null, 2));
        if (!report.consistent) {
            throw new P4VegaReconciliationDriftError(command);
        }
        return;
    }

    await rollbackEmptyLeaderboardSchema(migrationConnection, migrations, config);
    console.log('Empty leaderboard schema rolled back');
}

function safeErrorMessage(error: unknown, password: string): string {
    const message = error instanceof Error ? error.message : 'Unknown migration failure';
    return password.length > 0 ? message.split(password).join('[REDACTED]') : message;
}

async function main(): Promise<void> {
    const command = parseCommand(process.argv.slice(2));
    const config = loadMigrationConfig();
    if (command === 'apply' || command === 'rollback-empty') {
        // Refuse before opening a socket, not merely before the first DDL.
        assertMutationAuthorized(command, config);
    } else if (command === 'backfill-p4-vega' || command === 'reconcile-p4-vega') {
        // Data commands have separate approvals and also refuse before connecting.
        assertP4VegaDataOperationAuthorized(command, config);
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
        await assertConnectedDatabase(connection, config.database);
        await withOperationDeadline(
            connection,
            command === 'backfill-p4-vega' || command === 'reconcile-p4-vega'
                ? config.p4VegaOperationTimeoutMs
                : config.operationTimeoutMs,
            () => executeCommand(command, connection, config)
        );
    } finally {
        try {
            await connection.end();
        } catch {
            // A deadline intentionally destroys the connection before cleanup.
        }
    }
}

main().catch((error: unknown) => {
    let password = '';
    try {
        password = loadMigrationConfig().password;
    } catch {
        // Configuration errors are already secret-safe.
    }
    console.error(safeErrorMessage(error, password));
    process.exitCode = error instanceof P4VegaReconciliationDriftError ? 2 : 1;
});
