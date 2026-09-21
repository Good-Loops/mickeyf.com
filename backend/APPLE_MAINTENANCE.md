# Apple sign-in maintenance and activation

Status: preparation only, 2026-09-21. No resources, secrets, migrations,
provider settings, public privacy text or native capabilities are activated by
this document or by building the backend.

## Verified starting point

Read-only Cloud Run/Scheduler inventory on 2026-09-21 found two jobs:
`mickeyf-submission-receipt-cleanup` (hourly minute 0 UTC) and
`ludolume-account-deletion-audit` (hourly minute 20 UTC). Both schedules were
enabled. No Apple job was listed. A Secret Manager name search for `apple`
returned no matches; that is not proof that no differently named secret exists.
No secret value was read. The backend service is `mickeyf-org` in `us-central1`,
with URL `https://mickeyf-org-j7yuum4tiq-uc.a.run.app` and runtime identity
`mickeyf-runtime@noted-reef-387021.iam.gserviceaccount.com`.

Do not add token access or Apple private keys to the existing receipt worker or
the read-only deletion-audit worker. Their independent purposes and permissions
remain unchanged.

## Recommended operation — owner approval required

Use one separate Cloud Run Job on the existing platform, proposed name
`ludolume-apple-token-revocation`, and one five-minute Scheduler dispatch.
No always-running service, new database or message queue is needed.

- One task, parallelism one, 1 vCPU/512 MiB, 210-second platform task timeout.
  The command has its own 180-second work deadline and five-second shutdown.
- No automatic platform task retries or Scheduler retries. The SQL queue owns
  retry timing; a later schedule retries due work. The worker's database lock
  serializes Apple calls even if manual dispatches overlap.
- Run `node dist/apple-token-revocation.min.js apply` from a reviewed immutable
  image digest. The regular backend build includes this standalone entrypoint;
  it does not open an HTTP server. The source npm alias is for operator work,
  not a command available inside the production image (which has no ts-node).
- Prefer a dedicated job service account with Cloud SQL Client and access only
  to its pinned database password, Apple signing key and encryption-key secrets.
  The present command still pins `cms_mickeyf@%`: it is **not** a dedicated
  least-privilege SQL account. Review that trade-off explicitly or prepare a
  narrower SQL identity before activation; do not call it isolated merely
  because the cloud service account is separate.
- Reuse the existing Scheduler caller
  `mickeyf-receipt-scheduler@noted-reef-387021.iam.gserviceaccount.com` only by
  granting invocation on this additional job, not project-wide invocation or
  token/SQL access. Dispatch uses OAuth to the Cloud Run Jobs API, not OIDC.
- Reuse the previously approved operator email channel; verify its current
  destination before adding policies. Alert on failed job executions, aggregate
  cleanup/retry errors and absence of successful completion for 15 minutes.
  Receipt of a successful Scheduler response is not job completion.

### Cost boundary

At a five-minute cadence there are 8,640 executions in a 30-day month. Cloud Run
Jobs have a one-minute minimum billed duration. At the published us-central1
on-demand rates for 1 vCPU and 0.5 GiB, 60 seconds each is approximately
**USD 9.85/month before shared free allowances**, not a quote or spending cap.
Longer runs increase that amount. Builds, storage, logging, secrets and existing
SQL costs are separate. Scheduler is USD 0.10/job/31 days after the billing
account's first three free jobs; this project's two schedules do not establish
free-tier availability across the whole billing account.

