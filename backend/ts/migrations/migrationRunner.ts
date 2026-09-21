import { createHash } from 'node:crypto';
import {
    inspectAccountIdentityStage,
    accountIdentityBackfillComplete,
    verifyAccountIdentityPrecondition,
    verifyAccountIdentitySchema,
} from './accountIdentitySchema';
import { PROVIDER_IDENTITY_MIGRATION_VERSION, verifyProviderIdentitySchema } from './providerIdentitySchema';
import { verifyAppleTokenSchema } from './appleTokenSchema';
import { verifyAppleRevocationSchema } from './appleRevocationSchema';
import { PROVIDER_ATTEMPT_MIGRATION_VERSION, PROVIDER_ATTEMPT_ACTIONS_MIGRATION_VERSION,
    inspectProviderAttemptStage, verifyProviderAttemptSchema, type ProviderAttemptSchemaStage } from './providerAttemptSchema';
import { ACCOUNT_SESSION_MIGRATION_VERSION, inspectAccountSessionRenewal,
    ACCOUNT_SESSION_RENEWAL_MIGRATION_VERSION, APPLE_SESSION_PROVENANCE_MIGRATION_VERSION,
    inspectAppleSessionProvenance, verifyAccountSessionSchema, verifyRenewableAccountSessionSchema } from './accountSessionSchema';
import { UNIQUE_USER_NAME_MIGRATION_VERSION, PASSWORDLESS_ACCOUNT_MIGRATION_VERSION,
    inspectUniqueUserNames, inspectPasswordlessAccounts, verifyUniqueUserNamesPrecondition,
    verifyUniqueUserNamesSchema, verifyPasswordlessAccountsPrecondition,
    verifyPasswordlessAccountSchema } from './passwordlessAccountSchema';
import type { MigrationConfig } from '../config/migrationConfig';
import {
    legacyP4ScoreColumnExists,
    type MigrationConnection,
    tableExists,
    verifyHistoryTable,
    verifyLegacyP4ScoreColumnAbsent,
    verifyLegacyP4ScoreColumnPresent,
    verifyLeaderboardTable,
    personalBestSourceExists,
    verifyLeaderboardStage,
    type LeaderboardSchemaStage,
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
    beforeApply?: (plan: MigrationPlan) => Promise<void>;
    afterApply?: (plan: MigrationPlan) => Promise<void>;
}>;

const DETACH_VERSION = '0004_detach_personal_best_sources';
const RECEIPTS_VERSION = '0005_retain_submission_receipts';
const LEGACY_VERSIONS = [
    '0001_create_game_runs', '0002_create_game_personal_bests', '0003_drop_users_p4_score',
];
const PROVIDER_IDENTITY_PREREQUISITES = [
    ...LEGACY_VERSIONS, DETACH_VERSION, RECEIPTS_VERSION,
    '0006_add_account_identity', '0007_backfill_account_identity', '0008_finalize_account_identity',
];
const PROVIDER_ATTEMPT_PREREQUISITES = [
    ...PROVIDER_IDENTITY_PREREQUISITES, PROVIDER_IDENTITY_MIGRATION_VERSION,
];
const ACCOUNT_SESSION_PREREQUISITES = [...PROVIDER_ATTEMPT_PREREQUISITES, PROVIDER_ATTEMPT_MIGRATION_VERSION];
const SESSION_RENEWAL_PREREQUISITES = [...ACCOUNT_SESSION_PREREQUISITES, ACCOUNT_SESSION_MIGRATION_VERSION];
const UNIQUE_USER_NAME_PREREQUISITES = [...SESSION_RENEWAL_PREREQUISITES, ACCOUNT_SESSION_RENEWAL_MIGRATION_VERSION];
const PASSWORDLESS_ACCOUNT_PREREQUISITES = [...UNIQUE_USER_NAME_PREREQUISITES, UNIQUE_USER_NAME_MIGRATION_VERSION];
const PROVIDER_ATTEMPT_ACTIONS_PREREQUISITES = [...PASSWORDLESS_ACCOUNT_PREREQUISITES, PASSWORDLESS_ACCOUNT_MIGRATION_VERSION];

