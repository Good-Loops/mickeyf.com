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
    table: 'users' | 'game_submission_receipts' | 'game_personal_bests' | 'schema_migrations' | 'account_sessions'
        | 'account_provider_identities' | 'provider_auth_attempts' | 'apple_provider_tokens' | 'apple_auth_revocations';
    grants: readonly RuntimeColumnGrant[];
    tablePrivileges: readonly 'DELETE'[];
}>;

export type RuntimeTablePrivilege = Readonly<{
    tableName: RuntimeTableGrant['table'];
    privilegeType: 'DELETE';
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
 * Exact runtime DML plus two read-only migration fields for identity-epoch
 * verification. Migration writes and schema changes remain maintenance-only.
 */
export const RUNTIME_GRANT_MANIFEST: readonly RuntimeTableGrant[] = Object.freeze([
    Object.freeze({
        table: 'apple_auth_revocations' as const,
        tablePrivileges: Object.freeze(['DELETE' as const]),
        grants: Object.freeze([
            Object.freeze({ privilege: 'SELECT' as const, columns: Object.freeze(['subject_hash', 'revoked_at', 'expires_at']) }),
            Object.freeze({ privilege: 'INSERT' as const, columns: Object.freeze(['subject_hash', 'revoked_at', 'expires_at']) }),
            Object.freeze({ privilege: 'UPDATE' as const, columns: Object.freeze(['revoked_at', 'expires_at']) }),
        ]),
    }),
    Object.freeze({
        table: 'apple_provider_tokens' as const,
        tablePrivileges: Object.freeze(['DELETE' as const]),
        grants: Object.freeze([
            Object.freeze({ privilege: 'SELECT' as const,
                columns: Object.freeze(['token_id', 'account_uuid', 'client_id', 'encrypted_token', 'created_at',
                    'revocation_requested_at', 'next_attempt_at', 'retention_deadline', 'attempt_count']) }),
            Object.freeze({ privilege: 'INSERT' as const,
                columns: Object.freeze(['token_id', 'account_uuid', 'client_id', 'encrypted_token', 'created_at']) }),
            Object.freeze({ privilege: 'UPDATE' as const,
                columns: Object.freeze(['revocation_requested_at', 'next_attempt_at', 'retention_deadline', 'attempt_count']) }),
        ]),
    }),
    Object.freeze({
        table: 'account_sessions' as const,
        tablePrivileges: Object.freeze(['DELETE' as const]),
        grants: Object.freeze([
            Object.freeze({ privilege: 'SELECT' as const,
                columns: Object.freeze(['session_hash', 'account_uuid', 'created_at', 'expires_at',
                    'remembered', 'renewed_at', 'previous_session_hash', 'previous_valid_until',
                    'apple_subject_hash', 'apple_authenticated_at']) }),
            Object.freeze({ privilege: 'INSERT' as const,
                columns: Object.freeze(['session_hash', 'account_uuid', 'created_at', 'expires_at',
                    'remembered', 'renewed_at', 'apple_subject_hash', 'apple_authenticated_at']) }),
            Object.freeze({ privilege: 'UPDATE' as const,
                columns: Object.freeze(['session_hash', 'expires_at', 'renewed_at',
                    'previous_session_hash', 'previous_valid_until']) }),
        ]),
    }),
    Object.freeze({
        table: 'account_provider_identities' as const,
        tablePrivileges: Object.freeze([]),
        grants: Object.freeze([
            Object.freeze({ privilege: 'SELECT' as const,
                columns: Object.freeze(['provider', 'subject', 'account_uuid']) }),
            Object.freeze({ privilege: 'INSERT' as const,
                columns: Object.freeze(['provider', 'subject', 'account_uuid', 'linked_at']) }),
            // MySQL 8.0.31 requires a write privilege for SELECT ... FOR UPDATE.
            // Identity reassignment and direct identity deletion remain forbidden.
            Object.freeze({ privilege: 'UPDATE' as const,
                columns: Object.freeze(['linked_at']) }),
        ]),
    }),
    Object.freeze({
        table: 'provider_auth_attempts' as const,
        tablePrivileges: Object.freeze(['DELETE' as const]),
        grants: Object.freeze([
            Object.freeze({ privilege: 'SELECT' as const,
                columns: Object.freeze(['state_hash', 'binding_hash', 'nonce', 'client_key',
                    'action', 'user_id', 'account_uuid', 'expires_at']) }),
            Object.freeze({ privilege: 'INSERT' as const,
                columns: Object.freeze(['state_hash', 'binding_hash', 'nonce', 'client_key',
                    'action', 'user_id', 'account_uuid', 'expires_at']) }),
        ]),
    }),
    Object.freeze({
        table: 'schema_migrations' as const,
        tablePrivileges: Object.freeze([]),
        grants: Object.freeze([
            Object.freeze({ privilege: 'SELECT' as const,
                columns: Object.freeze(['version', 'applied_at']) }),
        ]),
    }),
    Object.freeze({
        table: 'users' as const,
        tablePrivileges: Object.freeze(['DELETE' as const]),
        grants: Object.freeze([
            Object.freeze({
                privilege: 'SELECT' as const,
                columns: Object.freeze([
                    'user_id',
                    'account_uuid',
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
        table: 'game_submission_receipts' as const,
        tablePrivileges: Object.freeze(['DELETE' as const]),
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
                    'improved_personal_best',
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
                    'improved_personal_best',
                    'submitted_at',
                ]),
            }),
        ]),
    }),
    Object.freeze({
        table: 'game_personal_bests' as const,
        tablePrivileges: Object.freeze(['DELETE' as const]),
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
                ]),
            }),
            Object.freeze({
                privilege: 'UPDATE' as const,
                columns: Object.freeze([
                    'score',
                    'completion_time_ms',
                    'recorded_at',
                ]),
            }),
        ]),
    }),
]);

const SAFE_IDENTIFIER = /^[A-Za-z0-9_]{1,64}$/u;
const SAFE_ACCOUNT_PART = /^[A-Za-z0-9_.%~\-]{1,255}$/u;

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

export function runtimeTablePrivilegeInventory(): readonly RuntimeTablePrivilege[] {
    // MySQL cannot restrict DELETE by column. Attempts need consumption and sessions need revocation;
    // the account and its dependent data tables need transactional self-deletion.
    return Object.freeze(RUNTIME_GRANT_MANIFEST.flatMap(({ table, tablePrivileges }) =>
        tablePrivileges.map((privilegeType) => Object.freeze({
            tableName: table,
            privilegeType,
        }))
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

    return Object.freeze(RUNTIME_GRANT_MANIFEST.map(({ table, grants, tablePrivileges }) => {
        const columnPrivileges = grants.map(({ privilege, columns }) => {
            const columnList = columns
                .map((column) => quoteIdentifier(column, 'Column name'))
                .join(', ');
            return `${privilege} (${columnList})`;
        });
        const privileges = [...columnPrivileges, ...tablePrivileges].join(', ');

        return `GRANT ${privileges} ON ${database}.${quoteIdentifier(
            table,
            'Table name'
        )} TO ${principal};`;
    }));
}
