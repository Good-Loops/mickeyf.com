# Temporary migration database principals

This procedure creates one fixed, single-connection MySQL account for one
approved operation, then locks, revokes, and drops it. A one-time MySQL Event
Scheduler watchdog is armed **before either temporary privileged account
exists**, so cleanup survives the controlling PowerShell process, proxy, host,
or power failing.

The repository does not select a Cloud SQL instance, start a proxy, create the
Cloud SQL bootstrap user, or authorize production changes. Those remain
separate approval-gated steps. Never create more than one profile at a time and
never reuse a profile for a different command.

## Fixed identities and profiles

All MySQL accounts use host `%` because the server-side source identity behind
the authenticated proxy is not a stable operator input. This broad host match
is bounded by the proxy, generated passwords, fixed account allowlists,
`MAX_USER_CONNECTIONS 1`, account locking, and immediate revocation. The
one-day password-aging setting is **not a TTL** and does not terminate an open
session.

| Purpose | Fixed MySQL account |
| --- | --- |
| Watchdog armer | `cms_mickeyf@%` |
| Principal administrator | `mickeyf_migration_bootstrap@%` |
| Allowed watchdog definer | exactly `root@%` or `cms_mickeyf@%` |

The armer identity is used only to arm. The bootstrap identity is required for
operation-account creation, normal revocation, and watchdog disarm. Both CLIs
verify `DATABASE()` and `CURRENT_USER()` exactly, so MySQL account resolution
cannot silently substitute another account. The selected watchdog definer is
independent of the connection identity and must be explicitly confirmed.

| Profile | Fixed operation account | Fixed event | Required capabilities |
| --- | --- | --- | --- |
| `schema-apply` | `mickeyf_schema_apply@%` | `mickeyf_watchdog_schema_apply` | `CREATE`, migration-history `SELECT`/`INSERT`, FK `REFERENCES`, and reviewed-table `TRIGGER` metadata |
| `p4-backfill` | `mickeyf_p4_backfill@%` | `mickeyf_watchdog_p4_backfill` | reviewed-table `SELECT`, only `users(user_id,p4_score)` `SELECT`, personal-best `INSERT`, only `score`/`recorded_at` `UPDATE`, and reviewed-table `TRIGGER` metadata |
| `p4-reconcile` | `mickeyf_p4_reconcile@%` | `mickeyf_watchdog_p4_reconcile` | reviewed-table `SELECT`, only `users(user_id,p4_score)` `SELECT`, and reviewed-table `TRIGGER` metadata |
| `empty-rollback` | `mickeyf_empty_rollback@%` | `mickeyf_watchdog_empty_rollback` | database-scoped `LOCK TABLES`, plus `SELECT`, `DROP`, and `TRIGGER` on only the three reviewed migration tables |

The executable allowlists are in
`ts/migrations/migrationPrincipalProfiles.ts` and
`ts/migrations/migrationPrincipalWatchdog.ts`. Database identifiers are
strictly validated and escaped. Account names, host, and passwords are fixed or
mysql2 parameters; no caller-provided SQL fragment is accepted.

### Deliberate MySQL privilege boundaries

`p4-reconcile` performs no DML and cannot create, alter, or drop tables, but it
is not strictly immutable. The exact-schema verifier needs table-level
`TRIGGER` to see every trigger in `information_schema`; that privilege can also
permit trigger DDL. Closeout audits the three reviewed tables after locking and
revoking. A surviving trigger prevents `DROP USER` until an operator removes
it. Table-level `SELECT` is similarly needed for complete column metadata.
Sensitive legacy access remains restricted to `users.user_id` and
`users.p4_score`.

`DROP` also authorizes `TRUNCATE` on the three rollback tables, and
`LOCK TABLES` is grantable only at database scope. Treat `empty-rollback` as a
destructive emergency credential even though it cannot drop or read `users`.

## Independent watchdog contract

Each profile owns one compile-time event name and exact event body. Arming:

- refuses unless `@@GLOBAL.event_scheduler` is `ON`;
- refuses unless both the bootstrap and selected operation account are absent;
- requires the selected allowlisted definer to exist exactly once;
- fixes the creation session to `time_zone = '+00:00'` and the reviewed
  `SQL_MODE`;
- schedules from server time for 120 through 1,800 seconds, preserves the event
  after its one attempt, and requires at least 60 seconds to remain before an
  operation account may be created;
- reads the event back and requires exact schema, name, definer, body, time
  zone, SQL mode, schedule, status, completion policy, comment, and deadline.