function isPasswordlessMigration(migration: MigrationDefinition): boolean {
    return migration.effect === 'add-unique-user-names' || migration.effect === 'allow-passwordless-accounts'
        || migration.effect === 'extend-provider-attempt-actions';
}

function requiresCompleteEarlierHistory(migration: MigrationDefinition): boolean {
    return migration.effect === 'add-provider-identities' || migration.effect === 'add-provider-attempts'
        || migration.effect === 'add-account-sessions' || migration.effect === 'add-session-renewal'
        || migration.effect === 'add-apple-tokens' || migration.effect === 'add-apple-revocations'
        || migration.effect === 'add-apple-session-provenance' || isPasswordlessMigration(migration);
}

async function inspectLeaderboardStage(
    connection: MigrationConnection,
    migrations: readonly MigrationDefinition[],
    applied: ReadonlyMap<string, AppliedMigrationRow>
): Promise<LeaderboardSchemaStage> {
    if (!migrations.some(({ effect }) => effect === 'detach-best-source')) return 'original';
    const hasReceipts = await tableExists(connection, 'game_submission_receipts');
    const hasRuns = await tableExists(connection, 'game_runs');
    const hasBests = await tableExists(connection, 'game_personal_bests');
    if (hasReceipts && hasRuns) throw new Error('Ambiguous receipt transition: both run tables exist');
    const detached = hasBests && !(await personalBestSourceExists(connection));
    if (hasReceipts || detached || applied.has(DETACH_VERSION) || applied.has(RECEIPTS_VERSION)) {
        if (!LEGACY_VERSIONS.every((version) => applied.has(version))) {
            throw new Error('Receipt transition requires all historical migrations to be recorded first');
        }
        if (!hasBests || !detached || (!hasRuns && !hasReceipts)) {
            throw new Error('Receipt transition schema disagrees with recorded history');
        }
        if (hasReceipts && !applied.has(DETACH_VERSION)) {
            throw new Error('Receipt rename requires recorded personal-best detachment');
        }
        if (applied.has(RECEIPTS_VERSION) && !hasReceipts) {
            throw new Error('Recorded receipt migration is missing game_submission_receipts');
        }
    }
    return hasReceipts ? 'receipts' : detached ? 'detached' : 'original';
}

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
    const stage = await inspectLeaderboardStage(connection, migrations, appliedByVersion);
    const attemptStage = migrations.some(({ version }) => version === PROVIDER_ATTEMPT_ACTIONS_MIGRATION_VERSION)
        && await tableExists(connection, 'provider_auth_attempts')
        ? await inspectProviderAttemptStage(connection) : 'legacy';
    if (attemptStage === 'extended') {
        const actionsMigration = migrations.find(({ version }) => version === PROVIDER_ATTEMPT_ACTIONS_MIGRATION_VERSION)!;
        assertProviderMigrationHistory(migrations, actionsMigration, appliedByVersion);
    }
    if (migrations.some(({ version }) => version === APPLE_SESSION_PROVENANCE_MIGRATION_VERSION)
        && await tableExists(connection, 'account_sessions') && await inspectAppleSessionProvenance(connection)) {
        const provenance = migrations.find(({ version }) => version === APPLE_SESSION_PROVENANCE_MIGRATION_VERSION)!;
        assertProviderMigrationHistory(migrations, provenance, appliedByVersion);
    }
    const applied: string[] = [];
    const pending: string[] = [];
    const recoverable: string[] = [];

    for (const migration of migrations) {
        if (appliedByVersion.has(migration.version)) {
            if (requiresCompleteEarlierHistory(migration)) {
                assertProviderMigrationHistory(migrations, migration, appliedByVersion);
            }
            await verifyMigrationPostcondition(connection, migration, stage, attemptStage);
            applied.push(migration.version);
            continue;
        }

        pending.push(migration.version);
        if (migration.effect === 'add-apple-session-provenance') {
            if (await tableExists(connection, migration.tableName)) {
                if (await inspectAppleSessionProvenance(connection)) {
                    assertProviderMigrationHistory(migrations, migration, appliedByVersion);
                    await verifyAccountSessionSchema(connection, true, true);
                    recoverable.push(migration.version);
                } else await verifyAccountSessionSchema(connection, await inspectAccountSessionRenewal(connection));
            }
            continue;
        }
        if (isPasswordlessMigration(migration)) {
            if (await tableExists(connection, migration.tableName)) {
                const completed = migration.effect === 'add-unique-user-names'
                    ? await inspectUniqueUserNames(connection)
                    : migration.effect === 'allow-passwordless-accounts'
                        ? await inspectPasswordlessAccounts(connection) : attemptStage === 'extended';
                if (completed) {
                    assertProviderMigrationHistory(migrations, migration, appliedByVersion);
                    await verifyMigrationPostcondition(connection, migration, stage, attemptStage);
                    recoverable.push(migration.version);
                }
            }
            continue;
        }
        if (migration.effect === 'add-session-renewal') {
            if (await tableExists(connection, migration.tableName)) {
                if (await inspectAccountSessionRenewal(connection)) {
                    assertProviderMigrationHistory(migrations, migration, appliedByVersion);
                    await verifyRenewableAccountSessionSchema(connection);
                    recoverable.push(migration.version);
                } else await verifyAccountSessionSchema(connection);
            }
            continue;
        }
        if (requiresCompleteEarlierHistory(migration)) {
            if (await tableExists(connection, migration.tableName)) {
                assertProviderMigrationHistory(migrations, migration, appliedByVersion);
                await verifyMigrationPostcondition(connection, migration);
                recoverable.push(migration.version);
            }
            continue;
        }
        if (migration.effect === 'add-account-identity') {
            if (await accountIdentityEffectComplete(connection, migration.stage)) {
                recoverable.push(migration.version);
            }
            continue;
        }
        if (migration.effect === 'detach-best-source' || migration.effect === 'retain-receipts') {
            const completed = migration.effect === 'detach-best-source'
                ? stage !== 'original' : stage === 'receipts';
            if (completed) {
                await verifyMigrationPostcondition(connection, migration, stage);
                recoverable.push(migration.version);
            }
            continue;
        }
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

async function accountIdentityEffectComplete(
    connection: MigrationConnection, stage: 'column' | 'backfill' | 'finalize'
): Promise<boolean> {
    if (stage === 'backfill') return accountIdentityBackfillComplete(connection);
    const schemaStage = await inspectAccountIdentityStage(connection);
    return stage === 'column' ? schemaStage !== 'absent' : schemaStage === 'complete';
}

async function verifyMigrationPrecondition(
    connection: MigrationConnection,
    migration: MigrationDefinition
): Promise<void> {
    if (migration.effect === 'add-apple-revocations') {
        await verifyAppleTokenSchema(connection);
        if (await tableExists(connection, migration.tableName)) throw new Error('Apple revocation migration requires its table to be absent');
        return;
    }
    if (migration.effect === 'add-apple-session-provenance') {
        await verifyAppleRevocationSchema(connection);
        await verifyAccountSessionSchema(connection, true, false);
        return;
    }
    if (migration.effect === 'add-apple-tokens') {
        await verifyProviderIdentitySchema(connection);
        if (await tableExists(connection, migration.tableName)) throw new Error('Apple token migration requires its table to be absent');
        return;
    }
    if (migration.effect === 'add-unique-user-names') {
        await verifyUniqueUserNamesPrecondition(connection);
        return;
    }
    if (migration.effect === 'allow-passwordless-accounts') {
        await verifyPasswordlessAccountsPrecondition(connection);
        return;
    }
    if (migration.effect === 'extend-provider-attempt-actions') {
        await verifyPasswordlessAccountSchema(connection);
        await verifyProviderAttemptSchema(connection);
        return;
    }
    if (migration.effect === 'add-session-renewal') {
        await verifyAccountSessionSchema(connection);
        return;
    }
    if (migration.effect === 'add-account-sessions') {
        await verifyAccountIdentitySchema(connection);
        await verifyProviderIdentitySchema(connection);
        await verifyProviderAttemptSchema(connection);
        if (await tableExists(connection, migration.tableName)) {
            throw new Error('Account session migration requires its table to be absent');
        }
        return;
    }
    if (migration.effect === 'add-provider-attempts') {
        await verifyAccountIdentitySchema(connection);
        await verifyProviderIdentitySchema(connection);
        if (await tableExists(connection, migration.tableName)) {
            throw new Error('Provider attempt migration requires its table to be absent');
        }
        return;
    }
    if (migration.effect === 'add-provider-identities') {
        await verifyAccountIdentitySchema(connection);
        if (await tableExists(connection, migration.tableName)) {
            throw new Error('Provider identity migration requires its table to be absent');
        }
        return;
    }
    if (migration.effect === 'add-account-identity') {
        await verifyAccountIdentityPrecondition(connection);
        const stage = await inspectAccountIdentityStage(connection);
        if (migration.stage === 'column' ? stage !== 'absent' : stage === 'absent') {
            throw new Error('Account identity migration requires the preceding reviewed schema stage');
        }
        if (migration.stage === 'finalize' && !(await accountIdentityBackfillComplete(connection))) {
            throw new Error('Account identity finalization requires a complete UUID backfill');
        }
        return;
    }
    if (migration.effect === 'detach-best-source') {
        await verifyLeaderboardTable(connection, 'game_personal_bests');
        return;
    }
    if (migration.effect === 'retain-receipts') {
        if (await tableExists(connection, 'game_submission_receipts')) {
            throw new Error('Receipt rename requires game_submission_receipts to be absent');
        }
        await verifyLeaderboardStage(connection, 'game_personal_bests', 'detached');
        await verifyLeaderboardTable(connection, 'game_runs');
        return;
    }
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
    migration: MigrationDefinition,
    stage: LeaderboardSchemaStage = 'original',
    attemptStage: ProviderAttemptSchemaStage = 'legacy'
): Promise<void> {
    if (migration.effect === 'add-apple-revocations') {
        await verifyAppleRevocationSchema(connection);
        return;
    }
    if (migration.effect === 'add-apple-session-provenance') {
        await verifyAccountSessionSchema(connection, true, true);
        return;
    }
    if (migration.effect === 'add-apple-tokens') {
        await verifyAppleTokenSchema(connection);
        return;
    }
    if (migration.effect === 'add-unique-user-names') {
        await verifyUniqueUserNamesSchema(connection);
        return;
    }
    if (migration.effect === 'allow-passwordless-accounts') {
        await verifyPasswordlessAccountSchema(connection);
        return;
    }
    if (migration.effect === 'extend-provider-attempt-actions') {
        await verifyPasswordlessAccountSchema(connection);
        await verifyProviderAttemptSchema(connection, 'extended');
        return;
    }
    if (migration.effect === 'add-session-renewal') {
        await verifyRenewableAccountSessionSchema(connection);
        return;
    }
    if (migration.effect === 'add-account-sessions') {
        await verifyAccountIdentitySchema(connection);
        await verifyProviderIdentitySchema(connection);
        await verifyProviderAttemptSchema(connection, attemptStage);
        await verifyAccountSessionSchema(connection, await inspectAccountSessionRenewal(connection),
            await inspectAppleSessionProvenance(connection));
        return;
    }
    if (migration.effect === 'add-provider-attempts') {
        await verifyAccountIdentitySchema(connection);
        await verifyProviderIdentitySchema(connection);
        await verifyProviderAttemptSchema(connection, attemptStage);
        return;
    }
    if (migration.effect === 'add-provider-identities') {
        await verifyAccountIdentitySchema(connection);
        await verifyProviderIdentitySchema(connection);
        return;
    }
    if (migration.effect === 'add-account-identity') {
        if (!(await accountIdentityEffectComplete(connection, migration.stage))) {
            throw new Error(`Account identity ${migration.stage} postcondition is incomplete`);
        }
        return;
    }
    if (migration.effect === 'detach-best-source') {
        await verifyLeaderboardStage(connection, 'game_personal_bests', 'detached');
        return;
    }
    if (migration.effect === 'retain-receipts') {
        if (await tableExists(connection, 'game_runs')) {
            throw new Error('Receipt migration must remove the historical game_runs table name');
        }
        await verifyLeaderboardStage(connection, 'game_runs', 'receipts');
        return;
    }
    if (migration.effect === 'create-table') {
        const currentTable = migration.tableName === 'game_runs' && stage === 'receipts'
            ? 'game_submission_receipts' : migration.tableName;
        if (!(await tableExists(connection, currentTable))) {
            throw new Error(
                `Applied migration ${migration.version} is missing table ${migration.tableName}`
            );
        }
        await verifyLeaderboardStage(connection, migration.tableName, stage);
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

function assertProviderMigrationHistory(
    migrations: readonly MigrationDefinition[], migration: MigrationDefinition,
    applied: ReadonlyMap<string, unknown> | ReadonlySet<string>
): void {
    const attempts = migration.effect === 'add-provider-attempts';
    const sessions = migration.effect === 'add-account-sessions';
    const renewal = migration.effect === 'add-session-renewal';
    const passwordlessPrerequisites = migration.effect === 'add-unique-user-names' ? UNIQUE_USER_NAME_PREREQUISITES
        : migration.effect === 'allow-passwordless-accounts' ? PASSWORDLESS_ACCOUNT_PREREQUISITES
            : migration.effect === 'extend-provider-attempt-actions' ? PROVIDER_ATTEMPT_ACTIONS_PREREQUISITES : undefined;
    const prerequisites = passwordlessPrerequisites ?? (renewal ? SESSION_RENEWAL_PREREQUISITES : sessions ? ACCOUNT_SESSION_PREREQUISITES
        : attempts ? PROVIDER_ATTEMPT_PREREQUISITES : PROVIDER_IDENTITY_PREREQUISITES);
    if (!prerequisites.every(version => applied.has(version))
        || migrations.some(({ version }) => version < migration.version && !applied.has(version))) {
        const label = migration.effect === 'add-apple-revocations' || migration.effect === 'add-apple-session-provenance'
            ? 'Apple revocation migrations' : migration.effect === 'add-apple-tokens' ? 'Apple token storage' : passwordlessPrerequisites ? 'Passwordless account migrations' : renewal ? 'Session renewal'
            : sessions ? 'Account sessions' : `Provider ${attempts ? 'attempts' : 'identities'}`;
        throw new Error(`${label} require all earlier migrations to be recorded first`);
    }
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
        if (allowedEffectKinds.has('detach-best-source') || allowedEffectKinds.has('retain-receipts')) {
            if (!LEGACY_VERSIONS.every((version) => initialPlan.applied.includes(version))) {
                throw new Error('Receipt transition requires all historical migrations to be recorded first');
            }
        }
        await options.beforeApply?.(initialPlan);

        if (!hasHistory) await createHistoryTable(connection);
        const applied = [...initialPlan.applied];

        for (const migration of migrations) {
            if (applied.includes(migration.version)) continue;
            if (!allowedEffectKinds.has(migration.effect)) continue;
            if (requiresCompleteEarlierHistory(migration)) {
                assertProviderMigrationHistory(migrations, migration, new Set(applied));
            }
            if (migration.effect === 'retain-receipts' && !applied.includes(DETACH_VERSION)) {
                throw new Error('Receipt rename requires recorded personal-best detachment before DDL');
            }

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

        const finalPlan = await inspectMigrationState(connection, migrations, true);
        await options.afterApply?.(finalPlan);
        return finalPlan;
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
