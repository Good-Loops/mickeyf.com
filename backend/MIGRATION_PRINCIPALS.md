# Temporary migration database principals

This procedure creates one fixed, single-connection MySQL account for one
approved operation, runs that operation through the authenticated loopback
Cloud SQL proxy, then locks, revokes, and drops the account. The provisioner
does not deploy code, start a proxy, mutate Cloud resources, or select a Cloud
SQL instance. Those are separate approval-gated steps.

Never create more than one profile at a time. Never reuse one profile for a
different command. The migration command must exit and close its sole database
connection before revocation.

## Exact profiles

All accounts use host `%` because the server-side source identity of a proxy
connection is not a stable operator input. This broad host match is bounded by
the authenticated proxy, a generated password, `MAX_USER_CONNECTIONS 1`, a
one-day password-aging setting, and immediate explicit revocation. Password
aging is **not an account TTL**: it does not terminate an existing session, and
an authenticated MySQL user can normally change its own password. Only the
lock/revoke/drop closeout makes this account temporary. A production run also
needs an independently scheduled cleanup path for shell, host, or power loss.

| Profile | Fixed account | Required capabilities |
| --- | --- | --- |
| `schema-apply` | `mickeyf_schema_apply@%` | `CREATE`, migration-history `SELECT`/`INSERT`, FK `REFERENCES`, and reviewed-table `TRIGGER` metadata |
| `p4-backfill` | `mickeyf_p4_backfill@%` | reviewed-table `SELECT`, only `users(user_id,p4_score)` `SELECT`, personal-best `INSERT`, only `score`/`recorded_at` `UPDATE`, and reviewed-table `TRIGGER` metadata |
| `p4-reconcile` | `mickeyf_p4_reconcile@%` | reviewed-table `SELECT`, only `users(user_id,p4_score)` `SELECT`, and reviewed-table `TRIGGER` metadata |
| `empty-rollback` | `mickeyf_empty_rollback@%` | database-scoped `LOCK TABLES`, plus `SELECT`, `DROP`, and `TRIGGER` on only the three reviewed migration tables |

The executable grant statements are the immutable allowlist in
`ts/migrations/migrationPrincipalProfiles.ts`. Database identifiers are
validated and escaped; account names, host, and passwords are mysql2 query
parameters. No caller-supplied SQL fragment is accepted.

### Deliberate MySQL privilege boundaries

`p4-reconcile` performs no DML and cannot create, alter, or drop tables, but it
is **not strictly immutable**. The exact-schema verifier must see every trigger,
and MySQL hides `information_schema.TRIGGERS` without table-level `TRIGGER`.
That privilege technically permits trigger DDL. On the pinned test server,
binary-log policy independently prevented a non-`SUPER` account from creating
a trigger, while the account could still drop an existing trigger. Do not rely
on that extra server restriction in production. The single connection and
immediate lock/revoke/drop are compensating boundaries. Closeout queries the
reviewed-table trigger inventory after locking and revoking, but before
`DROP USER`; any surviving trigger blocks account removal until an operator
investigates and removes it.

MySQL similarly requires table-level `SELECT` on each generic table so the
verifier can inspect its complete column metadata; column grants make the table
look incomplete. Sensitive legacy access remains restricted to
`users.user_id` and `users.p4_score`. Schema apply requires table-level
`REFERENCES` on `users`, but receives no `SELECT` or DML there.

`DROP` also authorizes `TRUNCATE` on the three rollback tables, and
`LOCK TABLES` is grantable only at database scope. Treat `empty-rollback` as a
destructive emergency credential even though it cannot drop or read `users`.

## Provisioner prerequisites

The bootstrap credential is separate from both runtime `DB_*` credentials and
operation `MIGRATION_DB_*` credentials. Native MySQL cannot restrict
`CREATE USER`, `ALTER USER`, `DROP USER`, or `PROCESS` to these four account
names. The credential therefore has unavoidable global account-management and
session-visibility power. The CLI's fixed profile allowlist constrains this
program, not the credential itself. Issue and constrain that bootstrap identity
externally, keep it short-lived, and allow it to:

- create, alter, and drop accounts (the CLI targets only the fixed accounts);
- grant/revoke the allowlisted object capabilities with bounded `GRANT OPTION`;
- inspect other sessions (`PROCESS`) so revocation can prove the operation
  account has no open connection.

The script fails if any capability is missing. Do not use the application
runtime account. Inject both bootstrap and operation passwords into the current
process without printing them, placing them in command arguments, committing
them, or sending them to Slack.

Provisioning also refuses to create an account while
`@@GLOBAL.mandatory_roles` is nonempty, because an inherited mandatory role
would silently widen the reviewed grant profile.

## Exact create, operate, revoke sequence

The following PowerShell template is intentionally explicit. Replace values in
angle brackets only after the target instance, backup/PITR evidence, proxy
target, database, and requested operation have received their separate
approval. Do not paste a password into the command history.