Operation-account provisioning then verifies the event, creates the account
`ACCOUNT LOCK`, installs the allowlisted grants while it remains unusable,
revalidates the exact event and deadline, and makes `ACCOUNT UNLOCK` the final
statement. A crash during provisioning therefore leaves either a harmless
locked account or a locked privileged account guarded by the watchdog.

At its deadline, the event conditionally locks both fixed temporary accounts.
It explicitly revokes the bootstrap account's `cloudsqlsuperuser` role because
`REVOKE ALL PRIVILEGES` does not revoke roles, then revokes direct privileges
from both accounts. Before dropping the bootstrap it audits every event,
routine, trigger, and view whose definer is exactly
`mickeyf_migration_bootstrap@%`. Before dropping the operation account it
audits triggers on `schema_migrations`, `game_runs`, and
`game_personal_bests`.

If the bootstrap owns any definer object, both accounts remain locked and
revoked and the event signals an error. If an unexpected reviewed-table
trigger exists, the bootstrap is dropped but the operation account remains
locked and revoked. Otherwise both temporary accounts are dropped. The event's
`LAST_EXECUTED` value means only that execution was attempted: MySQL records it
for both success and `SIGNAL` failure. Always verify account lock, grants,
existence, and definer-object outcomes directly.

`ON COMPLETION PRESERVE` intentionally leaves the event disabled after its
attempt. Normal disarm is itself crash-bounded. Authenticated as the fixed
bootstrap, it first requires zero bootstrap-definer objects, locks its own
account, reads back the complete reviewed event, drops the event, proves event
absence, and executes `DROP USER mickeyf_migration_bootstrap@%` as its final SQL
statement. If the process dies after event removal, at worst the bootstrap is
left locked. The CLI then closes its already-open session. An independent
administrator must verify bootstrap absence after closeout.

## Administrator prerequisites

Native MySQL cannot restrict global account-management privileges to these
four operation names. Fixed application allowlists constrain these CLIs, not a
stolen administrator credential. Keep administrator credentials out of
runtime `DB_*`, operation `MIGRATION_DB_*`, command arguments, source control,
logs, and Slack.

Before production, perform a live privilege probe on the selected instance:

- `cms_mickeyf@%` must read the required account/event metadata and create the
  fixed event. Creating an event with a different explicit definer can require
  both `SET_USER_ID` and `SYSTEM_USER` on MySQL 8.0.31; Cloud SQL may not make
  that combination available. This is why `root@%` and `cms_mickeyf@%` remain
  separate, explicitly tested candidates rather than an assumed default.
- On pinned MySQL 8.0.31, dropping a `root@%`-definer event also requires the
  bootstrap to hold `SYSTEM_USER`. Do not add that privilege merely to make the
  root path work. The tested `cms_mickeyf@%`-definer path lets a bootstrap
  without `SYSTEM_USER` disarm normally and is the narrower candidate if the
  live Cloud SQL probe agrees.
- The selected event definer must retain account lock, role/direct-grant
  revocation, metadata audit, and user-drop capabilities until the deadline.
- The externally created `mickeyf_migration_bootstrap@%` account must create,
  alter, grant to, revoke from, and drop the fixed operation accounts; inspect
  sessions with `PROCESS`; inspect event/trigger/definer metadata; drop the
  fixed event; and lock and drop itself during normal closeout.

Provisioning refuses a nonempty `@@GLOBAL.mandatory_roles`, because an inherited
mandatory role would silently widen an operation profile.

## Exact arm, create, operate, revoke, and disarm sequence

Replace angle-bracket values only after the instance, backup/PITR evidence,
proxy target, database, operation, watchdog definer, and deadline have their
own approvals. Do not paste passwords into command history.

Choose one fixed row:

| Profile | Account confirmation | Event confirmation | Operation command | Operation gate |
| --- | --- | --- | --- | --- |
| `schema-apply` | `mickeyf_schema_apply@%` | `mickeyf_watchdog_schema_apply` | `migrations:apply` | `MIGRATION_ALLOW_APPLY` |
| `p4-backfill` | `mickeyf_p4_backfill@%` | `mickeyf_watchdog_p4_backfill` | `migrations:p4-backfill` | `MIGRATION_ALLOW_P4_VEGA_BACKFILL` |
| `p4-reconcile` | `mickeyf_p4_reconcile@%` | `mickeyf_watchdog_p4_reconcile` | `migrations:p4-reconcile` | `MIGRATION_ALLOW_P4_VEGA_RECONCILE` |
| `empty-rollback` | `mickeyf_empty_rollback@%` | `mickeyf_watchdog_empty_rollback` | `migrations:rollback-empty` | `MIGRATION_ALLOW_ROLLBACK_EMPTY` |

Set shared target confirmations:

