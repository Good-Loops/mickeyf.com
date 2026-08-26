import { createHash } from 'node:crypto';
import mysql, { type Connection, type RowDataPacket } from 'mysql2/promise';
import {
    assertP4ScoreDropCommandConfirmed,
    assertP4VegaDataOperationAuthorized,
    assertMutationAuthorized,
    loadMigrationAccountConfirmation,
    loadMigrationConfig,
    type MigrationConfig,
    type RuntimeGrantConfirmation,
} from '../config/migrationConfig';
import {
    PRODUCTION_CLOUD_SQL_TARGET,
    verifyIncompatibleMainTriggerDisabled,
    verifyNoCloudSqlOperationsInFlight,
    verifyProductionCloudSqlTarget,
} from '../security/cloudSqlRuntimeRoleRemover';
import type { MigrationConnection } from './leaderboardSchema';
import {
    loadMigrationManifest,
    type MigrationDefinition,
} from './migrationManifest';
import {
    backfillP4VegaScores,
    type P4VegaBackfillConnection,
    reconcileP4VegaScores,
} from './p4VegaBackfill';
import {
    applyMigrations,
    planMigrations,
    type MigrationPlan,
} from './migrationRunner';

type MigrationCommand =
    | 'plan'
    | 'apply'
    | 'backfill-p4-vega'
    | 'reconcile-p4-vega'
    | 'p4-score-drop-plan'
    | 'p4-score-drop-apply'
    | 'p4-score-drop-verify';

type DatabaseIdentity = Readonly<{
    databaseName: string;
    currentUser: string;
    serverUuid: string;
    serverVersion: string;
    versionComment: string;
}>;

type P4ScoreDropState = 'ready' | 'recoverable' | 'applied' | 'blocked';

type P4ScoreDropPlan = Readonly<{
    formatVersion: 1;
    state: P4ScoreDropState;
    database: DatabaseIdentity;
    migration: Readonly<{ version: string; checksumSha256: string }>;
    schema: MigrationPlan;
    reconciliation: Awaited<ReturnType<typeof reconcileP4VegaScores>> | null;
    blockers: readonly string[];
    sha256: string;
}>;

const P4_SCORE_DROP_VERSION = '0003_drop_users_p4_score';

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
            + '<plan|apply|backfill-p4-vega|reconcile-p4-vega|'
            + 'p4-score-drop-plan|p4-score-drop-apply|p4-score-drop-verify>'
        );
    }
    const [command] = args;
    if (
        command !== 'plan'
        && command !== 'apply'
        && command !== 'backfill-p4-vega'
        && command !== 'reconcile-p4-vega'
        && command !== 'p4-score-drop-plan'
        && command !== 'p4-score-drop-apply'
        && command !== 'p4-score-drop-verify'
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

async function assertConnectedTarget(
    connection: Connection,
    expectedDatabase: string,
    expectedAccount: string
): Promise<DatabaseIdentity> {
    const [rows] = await connection.query<Array<RowDataPacket & {
        databaseName: string | null;
        currentUser: string;
        serverUuid: string;
        serverVersion: string;
        versionComment: string;
    }>>(`
        SELECT
            DATABASE() AS databaseName,
            CURRENT_USER() AS currentUser,
            @@GLOBAL.server_uuid AS serverUuid,
            @@version AS serverVersion,
            @@version_comment AS versionComment
    `);
    const [identity] = rows;

    if (
        rows.length !== 1
        || identity.databaseName !== expectedDatabase
        || identity.currentUser !== expectedAccount
    ) {
        throw new Error('Connected database or account does not match migration confirmations');
    }

    return Object.freeze({
        databaseName: identity.databaseName,
        currentUser: identity.currentUser,
        serverUuid: String(identity.serverUuid).toLowerCase(),
        serverVersion: String(identity.serverVersion),
        versionComment: String(identity.versionComment),
    });
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
        console.log(`Recoverable unrecorded effects: ${format(plan.recoverable)}`);
    }
}

