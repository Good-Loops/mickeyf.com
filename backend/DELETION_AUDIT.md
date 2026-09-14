# Pending account-deletion audit

## Status and purpose

The read-only detector is implemented. **Cloud Run Job, hourly scheduling and
deletion-audit alert activation are pending rollout evidence.** SQL/runtime
grant and IAM checks alone do not prove scheduled operation or enable deletion.

The audit compares validated, independent journal intents with current
`users.account_uuid` values. It catches an account still present even if the API
crashed before logging an error. Historical intents for absent accounts are not
a backlog. Duplicate requests use their earliest timestamp; retries cannot
restart the grace period. This detector never deletes data or applies replay.

## Access and execution contract

- SQL identity: `deletion_audit@cloudsqlproxy~%`, with only
  `SELECT(account_uuid)` on `cms.users` and `SELECT(version, applied_at)` on
  `cms.schema_migrations`; no DELETE, password/email access, roles or grant option.
- Service identity: `ludolume-deletion-recovery@noted-reef-387021.iam.gserviceaccount.com`.
  Its journal access is bucket-scoped read/list (`roles/storage.objectViewer`)
  on `ludolume-deletion-journal-1012884798546`; no journal mutation permission.
  It has Cloud SQL Client and Secret Accessor on only
  `projects/1012884798546/secrets/ludolume-deletion-audit-password/versions/1`
  (access is secret-scoped; the job pins version 1). No service-account key is needed.
- Reuse caller `mickeyf-receipt-scheduler`, adding Run Invoker on only the new
  audit job, without SQL, journal or secret access. Do not expand the receipt
  cleanup worker's data permissions.
- Job command: `node dist/account-deletion-audit.min.js`, using a reviewed image
  digest. The CLI verifies the actual ADC/impersonated reader email before GCS
  access and permits GET requests only. Local operator invocation is
  `npm run deletion-audit` from `backend`, with explicit loopback configuration.
- Dedicated variables: `DELETION_AUDIT_DB_USER`, `DB_PASSWORD`, `DB_NAME`,
  `DB_CURRENT_USER`, `DB_SERVER_UUID` and `IDENTITY_EPOCH`, all with the
  `DELETION_AUDIT_` prefix. Production requires `NODE_ENV=production` and
  `DELETION_AUDIT_CLOUD_SQL_CONNECTION_NAME=noted-reef-387021:us-central1:cms-mickeyf`;
  local execution requires explicit `DB_HOST=127.0.0.1` and `DB_PORT` with that
  same prefix. There is no website-credential fallback or freeze assertion.
- Pin the independently recorded original identity epoch and exact database,
  SQL account and server UUID. Defaults: 900,000 ms grace, 1,000 journal intents,
  60-second deadline; account lookups use at most 200 UUIDs and ten-second queries.

## Intended schedule and alerts

Intended job: `ludolume-account-deletion-audit`; Scheduler:
`ludolume-account-deletion-audit-hourly`, minute 20 each UTC hour. With the
15-minute grace period, an unresolved request is normally
detected within approximately 75 minutes, plus scheduling/execution/ingestion
delay. This is not an exact response-time guarantee. Reuse approved email
channel `9138709485205441101`; do not create another recipient or delivery system.

Alert on `account-deletion-audit` pending/error output, failed Cloud Run Job
executions, and no successful audit for two hourly intervals. A Scheduler 2xx
only confirms dispatch. Arm the missing-success watchdog after observing a real
successful audit; pause it during intentional schedule maintenance. Logs contain
only status, aggregate counts and oldest pending age. Exit codes are 0 clear,
2 pending and 1 failed; unreadable journals and wrong pins fail closed.

## Response and acceptance

The owner investigates an alert, then follows the pending/unconfirmed-request
procedure in [LEADERBOARD_DESIGN.md](LEADERBOARD_DESIGN.md): arrange real writer
freeze/drain, review a fresh active replay plan, apply only its approved digest,
confirm reconciliation and restore the previous access state. Never fabricate
a freeze acknowledgment, delete by numeric ID, discard an intent, promise
cancellation, or ask for the user's password. There is no automatic replay.

Focused tests cover old/present, old/absent, recent, invalid/unavailable journal,
wrong pins and deadlines. Record one real scheduled execution and alert-policy
readback during rollout, not repeated generic login/score/restore tests. An IAM
permission check does **not** verify an actual journal upload; writer acceptance
and any synthetic intent's approved retention remain separate evidence.
