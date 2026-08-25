import { createHash } from 'node:crypto';
import type { MigrationConfig } from '../config/migrationConfig';
import {
    type MigrationConnection,
    tableExists,
    verifyHistoryTable,
    verifyLeaderboardTable,
} from './leaderboardSchema';
import type { MigrationDefinition } from './migrationManifest';

type RunnerSettings = Pick<
    MigrationConfig,
    'database' | 'advisoryLockTimeoutSeconds' | 'lockWaitTimeoutSeconds'
>;

type AppliedMigrationRow = {
    version: string;
    checksum: Buffer;
};

type LockRow = {
    acquired: number | null;
};

type ReleaseRow = {
    released: number | null;
};

type ExistsRow = {
    hasRows: number;
};

export type MigrationPlan = Readonly<{
    applied: readonly string[];
    pending: readonly string[];
    recoverable: readonly string[];
}>;

const CREATE_HISTORY_TABLE_SQL = `
    CREATE TABLE schema_migrations (
        version VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        checksum BINARY(32) NOT NULL,
        applied_at DATETIME(6) NOT NULL COMMENT 'UTC',
        CONSTRAINT pk_schema_migrations PRIMARY KEY (version)
    ) ENGINE = InnoDB
      DEFAULT CHARACTER SET = utf8mb4
      COLLATE = utf8mb4_unicode_ci
`;

async function queryRows<T>(
    connection: MigrationConnection,
    sql: string,
    values: unknown[] = []
): Promise<T[]> {
    const [rows] = await connection.query(sql, values);
    if (!Array.isArray(rows)) {
        throw new Error('Migration query returned an unexpected result');
    }
    return rows as T[];
}

export function migrationLockName(database: string): string {
    const databaseHash = createHash('sha256').update(database, 'utf8').digest('hex').slice(0, 24);
    return `mickeyf:leaderboard:${databaseHash}`;
}

async function configureSession(
    connection: MigrationConnection,
    lockWaitTimeoutSeconds: number
): Promise<void> {
    // Migration history must be durable regardless of a server's global default.
    await connection.query('SET SESSION autocommit = 1');
    await connection.query("SET SESSION time_zone = '+00:00'");
    await connection.query('SET SESSION lock_wait_timeout = ?', [lockWaitTimeoutSeconds]);
}

async function withMigrationLock<T>(
    connection: MigrationConnection,
    settings: RunnerSettings,
    operation: () => Promise<T>
): Promise<T> {
    await configureSession(connection, settings.lockWaitTimeoutSeconds);
    const lockName = migrationLockName(settings.database);
    const lockRows = await queryRows<LockRow>(
        connection,
        'SELECT GET_LOCK(?, ?) AS acquired',
        [lockName, settings.advisoryLockTimeoutSeconds]
    );
    if (Number(lockRows[0]?.acquired) !== 1) {
        throw new Error('Could not acquire the database migration lock');
    }

    let operationFailed = false;
    try {
        return await operation();
    } catch (error) {
        operationFailed = true;
        throw error;
    } finally {
        try {
            const releaseRows = await queryRows<ReleaseRow>(
                connection,
                'SELECT RELEASE_LOCK(?) AS released',
                [lockName]
            );
            if (!operationFailed && Number(releaseRows[0]?.released) !== 1) {
                throw new Error('Database migration lock was not released cleanly');
            }
        } catch (releaseError) {
            if (!operationFailed) throw releaseError;
        }
    }
}

async function createHistoryTable(connection: MigrationConnection): Promise<void> {
    if (!(await tableExists(connection, 'schema_migrations'))) {
        await connection.query(CREATE_HISTORY_TABLE_SQL);
    }
    await verifyHistoryTable(connection);
}

async function readAppliedMigrations(
    connection: MigrationConnection
): Promise<AppliedMigrationRow[]> {
    return queryRows<AppliedMigrationRow>(connection, `
        SELECT version, checksum
        FROM schema_migrations
        ORDER BY version
    `);
}

function validateHistory(
    migrations: readonly MigrationDefinition[],
    appliedRows: readonly AppliedMigrationRow[]
): Map<string, AppliedMigrationRow> {
    const manifestByVersion = new Map(
        migrations.map((migration) => [migration.version, migration])
    );
    const appliedByVersion = new Map<string, AppliedMigrationRow>();

    for (const applied of appliedRows) {
        const migration = manifestByVersion.get(applied.version);
        if (!migration) {
            throw new Error(`Database contains unknown migration version: ${applied.version}`);
        }
        if (!Buffer.isBuffer(applied.checksum) || !applied.checksum.equals(migration.checksum)) {
            throw new Error(`Checksum mismatch for applied migration: ${applied.version}`);
        }
        if (appliedByVersion.has(applied.version)) {
            throw new Error(`Database contains duplicate migration version: ${applied.version}`);
        }
        appliedByVersion.set(applied.version, applied);
    }

    return appliedByVersion;
}