function additiveMigrations(
    migrations: readonly MigrationDefinition[]
): readonly MigrationDefinition[] {
    return migrations.filter(({ effect }) => effect === 'create-table');
}

function p4ScoreDropMigration(
    migrations: readonly MigrationDefinition[]
): MigrationDefinition {
    const migration = migrations.find(({ version }) => version === P4_SCORE_DROP_VERSION);
    if (!migration || migration.effect !== 'drop-column') {
        throw new Error('The reviewed p4_score drop migration is missing');
    }
    return migration;
}

async function createP4ScoreDropPlan(
    connection: Connection,
    migrations: readonly MigrationDefinition[],
    config: MigrationConfig,
    identity: DatabaseIdentity
): Promise<P4ScoreDropPlan> {
    const migration = p4ScoreDropMigration(migrations);
    const schema = await planMigrations(asMigrationConnection(connection), migrations, config);
    const baseVersions = additiveMigrations(migrations).map(({ version }) => version);
    const baseComplete = baseVersions.every((version) => schema.applied.includes(version));
    const dropApplied = schema.applied.includes(migration.version);
    const dropRecoverable = schema.recoverable.includes(migration.version);
    const dropPending = schema.pending.includes(migration.version);
    const reconciliation = baseComplete && dropPending && !dropRecoverable
        ? await reconcileP4VegaScores(
            asP4VegaBackfillConnection(connection),
            additiveMigrations(migrations),
            config
        )
        : null;
    const blockers: string[] = [];

    if (!baseComplete) blockers.push('additive leaderboard migrations are not fully applied');
    if (identity.serverUuid !== PRODUCTION_CLOUD_SQL_TARGET.serverUuid) {
        blockers.push('connected server UUID does not match the pinned production instance');
    }
    if (dropPending && !dropRecoverable && reconciliation?.consistent !== true) {
        blockers.push('p4-Vega legacy and generic scores are not exactly reconciled');
    }
    if (!dropPending && !dropApplied) {
        blockers.push('p4_score drop migration is in an unsupported state');
    }

    const state: P4ScoreDropState = blockers.length > 0
        ? 'blocked'
        : dropApplied
            ? 'applied'
            : dropRecoverable
                ? 'recoverable'
                : 'ready';
    const payload = {
        formatVersion: 1 as const,
        state,
        database: identity,
        migration: Object.freeze({
            version: migration.version,
            checksumSha256: migration.checksum.toString('hex'),
        }),
        schema,
        reconciliation,
        blockers: Object.freeze(blockers),
    };
    const sha256 = createHash('sha256')
        .update(JSON.stringify(payload), 'utf8')
        .digest('hex');
    return Object.freeze({ ...payload, sha256 });
}

async function assertNoConcurrentDatabaseWork(connection: Connection): Promise<void> {
    const [transactionRows] = await connection.query<Array<RowDataPacket & {
        activeTransactions: number;
    }>>('SELECT COUNT(*) AS activeTransactions FROM information_schema.INNODB_TRX');
    if (Number(transactionRows[0]?.activeTransactions) !== 0) {
        throw new Error('p4_score drop requires zero active InnoDB transactions');
    }

    const [lockRows] = await connection.query<Array<RowDataPacket & {
        pendingMetadataLocks: number;
    }>>(`
        SELECT COUNT(*) AS pendingMetadataLocks
        FROM performance_schema.metadata_locks
        WHERE OBJECT_SCHEMA = DATABASE()
          AND OBJECT_NAME IN ('users', 'schema_migrations')
          AND LOCK_STATUS = 'PENDING'
    `);
    if (Number(lockRows[0]?.pendingMetadataLocks) !== 0) {
        throw new Error('p4_score drop requires zero pending metadata locks');
    }
}

function printP4ScoreDropPlan(plan: P4ScoreDropPlan): void {
    console.log(JSON.stringify(plan, null, 2));
}

