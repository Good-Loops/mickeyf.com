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

## No additional recurring spend — revised direction

The owner rejected the proposed separate five-minute Apple job on 2026-09-21.
It was never created and is **not** a prerequisite for development or the
recommended deployment. Do not add jobs, schedules, increased dispatch frequency,
minimum instances or paid services. Reusing existing resources can still add
metered requests/runtime; it is not a promise of a zero billing increase.

The first source improvement is an immediate, account-scoped revocation attempt
after confirmed local account deletion: one Apple call, with a ten-second total
budget. A failure leaves the existing encrypted retry record for recovery and
does not turn an already-completed local deletion into a failure. No timer,
background promise or app traffic is treated as a reliable retry scheduler.

### Smallest scheduled fallback — proposed, not implemented

Reuse the existing hourly receipt-job dispatch, not its SQL credentials or its
process for Apple work:

1. Add one bounded service-to-service request from the receipt job to a new
   disabled-by-default backend maintenance endpoint. The job obtains its own
   short-lived workload identity token. The endpoint must verify Google's
   signature, exact audience and pinned receipt-job identity before doing work;
   user sessions, caller-supplied identity headers and arbitrary callback URLs
   are not authorization. The existing public API's ingress is not this check.
2. The backend, which already needs the Apple lifecycle credentials for sign-in,
   owns DB-only purge and due retries under the existing database lock. Accept
   no caller-selected account, SQL, deadline or batch size. Use fixed row/time
   limits, aggregate results and fail-closed configuration. No Apple signing
   key, encryption key or token-table privilege goes to the receipt job. The
   read-only deletion-audit job remains untouched.
3. Run the request independently of the receipt-cleanup result, including when
   receipt SQL/configuration fails; bound both operations so neither starves
   the other. Record both outcomes. A failed retry/purge cannot be hidden behind
   a successful receipt result. Review the existing execution timeout and
   failure/missing-success monitoring rather than adding a new monitoring
   service. The hourly Scheduler target and caller do not need to change.

The existing receipt entrypoint currently performs only receipt cleanup and
has no such call. The API has no maintenance endpoint or workload-token guard.
Implement this path and make DB-only maintenance start independently of Apple
retry-key availability before activating Apple sign-in. Verify the existing
workload identity and exact endpoint audience at deployment; do not substitute
a permanent shared password or service-account key. One authorized dummy
dispatch will then verify retry, purge and failure reporting on the actual path.

### Operator/recovery command retained

`node dist/apple-token-revocation.min.js apply` remains a bounded, explicitly
enabled operator/recovery command, not an automatically scheduled deployment.
The regular backend build includes this standalone entrypoint; it does not open
an HTTP server. The source npm alias needs ts-node and is not the production
image command. It verifies the pinned runtime SQL identity before writes and
uses a 180-second work deadline plus five-second shutdown. Its runtime SQL
account is broader than a dedicated maintenance account; do not transfer that
credential to either existing restricted job.

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

Cutoffs expire logically 330 seconds after the signed event. Under the proposed
hourly fallback, their physical removal would follow on a later successful
sweep, normally within one additional interval plus execution delay when
healthy. That longer physical lifetime needs explicit acceptance before
activation; it is not a five-minute physical-deletion guarantee. Likewise, a
retry record expiring at seven days can otherwise wait until the next sweep.
Neither periodic execution nor an alert guarantees an exact physical maximum
during an outage. **Do not publish a strict seven-day physical-deletion claim
on this evidence alone or silently extend the owner's approved retention.**
The proposed fallback should purge queued encrypted records 24 hours before
their existing seven-day deadline, before attempting retries. That shortens the
normal retry window to six days and reserves multiple hourly opportunities for
deletion; it never restarts or extends the approved deadline. This headroom is
not implemented, nor does it guarantee recovery from an outage lasting longer
than the reserved window. Before activation, implement/verify that rule and the
operational response for overdue rows, test the actual path once with dummy records, and
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

1. Finish the bounded backend endpoint, workload-token guard and existing
   hourly dispatch hook described above, including proactive/key-independent
   purge and separate failure results. Retain the approved seven-day maximum;
   settle the short-lived cutoff's physical-retention wording. Do not create
   new scheduled resources or silently increase the existing cadence.
2. Under scoped deployment approval, apply/verify reviewed schema/grants and
   build/scan the exact image. Use the backend's dedicated Sign in with Apple
   credentials, not its App Store Connect key or either restricted worker's
   credentials. Keep new sign-in issuance off while enabling and proving the
   maintenance path once with authorized dummy records. Verify existing
   execution/backlog/missing-success reporting on that same dispatch.
3. Deploy the signed notification receiver with new Apple issuance still off;
   register the verified endpoint in Apple and prove one controlled delivery.
   Keep notification receipt running if later pausing new Apple sign-ins.
4. Only after privacy/audience, deletion fallback, cleanup and notification
   operation are accepted, enable the approved native capability, profile and
   app build. Perform one new/returning-user/deletion lifecycle check. KWS remains
   a separate account-creation eligibility decision, not a prerequisite to this
   source preparation. Public Apple web sign-in is a separate integration.

If cleanup fails, repair it and stop new Apple issuance when necessary; do not
erase operational errors or disable retention work as a rollback. Never restore
already-deleted accounts or broaden SQL permissions just to clear an alert.

## Immediate-attempt verification

The no-new-recurring-spend source change passed 78 focused tests: 15 worker,
12 maintenance-command regression and 51 password/provider HTTP tests. These
use synthetic credentials and local fixtures, not live SQL or Apple requests.
They verify one-account/one-call scope, commit and lock-release ordering,
timeouts and late continuations, successful local deletion despite an Apple
failure, and no added queue work when lifecycle configuration is absent.

From `backend`:

```text
node --test -r ts-node/register ts/accounts/appleTokenRevocation.test.ts
node --test -r ts-node/register ts/accounts/runAppleTokenRevocation.test.ts
node --test -r ts-node/register ts/routers/authRouter.security.test.ts ts/routers/providerAuthRouter.test.ts
```

Backend TypeScript and scoped `git diff --check` passed. No cloud resource,
schedule, IAM/SQL grant, production configuration or public sign-in capability
was changed. This is not operational acceptance of the proposed hourly fallback.

## Earlier standalone-command preparation verification

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
