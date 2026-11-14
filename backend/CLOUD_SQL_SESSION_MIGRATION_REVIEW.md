# Cloud SQL session migration review — 2026-09-29

Status: approved migrations 0009–0012 and the additive session grant completed;
the existing VS Code backend is running again against Cloud SQL. Execution and
cleanup evidence are recorded below. The owner retains Cloud SQL development.
Baseline source: `8271af27` on `improvement/clean-code-sweep`.

## Initial runtime-only diagnosis

`node dist/server.min.js` from `backend` reproduces exit code 1 with
`Backend startup failed`. A separate read-only call to `verifyDatabaseConnection`
passes; `verifyAccountSessionReadiness` fails. The compiler is not the failure.

- The connection matches the repository-pinned Cloud SQL server UUID for
  `noted-reef-387021:us-central1:cms-mickeyf`, reports MySQL `8.0.31-google`,
  selects `cms`, and uses the pinned runtime account `cms_mickeyf`@`%`.
- `schema_migrations.version` contains exactly 0001–0008. Required session
  records 0011/0012 and prerequisites 0009/0010 are not recorded.
- `SHOW GRANTS FOR CURRENT_USER()` reports the existing user/score/receipt
  privileges and SELECT on migration `version`/`applied_at`; no session or
  provider-table privileges are present.
- Target tables are not visible in `information_schema` to this runtime account.
  This is **not proof of physical absence**: metadata is privilege-filtered.
  The earlier initial diagnosis of absent tables must be read with that limit.
- Reading migration `checksum` was denied with `ER_COLUMNACCESS_DENIED_ERROR`.
  The six required migration connection/account environment variables are not
  configured in the inspected environment. No full maintenance plan had been run
  at this initial checkpoint; the approved follow-up below resolves that limit.
- The loaded local configuration has provider authentication and provider signup
  disabled. No environment values, credentials or feature gates were changed.

Checks used SELECT metadata, SHOW GRANTS and the existing read-only readiness
functions. No accounts, scores, sessions, migrations or grants were written.

## Approved minimum change

Use the four existing migrations in order; do not edit historical SQL, skip the
runner's prerequisites, or add Google-signup/Apple migrations for this repair.
Creating dormant provider tables does not activate provider authentication.

| Migration | Effect | SHA-256 of the checked-out SQL |
| --- | --- | --- |
| 0009 | Create provider identity table with UUID cascade and uniqueness checks | `e340eef416c5b837a37b40b10b5c435b7519536596f6d477b69addbb3314a57f` |
| 0010 | Create one-use provider attempt table, indexes and constraints | `150391a30408a7df03953b006472f39316be99b20c01fe3e57f481b5487ca937` |
| 0011 | Create hashed account-session storage and account/expiry indexes | `bb0b7743bca7eaef1c47cb1284291e86ae51d188a9dd10183211329e79405cfa` |
| 0012 | Add four renewal columns and unique previous-session hash index | `27ea0ea51885c7fbe9d9f9727de94445e5856d9ff9a3074e02dca98523622ece` |

The SQL creates three tables and alters only session storage; it does not
backfill or modify existing users/scores. If an unrecorded table already exists,
the runner must verify its exact shape and recover its history rather than
blindly recreate it. Existing session rows, if found, retain ordinary expiry
and default to non-renewable under 0012.

For the currently disabled provider configuration, apply only the additive
session permissions below, copied from the session entry in the reviewed
`GOOGLE_RUNTIME_GRANT_MANIFEST`. This exact grant was approved and executed:

```sql
GRANT SELECT (session_hash, account_uuid, created_at, expires_at,
              remembered, renewed_at, previous_session_hash, previous_valid_until),
      INSERT (session_hash, account_uuid, created_at, expires_at, remembered, renewed_at),
      UPDATE (session_hash, expires_at, renewed_at, previous_session_hash, previous_valid_until),
      DELETE
ON `cms`.`account_sessions` TO 'cms_mickeyf'@'%';
```

