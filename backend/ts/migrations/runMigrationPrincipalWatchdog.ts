import mysql, { type RowDataPacket } from 'mysql2/promise';
import { loadMigrationPrincipalAdminConfig } from '../config/migrationPrincipalConfig';
import {
    isMigrationPrincipalProfileName,
    type MigrationPrincipalProfileName,
} from './migrationPrincipalProfiles';
import {
    armMigrationPrincipalWatchdog,
    disarmMigrationPrincipalWatchdog,
} from './migrationPrincipalWatchdog';

type WatchdogCliAction = 'arm' | 'disarm';

function parseArguments(): Readonly<{
    action: WatchdogCliAction;
    profileName: MigrationPrincipalProfileName;
}> {
    const [action, profileName, ...extraArguments] = process.argv.slice(2);
    if (
        extraArguments.length > 0
        || (action !== 'arm' && action !== 'disarm')
        || !profileName
        || !isMigrationPrincipalProfileName(profileName)
    ) {
        throw new Error(
            'Usage: runMigrationPrincipalWatchdog.ts <arm|disarm> '
                + '<schema-apply|p4-backfill|p4-reconcile|empty-rollback>'
        );
    }
    return Object.freeze({ action, profileName });
}

async function main(): Promise<void> {
    const { action, profileName } = parseArguments();
    const configAction = action === 'arm' ? 'watchdog-arm' : 'watchdog-disarm';
    const config = loadMigrationPrincipalAdminConfig(configAction, profileName);
    if (config.watchdogDefiner === undefined) {
        throw new Error('Migration-watchdog definer confirmation was not loaded');
    }
    const connection = await mysql.createConnection({
        host: config.host,
        port: config.port,
        user: config.user,
        password: config.password,
        database: config.database,
        connectTimeout: 10_000,
        dateStrings: true,
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
            throw new Error('Watchdog connection selected an unexpected database or account');
        }

        if (action === 'arm') {
            if (config.watchdogDelaySeconds === undefined) {
                throw new Error('Migration-watchdog delay was not loaded');
            }
            const state = await armMigrationPrincipalWatchdog(
                connection,
                config.database,
                profileName,
                config.watchdogDelaySeconds,
                config.watchdogDefiner
            );
            console.log(
                `Temporary ${profileName} watchdog ${state.eventName} armed `
                    + `with ${state.secondsUntilExecution} second(s) remaining.`
            );
        } else {
            await disarmMigrationPrincipalWatchdog(
                connection,
                config.database,
                profileName,
                config.watchdogDefiner
            );
            console.log(
                `Temporary ${profileName} watchdog disarmed and bootstrap account dropped.`
            );
        }
    } finally {
        await connection.end();
    }
}

main().catch((error: unknown) => {
    if (
        error instanceof Error
        && (
            error.message.startsWith('Missing required environment variable:')
            || error.message.startsWith('MIGRATION_')
            || error.message.startsWith('Migration-')
            || error.message.startsWith('MySQL Event Scheduler')
            || error.message.startsWith('Temporary migration account')
            || error.message.startsWith('Usage:')
            || error.message.startsWith('Watchdog connection')
        )
    ) {
        console.error(error.message);
    } else {
        console.error('Migration-watchdog action failed; no secret was printed.');
    }
    process.exitCode = 1;
});
