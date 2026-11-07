# Apple sign-in maintenance and activation

Status: hourly fallback implemented in source only, 2026-09-21. All new
activation flags remain off; nothing in this checkpoint was deployed. No
resources, secrets, migrations,
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

### Existing hourly fallback — implemented, not activated

The receipt entrypoint now runs its existing cleanup and one bounded HTTP
dispatch concurrently, awaiting both outcomes before exiting. Failure of receipt
configuration/SQL does not skip Apple work; an Apple failure cannot interrupt
receipt cleanup. Either failure makes the combined execution fail. The existing
hourly Scheduler target, caller and cadence do not change.

1. The disabled-by-default dispatch obtains a short-lived identity token from
   Google's fixed metadata endpoint using the job's attached service account.
   The backend endpoint verifies Google's signature, exact service-base audience
   and both the pinned caller email and numeric subject before doing work;
   user sessions, caller-supplied identity headers and arbitrary callback URLs
   are not authorization. The existing public API's ingress is not this check.
2. The backend owns verified DB-only purge followed by due retries protected by
   the existing revocation lock. It accepts no caller-selected account, SQL,
   deadline or batch size. Fixed row/time limits, aggregate results and
   fail-closed configuration bound the work. No Apple signing
   key, encryption key or token-table privilege goes to the receipt job. The
   read-only deletion-audit job remains untouched.
3. Metadata fetch/body reading is limited to five seconds and the whole dispatch
   to 110 seconds, with no retries or redirects and bounded response bodies.
   Success requires exactly HTTP 200 and JSON `{ "completed": true }`. The
   backend allows five seconds for identity verification and a 90-second
   maintenance watchdog. Existing receipt work retains its 120-second limit plus
   five-second shutdown. Parallel execution fits the existing 180-second job
   timeout; verify that deployed setting before enabling. Review existing
   failure/missing-success monitoring rather than adding a new monitoring
   service. The hourly Scheduler target and caller do not need to change.

The route is mounted before public CORS, cookie and body middleware. It rejects
browser cookies/origins, query strings, body payloads and alternate methods;
disabled configuration returns 404. Its direct Cloud Run URL, not a Hosting
rewrite, is the intended target. No permanent shared password, service-account
key, local ADC fallback or environment-selected destination is accepted.

### Explicit deployment configuration — none enabled by this checkpoint

On the existing receipt job, `APPLE_MAINTENANCE_DISPATCH_ENABLED=true` requires
`NODE_ENV=production` and the Cloud Run supplied
`CLOUD_RUN_JOB=mickeyf-submission-receipt-cleanup`. It rejects isolated runtimes.
The job retains its receipt-only SQL account and receives no Apple credentials.

On `mickeyf-org`, use these reviewed settings only after scoped activation approval:

- `APPLE_MAINTENANCE_HTTP_ENABLED=true`;
- `APPLE_MAINTENANCE_CALLER_SUBJECT=<verified numeric service-account uniqueId>`;
- `APPLE_MAINTENANCE_EXPECTED_SERVER_UUID=<verified production SQL server UUID>`;
- `APPLE_TOKEN_RUNTIME_SECRETS_ENABLED=true` and, for actual Apple retries,
  `APPLE_TOKEN_LIFECYCLE_ENABLED=true`;
- `APPLE_SIGN_IN_PRIVATE_KEY_SECRET_VERSION` and
  `APPLE_TOKEN_ENCRYPTION_KEYS_SECRET_VERSION`, each a distinct pinned positive
  numeric version such as
  `projects/noted-reef-387021/secrets/<reviewed-name>/versions/<number>`;
- existing nonsecret lifecycle settings `APPLE_IOS_BUNDLE_ID`,
  `APPLE_SIGN_IN_TEAM_ID`, `APPLE_SIGN_IN_KEY_ID` and `APPLE_TOKEN_ACTIVE_KEY_ID`.

`latest`, unpinned aliases, other projects and duplicate secret references are
rejected; the same project number `1012884798546` is also accepted. The signing
secret contains the dedicated Sign in with Apple private key; the encryption
secret contains the existing key-ID to canonical base64 32-byte-key JSON map.
Do not use the App Store Connect key. HTTP maintenance rejects the inline or
container-injected `APPLE_SIGN_IN_PRIVATE_KEY` and `APPLE_TOKEN_ENCRYPTION_KEYS`
variables. Necessary Secret Manager access must be reviewed for the existing
backend identity only; no secret, role or grant was created in this checkpoint.

The fixed token audience is the service base, **without** the maintenance path:

```text
https://mickeyf-org-j7yuum4tiq-uc.a.run.app
```

The fixed POST target is:

```text
https://mickeyf-org-j7yuum4tiq-uc.a.run.app/internal/maintenance/apple
```

The pinned email is
`mickeyf-receipt-cleanup@noted-reef-387021.iam.gserviceaccount.com`. Read and
verify that account's numeric `uniqueId` and its actual attachment to the job
at deployment; do not guess it, substitute the email for it, or trust email
alone. Verification checks both claims and a current Google-signed token.

