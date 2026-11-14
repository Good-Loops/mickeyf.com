import { createHash } from 'node:crypto';
import type { MigrationDefinition } from './migrationManifest';
import type { MigrationPlan } from './migrationRunner';

type DatabaseIdentity = Readonly<{ databaseName: string; currentUser: string; serverUuid: string;
    serverVersion: string; versionComment: string }>;

/** Bind the one additive change to the reviewed server, account, history and SQL bytes. */
export function signedParentFormPlan(database: DatabaseIdentity, migrations: readonly MigrationDefinition[], schema: MigrationPlan) {
    const migration = migrations.find(item => item.effect === 'add-signed-parent-forms');
    if (!migration || migrations.length !== 26 || schema.applied.length !== 25
        || migrations.slice(0, 25).some(item => !schema.applied.includes(item.version))
        || schema.pending.length !== 1 || schema.pending[0] !== migration.version
        || schema.recoverable.some(version => version !== migration.version)) {
        throw new Error('Signed form operation requires the exact recorded 0001-0025 history and only migration 0026 pending.');
    }
    const payload = { formatVersion: 1, command: 'signed-parent-forms-apply', database,
        migration: { version: migration.version, checksumSha256: migration.checksum.toString('hex') }, schema };
    return Object.freeze({ ...payload, sha256: createHash('sha256').update(JSON.stringify(payload)).digest('hex') });
}

export function assertSignedParentFormPlan(plan: ReturnType<typeof signedParentFormPlan>, env: Readonly<Record<string, string | undefined>>) {
    if (env.MIGRATION_CONFIRM_SERVER_UUID !== plan.database.serverUuid
        || env.MIGRATION_APPROVED_PLAN_SHA256 !== plan.sha256) {
        throw new Error('Signed form operation requires the exact confirmed server UUID and freshly approved plan SHA256.');
    }
}
