import mysql from 'mysql2';

export const MIGRATION_PRINCIPAL_HOST = '%' as const;
export const MIGRATION_PRINCIPAL_BOOTSTRAP_ACCOUNT =
    'mickeyf_migration_bootstrap' as const;
export const MIGRATION_PRINCIPAL_WATCHDOG_ARMER_ACCOUNT = 'cms_mickeyf' as const;

export const MIGRATION_PRINCIPAL_PROFILE_NAMES = Object.freeze([
    'schema-apply',
    'p4-backfill',
    'p4-reconcile',
    'empty-rollback',
] as const);

export const MIGRATION_PRINCIPAL_REVIEWED_TABLES = Object.freeze([
    'schema_migrations',
    'game_runs',
    'game_personal_bests',
] as const);

export type MigrationPrincipalProfileName =
    typeof MIGRATION_PRINCIPAL_PROFILE_NAMES[number];

type TableGrant = Readonly<{
    scope: 'table';
    tableName: 'users' | 'schema_migrations' | 'game_runs' | 'game_personal_bests';
    privileges: string;
}>;

type DatabaseGrant = Readonly<{
    scope: 'database';
    privileges: string;
}>;

type PrincipalGrant = TableGrant | DatabaseGrant;

export type MigrationPrincipalProfile = Readonly<{
    name: MigrationPrincipalProfileName;
    accountName: string;
    grants: readonly PrincipalGrant[];
}>;

const profiles: Readonly<Record<
    MigrationPrincipalProfileName,
    MigrationPrincipalProfile
>> = Object.freeze({
    'schema-apply': profile(
        'schema-apply',
        'mickeyf_schema_apply',
        [
            tableGrant(
                'schema_migrations',
                'CREATE, SELECT, INSERT, TRIGGER'
            ),
            // REFERENCES is table-scoped because this table does not exist when
            // the temporary account is provisioned. Column grants cannot be
            // issued against columns which MySQL has not created yet.
            tableGrant('game_runs', 'CREATE, REFERENCES, TRIGGER'),
            // REFERENCES is metadata-only here; unlike CREATE/TRIGGER, it makes
            // all columns visible to the exact-schema verifier after creation.
            tableGrant('game_personal_bests', 'CREATE, REFERENCES, TRIGGER'),
            // MySQL 8.0.31 requires table-level REFERENCES when CREATE TABLE
            // declares the foreign key; a column grant is rejected.
            tableGrant('users', 'REFERENCES'),
        ]
    ),
    'p4-backfill': profile(
        'p4-backfill',
        'mickeyf_p4_backfill',
        [
            // The exact-schema verifier inspects every column. MySQL filters
            // information_schema.COLUMNS down to column-level SELECT grants,
            // even when TRIGGER is also present, so these three reviewed tables
            // require table-level SELECT.
            tableGrant('schema_migrations', 'SELECT, TRIGGER'),
            tableGrant('users', 'SELECT (user_id, p4_score)'),
            tableGrant('game_runs', 'SELECT, TRIGGER'),
            tableGrant(
                'game_personal_bests',
                'SELECT, '
                    + 'INSERT (game_id, rules_version, user_id, score, '
                    + 'completion_time_ms, recorded_at, source_game_run_id), '
                    + 'UPDATE (score, recorded_at), TRIGGER'
            ),
        ]
    ),
    'p4-reconcile': profile(
        'p4-reconcile',
        'mickeyf_p4_reconcile',
        [
            tableGrant('schema_migrations', 'SELECT, TRIGGER'),
            tableGrant('users', 'SELECT (user_id, p4_score)'),
            tableGrant('game_runs', 'SELECT, TRIGGER'),
            tableGrant('game_personal_bests', 'SELECT, TRIGGER'),
        ]
    ),
    'empty-rollback': profile(
        'empty-rollback',
        'mickeyf_empty_rollback',
        [
            // MySQL grants LOCK TABLES only at database scope. Object-level
            // SELECT/DROP below still limits which tables this account can read
            // or destroy.
            databaseGrant('LOCK TABLES'),
            tableGrant('schema_migrations', 'SELECT, DROP, TRIGGER'),
            tableGrant('game_runs', 'SELECT, DROP, TRIGGER'),
            tableGrant('game_personal_bests', 'SELECT, DROP, TRIGGER'),
        ]
    ),
});

function tableGrant(
    tableName: TableGrant['tableName'],
    privileges: string
): TableGrant {
    return Object.freeze({ scope: 'table', tableName, privileges });
}

function databaseGrant(privileges: string): DatabaseGrant {
    return Object.freeze({ scope: 'database', privileges });
}

function profile(
    name: MigrationPrincipalProfileName,
    accountName: string,
    grants: readonly PrincipalGrant[]
): MigrationPrincipalProfile {
    return Object.freeze({
        name,
        accountName,
        grants: Object.freeze([...grants]),
    });
}

export function isMigrationPrincipalProfileName(
    value: string
): value is MigrationPrincipalProfileName {
    return (MIGRATION_PRINCIPAL_PROFILE_NAMES as readonly string[]).includes(value);
}

export function getMigrationPrincipalProfile(
    name: MigrationPrincipalProfileName
): MigrationPrincipalProfile {
    return profiles[name];
}

export function quoteMigrationPrincipalDatabaseName(database: string): string {
    // Restrict the operator-controlled identifier before escaping it. The live
    // database names used by this project fit this intentionally narrow set.
    if (!/^[A-Za-z0-9_$-]{1,64}$/u.test(database)) {
        throw new Error(
            'Migration-principal database name must contain only ASCII letters, '
                + 'digits, underscore, dollar sign, or hyphen (maximum 64 characters)'
        );
    }
    return mysql.escapeId(database, true);
}

export function buildMigrationPrincipalGrantStatements(
    database: string,
    profileName: MigrationPrincipalProfileName
): readonly string[] {
    const quotedDatabase = quoteMigrationPrincipalDatabaseName(database);
    return Object.freeze(getMigrationPrincipalProfile(profileName).grants.map((grant) => {
        const object = grant.scope === 'database'
            ? `${quotedDatabase}.*`
            : `${quotedDatabase}.${mysql.escapeId(grant.tableName, true)}`;
        return `GRANT ${grant.privileges} ON ${object} TO ?@?`;
    }));
}