async function inspectMigrationState(
    connection: MigrationConnection,
    migrations: readonly MigrationDefinition[],
    historyExists: boolean
): Promise<MigrationPlan> {
    const appliedRows = historyExists ? await readAppliedMigrations(connection) : [];
    const appliedByVersion = validateHistory(migrations, appliedRows);
    const applied: string[] = [];
    const pending: string[] = [];
    const recoverable: string[] = [];

    for (const migration of migrations) {
        const hasTable = await tableExists(connection, migration.tableName);
        if (appliedByVersion.has(migration.version)) {
            if (!hasTable) {
                throw new Error(
                    `Applied migration ${migration.version} is missing table ${migration.tableName}`
                );
            }
            await verifyLeaderboardTable(connection, migration.tableName);
            applied.push(migration.version);
            continue;
        }

        pending.push(migration.version);
        if (hasTable) {
            await verifyLeaderboardTable(connection, migration.tableName);
            recoverable.push(migration.version);
        }
    }

    return Object.freeze({
        applied: Object.freeze(applied),
        pending: Object.freeze(pending),
        recoverable: Object.freeze(recoverable),
    });
}

export async function planMigrations(
    connection: MigrationConnection,
    migrations: readonly MigrationDefinition[],
    settings: RunnerSettings
): Promise<MigrationPlan> {
    return withMigrationLock(connection, settings, async () => {
        const hasHistory = await tableExists(connection, 'schema_migrations');
        if (hasHistory) await verifyHistoryTable(connection);
        return inspectMigrationState(connection, migrations, hasHistory);
    });
}

export async function applyMigrations(
    connection: MigrationConnection,
    migrations: readonly MigrationDefinition[],
    settings: RunnerSettings
): Promise<MigrationPlan> {
    return withMigrationLock(connection, settings, async () => {
        await createHistoryTable(connection);
        const initialPlan = await inspectMigrationState(connection, migrations, true);
        const applied = [...initialPlan.applied];

        for (const migration of migrations) {
            if (applied.includes(migration.version)) continue;

            if (!initialPlan.recoverable.includes(migration.version)) {
                await connection.query(migration.sql);
                await verifyLeaderboardTable(connection, migration.tableName);
            }

            await connection.query(
                `INSERT INTO schema_migrations (version, checksum, applied_at)
                 VALUES (?, ?, UTC_TIMESTAMP(6))`,
                [migration.version, migration.checksum]
            );
            applied.push(migration.version);
        }

        return Object.freeze({
            applied: Object.freeze(applied),
            pending: Object.freeze([]),
            recoverable: Object.freeze([]),
        });
    });
}

export async function rollbackEmptyLeaderboardSchema(
    connection: MigrationConnection,
    migrations: readonly MigrationDefinition[],
    settings: RunnerSettings
): Promise<void> {
    await withMigrationLock(connection, settings, async () => {
        if (!(await tableExists(connection, 'schema_migrations'))) {
            throw new Error('Cannot roll back because schema_migrations does not exist');
        }
        await verifyHistoryTable(connection);
        const plan = await inspectMigrationState(connection, migrations, true);
        if (plan.pending.length > 0 || plan.recoverable.length > 0) {
            throw new Error('Cannot roll back a partially applied migration set');
        }

        let tablesLocked = false;
        let rollbackFailed = false;
        try {
            await connection.query(`
                LOCK TABLES
                    game_personal_bests WRITE,
                    game_runs WRITE,
                    schema_migrations WRITE
            `);
            tablesLocked = true;

            // Recheck under the write locks so an out-of-band schema change
            // cannot slip between the initial inspection and destructive DDL.
            const lockedPlan = await inspectMigrationState(connection, migrations, true);
            if (lockedPlan.pending.length > 0 || lockedPlan.recoverable.length > 0) {
                throw new Error('Cannot roll back a partially applied migration set');
            }

            const bestRows = await queryRows<ExistsRow>(connection, `
                SELECT EXISTS(
                    SELECT 1 FROM game_personal_bests LIMIT 1
                ) AS hasRows
            `);
            const runRows = await queryRows<ExistsRow>(connection, `
                SELECT EXISTS(
                    SELECT 1 FROM game_runs LIMIT 1
                ) AS hasRows
            `);
            if (Number(bestRows[0]?.hasRows) !== 0 || Number(runRows[0]?.hasRows) !== 0) {
                throw new Error(
                    'Destructive rollback refused because leaderboard tables contain data'
                );
            }

            // One MySQL 8 atomic DDL statement closes the count-to-drop race.
            await connection.query(`
                DROP TABLE
                    game_personal_bests,
                    game_runs,
                    schema_migrations
            `);
        } catch (error) {
            rollbackFailed = true;
            throw error;
        } finally {
            if (tablesLocked) {
                try {
                    await connection.query('UNLOCK TABLES');
                } catch (unlockError) {
                    if (!rollbackFailed) throw unlockError;
                }
            }
        }
    });
}