```powershell
# Authenticated proxy must already be listening on this approved non-default port.
$env:MIGRATION_PRINCIPAL_ADMIN_HOST = '127.0.0.1'
$env:MIGRATION_PRINCIPAL_ADMIN_PORT = '<approved-proxy-port>'
$env:MIGRATION_PRINCIPAL_ADMIN_DATABASE = '<approved-database>'
$env:MIGRATION_PRINCIPAL_ADMIN_USER = '<short-lived-bootstrap-user>'
$env:MIGRATION_PRINCIPAL_ADMIN_PASS = '<injected-without-echo>'

# Generate one operation password in memory; do not print it.
$temporaryPasswordBytes = [byte[]]::new(32)
[Security.Cryptography.RandomNumberGenerator]::Fill($temporaryPasswordBytes)
$env:MIGRATION_PRINCIPAL_PASSWORD = [Convert]::ToBase64String($temporaryPasswordBytes)
[Array]::Clear($temporaryPasswordBytes, 0, $temporaryPasswordBytes.Length)
```

Choose exactly one row and keep its profile, account, command, and action gate
together:

| Profile | Account confirmation | Operation command | Operation gate |
| --- | --- | --- | --- |
| `schema-apply` | `mickeyf_schema_apply@%` | `npm --prefix backend run migrations:apply` | `MIGRATION_ALLOW_APPLY=1` |
| `p4-backfill` | `mickeyf_p4_backfill@%` | `npm --prefix backend run migrations:p4-backfill` | `MIGRATION_ALLOW_P4_VEGA_BACKFILL=1` |
| `p4-reconcile` | `mickeyf_p4_reconcile@%` | `npm --prefix backend run migrations:p4-reconcile` | `MIGRATION_ALLOW_P4_VEGA_RECONCILE=1` |
| `empty-rollback` | `mickeyf_empty_rollback@%` | `npm --prefix backend run migrations:rollback-empty` | `MIGRATION_ALLOW_ROLLBACK_EMPTY=1` |

For the chosen row, set the literal values and create the account:

```powershell
$profile = '<profile>'
$account = '<fixed-account-confirmation>'
$env:MIGRATION_PRINCIPAL_CONFIRM_TARGET = "127.0.0.1:$($env:MIGRATION_PRINCIPAL_ADMIN_PORT)/$($env:MIGRATION_PRINCIPAL_ADMIN_DATABASE)"
$env:MIGRATION_PRINCIPAL_CONFIRM_DATABASE = $env:MIGRATION_PRINCIPAL_ADMIN_DATABASE
$env:MIGRATION_PRINCIPAL_CONFIRM_PROFILE = $profile
$env:MIGRATION_PRINCIPAL_CONFIRM_ACCOUNT = $account
$env:MIGRATION_PRINCIPAL_ALLOW_CREATE = '1'
& npm --prefix backend run migrations:principal:create -- $profile
$createExitCode = $LASTEXITCODE
Remove-Item Env:MIGRATION_PRINCIPAL_ALLOW_CREATE
Remove-Item Env:MIGRATION_PRINCIPAL_ADMIN_PASS
if ($createExitCode -ne 0) { throw "Temporary-account creation failed with exit $createExitCode" }
```

Removing the bootstrap password here is mandatory: the ordinary migration
process must never inherit it. Reinject it from the protected source only for
the revoke command.

Configure the ordinary migration CLI with only the temporary account, set its
existing exact target confirmations and the one operation gate from the table,
then use this fixed mapping to run exactly one operation. The `finally` block
revokes on an ordinary command failure or PowerShell interruption before the
exit code is investigated:

```powershell
$env:MIGRATION_DB_HOST = '127.0.0.1'
$env:MIGRATION_DB_PORT = $env:MIGRATION_PRINCIPAL_ADMIN_PORT
$env:MIGRATION_DB_NAME = $env:MIGRATION_PRINCIPAL_ADMIN_DATABASE
$env:MIGRATION_DB_USER = $account.Split('@')[0]
$env:MIGRATION_DB_PASS = $env:MIGRATION_PRINCIPAL_PASSWORD
Remove-Item Env:MIGRATION_PRINCIPAL_PASSWORD
$env:MIGRATION_CONFIRM_DATABASE = $env:MIGRATION_DB_NAME
$env:MIGRATION_CONFIRM_TARGET = "127.0.0.1:$($env:MIGRATION_DB_PORT)/$($env:MIGRATION_DB_NAME)"

switch ($profile) {
    'schema-apply' {
        $operationScript = 'migrations:apply'
        $operationGate = 'MIGRATION_ALLOW_APPLY'
    }
    'p4-backfill' {
        $operationScript = 'migrations:p4-backfill'
        $operationGate = 'MIGRATION_ALLOW_P4_VEGA_BACKFILL'
    }
    'p4-reconcile' {
        $operationScript = 'migrations:p4-reconcile'
        $operationGate = 'MIGRATION_ALLOW_P4_VEGA_RECONCILE'
    }
    'empty-rollback' {
        $operationScript = 'migrations:rollback-empty'
        $operationGate = 'MIGRATION_ALLOW_ROLLBACK_EMPTY'
    }
    default { throw "Unmapped migration profile: $profile" }
}

$operationExitCode = 1
$revokeExitCode = 1
try {
    Set-Item "Env:$operationGate" '1'
    & npm --prefix backend run $operationScript
    $operationExitCode = $LASTEXITCODE
} finally {
    Remove-Item "Env:$operationGate" -ErrorAction SilentlyContinue
    Remove-Item Env:MIGRATION_DB_PASS -ErrorAction SilentlyContinue

    # Reinject from the protected source without echo only for closeout.
    $env:MIGRATION_PRINCIPAL_ADMIN_PASS = '<re-injected-without-echo>'
    $env:MIGRATION_PRINCIPAL_ALLOW_REVOKE = '1'
    & npm --prefix backend run migrations:principal:revoke -- $profile
    $revokeExitCode = $LASTEXITCODE
    Remove-Item Env:MIGRATION_PRINCIPAL_ALLOW_REVOKE -ErrorAction SilentlyContinue
    Remove-Item Env:MIGRATION_PRINCIPAL_ADMIN_PASS -ErrorAction SilentlyContinue
}

if ($revokeExitCode -ne 0) { throw "Temporary-account revocation failed with exit $revokeExitCode" }
if ($operationExitCode -ne 0) { throw "Migration operation failed with exit $operationExitCode" }
```

No in-process `finally` can survive host termination or power loss. The
independent bounded cleanup path required above remains a production
prerequisite; the one-day password-aging setting is not a substitute.

Revocation performs `ALTER USER ... ACCOUNT LOCK`, `REVOKE ALL PRIVILEGES,
GRANT OPTION`, an active-session count, an exact reviewed-table trigger
inventory, and finally `DROP USER`. Privilege
revocation affects an existing session on its next request. If a session is
still open, the command fails loudly after locking and revoking the account;
close that session and rerun the same revoke command. The retry is intentional
and idempotent. If trigger inventory fails, investigate and remove the
unexpected trigger as the bootstrap operator, then rerun revocation. `FLUSH
PRIVILEGES` is neither required nor used.

Finally remove all remaining operation and provisioner inputs from the current
shell. Missing variables are ignored so cleanup is safe to repeat:

```powershell
@(
    'MIGRATION_DB_HOST', 'MIGRATION_DB_PORT', 'MIGRATION_DB_NAME',
    'MIGRATION_DB_USER', 'MIGRATION_DB_PASS', 'MIGRATION_CONFIRM_DATABASE',
    'MIGRATION_CONFIRM_TARGET', 'MIGRATION_PRINCIPAL_ADMIN_HOST',
    'MIGRATION_PRINCIPAL_ADMIN_PORT', 'MIGRATION_PRINCIPAL_ADMIN_DATABASE',
    'MIGRATION_PRINCIPAL_ADMIN_USER', 'MIGRATION_PRINCIPAL_ADMIN_PASS',
    'MIGRATION_PRINCIPAL_PASSWORD', 'MIGRATION_PRINCIPAL_CONFIRM_TARGET',
    'MIGRATION_PRINCIPAL_CONFIRM_DATABASE',
    'MIGRATION_PRINCIPAL_CONFIRM_PROFILE',
    'MIGRATION_PRINCIPAL_CONFIRM_ACCOUNT',
    'MIGRATION_PRINCIPAL_ALLOW_CREATE', 'MIGRATION_PRINCIPAL_ALLOW_REVOKE',
    'MIGRATION_ALLOW_APPLY', 'MIGRATION_ALLOW_ROLLBACK_EMPTY',
    'MIGRATION_ALLOW_P4_VEGA_BACKFILL',
    'MIGRATION_ALLOW_P4_VEGA_RECONCILE'
) | ForEach-Object { Remove-Item "Env:$_" -ErrorAction SilentlyContinue }
Remove-Variable temporaryPasswordBytes -ErrorAction SilentlyContinue
```

A successful operation is not complete until the revoke command reports that
the account was revoked and dropped.

## Local verification

`npm --prefix backend run test:migrations` provisions every profile in the
pinned disposable MySQL 8.0.31 container, executes its real operation, proves
ordinary DML/table-DDL and cross-schema denials, exercises trigger detection and
cleanup, behaviorally rejects a concurrent second connection, checks the
configured one-day password-aging interval without treating it as a TTL, and
proves reconnect denial after revocation. The harness removes the container,
volume, accounts, and sentinel schema even on failure.
