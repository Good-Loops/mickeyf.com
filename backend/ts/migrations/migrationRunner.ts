import { createHash } from 'node:crypto';
import type { MigrationConfig } from '../config/migrationConfig';
import {
    legacyP4ScoreColumnExists,
    type MigrationConnection,
    tableExists,
    verifyHistoryTable,
    verifyLegacyP4ScoreColumnAbsent,
    verifyLegacyP4ScoreColumnPresent,
    verifyLeaderboardTable,
} from './leaderboardSchema';
import type {
    MigrationDefinition,
    MigrationEffectKind,
} from './migrationManifest';

export type MigrationRunnerSettings = Pick<
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

export type MigrationPlan = Readonly<{
    applied: readonly string[];
    pending: readonly string[];
    recoverable: readonly string[];
}>;

export type ApplyMigrationOptions = Readonly<{
    allowedEffectKinds?: readonly MigrationEffectKind[];
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
    settings: MigrationRunnerSettings,
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
            if (Number(releaseRows[0]?.released) !== 1) {
                throw new Error('Database migration lock was not released cleanly');
            }
        } catch (releaseError) {
            // A session-scoped lock must never leak into a reusable caller.
            connection.destroy?.();
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
        if (appliedByVersion.has(migration.version)) {
            await verifyMigrationPostcondition(connection, migration);
            applied.push(migration.version);
            continue;
        }

        pending.push(migration.version);
        if (migration.effect === 'create-table') {
            if (await tableExists(connection, migration.tableName)) {
                await verifyLeaderboardTable(connection, migration.tableName);
                recoverable.push(migration.version);
            }
            continue;
        }

        if (await legacyP4ScoreColumnExists(connection)) {
            await verifyLegacyP4ScoreColumnPresent(connection);
        } else {
            await verifyLegacyP4ScoreColumnAbsent(connection);
            recoverable.push(migration.version);
        }
    }

    return Object.freeze({
        applied: Object.freeze(applied),
        pending: Object.freeze(pending),
        recoverable: Object.freeze(recoverable),
    });
}

async function verifyMigrationPrecondition(
    connection: MigrationConnection,
    migration: MigrationDefinition
): Promise<void> {
    if (migration.effect === 'create-table') {
        if (await tableExists(connection, migration.tableName)) {
            throw new Error(
                `Migration ${migration.version} requires table ${migration.tableName} to be absent`
            );
        }
        return;
    }

    await verifyLegacyP4ScoreColumnPresent(connection);
}

async function verifyMigrationPostcondition(
    connection: MigrationConnection,
    migration: MigrationDefinition
): Promise<void> {
    if (migration.effect === 'create-table') {
        if (!(await tableExists(connection, migration.tableName))) {
            throw new Error(
                `Applied migration ${migration.version} is missing table ${migration.tableName}`
            );
        }
        await verifyLeaderboardTable(connection, migration.tableName);
        return;
    }

    await verifyLegacyP4ScoreColumnAbsent(connection);
}

export async function planMigrations(
    connection: MigrationConnection,
    migrations: readonly MigrationDefinition[],
    settings: MigrationRunnerSettings
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
    settings: MigrationRunnerSettings,
    options: ApplyMigrationOptions = {}
): Promise<MigrationPlan> {
    return withMigrationLock(connection, settings, async () => {
        const hasHistory = await tableExists(connection, 'schema_migrations');
        if (hasHistory) await verifyHistoryTable(connection);
        const initialPlan = await inspectMigrationState(connection, migrations, hasHistory);
        const allowedEffectKinds = new Set<MigrationEffectKind>(
            options.allowedEffectKinds ?? ['create-table']
        );

        if (!hasHistory) await createHistoryTable(connection);
        const applied = [...initialPlan.applied];

        for (const migration of migrations) {
            if (applied.includes(migration.version)) continue;
            if (!allowedEffectKinds.has(migration.effect)) continue;

            if (!initialPlan.recoverable.includes(migration.version)) {
                await verifyMigrationPrecondition(connection, migration);
                await connection.query(migration.sql);
            }
            await verifyMigrationPostcondition(connection, migration);

            await connection.query(
                `INSERT INTO schema_migrations (version, checksum, applied_at)
                 VALUES (?, ?, UTC_TIMESTAMP(6))`,
                [migration.version, migration.checksum]
            );
            applied.push(migration.version);
        }

        return inspectMigrationState(connection, migrations, true);
    });
}

/**
 * Runs an operational data command only after the complete reviewed migration
 * set and its exact table shapes have been verified under the migration lock.
 */
export async function withVerifiedLeaderboardSchema<T>(
    connection: MigrationConnection,
    migrations: readonly MigrationDefinition[],
    settings: MigrationRunnerSettings,
    operation: () => Promise<T>
): Promise<T> {
    return withMigrationLock(connection, settings, async () => {
        await assertCompleteReviewedMigrationSet(connection, migrations);
        const result = await operation();
        // Detect out-of-band DDL that raced the initial verification before
        // reporting a data operation as successful.
        await assertCompleteReviewedMigrationSet(connection, migrations);
        return result;
    });
}

async function assertCompleteReviewedMigrationSet(
    connection: MigrationConnection,
    migrations: readonly MigrationDefinition[]
): Promise<void> {
    if (!(await tableExists(connection, 'schema_migrations'))) {
        throw new Error('Leaderboard data operation requires schema_migrations');
    }

    await verifyHistoryTable(connection);
    const plan = await inspectMigrationState(connection, migrations, true);
    if (plan.pending.length > 0 || plan.recoverable.length > 0) {
        throw new Error(
            'Leaderboard data operation requires the complete reviewed migration set'
        );
    }
}