Keep existing grants unchanged. This grants no DDL, grant option or updates to
the session account UUID, creation time or remembered choice. Do not invoke the
full runtime-grant apply command for this narrow delta: its profile includes
additional provider permissions and role reconciliation. This proposal is not
a claim of compliance with that full profile; provider activation retains its
separate rollout/grant review.

## Preconditions before approval and execution

1. Load the existing dedicated maintenance identity through the approved secret
   handling mechanism, using `MIGRATION_DB_HOST`, `MIGRATION_DB_PORT`,
   `MIGRATION_DB_USER`, `MIGRATION_DB_PASS`, `MIGRATION_DB_NAME`, and
   `MIGRATION_CONFIRM_ACCOUNT`. Do not put credentials in this document or chat,
   copy runtime credentials into maintenance variables, or broaden runtime
   privileges to inspect migration history.
2. Verify exact database/account and pinned server identity; run
   `npm --prefix backend run migrations:plan`. Require matching stored checksums
   for 0001–0008, exact existing schema and an understood absent/recoverable state
   for 0009–0012. Inspect hidden tables with maintenance schema visibility.
3. Confirm a usable recovery point, current serving application compatibility,
   and a short migration window with competing migration/DDL activity excluded.
   The cloud follow-up below records backup and serving-revision evidence. The
   runner's advisory lock does not exclude arbitrary application or admin work.
4. Review the fresh plan and the additive session grant against the actual target.
   Obtain explicit execution approval. Only then supply the runner's exact
   database/target write confirmations and enable its apply gate.

The approved sequence uses these existing migration entrypoints, stopping on
the first failure. Execution invoked their `runMigrations` commands directly
in one maintenance process; the equivalent npm commands are:

```powershell
npm --prefix backend run migrations:providers:apply
npm --prefix backend run migrations:provider-attempts:apply
npm --prefix backend run migrations:account-sessions:apply
npm --prefix backend run migrations:session-renewal:apply
```

Then apply the approved additive grant through the maintenance connection and
read back the affected grant/schema/history. Run account-session readiness as
the runtime account and restart the existing VS Code `back` runner once. A
successful `Backend listening` message verifies startup; it does not prove login,
logout or renewal. If a session smoke test is authorized, use one designated
test account. Do not rerun broad suites for unchanged SQL or use real accounts
as unapproved automated fixtures.

## Failure and rollback boundary

DDL effects can outlive an interrupted client; a failed command is not proof
that nothing changed. Re-plan before retrying, preserving the runner's checksum
and postcondition checks. Keep added tables/history on application rollback;
do not drop session storage or revoke permissions while a new runtime uses it.
Existing deployed traffic is not being switched by this proposal. Any later
production authentication cutover must follow the coordinated release and
re-login requirements in [SESSION_AUTHENTICATION.md](SESSION_AUTHENTICATION.md).
Database restore remains a separate operation with the established deletion
replay and session-invalidation requirements.

## Access and cloud preflight follow-up

The next read-only pass confirmed the instance is RUNNABLE, connector use is
required, automated backups and binary logging are enabled, eight backups are
retained, and transaction logs are retained for seven days. Latest reported
successful backup: `1790625600000`, completed `2026-09-28T21:29:13.284Z`.
This is backup metadata, not a fresh restore test. No pending Cloud SQL operation
was reported. The incompatible `main-push-mickeyf-com` build trigger is disabled.

Cloud Run serves `mickeyf-org-localhost-dbb80d4f` at 100% traffic and reports it
Ready/Active. Its source label is `dbb80d4f701da734ea971cb25b5c02d1e5b8d6d8`;
that source contains no references to the three proposed tables. This supports
the additive compatibility assessment without deploying or switching traffic.

Cloud SQL user inventory contains the runtime, operator, root, receipt-cleanup
and deletion-audit accounts; the former temporary maintenance user is absent.
Secret inventory exposes no dedicated migration password. Repository records
describe `michel_operator` as a restricted TablePlus DML identity, not a migration
administrator; it was not elevated or used to work around missing access.