async function executeCommand(
    command: MigrationCommand,
    connection: Connection,
    config: MigrationConfig,
    identity: DatabaseIdentity,
    confirmation: RuntimeGrantConfirmation
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

    if (command === 'p4-score-drop-plan') {
        printP4ScoreDropPlan(
            await createP4ScoreDropPlan(connection, migrations, config, identity)
        );
        return;
    }

    if (command === 'p4-score-drop-verify') {
        const plan = await createP4ScoreDropPlan(connection, migrations, config, identity);
        printP4ScoreDropPlan(plan);
        if (plan.state !== 'applied') {
            throw new Error('p4_score drop verification requires migration 0003 to be applied');
        }
        return;
    }

    if (command === 'p4-score-drop-apply') {
        await assertNoConcurrentDatabaseWork(connection);
        const approvedPlan = await createP4ScoreDropPlan(
            connection,
            migrations,
            config,
            identity
        );
        if (approvedPlan.sha256 !== confirmation.approvedPlanSha256) {
            throw new Error(
                'MIGRATION_CONFIRM_P4_SCORE_DROP_PLAN_SHA256 does not match the current plan'
            );
        }
        if (approvedPlan.state !== 'ready' && approvedPlan.state !== 'recoverable') {
            throw new Error(`p4_score drop apply is blocked in state ${approvedPlan.state}`);
        }

        await applyMigrations(migrationConnection, migrations, config, {
            allowedEffectKinds: ['drop-column'],
        });
        const verifiedPlan = await createP4ScoreDropPlan(
            connection,
            migrations,
            config,
            identity
        );
        printP4ScoreDropPlan(verifiedPlan);
        if (verifiedPlan.state !== 'applied') {
            throw new Error('p4_score drop did not reach its verified applied state');
        }
        return;
    }

    if (command === 'backfill-p4-vega') {
        const result = await backfillP4VegaScores(
            asP4VegaBackfillConnection(connection),
            additiveMigrations(migrations),
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
            additiveMigrations(migrations),
            config
        );
        console.log(JSON.stringify({ command, report }, null, 2));
        if (!report.consistent) {
            throw new P4VegaReconciliationDriftError(command);
        }
        return;
    }

    throw new Error('Unhandled migration command');
}

function safeErrorMessage(error: unknown, password: string): string {
    const message = error instanceof Error ? error.message : 'Unknown migration failure';
    return password.length > 0 ? message.split(password).join('[REDACTED]') : message;
}

async function main(): Promise<void> {
    const command = parseCommand(process.argv.slice(2));
    const config = loadMigrationConfig();
    const confirmedAccount = loadMigrationAccountConfirmation();
    let confirmation: RuntimeGrantConfirmation = Object.freeze({});
    if (command === 'apply') {
        // Refuse before opening a socket, not merely before the first DDL.
        assertMutationAuthorized(command, config);
    } else if (command === 'backfill-p4-vega' || command === 'reconcile-p4-vega') {
        // Data commands have separate approvals and also refuse before connecting.
        assertP4VegaDataOperationAuthorized(command, config);
    } else if (command.startsWith('p4-score-drop-')) {
        const dropCommand = command.slice('p4-score-drop-'.length) as
            'plan' | 'apply' | 'verify';
        confirmation = assertP4ScoreDropCommandConfirmed(
            dropCommand,
            config,
            PRODUCTION_CLOUD_SQL_TARGET
        );
        if (dropCommand === 'apply') {
            await verifyProductionCloudSqlTarget(config.operationTimeoutMs);
            await verifyNoCloudSqlOperationsInFlight(config.operationTimeoutMs);
            await verifyIncompatibleMainTriggerDisabled(config.operationTimeoutMs);
        }
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
        const identity = await assertConnectedTarget(
            connection,
            config.database,
            confirmedAccount
        );
        await withOperationDeadline(
            connection,
            command === 'backfill-p4-vega'
                || command === 'reconcile-p4-vega'
                || command === 'p4-score-drop-plan'
                || command === 'p4-score-drop-apply'
                ? config.p4VegaOperationTimeoutMs
                : config.operationTimeoutMs,
            () => executeCommand(command, connection, config, identity, confirmation)
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