```powershell
$profile = '<profile>'
$account = '<fixed-account-confirmation>'
$event = '<fixed-event-confirmation>'
$watchdogDefiner = '<root@% or cms_mickeyf@%>'
$watchdogDelaySeconds = '<120-through-1800>'

$env:MIGRATION_PRINCIPAL_ADMIN_HOST = '127.0.0.1'
$env:MIGRATION_PRINCIPAL_ADMIN_PORT = '<approved-proxy-port>'
$env:MIGRATION_PRINCIPAL_ADMIN_DATABASE = '<approved-database>'
$env:MIGRATION_PRINCIPAL_CONFIRM_TARGET = "127.0.0.1:$($env:MIGRATION_PRINCIPAL_ADMIN_PORT)/$($env:MIGRATION_PRINCIPAL_ADMIN_DATABASE)"
$env:MIGRATION_PRINCIPAL_CONFIRM_DATABASE = $env:MIGRATION_PRINCIPAL_ADMIN_DATABASE
$env:MIGRATION_PRINCIPAL_CONFIRM_PROFILE = $profile
$env:MIGRATION_PRINCIPAL_CONFIRM_ACCOUNT = $account
$env:MIGRATION_PRINCIPAL_CONFIRM_EVENT = $event
$env:MIGRATION_PRINCIPAL_CONFIRM_WATCHDOG_DEFINER = $watchdogDefiner
```

1. Arm before creating either temporary account, using only the fixed armer:

```powershell
$env:MIGRATION_PRINCIPAL_ADMIN_USER = 'cms_mickeyf'
$env:MIGRATION_PRINCIPAL_ADMIN_PASS = '<injected-without-echo>'
$env:MIGRATION_PRINCIPAL_WATCHDOG_DELAY_SECONDS = $watchdogDelaySeconds
$env:MIGRATION_PRINCIPAL_ALLOW_WATCHDOG_ARM = '1'
& npm --prefix backend run migrations:principal:watchdog:arm -- $profile
$armExitCode = $LASTEXITCODE
Remove-Item Env:MIGRATION_PRINCIPAL_ALLOW_WATCHDOG_ARM
Remove-Item Env:MIGRATION_PRINCIPAL_WATCHDOG_DELAY_SECONDS
Remove-Item Env:MIGRATION_PRINCIPAL_ADMIN_PASS
if ($armExitCode -ne 0) { throw "Watchdog arm failed with exit $armExitCode" }
```

2. Through the separately approved Cloud SQL administration path, create only
   `mickeyf_migration_bootstrap@%` with a generated secret. Do this after arm,
   never before it. Then inject its secret without echo and create the locked
   operation account:

```powershell
$env:MIGRATION_PRINCIPAL_ADMIN_USER = 'mickeyf_migration_bootstrap'
$env:MIGRATION_PRINCIPAL_ADMIN_PASS = '<injected-without-echo>'

$temporaryPasswordBytes = [byte[]]::new(32)
[Security.Cryptography.RandomNumberGenerator]::Fill($temporaryPasswordBytes)
$env:MIGRATION_PRINCIPAL_PASSWORD = [Convert]::ToBase64String($temporaryPasswordBytes)
[Array]::Clear($temporaryPasswordBytes, 0, $temporaryPasswordBytes.Length)

$env:MIGRATION_PRINCIPAL_ALLOW_CREATE = '1'
& npm --prefix backend run migrations:principal:create -- $profile
$createExitCode = $LASTEXITCODE
Remove-Item Env:MIGRATION_PRINCIPAL_ALLOW_CREATE
Remove-Item Env:MIGRATION_PRINCIPAL_ADMIN_PASS
if ($createExitCode -ne 0) { throw "Temporary-account creation failed with exit $createExitCode" }
```

Removing the bootstrap password before the ordinary migration is mandatory.
Reinject it only for normal closeout.

3. Run exactly the selected operation. Revoke first in `finally`; disarm only
   after revocation succeeds:

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
    'schema-apply' { $operationScript = 'migrations:apply'; $operationGate = 'MIGRATION_ALLOW_APPLY' }
    'p4-backfill' { $operationScript = 'migrations:p4-backfill'; $operationGate = 'MIGRATION_ALLOW_P4_VEGA_BACKFILL' }
    'p4-reconcile' { $operationScript = 'migrations:p4-reconcile'; $operationGate = 'MIGRATION_ALLOW_P4_VEGA_RECONCILE' }
    'empty-rollback' { $operationScript = 'migrations:rollback-empty'; $operationGate = 'MIGRATION_ALLOW_ROLLBACK_EMPTY' }
    default { throw "Unmapped migration profile: $profile" }
}