Apple secret values are fetched by application code after container startup,
using the backend's attached workload identity and fixed Secret Manager API.
Pinned response names, bounded bodies and CRC32C checks protect the read; no
raw key/token/error is logged. Provider bootstrap makes one bounded load. If
that read fails, Apple is omitted from public capabilities and remains
unavailable in that process until restart; Google, notification handling and
the maintenance route still initialize. Each authenticated maintenance pass
performs a fresh secret load **after** its DB-only purge. Thus an Apple secret
outage cannot block that purge, though DB/schema/identity failures still can.
The 90-second maintenance watchdog rejects the run and prevents subsequent SQL,
decryption or Apple calls. An already-running secret fetch has its own
ten-second deadline and can finish after the failed run; this is not a claim
that every underlying I/O operation is forcibly stopped at 90 seconds.

These switches do not enable Apple signup/deletion or the native capability.
One authorized dummy dispatch must still prove retry, proactive purge and
failure reporting on the deployed path before public activation.

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
then purges queued encrypted records approaching their deadline and expired
hashed-subject cutoffs without decrypting them or contacting Apple. Only after
that step does it load Apple
signing/decryption configuration and process up to 20 due revocations. Missing
or invalid keys therefore still produce a failed run, but do not block the
preceding DB-only purge. Failed SQL/schema verification permits no deletion.

The initial purge allows at most 100 batches of 100 rows per table, then checks whether
expired records remain. A deadline, uncertain query, shutdown failure or backlog
cannot be reported as clean completion. This replaces the earlier single
100-row guard sweep, which could take many hours to catch up on a quiet site.
The retry worker can additionally purge up to 40 queued token rows at the
proactive cutoff.
The HTTP path now loads Apple secrets after DB-only cleanup instead of requiring
their platform injection at container startup. The standalone operator command
retains its explicit configuration. The source supports key-independent HTTP
purging; no cloud secret-loading configuration is operationally activated here.

Cutoffs expire logically 330 seconds after the signed event. Under the implemented
but undeployed hourly fallback, their physical removal follows a later successful
sweep, normally within one additional interval plus execution delay when
healthy. That longer physical lifetime needs explicit acceptance before
activation; it is not a five-minute physical-deletion guarantee. Likewise, a
retry record expiring at seven days can otherwise wait until the next sweep.
Neither periodic execution nor an alert guarantees an exact physical maximum
during an outage. **Do not publish a strict seven-day physical-deletion claim
on this evidence alone or silently extend the owner's approved retention.**
The worker and maintenance path now purge queued encrypted records once their
existing deadline is within 24 hours, before attempting retries. Normally this
starts on day six; the original seven-day deadline is never restarted or
extended. The retry claim also rechecks this earlier cutoff after prior network
waits. This headroom reserves multiple hourly opportunities for deletion but
does not guarantee recovery from an outage lasting longer than the reserved
window. Purging a token without confirmed revocation is reported as incomplete,
not silent success. Before activation, verify that rule and the
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

Publication still needs the shorter normal retry-window and physical-purge/backup
wording above resolved,
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

1. Review the implemented backend endpoint, workload-token guard, post-startup
   secret access and existing hourly dispatch hook for deployment. Retain the
   approved seven-day maximum; settle the cutoff's physical-retention wording
   and describe the shorter normal retry window accurately. Do not create
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

## Hourly-fallback source verification

Passed 182 focused tests and backend TypeScript. The normal production webpack
configuration also built the server and receipt-job entries into an isolated
temporary directory without overwriting the running backend's `dist`. The
compiled receipt entry, launched with a sanitized environment and both cleanup
and Apple-dispatch flags off, returned exit 1 for disabled receipt configuration
and logged disabled Apple dispatch; no database credentials were supplied. The
temporary outputs from this build were removed.
Tests use synthetic identities, bounded fake transports and local
fixtures; they do not exercise live Google metadata, Secret Manager, SQL or
Apple. All new activation flags remain off. No job, schedule, secret, IAM/SQL
grant, production image/configuration or provider capability was changed, and
the read-only deletion-audit job remains untouched. Source verification is not
operational acceptance of retention or public sign-in.

From `backend`:

```text
node --test -r ts-node/register ts/accounts/runAppleTokenRevocation.test.ts ts/accounts/appleTokenRevocation.test.ts ts/config/appleRevocationConfig.test.ts ts/config/appleMaintenanceConfig.test.ts ts/security/appleMaintenanceIdentity.test.ts ts/routers/appleMaintenanceRouter.test.ts ts/leaderboards/appleMaintenanceDispatch.test.ts ts/leaderboards/receiptMaintenanceOperations.test.ts ts/leaderboards/submissionReceiptCleanup.test.ts ts/config/receiptCleanupConfig.test.ts ts/config/appleRuntimeSecrets.test.ts ts/config/providerAuthConfig.test.ts ts/config/runtimeConfig.test.ts ts/config/appleTokenConfig.test.ts ts/routers/providerAuthRouter.test.ts ts/routers/authRouter.security.test.ts
```

Typecheck, also from `backend`:

```text
npm test
```

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
was changed. This earlier check is not operational acceptance of the hourly fallback.

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
