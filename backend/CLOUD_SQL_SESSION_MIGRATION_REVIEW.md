# Cloud SQL session migration review — 2026-09-29

Status: review prepared; no database or grant changes applied. The owner chose
to keep the Cloud SQL development workflow. Do not replace it with local MySQL.
Baseline source: `8271af27` on `improvement/clean-code-sweep`.

## Diagnosis and verified evidence

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
  configured in the inspected environment. No full maintenance plan was run.
- The loaded local configuration has provider authentication and provider signup
  disabled. No environment values, credentials or feature gates were changed.

Checks used SELECT metadata, SHOW GRANTS and the existing read-only readiness
functions. No accounts, scores, sessions, migrations or grants were written.

## Recommended minimum change

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

For the currently disabled provider configuration, propose only the additive
session permissions below, copied from the session entry in the reviewed
`GOOGLE_RUNTIME_GRANT_MANIFEST`. This is review material, **not executed SQL**:

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
   Those cloud/recovery conditions were not inspected in this diagnosis. The
   runner's advisory lock does not exclude arbitrary application or admin work.
4. Review the fresh plan and the additive session grant against the actual target.
   Obtain explicit execution approval. Only then supply the runner's exact
   database/target write confirmations and enable its apply gate.

The later approved sequence is the following, stopping on the first failed
command; these commands have **not** been run:

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

Next required step: maintenance-account read-only preflight. Until it passes and
execution is approved, the local backend remains stopped by its readiness gate.