$operationExitCode = 1
$revokeExitCode = 1
$disarmExitCode = 1
try {
    Set-Item "Env:$operationGate" '1'
    & npm --prefix backend run $operationScript
    $operationExitCode = $LASTEXITCODE
} finally {
    Remove-Item "Env:$operationGate" -ErrorAction SilentlyContinue
    Remove-Item Env:MIGRATION_DB_PASS -ErrorAction SilentlyContinue

    $env:MIGRATION_PRINCIPAL_ADMIN_PASS = '<re-injected-without-echo>'
    $env:MIGRATION_PRINCIPAL_ALLOW_REVOKE = '1'
    & npm --prefix backend run migrations:principal:revoke -- $profile
    $revokeExitCode = $LASTEXITCODE
    Remove-Item Env:MIGRATION_PRINCIPAL_ALLOW_REVOKE -ErrorAction SilentlyContinue

    if ($revokeExitCode -eq 0) {
        $env:MIGRATION_PRINCIPAL_ALLOW_WATCHDOG_DISARM = '1'
        & npm --prefix backend run migrations:principal:watchdog:disarm -- $profile
        $disarmExitCode = $LASTEXITCODE
        Remove-Item Env:MIGRATION_PRINCIPAL_ALLOW_WATCHDOG_DISARM -ErrorAction SilentlyContinue
    }
    Remove-Item Env:MIGRATION_PRINCIPAL_ADMIN_PASS -ErrorAction SilentlyContinue
}

if ($revokeExitCode -ne 0) { throw "Revocation failed; leave the watchdog armed" }
if ($disarmExitCode -ne 0) { throw "Watchdog disarm could not be confirmed" }
if ($operationExitCode -ne 0) { throw "Migration operation failed with exit $operationExitCode" }
```

4. After the disarm connection closes, verify through the separately approved
   administration path that `mickeyf_migration_bootstrap@%` is absent. The
   disarm CLI self-drops it, but intentionally cannot query after its final
   statement to prove its own absence.

Revocation locks, revokes, counts active sessions, audits reviewed-table
triggers, and then drops the operation account. If a session remains, it fails
loudly after lock/revoke; close the session and retry. `FLUSH PRIVILEGES` is
neither needed nor used.

### If the deadline fires or closeout fails

Do not infer success from `LAST_EXECUTED`. Verify both fixed temporary accounts,
their lock/grant state, the four bootstrap definer-object categories, and the
reviewed-table trigger inventory directly. If the preserved event remains but
the watchdog dropped the bootstrap, recreate the same fixed bootstrap only
through the separately approved Cloud SQL path, inspect the outcome, safely
disarm the exact event, and verify the bootstrap's second removal. Never disarm
first merely to clear an error: that removes the independent cleanup boundary
while the interesting mess is still on the floor.

Finally clear every input from the shell:

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
    'MIGRATION_PRINCIPAL_CONFIRM_EVENT',
    'MIGRATION_PRINCIPAL_CONFIRM_WATCHDOG_DEFINER',
    'MIGRATION_PRINCIPAL_WATCHDOG_DELAY_SECONDS',
    'MIGRATION_PRINCIPAL_ALLOW_CREATE', 'MIGRATION_PRINCIPAL_ALLOW_REVOKE',
    'MIGRATION_PRINCIPAL_ALLOW_WATCHDOG_ARM',
    'MIGRATION_PRINCIPAL_ALLOW_WATCHDOG_DISARM',
    'MIGRATION_ALLOW_APPLY', 'MIGRATION_ALLOW_ROLLBACK_EMPTY',
    'MIGRATION_ALLOW_P4_VEGA_BACKFILL',
    'MIGRATION_ALLOW_P4_VEGA_RECONCILE'
) | ForEach-Object { Remove-Item "Env:$_" -ErrorAction SilentlyContinue }
Remove-Variable temporaryPasswordBytes -ErrorAction SilentlyContinue
```

A run is not complete until the operation account is absent, the exact event is
absent, the bootstrap account is externally verified absent, and secrets are
cleared.

## Local verification

`npm --prefix backend run test:migrations` uses pinned disposable MySQL 8.0.31.
It executes every real profile, proves least-privilege denials, verifies
lock-first provisioning and final unlock ordering, tests crash-bounded
bootstrap self-lock/disarm/self-drop, and lets the scheduler deadline fire.
Deadline tests inspect actual account lock/revoke/drop outcomes for normal
cleanup, operation-trigger refusal, and bootstrap-definer refusal; they do not
treat event metadata as proof of success. The harness removes its container,
volume, accounts, events, roles, views, triggers, and sentinel schema even on
failure.
