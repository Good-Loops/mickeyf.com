import { createHash } from 'node:crypto';
import type { AccountIdentityConfirmation } from '../config/accountIdentityMigrationConfig';
import { PRODUCTION_CLOUD_SQL_TARGET } from '../security/cloudSqlRuntimeRoleRemover';
import type { MigrationConnection } from './leaderboardSchema';
import type { MigrationDefinition } from './migrationManifest';
import { applyMigrations, planMigrations, type MigrationPlan, type MigrationRunnerSettings } from './migrationRunner';
import { ACCOUNT_IDENTITY_MIGRATION_VERSION } from './accountIdentitySchema';

export type AccountIdentityDatabase = Readonly<{
    databaseName: string; currentUser: string; serverUuid: string;
    serverVersion: string; versionComment: string;
}>;

function buildPlan(
    migrations: readonly MigrationDefinition[], schema: MigrationPlan, database: AccountIdentityDatabase
) {
    const identityMigrations = migrations.filter(({ effect }) => effect === 'add-account-identity');
    const migration = identityMigrations.at(-1);
    if (identityMigrations.length !== 3 || migration?.version !== ACCOUNT_IDENTITY_MIGRATION_VERSION) {
        throw new Error('Reviewed account identity migration set is missing');
    }
    const blockers: string[] = [];
    if (migrations.filter(({ version }) => version < identityMigrations[0].version)
        .some(({ version }) => !schema.applied.includes(version))) {
        blockers.push('all earlier migrations must be recorded first');
    }
    if (database.databaseName === 'cms' && database.serverUuid !== PRODUCTION_CLOUD_SQL_TARGET.serverUuid) {
        blockers.push('production database name requires the independently pinned Cloud SQL UUID');
    }
    const state = blockers.length ? 'blocked'
        : schema.applied.includes(migration.version) ? 'applied'
            : schema.recoverable.includes(migration.version) ? 'recoverable' : 'ready';
    const payload = {
        formatVersion: 1, state, database, schema,
        migrations: identityMigrations.map(({ version, checksum }) => ({ version, checksumSha256: checksum.toString('hex') })),
        blockers,
    };
    return Object.freeze({ ...payload, sha256: createHash('sha256').update(JSON.stringify(payload)).digest('hex') });
}

export async function planAccountIdentityMigration(
    connection: MigrationConnection, migrations: readonly MigrationDefinition[],
    settings: MigrationRunnerSettings, database: AccountIdentityDatabase
) {
    return buildPlan(migrations, await planMigrations(connection, migrations, settings), database);
}

export async function applyAccountIdentityMigration(
    connection: MigrationConnection, migrations: readonly MigrationDefinition[],
    settings: MigrationRunnerSettings, database: AccountIdentityDatabase,
    confirmation: AccountIdentityConfirmation
) {
    if (database.serverUuid !== confirmation.confirmedServerUuid) {
        throw new Error('Account identity server UUID does not match confirmation');
    }
    const schema = await applyMigrations(connection, migrations, settings, {
        allowedEffectKinds: ['add-account-identity'],
        beforeApply: async (initialSchema) => {
            const plan = buildPlan(migrations, initialSchema, database);
            if (plan.sha256 !== confirmation.approvedPlanSha256) {
                throw new Error('Account identity approved plan digest does not match the current plan');
            }
            if (plan.state !== 'ready' && plan.state !== 'recoverable') {
                throw new Error(`Account identity migration is blocked in state ${plan.state}`);
            }
        },
    });
    return buildPlan(migrations, schema, database);
}