The owner approved `session_preflight_20260929` restricted to the authenticated
proxy host pattern for read-only preflight, followed by immediate deletion.
The password remained only in process memory. This approval did not authorize
migration or application grant changes.
Cloud SQL's default administrative role for newly created built-in MySQL users
is documented in [Google's user-management guide](https://docs.cloud.google.com/sql/docs/mysql/create-manage-users).

The initial Google CLI certificate failure was also resolved locally: its custom
CA file contained the previous Norton root. That public certificate file was
backed up and refreshed from the current Windows trusted root. TLS verification
remains enabled; successful authenticated cloud reads verified the repair.
No secrets, certificate material or machine-local configuration entered Git.

## Approved read-only result — 2026-09-29 20:35 UTC

The existing `planMigrations` implementation ran under its advisory lock through
a query adapter accepting only SELECT and the runner's three session settings.
The connection had pinned database, complete account and server UUID checks,
per-query timeouts, an overall deadline and forced connection cleanup.

- Applied: exactly 0001–0008. All stored checksums and existing schema
  postconditions passed the current planner's checks.
- Pending: 0009–0018. The execution proposal remains only 0009–0012; the
  planner listing later migrations is not authorization to apply them.
- Recoverable: none. Full maintenance visibility confirmed the three proposed
  tables are absent, resolving the runtime account's visibility limitation.
- No schema, history, grants, account data, scores or session rows were changed.
  Temporary user creation/deletion were the only Cloud SQL access mutations.
- Cleanup verified the user absent in Cloud SQL and rejected a fresh SQL login
  with its former credentials. No maintenance password or access token was saved.

The credential-free helper is outside Git at
`%TEMP%/mickeyf-session-preflight-20260929.cjs`. Commands run:
`node --check` on that helper, then `node` on it with the current trusted public
CA configured for that process. No unit suite, build or deployment was needed.

## Approved execution and startup recovery — 2026-09-29 20:49 UTC

The owner approved the four migrations and session-only grant. Temporary user
`session_migrate_20260929`@`cloudsqlproxy~%` used a random password held only in
process memory. Exact target/account/server identity, the four source hashes
above and a fresh plan matching 0001–0008 with no recoverable migration were
verified before applying changes through the existing migration runner.

- `provider-identities-apply`, `provider-attempts-apply`, `account-sessions-apply`
  and `session-renewal-apply` completed in order. All 12 recorded checksums match
  the current manifest; migrations 0013–0018 remain pending and untouched.
- The session grant was rendered from the committed manifest and applied once.
  Readback verified all column privileges, table DELETE and no grant option.
  Comparing before/after grants confirmed all other runtime grants unchanged.
- A fresh runtime connection passed `verifyAccountSessionReadiness` at
  `2026-09-29T20:49:26.717Z`. The maintenance user was then deleted, confirmed
  absent in Cloud SQL, and a fresh login rejected with `ER_ACCESS_DENIED_ERROR`.
- Touching only the generated server bundle timestamp restarted the existing
  VS Code nodemon process. Port 8080 opened; `GET /api/leaderboards` returned
  HTTP 200, `success: true`, contract version 1 and two games.

Commands run (the credential-free helper stays outside Git):

```powershell
node --check C:\Users\User\AppData\Local\Temp\mickeyf-session-migrate-20260929.cjs
node C:\Users\User\AppData\Local\Temp\mickeyf-session-migrate-20260929.cjs
(Get-Item -LiteralPath 'C:\Users\User\Desktop\Pastas\Code\mickeyf.com\backend\dist\server.min.js').LastWriteTimeUtc = [DateTime]::UtcNow
node scripts/wait-for-port.mjs 127.0.0.1 8080 15000
Invoke-WebRequest -Uri 'http://localhost:8080/api/leaderboards' -TimeoutSec 10
```

The helper's Node process used the current trusted public CA through
`NODE_EXTRA_CA_CERTS`, restoring its previous value afterward. No credential
was printed or saved. Provider flags, application credentials and deployed
revisions remain unchanged. No rebuild, broad test suite, restore exercise or
login/logout/renewal smoke test was run; readiness and HTTP startup are verified.
