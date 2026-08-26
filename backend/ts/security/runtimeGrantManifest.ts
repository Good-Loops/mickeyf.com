export type RuntimeDatabaseAccount = Readonly<{
    user: string;
    host: string;
}>;

export type RuntimeDmlPrivilege = 'SELECT' | 'INSERT' | 'UPDATE';

export type RuntimeColumnGrant = Readonly<{
    privilege: RuntimeDmlPrivilege;
    columns: readonly string[];
}>;

export type RuntimeTableGrant = Readonly<{
    table: 'users' | 'game_runs' | 'game_personal_bests';
    grants: readonly RuntimeColumnGrant[];
}>;

export type RuntimeColumnPrivilege = Readonly<{
    tableName: RuntimeTableGrant['table'];
    columnName: string;
    privilegeType: RuntimeDmlPrivilege;
}>;

export const PRODUCTION_RUNTIME_DATABASE_ACCOUNT: RuntimeDatabaseAccount =
    Object.freeze({
        user: 'cms_mickeyf',
        host: '%',
    });

export const PRODUCTION_RUNTIME_DATABASE_ROLE: RuntimeDatabaseAccount =
    Object.freeze({
        user: 'cloudsqlsuperuser',
        host: '%',
    });

/**
 * Exact application-runtime DML. Migration history and schema changes belong
 * to a separate maintenance identity and are deliberately absent here.
 */
export const RUNTIME_GRANT_MANIFEST: readonly RuntimeTableGrant[] = Object.freeze([
    Object.freeze({
        table: 'users' as const,
        grants: Object.freeze([
            Object.freeze({
                privilege: 'SELECT' as const,
                columns: Object.freeze([
                    'user_id',
                    'user_name',
                    'email',
                    'user_password',
                ]),
            }),
            Object.freeze({
                privilege: 'INSERT' as const,
                columns: Object.freeze([
                    'user_name',
                    'email',
                    'user_password',
                ]),
            }),
        ]),
    }),
    Object.freeze({
        table: 'game_runs' as const,
        grants: Object.freeze([
            Object.freeze({
                privilege: 'SELECT' as const,
                columns: Object.freeze([
                    'game_id',
                    'rules_version',
                    'user_id',
                    'run_id',
                    'score',
                    'completion_time_ms',
                    'payload_fingerprint',
                    'personal_best',
                    'submitted_at',
                ]),
            }),
            Object.freeze({
                privilege: 'INSERT' as const,
                columns: Object.freeze([
                    'game_id',
                    'rules_version',
                    'user_id',
                    'run_id',
                    'score',
                    'completion_time_ms',
                    'payload_fingerprint',
                    'personal_best',
                    'submitted_at',
                ]),
            }),
        ]),
    }),
    Object.freeze({
        table: 'game_personal_bests' as const,
        grants: Object.freeze([
            Object.freeze({
                privilege: 'SELECT' as const,
                columns: Object.freeze([
                    'game_id',
                    'rules_version',
                    'user_id',
                    'score',
                    'completion_time_ms',
                    'recorded_at',
                ]),
            }),
            Object.freeze({
                privilege: 'INSERT' as const,
                columns: Object.freeze([
                    'game_id',
                    'rules_version',
                    'user_id',
                    'score',
                    'completion_time_ms',
                    'recorded_at',
                    'source_game_run_id',
                ]),
            }),
            Object.freeze({
                privilege: 'UPDATE' as const,
                columns: Object.freeze([
                    'score',
                    'completion_time_ms',
                    'recorded_at',
                    'source_game_run_id',
                ]),
            }),
        ]),
    }),
]);

const SAFE_IDENTIFIER = /^[A-Za-z0-9_]{1,64}$/u;
const SAFE_ACCOUNT_PART = /^[A-Za-z0-9_.%\-]{1,255}$/u;

function quoteIdentifier(value: string, label: string): string {
    if (!SAFE_IDENTIFIER.test(value)) {
        throw new TypeError(`${label} must be a simple MySQL identifier`);
    }
    return `\`${value}\``;
}

export function renderRuntimeDatabaseAccount(
    account: RuntimeDatabaseAccount
): string {
    if (
        !SAFE_ACCOUNT_PART.test(account.user)
        || !SAFE_ACCOUNT_PART.test(account.host)
    ) {
        throw new TypeError('Runtime database account contains unsupported characters');
    }
    return `'${account.user}'@'${account.host}'`;
}

export function runtimeDatabaseAccountName(
    account: RuntimeDatabaseAccount
): string {
    // Validate through the SQL renderer so confirmations and statements accept
    // exactly the same deliberately narrow account syntax.
    renderRuntimeDatabaseAccount(account);
    return `${account.user}@${account.host}`;
}

export function runtimeColumnPrivilegeInventory(): readonly RuntimeColumnPrivilege[] {
    return Object.freeze(RUNTIME_GRANT_MANIFEST.flatMap(({ table, grants }) =>
        grants.flatMap(({ privilege, columns }) => columns.map((columnName) =>
            Object.freeze({
                tableName: table,
                columnName,
                privilegeType: privilege,
            })
        ))
    ));
}

/**
 * Renders reviewable statements but never opens a database connection or
 * changes privileges by itself.
 */
export function renderRuntimeGrantStatements(
    databaseName: string,
    account: RuntimeDatabaseAccount
): readonly string[] {
    const database = quoteIdentifier(databaseName, 'Database name');
    const principal = renderRuntimeDatabaseAccount(account);

    return Object.freeze(RUNTIME_GRANT_MANIFEST.map(({ table, grants }) => {
        const privileges = grants.map(({ privilege, columns }) => {
            const columnList = columns
                .map((column) => quoteIdentifier(column, 'Column name'))
                .join(', ');
            return `${privilege} (${columnList})`;
        }).join(', ');

        return `GRANT ${privileges} ON ${database}.${quoteIdentifier(
            table,
            'Table name'
        )} TO ${principal};`;
    }));
}

/**
 * Renders the single, atomic privilege statement used after the frozen
 * generic-only runtime has been deployed and every old runtime session has
 * drained. It deliberately names only the two transitional p4_score grants.
 */
export function renderP4VegaGrantRetirementStatement(
    databaseName: string,
    account: RuntimeDatabaseAccount
): string {
    const database = quoteIdentifier(databaseName, 'Database name');
    const principal = renderRuntimeDatabaseAccount(account);

    return `REVOKE SELECT (\`p4_score\`), UPDATE (\`p4_score\`) ON ${
        database
    }.\`users\` FROM ${principal};`;
}