Sources checked 2026-09-21: [Cloud Run pricing](https://cloud.google.com/run/pricing),
[Scheduler pricing](https://cloud.google.com/scheduler/pricing),
[scheduled jobs and OAuth](https://docs.cloud.google.com/run/docs/execute/jobs-on-schedule).

## Data lifetime: expiry is not physical deletion

The approved encrypted deletion-retry deadline remains seven days from the
earliest deletion request, never seven days from a retry. A successful Apple
revocation removes the record sooner. Profiles, sessions and scores are not
kept while waiting for this retry queue.

The maintenance command first verifies the SQL identity and recorded schemas,
then purges expired encrypted records and hashed-subject cutoffs without
decrypting them or contacting Apple. Only after that step does it load Apple
signing/decryption configuration and process up to 20 due revocations. Missing
or invalid keys therefore still produce a failed run, but do not block the
preceding DB-only purge. Failed SQL/schema verification permits no deletion.

The initial purge allows at most 100 batches of 100 rows per table, then checks whether
expired records remain. A deadline, uncertain query, shutdown failure or backlog
cannot be reported as clean completion. This replaces the earlier single
100-row guard sweep, which could take many hours to catch up on a quiet site.
The unchanged retry worker can additionally purge up to 40 expired token rows.
Key independence applies after process startup: unreadable Secret Manager
versions injected into a Cloud Run container can prevent startup entirely.
The deployment design must keep a DB-only purge path runnable during Apple
secret outages (for example, load retry secrets after startup), not just handle
invalid in-process key values. No such cloud secret-loading path is activated here.

Cutoffs expire logically 330 seconds after the signed event. With healthy
five-minute dispatch and an empty backlog, their physical removal normally
follows within one additional interval plus job runtime. Likewise, a retry
record expiring at seven days can otherwise wait until the next sweep.
Neither periodic execution nor an alert guarantees an exact physical maximum
during an outage. **Do not publish a strict seven-day physical-deletion claim
on this evidence alone or silently extend the owner's approved retention.**
Before activation, settle proactive purge headroom and the operational response
for overdue rows, test the actual execution path once with dummy records, and
approve wording that accurately distinguishes retry eligibility, deletion and
backup expiry. Existing restore/deletion-journal controls still apply; a restored
database must not resume traffic with resurrected sessions or expired tokens.

## Privacy wording prepared for review — not a published policy

This is an insert for the existing policy draft, not a replacement legal policy
or a representation that Apple sign-in is live. It does not change the approved
audience plan, KWS decisions, no-sale commitment or targeted-advertising policy.

> If you choose Sign in with Apple, Apple provides a sign-in identifier and may
> provide your verified email address or a private relay address. We use this
> information to create or access your Ludolume account. We do not receive your
> Apple password. Choosing Apple sign-in is optional; accounts are not merged
> solely because they share an email address.
>
> We keep Apple authorization credentials encrypted on our servers so we can
> withdraw the app's access when you delete your account. After deletion, an
> encrypted credential may remain solely for revocation retries. The retry
> deadline is seven days from the original deletion request; successful
> revocation removes the credential sooner. This does not retain your deleted
> profile, username or leaderboard entries.
>
> We also process signed account-change notifications from Apple to invalidate
> affected sign-ins. Brief security records contain a hashed Apple identifier
> and event timing, not a notification archive. A hash is not anonymous data.
> These records prevent a sign-in already in progress from overriding a
> revocation. We do not use them for advertising or tracking across apps.

Publication still needs the physical-purge/backup wording above resolved,
accurate contact/controller details from the approved policy draft, accessible
in-app and website links, and matching store disclosures. Apple requires clear
collection/use, retention/deletion and consent-withdrawal information; publishing
this insert alone is not an App Review or legal-compliance determination.
See [App Review privacy requirements](https://developer.apple.com/app-store/review/guidelines/#privacy).

## Notification endpoint and ordered activation

Proposed endpoint for primary App ID `com.mickeyf.app`, team `AX4Z7T24C9`:

```text
https://mickeyf.com/auth/providers/apple-notifications
```

The checked-in Hosting rewrite already forwards `/auth/**` to `mickeyf-org`.
Before registration, verify the deployed URL has no redirect, uses TLS 1.2 or
later, reaches the approved receiver and rejects an invalid signed payload
without database mutation. Register this only on the primary App ID; do not
replace an existing app-group notification URL without checking its consumers.
See [Apple endpoint registration](https://developer.apple.com/help/account/capabilities/enabling-server-to-server-notifications/).

1. Obtain approval for the exact operational/data changes and retention wording.
   Provision/review the job identity, SQL privileges and pinned secret versions;
   use a Sign in with Apple key, not the App Store Connect API key. No secret
   values belong in the repository, shell arguments or logs.
2. Apply/verify the reviewed schema and grants under the existing migration
   procedure. Build/scan the exact backend image. Create the job disabled first;
   configure the reviewed execution-failure/backlog alerts before real deletion.
3. Enable and execute the maintenance job only after approval, using authorized
   dummy data for one bounded expiry/retry proof. Enable its schedule and verify
   the actual execution result. Do not repeat generic gameplay/login checks.
4. Deploy the signed notification receiver with new Apple issuance still off;
   register the verified endpoint in Apple and prove one controlled delivery.
   Keep notification receipt running if later pausing new Apple sign-ins.
5. Only after privacy/audience, deletion fallback, cleanup and notification
   operation are accepted, enable the approved native capability, profile and
   app build. Perform one new/returning-user/deletion lifecycle check. KWS remains
   a separate account-creation eligibility decision, not a prerequisite to this
   source preparation. Public Apple web sign-in is a separate integration.

If cleanup fails, repair it and stop new Apple issuance when necessary; do not
erase operational errors or disable retention work as a rollback. Never restore
already-deleted accounts or broaden SQL permissions just to clear an alert.

## Preparation verification

Passed on 2026-09-21: 27 focused configuration/worker/command tests,
backend TypeScript and `git diff --check`. The actual new production webpack
entry was built into a temporary directory; launching that compiled file with
no command or with `apply` and maintenance disabled returned exactly one
sanitized configuration failure and exit1. The temporary build is outside the
repository. Its cleanup command was refused by the tool policy, so the two
generated files remain in
`C:\Users\User\AppData\Local\Temp\ludolume-apple-maintenance-build-a45becd0e92f44f8a99dd1cb4321fe57`;
they contain compiled source/license notices, not credentials. The separate
temporary public-certificate bundle used for cloud inspection was removed.
No server was restarted and no live SQL write, Apple call, job execution,
image upload or deployment was performed. This is not a Linux image or native
device acceptance claim.

```text
npm --prefix backend test
```

From `backend`:

```text
node --test -r ts-node/register ts/config/appleRevocationConfig.test.ts ts/accounts/runAppleTokenRevocation.test.ts ts/accounts/appleTokenRevocation.test.ts
```

The temporary build used the normal `webpack.config.js`, production mode and
only its `apple-token-revocation` entry with a separate output directory; it did
not overwrite the running local server's `dist` directory.
