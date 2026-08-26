import mysql, { type RowDataPacket } from 'mysql2/promise';
import {
    loadMigrationPrincipalAdminConfig,
    type MigrationPrincipalAction,
} from '../config/migrationPrincipalConfig';
import {
    ActiveMigrationPrincipalConnectionsError,
    createTemporaryMigrationPrincipal,
    MandatoryMigrationRoleError,
    MigrationPrincipalProvisioningError,
    revokeTemporaryMigrationPrincipal,
    UnexpectedMigrationTriggerError,
} from './migrationPrincipalManager';
import {
    getMigrationPrincipalProfile,
    isMigrationPrincipalProfileName,
    MIGRATION_PRINCIPAL_HOST,
} from './migrationPrincipalProfiles';

function parseArguments(): Readonly<{
    action: MigrationPrincipalAction;
    profileName: Parameters<typeof getMigrationPrincipalProfile>[0];
}> {
    const [action, profileName, ...extraArguments] = process.argv.slice(2);
    if (
        extraArguments.length > 0
        || (action !== 'create' && action !== 'revoke')
        || !profileName
        || !isMigrationPrincipalProfileName(profileName)
    ) {
        throw new Error(
            'Usage: runMigrationPrincipal.ts <create|revoke> '
                + '<schema-apply|p4-backfill|p4-reconcile|empty-rollback>'
        );
    }
    return Object.freeze({ action, profileName });
}

async function main(): Promise<void> {
    const { action, profileName } = parseArguments();
    // All confirmations and the action-specific gate are checked before this
    // privileged socket is opened.
    const config = loadMigrationPrincipalAdminConfig(action, profileName);
    const connection = await mysql.createConnection({
        host: config.host,
        port: config.port,
        user: config.user,
        password: config.password,
        database: config.database,
        connectTimeout: 10_000,
        multipleStatements: false,
    });

    try {
        const [rows] = await connection.query<Array<RowDataPacket & {
            databaseName: string;
            currentUser: string;
        }>>('SELECT DATABASE() AS databaseName, CURRENT_USER() AS currentUser');
        if (
            rows.length !== 1
            || rows[0].databaseName !== config.database
            || rows[0].currentUser !== `${config.user}@%`
        ) {
            throw new Error(
                'Provisioning connection selected an unexpected database or account'
            );
        }

        if (action === 'create') {
            if (
                config.principalPassword === undefined
                || config.watchdogDefiner === undefined
            ) {
                throw new Error('Temporary principal or watchdog configuration was not loaded');
            }
            await createTemporaryMigrationPrincipal(
                connection,
                config.database,
                profileName,
                config.principalPassword,
                config.watchdogDefiner
            );
        } else {
            await revokeTemporaryMigrationPrincipal(
                connection,
                config.database,
                profileName
            );
        }
    } finally {
        await connection.end();
    }

    const profile = getMigrationPrincipalProfile(profileName);
    const result = action === 'create' ? 'created' : 'revoked and dropped';
    console.log(
        `Temporary ${profileName} account `
            + `${profile.accountName}@${MIGRATION_PRINCIPAL_HOST} ${result}.`
    );
}

main().catch((error: unknown) => {
    if (
        error instanceof ActiveMigrationPrincipalConnectionsError
        || error instanceof MigrationPrincipalProvisioningError
        || error instanceof MandatoryMigrationRoleError
        || error instanceof UnexpectedMigrationTriggerError
    ) {
        console.error(error.message);
    } else if (
        error instanceof Error
        && (
            error.message.startsWith('Missing required environment variable:')
            || error.message.startsWith('MIGRATION_')
            || error.message.startsWith('Provisioning administrator')
            || error.message.startsWith('Temporary migration-principal password')
            || error.message.startsWith('Usage:')
        )
    ) {
        console.error(error.message);
    } else {
        // mysql2 errors may carry a fully formatted CREATE USER statement in
        // their `sql` property. Never serialize the error object or secret SQL.
        console.error('Migration-principal account action failed; no secret was printed.');
    }
    process.exitCode = 1;
});
