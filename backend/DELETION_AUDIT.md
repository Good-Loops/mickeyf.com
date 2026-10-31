# Pending account-deletion audit

## Status and purpose

**Operational as of 2026-09-14 UTC:** the read-only Job and hourly Scheduler are
enabled, a Scheduler-triggered execution completed successfully, and all three
alert policies were read back enabled. This detects unfinished deletions; it
does not enable website account deletion or prove backup-recovery readiness.

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

## Active schedule and alerts

Job: `ludolume-account-deletion-audit`; Scheduler:
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

The three policy IDs are:

| Condition | Monitoring policy ID |
| --- | --- |
| Pending request or audit error log | `11326691462626878619` |
| Failed job execution | `13060497909912260602` |
| No successful audit for two hours, including missing telemetry | `4140849655626802345` |

They are scoped to this exact project, region and job. Failed/successful metric
filters distinguish the `result` label. The no-success policy was armed only
after an actual completed audit. The log policy groups repeated notifications
with a five-minute rate limit. A single failed run can trigger both the log and
execution policies; these are two signals for the same incident, not necessarily
two problems. No new test-failure email was generated for this rollout; the
existing channel's prior delivery test is not claimed as a new delivery test.

## Deployment and acceptance evidence

- Source `64e274e1c72855df0c6c770921d6e680e13f7073`, approved image-only build
  `0c99adb9-028c-461e-bb0a-798618788e7b`; completed image analysis found no
  vulnerability occurrences. The job pins image digest
  `sha256:23d5cd840582c53bad36855e2e37e92ffd203d20821334480a51d36e4d8779c1`
  in `us-central1-docker.pkg.dev/noted-reef-387021/cloud-run-source-deploy/cloud-run-source-deploy`.
- Job generation 1: one task, parallelism one, zero retries, 180-second task
  timeout, 1 CPU/512 MiB. V2 job readback confirmed the Cloud SQL volume/socket;
  V1 execution annotations independently preserved the instance attachment.
- Scheduler dispatch was explicitly requested once through its `:run` API,
  exercising the real caller's job-scoped `roles/run.invoker` permission and
  OAuth POST configuration. This was not a natural hourly tick, a fake dispatch,
  or a direct operator-created execution.
- Execution `ludolume-account-deletion-audit-pcmdg` was created by
  `mickeyf-receipt-scheduler` at `19:04:23.656805Z`, completed successfully at
  `19:08:13.579110Z`, and logged `status=clear`, zero journal intents and zero
  pending accounts. Completion, structured log and Scheduler status were
  correlated; HTTP dispatch alone was not used as success evidence.
- The three enabled policies and their sole existing approved email channel
  were read back. Cleanup verified both temporary maintenance SQL users and
  temporary impersonation bindings absent; the image-only temporary trigger
  was deleted and all four pre-existing deployment triggers remained disabled.
- Non-secret deployment definitions/readbacks are retained as September 14
  `deletion-audit-job`, `deletion-audit-schedule`, `deletion-audit-alerts` and
  `deletion-audit-closeout` JSON reports in the restricted
  `%LOCALAPPDATA%\Ludolume\Recovery\identity-20260911` evidence directory.
  Credentials remain in Secret Manager, not these reports.
- Local cleanup limitation: removing the five non-secret rollout helper scripts
  under `%LOCALAPPDATA%\Temp\ludolume-deletion-access-a8686acdc8ee4f2cadd47baf6db614f6`
  was refused by the filesystem tool. The folder remains for manual cleanup;
  no alternate deletion route was attempted. This does not leave temporary
  cloud access active. Preserve the separate restricted recovery evidence.

No real account or score was changed. The live website revision was not
replaced, and automatic backup/PITR retention was preserved. The older recovery
history still blocks self-deletion activation; actual journal-upload acceptance
belongs with the reviewed final rollout, not an arbitrary retained test object.

## Response and acceptance

The owner investigates an alert, then follows the pending/unconfirmed-request
procedure in [LEADERBOARD_DESIGN.md](LEADERBOARD_DESIGN.md): arrange real writer
freeze/drain, review a fresh active replay plan, apply only its approved digest,
confirm reconciliation and restore the previous access state. Never fabricate
a freeze acknowledgment, delete by numeric ID, discard an intent, promise
cancellation, or ask for the user's password. There is no automatic replay.

Focused tests cover old/present, old/absent, recent, invalid/unavailable journal,
wrong pins and deadlines. The two audit/config suites passed 11 tests, and
`npm test` in `backend` passed typechecking. The Scheduler-triggered execution
and alert-policy readback above close this audit's initial acceptance; no
repeated generic login/score/restore checks are required. An IAM
permission check does **not** verify an actual journal upload; writer acceptance
and any synthetic intent's approved retention remain separate evidence.

Exact local validation commands used in this change:

```powershell
# From backend: 11 audit/config tests, followed by the TypeScript check.
node --test -r ts-node/register ts/accounts/deletionAudit.test.ts ts/config/deletionAuditConfig.test.ts
npm test
# From the repository root: 64 deployment/traffic contract tests.
node --test --test-reporter=spec scripts/render-frozen-backend-deploy.test.mjs scripts/frozen-backend-traffic.test.mjs
git diff --check
```
