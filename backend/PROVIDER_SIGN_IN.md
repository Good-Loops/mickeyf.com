# Google and Apple sign-in foundation

## Status — 2026-09-21

Implemented backend identity verification, one-use attempts and an opt-in HTTP
adapter connected to shared sessions; **not an enabled sign-in feature**.
Application bootstrap now reads explicit opt-in configuration; provider sign-in
remains disabled in production. Username/password and provider issuance reuse UUID-bound,
revocable device sessions; see [session behavior and rollout](SESSION_AUTHENTICATION.md).
Production provider credentials/runtime flags, HTTP callbacks and native
capabilities remain unchanged. Google web can now be enabled explicitly on the
isolated local backend as described below; full real-account acceptance is pending.

Native iOS sign-in can be developed and tested before publication. Apple's
documented web/other-platform setup requires an existing App Store app using
Sign in with Apple. The pending KWS/privacy work remains part of Ludolume's
release and age/consent plan, not a prerequisite for these synthetic backend
tests; provider sign-in must never bypass those account-creation safeguards.

Native Apple onboarding is now implemented behind disabled capabilities. Login
and signup share the prepared identity check; an unknown subject receives a
nonce-bound, single-use username continuation, while an existing account signs
in directly. No existing password account must link a provider. Apple's signed,
verified shared or private-relay email may create a new account, but email is
never used to find, merge or take over an existing account. Linked login and
fresh deletion proof do not require the token to contain an email.

The native bridge requests only email, not a profile name. `Manage account`
recognizes Apple-linked accounts and selects a deletion method only when the
server explicitly permits that provider. The SQL deletion proof and encrypted
revocation queue are implemented, but **not operationally activated**. Configuration keeps
`apple-ios.signupEnabled` and `deletionEnabled` false, omits Apple's public
signup capability, and the native Info.plist flag stays false. There is no new
environment switch that activates Apple signup. Finish reliable revocation/cleanup operation,
retention acceptance and server-notification endpoint registration before wiring those
capabilities to deployment settings; then compile on macOS and test one native
new/returning-account lifecycle. See Apple's [account-deletion guidance](https://developer.apple.com/documentation/technotes/tn3194-handling-account-deletions-and-revoking-tokens-for-sign-in-with-apple).

## Apple encrypted credentials and deletion retries — prepared, not activated

Owner-approved retention on 2026-09-21: retain Apple refresh tokens encrypted
while linked; after account deletion, retain only the encrypted revocation work
for at most seven days, deleting it sooner when Apple confirms revocation.
This exception must be included in the published privacy policy before activation.
It is an approved implementation contract, not a claim about current production.
The owner requires no additional recurring-spend setup: the separate five-minute
Apple job was not created and is no longer proposed. The existing-infrastructure
fallback plan, draft disclosure wording and
the exact notification URL are in [Apple maintenance](APPLE_MAINTENANCE.md).

The native bridge returns the ID token and one-use authorization code. Both stay
in operation memory, including the username continuation; neither is logged or
written to browser/native storage. Unknown-user login does not consume Apple's
code before the user completes signup. Google retains its existing token-only
request shape. The backend exchanges the code at Apple's fixed HTTPS endpoint,
then verifies the exchanged ID token against the original nonce and exact subject.
Known login cannot become session-eligible until credential storage succeeds.

`appleTokenRepository` uses AES-256-GCM with fresh nonces and an explicit rotation
key ID. Authenticated context binds ciphertext to its credential UUID, account
UUID and client ID. Keys are separate from SQL, session signing and App Store
Connect credentials. Migration `0016_create_apple_provider_tokens.sql` deliberately
has no cascading account foreign key: each issued credential remains available
for revocation after account removal. Signup/link token writes share the account
transaction; returning-login writes use the same account lock as deletion.

Password, Google and Apple deletion all mark existing credentials for revocation
in the deletion transaction. Apple reauthentication can add its newly exchanged
credential in that transaction. Profiles, provider links, sessions, scores and
receipts are deleted normally. The independent deletion journal is unchanged:
no token, key, email or additional field is written to it. Isolated backup replay
marks/purges credentials using the earliest deletion intent, even for an absent
account; it never contacts Apple and cannot restart the seven-day deadline.

After confirmed local deletion, the HTTP path now attempts one account-scoped
Apple revocation within a ten-second total budget. Failure leaves durable work
queued; it cannot undo deletion or report the removed account as still present.
This improves the normal case but is not a scheduled retry or retention guarantee.

The maintenance worker processes at most 20 due rows per pass under a
database-scoped lock. SQL changes commit before network calls. Transient failures
retry with 60-second exponential backoff, capped at one hour and the original
proactive purge cutoff. Queued credentials are now purged when their original
seven-day deadline is within 24 hours, normally starting on day six; claims
recheck that cutoff and never extend retention. This headroom is not a guarantee
against longer outages. Purging without confirmed Apple revocation reports an
incomplete run. DB-only purge does not need working decryption keys or Apple.
The compiled operator command keeps its 180-second work and five-second shutdown
limits. The new HTTP adapter has a 90-second watchdog and borrows, but never
closes, the website pool. Late continuation guards prevent further SQL,
decryption or Apple calls; an in-flight secret fetch retains its separate
ten-second bound and may finish after a failed run. Both probe actual remaining backlog and report only
aggregate counters, not tokens or account identifiers.

The source now connects that adapter to the existing hourly receipt job through
one disabled-by-default, workload-identity-authenticated request. Receipt work
and Apple dispatch run independently in parallel; either failure makes the job
fail after both finish. The dispatch is bounded to 110 seconds including its
five-second identity-token fetch, with no redirects or retry loop. The receipt
operation retains its 120-second work/five-second shutdown bounds. No extra
schedule, job, SQL privilege or Apple key is added to the receipt worker; the
read-only deletion-audit worker is unchanged. This is not yet deployed.

Preparation commands (not run against production in this checkpoint):

```text
npm --prefix backend run migrations:apple-tokens:apply
npm --prefix backend run migrations:apple-revocation:apply
npm --prefix backend run apple-tokens:revoke
```

Apple issuance with `APPLE_TOKEN_LIFECYCLE_ENABLED=true` requires
`APPLE_NOTIFICATIONS_ENABLED=true`, `APPLE_IOS_BUNDLE_ID`, dedicated
`APPLE_SIGN_IN_TEAM_ID`, `APPLE_SIGN_IN_KEY_ID`, `APPLE_TOKEN_ACTIVE_KEY_ID`,
and valid signing/encryption material. The existing explicit operator/local
mode reads `APPLE_SIGN_IN_PRIVATE_KEY` and `APPLE_TOKEN_ENCRYPTION_KEYS` (a JSON
key-ID to canonical base64 32-byte-key map, up to eight rotation keys).

HTTP maintenance instead requires `APPLE_TOKEN_RUNTIME_SECRETS_ENABLED=true`
and prohibits those inline/container-injected key variables. Application code
reads `APPLE_SIGN_IN_PRIVATE_KEY_SECRET_VERSION` and
`APPLE_TOKEN_ENCRYPTION_KEYS_SECRET_VERSION` from distinct, pinned positive
numeric Secret Manager versions in the existing project after container startup.
There is no `latest` alias, new key creation, permanent service-account key or
local ADC fallback. Provider bootstrap loads once with a bounded timeout; failure
hides Apple for that process until restart without disabling Google, Apple
notifications or DB maintenance. Each maintenance pass fetches fresh keys only
after its independent DB-only purge. See [exact flags, identities and deployment
limits](APPLE_MAINTENANCE.md#explicit-deployment-configuration--none-enabled-by-this-checkpoint).
Missing schema or invalid SQL identity still fails closed. Keep historical decryption keys
until corresponding live/recovery ciphertext has expired or been re-encrypted.
Preparing these credentials does not enable Apple signup/deletion or Info.plist.

The maintenance command additionally requires exact `apply`, `NODE_ENV=production`,
`APPLE_REVOCATION_RUN_ENABLED=true`, `APPLE_REVOCATION_DB_USER`,
`APPLE_REVOCATION_DB_PASS`, `APPLE_REVOCATION_DB_NAME`,
`APPLE_REVOCATION_CLOUD_SQL_CONNECTION_NAME`, `APPLE_REVOCATION_EXPECTED_ACCOUNT`
and `APPLE_REVOCATION_EXPECTED_SERVER_UUID`. It accepts only the reviewed `cms`
Cloud SQL socket and runtime identity, then verifies actual SQL identity/schema
on every borrowed connection. There is no dotenv/default-database fallback;
isolated-runtime settings are rejected. A nonzero result signals retries,
backlog, lock contention, failure or expiry without confirmed revocation.

Before activation: publish matching retention disclosures; apply/verify the
reviewed migration and grants; deploy/enable the prepared backend maintenance
endpoint and bounded call from the existing hourly receipt dispatch, without
sharing Apple keys or broadening that worker's SQL grants; verify the caller's
numeric uniqueId and fixed service-base audience; prove proactive expiry
and retry behavior there; register and verify signed server-notification delivery;
then approve native signing/build/device acceptance. The hourly fallback,
proactive purge headroom and post-startup secret loading are now implemented in
source; new flags remain off and no operational activation has occurred. Verify
existing failure/backlog/missing-success reporting on the actual dispatch. No new cloud
service or recurring timer has been created. The standalone command remains available
for operator/recovery work. Immediate attempts and an unscheduled command alone
do not satisfy the retention commitment, and resource reuse does not guarantee
zero additional metered usage.

Apple exchange and SQL cannot form one distributed transaction. A lost exchange
response or failed persistence is reported as failure, not successful login.
Do not claim all issued tokens are recoverable from a failed exchange, and do
not blindly revoke on a signup/link conflict: that may revoke an existing user's
Apple authorization. Existing accounts without a recoverable token still need
Apple's documented manual-revocation fallback before native activation.

References: [Apple code exchange](https://developer.apple.com/documentation/signinwithapplerestapi/generate-and-validate-tokens),
[Apple revocation](https://developer.apple.com/documentation/signinwithapplerestapi/revoke-tokens).

Checkpoint verification: all 596 backend unit tests, 126 focused frontend tests,
both TypeScript checks, 41 disposable provider/replay/session MySQL cases and
14 disposable runtime-grant cases passed. Initial broader runs exposed stale
fixtures for the new token queries and the previously committed session-isolation
statement; fixture corrections preserved their strict query/race assertions.
Both disposable containers/networks were removed. No live Apple authentication,
production migration, deployment or macOS compilation was performed.

Commands from the repository root:

```powershell
npm.cmd --prefix backend test
node frontend/node_modules/typescript/bin/tsc --noEmit -p frontend/tsconfig.json
node backend/scripts/run-migration-tests.mjs --provider-identities
node backend/scripts/run-migration-tests.mjs --runtime-grants
```

Backend unit execution used the complete `test:unit` file list with concurrency
limited to two (from `backend`):

```powershell
$unitFiles = ((Get-Content package.json -Raw | ConvertFrom-Json).scripts.'test:unit' -replace '^node --test -r ts-node/register ', '').Split(' ')
node --test --test-concurrency=2 --test-reporter=spec -r ts-node/register @unitFiles
```

Frontend directory: `node --experimental-strip-types --test --test-reporter=spec
ts/services/providerClient.test.mjs ts/services/authApi.test.mjs
ts/services/authProviderSignup.test.mjs ts/services/nativeApiFetch.test.mjs
ts/components/ProviderSignInControls.test.mjs`.

## Native Apple credential loss — prepared, not activated (2026-09-21)

New Apple-issued sessions carry the signed `authenticationMethod: 'apple'` claim;
renewal preserves it. Password, Google and existing unmarked sessions do not
inherit it merely because an account has an Apple link. No session-table change
is needed. `GET /auth/providers/apple-credential` accepts only the current live,
unambiguous native signed cookie and exact `capacitor://localhost` Origin. It
returns that session's linked subject, or `userId: null` for non-Apple sessions;
caller-selected subjects, Bearer tokens, web cookies and query selectors are rejected.
Responses are non-cacheable; provider/storage failures are sanitized.

The native bridge observes Apple credential revocation and app foreground return.
Startup, renewal and those notifications check platform authorization before
trusting/extending an Apple session. Confirmed `revoked`/`notFound` states invoke
the existing cookie-bearing device logout. Unknown states, app-transfer states
and failed checks are unavailable, not evidence of revocation. Checks have a
ten-second deadline and share the auth mutation queue; a late old-account check
cannot sign out a newer login. Signals during a pending check coalesce into a
follow-up instead of being dropped.

If Apple confirms credential loss but server logout fails, authenticated UI is
hidden and the cookie is retained for a later foreground/activity logout retry.
The client does not claim server revocation succeeded. A new successful login
does not inherit the previous session's pending logout. No account, scores,
provider links or other devices are deleted/revoked by this client signal.

This is a native-client protection, **not global server enforcement**: a copied
cookie or another device is not invalidated solely by a client notification.
The server implementation below supplies independent global enforcement once
its receiver is deployed and registered with Apple. Apple Account deletion
does not reliably trigger the native revocation notification, so foreground
credential-state checks are necessary. See [Apple's account-change guidance](https://developer.apple.com/documentation/signinwithapple/processing-changes-for-sign-in-with-apple-accounts).
Native capability/signup/deletion switches remain disabled. Swift verification
here is source-contract testing, not a macOS build or device acceptance.

Verification: 162 focused frontend tests and 110 focused backend tests passed,
along with both TypeScript checks and `git diff --check`. No database integration
rerun was needed for this schema-free change; no live Apple calls were made.
Focused commands (repository root unless noted):

```text
node frontend/node_modules/typescript/bin/tsc --noEmit -p frontend/tsconfig.json
node backend/node_modules/typescript/bin/tsc --noEmit -p backend/tsconfig.json
node --experimental-strip-types --test frontend/ts/services/nativeAppleSession.test.mjs frontend/ts/services/authApi.appleSession.test.mjs frontend/ts/services/authApi.test.mjs frontend/ts/services/authProviderSignup.test.mjs frontend/ts/services/nativeApiFetch.test.mjs frontend/ts/services/sessionRenewalActivity.test.mjs frontend/ts/services/providerClient.test.mjs frontend/ts/components/ProviderSignInControls.test.mjs
```

From `backend`:

```text
node --test --test-reporter=dot -r ts-node/register ts/security/sessionPolicy.test.ts ts/security/requestAuthentication.test.ts ts/auth/providerSession.test.ts ts/auth/providerAuthFlow.test.ts ts/routers/providerAuthRouter.test.ts ts/routers/authRouter.security.test.ts
```

## Signed Apple server notifications — prepared, not activated (2026-09-21)

`POST /auth/providers/apple-notifications` is absent unless
`APPLE_NOTIFICATIONS_ENABLED=true`. Receiving remains independently configurable
when new provider sign-in is paused. Token-lifecycle issuance requires the
receiver flag; startup also verifies recorded migrations 0017/0018 and exact
schemas. This checkpoint changes no live configuration or Apple portal setting.

The endpoint accepts only `{ "payload": "<signed JWT>" }`: at most 32 KiB JSON
and a 16 KiB payload. A cookie, Origin or bearer token does not authorize a
notification. Verification requires RS256 with Apple's fixed HTTPS key source,
issuer, the configured bundle ID as exact audience, event subject/type and
bounded timestamps. It accepts delayed signed messages rather than applying the
five-minute *login* deadline. Optional JWT expiry is enforced. Unknown events or
invalid proofs are rejected, while key/storage failures return a sanitized 503.
The response acknowledges only completed application; retries are idempotent.

`consent-revoked` and `account-deleted` delete only Apple-authenticated sessions
whose **original verified ID-token issuance time** is at or before the event.
The new nullable session provenance binds that time to a SHA-256 hash of the
exact Apple client/subject. Cookie renewal cannot reset it; the exchanged token's
later issuance time cannot replace it. Newer Apple logins, password/Google
sessions, accounts, provider links and scores are preserved. Email-forwarding
events are acknowledged without mutating sessions or persisting email data.

To close sign-in races, the receiver commits an event cutoff before looking up
the subject or acquiring the account lock. It then deletes matching sessions
under the same lock used by issuance, renewal, deletion and protected writes.
Issuance rechecks the identity, cutoff and proof age immediately before INSERT;
the INSERT also checks age against database time. A rejected proof rolls back
any session-cap eviction. Unknown-subject notifications receive the same cutoff,
so a concurrently completing signup cannot issue a pre-revocation session.

`apple_auth_revocations` holds at most 10,000 hashed-subject cutoffs, not a raw
notification history. Each logical cutoff expires 330 seconds after the signed
event, covering the 300-second accepted proof age plus clock tolerance. Duplicate
or older events cannot restart that deadline. Delayed events still delete old
surviving sessions even after no cutoff is needed. This hash is pseudonymous
security data, **not anonymous data**. Physical removal is bounded to 100 rows
per pass, on notifications and in the existing explicit `apple-tokens:revoke`
maintenance command. A full batch requests another pass. Physical retention
depends on that worker actually running; it is not guaranteed to be 330 seconds.

Before activation, disclose this short-lived security processing and agree the
maintenance cadence/physical retention bound, alongside the approved seven-day
encrypted deletion-retry exception. Apply/verify 0016, 0017, 0018 and scoped grants;
register the approved HTTPS receiver; verify delivery and maintenance execution;
then perform the approved native build/lifecycle check. This adds no scheduler.
Check for prepared/legacy Apple sessions without SQL provenance and invalidate
those before enabling Apple. Do not infer a session's login method from its
account's provider link. A database restore must invalidate restored sessions
before traffic resumes: deletion replay cannot replay Apple's past notifications.

Disposable MySQL verification passed six notification/issuance/renewal/cleanup
cases and fifteen restricted-grant cases, including real lock ordering and the
database CHECK constraint. Both test containers/networks were removed. No live
Apple call, production migration, native compilation or deployment was performed.
The complete backend unit suite, backend TypeScript check and eleven local
launcher/test-selection checks also passed. Unit execution used the complete
`test:unit` list with concurrency limited to two, as documented above.

```text
node backend/scripts/run-migration-tests.mjs --apple-revocation
node backend/scripts/run-migration-tests.mjs --runtime-grants
node --test backend/scripts/dev-isolated.test.cjs backend/scripts/run-migration-tests.test.mjs
npm --prefix backend test
```

Reference: [Apple account-change notifications](https://developer.apple.com/documentation/signinwithapple/processing-changes-for-sign-in-with-apple-accounts).

## Identity and account ownership

`auth/providerTokenVerifier.ts` accepts a signed ID token only after checking
RS256 against the provider's fixed HTTPS JWKS endpoint, issuer, one exact
server-configured audience, expiration, issuance age, and expected nonce.
Google's authorized presenter (`azp`) must also match configuration when present;
a separately configured native presenter must be present in the token.
Configuration belongs to the server, never to submitted request fields.

The successful result identifies `{ provider, subject }` and can include a
provider-authoritative verified email for separately enabled account creation. Its nominal
TypeScript type prevents accidental use of decoded/request claims, but is not
a runtime security boundary. Only the verifier should construct it.

`accounts/providerAccountRepository.ts` maps that identity to `users.account_uuid`.
Login lookup does **not** match email addresses. Separately enabled signup can
create a passwordless account; it never merges with an account by email. To link an existing
account, the trusted context supplies its numeric ID, immutable UUID and device
SessionProof; the user also supplies the current password. The repository checks
UUID and password inside the same per-user lock used by logout, score submission
and deletion, then rechecks that device session immediately before insertion.
Logout or expiry during provider verification therefore prevents a late link.

- `(provider, subject)` is byte-exact and belongs to one account.
- `(account_uuid, provider)` permits one identity per provider per account.
- Retrying the same link is idempotent; a conflict never moves or overwrites it.
- A deleted/recreated numeric user ID cannot inherit the original UUID's links.
- Only subject, provider, account UUID and UTC linking time are stored—no
  provider email/name, access token, refresh token or raw ID token in the identity
  table. Signup stores its verified email in the ordinary user record.
- Driver errors are sanitized; ambiguous commits must not be reported as success.

Migration `0009_create_account_provider_identities.sql` adds this table with an
account-UUID foreign key and `ON DELETE CASCADE`. Ordinary deletion and restored
backup replay therefore remove its links when deleting the account. Readiness
and replay validate that relationship; a pre-0009 backup may omit the table,
but a recorded 0009 with a missing or malformed table fails verification.

## Deliberate verification limits

ID tokens must be less than five minutes old, with at most 30 seconds of future
issuance skew; expired tokens have no grace period. Nonces are bounded ASCII
base64url/hex strings. The caller must supply the exact nonce sent to the provider,
including any transformation required by a native flow.

JWKS requests have a five-second deadline, 64 KiB/16-key bounds, no redirects,
RS256 RSA keys of 2048–8192 bits, a one-hour cache cap and a 30-second refresh
cooldown. Concurrent requests share one fetch. Expired keys are not reused;
new keys or an unavailable provider can temporarily require a retry. Tokens and
provider payloads must not be logged.

**Signature verification alone does not prevent replay or login CSRF.** The
internal flow now supplies the expected nonce from a consumed server-held attempt,
never from a completion request. Account UUID and audience are not accepted from
request bodies either.

## One-use attempts and internal orchestration

`auth/providerAuthContext.ts` requires JSON POST and an exact approved Origin.
Only begin may bootstrap an anonymous binding. It uses a purpose-separated random,
timestamped value in the canonical signed HttpOnly cookie: `__session` on the web,
`session` for the native Origin. Cookie-parser verifies its signature; the reader
enforces its five-minute lifetime independently of browser cookie expiry. The value
is not a session JWT and cannot authenticate a user. Each anonymous begin rotates
it; the challenge reports no more than its remaining lifetime after database work.
Complete never bootstraps. Bearer headers, unsigned cookies, conflicting cookie
names and malformed signed sessions are rejected, never treated as anonymous.
Only begin can refresh a correctly signed, well-formed expired anonymous binding.

For linking, the reader verifies the current live device session and resolves the
account UUID from storage, carrying SessionProof to the final repository guard.
The binding hash includes Origin, the raw canonical cookie and resolved account.
Login replaces that cookie and logout clears it, including through Firebase
Hosting, which forwards only `__session`. Normal sequential anonymous → login →
logout cannot reuse the previous challenge from that browser's cookie state.

`auth/providerAuthFlow.ts` is disabled by default. It creates separate random
state and nonce values, pins the action/client to server configuration, then
consumes the matching attempt **before** token verification or account operations.
Invalid proof, incorrect linking password, provider failure and cancellation need
a new attempt. Only the explicit linking flow requires the current password;
already-linked login resolves the verified provider subject without it. With
Google signup enabled, an unknown verified Google subject receives a fresh
single-use signup continuation instead of a NOT_LINKED error. The continuation
uses the original nonce and signed browser binding; it cannot extend that
binding's original five-minute lifetime. Completing it re-verifies the Google
credential and creates the account only after a username is provided. No raw
credential is stored server-side. `account-verified` is an internal
result, not an issued session or a proof to send through a browser and trust later.

`auth/providerAttemptRepository.ts` uses the existing database across instances.
The stored state is hashed; raw ID tokens, session cookies and passwords are not
stored. Consumption locks the row, checks expiry using database time after the
lock is obtained, and commits its removal before returning the nonce. A failed or
uncertain commit cannot authorize a caller. A new attempt replaces a pending one
with the same binding. Fresh anonymous begins have new bindings, so their abandoned
rows instead expire and use the bounded opportunistic cleanup below. Old anonymous
challenges no longer match the browser's replacement cookie; possession of a stolen
old signed cookie is not server-side revocation of that cookie before its expiry.

Attempts expire after five minutes. This is **validity**, not a promise of physical
deletion at five minutes: each creation removes up to 100 expired rows; consumption
also removes its matched expired row. Expired rows can remain while there is no
activity. A database-scoped creation lock enforces a 10,000-row cap. No scheduler,
cloud service or background worker is added. Linked attempts reference account
UUIDs and cascade on deletion, including deletion replay after restoring a backup.

## Opt-in HTTP session adapter

`routers/providerAuthRouter.ts` is mounted at `/auth/providers` only when
`createAuthRouter` receives explicit enablement and configured clients. The
runtime configuration remains disabled unless `PROVIDER_AUTH_ENABLED=true`.
The request shapes are:

- `GET /config`: `{ clients: [{ clientKey, provider, platform, clientId }] }`, public identifiers only;
  always mounted, empty when disabled, no database/cookie effects and `Cache-Control: no-store`.
- `POST /begin`: `{ action: "login" | "link", clientKey }` → `{ state, nonce, expiresInSeconds }`.
- `POST /complete`, login: `{ action: "login", clientKey, state, idToken, rememberMe?: boolean }`.
- `POST /complete`, link: `{ action: "link", clientKey, state, idToken, password }`.

Unknown fields are rejected. Login can return
`{ signupRequired: true, challenge: { state, nonce, expiresInSeconds } }` for
enabled Google onboarding; this is not a session or an authenticated account.
Successful login returns `{ success: true, user_name }`;
linking returns `{ success: true, linked: true }`. The internal verified-account
result and session token are never returned as JSON. `auth/providerSession.ts`
uses the same token issuer, locked session repository and cookie policy as password
login. It sends a cookie only after the session commit is confirmed. `rememberMe`
selects the existing renewable 30-day inactivity policy; otherwise the device
session lasts four hours. No separate provider refresh-token store is introduced.

Dedicated in-memory limits per server instance allow 30 begin requests/IP,
50 completion requests/IP and 5 link password attempts/account per 15 minutes.
These supplement the general API limit; they are not a distributed global quota.
Failures are sanitized and do not clear newer authentication cookies. The total
JSON budget stays 32 KiB and ID tokens remain bounded to 16,384 characters.

Provider begin and complete requests share the frontend auth queue with password
login, renewal and logout. Waiting for the inline Google credential does not hold
that queue or disable password login. Other authentication actions invalidate the
prepared attempt; expiry/unmount/cancel removes the stale button. Account linking
and native sign-in retain their queued dialog flow and five-minute deadline.
An already-dispatched completion is awaited, including saved-cookie verification,
before releasing the queue: cancel cannot undo an accepted server request.
Native transport explicitly allows only these three provider routes and uses
the same 32 KiB JSON budget as the server. Arbitrary cross-tab/in-flight responses
are not canceled by canonical-cookie replacement; acceptance must cover those
separately from the single-page queue.

## Client configuration and controls

- `GOOGLE_WEB_CLIENT_ID` configures exact audience/key `google-web` for ordinary
  browsers. Google's official GIS button appears directly on the login form;
  its own click opens the provider prompt. The SDK loads when the configured
  Google login control mounts, not globally on other pages. Account linking
  retains the site's dialog. **Authorized-origin checkpoint
  (2026-09-14):** saved and read back exactly `http://localhost:5173`,
  `https://mickeyf.com` and `https://www.mickeyf.com` on the existing `MickeyFOrg Client`.
  Its name/client ID and credentials are unchanged; redirect URIs remain empty.
  The console warns that propagation may be delayed. **Branding/header checkpoint
  (2026-09-14):** Google confirmed saving app name `Ludolume` and homepage
  `https://mickeyf.com`. Existing support/developer contacts, authorized domain
  and Testing status are unchanged. Privacy/terms URLs and logo remain unset;
  the private privacy-policy draft is not a published URL.
  Local `firebase.json` now permits only Google's documented GIS paths for
  script/style/frame/connect requests and uses `same-origin-allow-popups` for
  popup communication. The global rule is necessary because Home-to-Login SPA
  navigation retains the original document headers. Seven focused policy/API-base
  tests pass; other security headers remain unchanged. See
  [Google's setup guidance](https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid).
  This is not deployed or live-tested. Deployment needs approval for trusting
  those Google resources and retaining popup opener relationships; provider
  production sign-in remains disabled. Google's localhost instructions also list bare
  `http://localhost` alongside the port-specific origin. The owner approved that
  fourth origin on 2026-09-14; it is now saved and read back on the same client,
  with the original three origins and empty redirect list preserved.
- `APPLE_IOS_BUNDLE_ID` configures exact audience/key `apple-ios`. Native iOS
  uses AuthenticationServices, not a web OAuth view. The native bridge reports
  unavailable while `LudolumeAppleSignInEnabled` is false (the committed default).
  Enable it only together with the App ID capability, entitlement and matching
  provisioning profile. The build/signed-device acceptance is still pending.
- Each client receives the server challenge nonce unchanged. Native Apple also
  checks the returned state and requires its client ID to match the app bundle.
  Tokens are transient: no provider token/profile is persisted or logged.
  Capacitor bridge payload logging is disabled, including debug builds.
- Unsupported native Google and web Apple IDs are rejected when opt-in is enabled,
  rather than accidentally advertising unusable clients. Android and iOS Google
  still need their official native SDK/client configuration; Apple web remains
  a separate Services ID/callback milestone.
- Controls appear only for server-configured and platform-capable clients.
  Google login uses its official button without a separate selector or provider
  heading. Password accounts retain the linking dialog and current-password proof;
  native Apple retains its existing control and sheet.
  Existing users link from Manage account using their current password, then
  log in with that provider and the same Stay signed in preference. Linking is
  optional: new Google users can use the separately enabled onboarding flow
  from either entry form, without first creating a password account.
  Disconnect/provider-token revocation remain separate work.

## Passwordless Google signup and deletion

`PROVIDER_GOOGLE_SIGNUP_ENABLED=true` separately enables Google **web** signup;
the default is off. Discovery advertises `signup: true` only for that Google
client. Sign up and Log in start the same official Continue with Google flow.
A known Google subject signs in immediately on either form. Only a new subject
sees the small username card, using a fresh bound continuation without another
Google popup. Signup being disabled never prevents an existing Google user
from signing in through either form. The
chosen Stay signed in preference uses the existing renewable, revocable session.

The server verifies the Google token signature, audience, issuer, expiry and
single-use nonce/state before creating anything. It accepts an email only when
Google is authoritative for it (verified Gmail, or verified email with a valid
Workspace `hd` claim). Other Google-account emails can still log in when linked,
but cannot create a passwordless account through this path. Google authentication
is **not** age assurance or parental consent.

One transaction inserts the user with `user_password = NULL` and its exact Google
subject link. Unique username/email/provider keys prevent collision races. It
never invents a password, overwrites an existing link or merges accounts by email.
An already registered Google subject signs in directly; a username/email collision
with an unrelated subject remains a conflict, never an email-based merge. Signup success
requires a durable session and the client's matching authenticated-session check.

Manage account reads only authenticated boolean capabilities. Password-only
accounts keep password deletion. Google-only accounts use typed DELETE,
destructive confirmation and a fresh Google challenge. Under the existing
deletion/submission lock, the server rechecks the exact linked subject, UUID and
live session **before** recording the independent deletion journal and deleting
data. Wrong/replayed proof never records deletion intent; uncertain completion
does not claim success or clear the UI session.

Production signup refuses to start without account deletion enabled. Public
activation still requires the agreed age/consent and privacy work, migration and
least-privilege grants, and explicit deployment approval. No native Google flow
or provider-disconnect UI is added by this change.

## Isolated Google web check

Use the existing local launcher, with the approved public web client ID supplied
explicitly (not a client secret):

```text
npm run backend:dev:isolated -- --google-web-client-id <approved-client-id>
```

It verifies the owned, pinned Docker MySQL container and server UUID before
writes, uses only `ludolume_development` on `127.0.0.1:3307`, and retains the
existing data while applying reviewed schema 0001–0015. Only this opt-in adds local provider-table grants.
Identity columns can be selected/inserted, not reassigned or deleted; MySQL's
locking reads additionally need `UPDATE(linked_at)`. Attempts have the exact
read/insert columns plus deletion. The production grant manifest is unchanged.

The launcher strips inherited Google/Apple configuration and supplies an
explicit isolated-development marker. App bootstrap skips the root `.env`
only for that marker **and** development mode, so removed settings cannot be
silently reintroduced. Ordinary development and production still load `.env`.
Running the launcher without the flag disables providers; local grants and
local accounts remain stored and are not silently revoked/deleted.

Append `--google-signup` to enable the new signup button on this isolated backend.
The launcher applies 0013 username uniqueness (stopping on duplicates, never
renaming users), 0014 nullable passwords, and 0015 signup/delete attempt actions.
Startup verifies the resulting schema before advertising signup. Local account
deletion remains disabled: deletion behavior is tested with an injected fake
journal in the disposable MySQL/HTTP fixtures, not with production GCS access.

Checkpoint (2026-09-14): seven launcher/bootstrap tests and backend typecheck
passed. Restarted only VS Code's Back terminal in Google-only mode. A restricted
runtime-user transaction proved identity insert/locking read, attempt
insert/locking read/delete, and denial of identity reassignment/deletion; all
probe rows were rolled back. Local discovery advertises only `google-web`.
The real GIS button rendered and cancellation returned to the login form.
No Google account was chosen and no real identity was linked or logged in.
The extra bare-localhost origin is now owner-approved, saved and read back;
credentials/scopes/publication were not changed. Production and native
providers remain disabled and no deployment occurred.

Provider implementation acceptance must use an isolated local website account
(`VITE_USE_PUBLIC_API=0`): link Google from
Manage account using that account's password, then log out and sign in through
Google with Stay signed in selected. A production website account is not copied
into this database. Google basic sign-in does not require adding test users
under [its documented Testing-status exception](https://support.google.com/cloud/answer/15549945);
do not add Gmail/Drive scopes, publish the OAuth app, or treat button rendering
as successful end-to-end authentication.

## Migration and activation boundary

The usual `migrations:apply` deliberately applies neither 0009 nor 0010. After reviewing an
approved target and the existing explicit migration-account/write confirmations:

```text
npm --prefix backend run migrations:plan
npm --prefix backend run migrations:providers:apply
npm --prefix backend run migrations:provider-attempts:apply
npm --prefix backend run migrations:plan
```

The provider-identity command selects only 0009 and requires recorded 0001–0008.
The separate attempt command selects only 0010 and requires recorded 0001–0009.
Both validate the exact resulting schema before recording history. Deletion
recovery checks allow pre-0010 backups without the attempt table, but reject a
missing recorded table or malformed cascade. Historical SQL remains unchanged.
Enabled provider authentication instead requires recorded 0009/0010 and both
exact schemas at startup. Extended attempt actions additionally require recorded
0015; signup and Google-authorized deletion continue to require that extended stage.
These commands are **not** a local-safety guarantee: a loopback proxy may target
production. No production migration was executed in this checkpoint.

The reviewed runtime grant manifest now includes narrow provider-table access:
identity lookup/insertion, UPDATE only on `linked_at` for the supported MySQL
locking read, and attempt insertion/consumption. It permits neither identity
reassignment nor direct identity deletion. These are source definitions, not
applied production grants. Coordinate their explicit application with schema,
recovery compatibility and the enabled application revision; no blanket grants.

### Public activation preparation — 2026-09-14

A read-only production query confirmed recorded migrations only through 0008.
This does not establish whether any unrecorded partial tables exist; the explicit
migration planner must inspect those before a write. The public backend remains
the legacy password/session revision, and localhost public preview still uses it.

Provider startup checks and narrow grants now pass isolated validation: 26 focused
grant unit tests, 13 disposable MySQL grant integration tests (including actual
provider startup, linking and single-use attempts), and the backend typecheck.
No production schema, privilege, traffic, OAuth setting or account was changed.

The owner clarified that the release must include both first-time Google signup
and returning-user login, on both forms and the same public backend from localhost.
An existing-account/link-only rollout is not the requested completion. Linking
password accounts remains optional. New Google accounts still require the approved
age/consent, available-deletion and published-privacy work; keep those gates while
preparing the coordinated backend/Hosting/session cutover.

The localhost gateway now has a tested `renewable` protocol option for provider
discovery, begin/complete and renewal. It maps only `ludolume_public_web_session`
to the backend's canonical `__session`, including anonymous challenge bindings.
Local test credentials, native cookies and legacy public cookies are not mixed.
The Vite plugin defaults to legacy mode: select the renewable protocol only
with the real public backend deployment.
Renewable-mode self-service deletion is covered below; admin routes remain
outside the gateway's allowlist.

Unified-entry verification: 52 backend provider-flow/router tests, 67 frontend
auth-transport/UI tests, 14 direct gateway tests and four public-preview
compatibility tests passed. Both TypeScript checks and the production frontend
build passed. These use synthetic provider responses and do not establish live
Google/public-session acceptance. No production activation occurred.

### Deployment configuration prepared — 2026-09-14

The canonical deployment, frozen renderer and traffic planner now carry the
Google configuration explicitly. Previously `--set-env-vars` replaced the
runtime settings without including Google, so activation could be omitted or
lost during a later deployment.

The optional `googleSignIn` pins accept either `{ "enabled": false }` or
`{ "enabled": true, "clientId": "1012884798546-u18tb6962p05mdpfe6nov8uhe0pbeak8.apps.googleusercontent.com" }`.
Enabling requires the existing reviewed enabled `accountDeletion` pins and sets
both provider login and Google signup flags together. There is no link-only
release mode. Omission stays off by default, but cannot silently disable Google
on a current template, serving revision or tagged revision. Intentional disable
requires an explicit decision bound to the reviewed source/build/image.
Unsupported provider settings and inconsistent states fail before deployment.

Verification: `node --test scripts/render-frozen-backend-deploy.test.mjs`
(16 tests, including generated Bash/Python syntax) and
`node --test scripts/frozen-backend-traffic.test.mjs` (57 tests) passed using
offline fixtures. No cloud configuration, production data or traffic changed.
This prepares deployment inputs; it does not satisfy the age/privacy, recovery,
schema/grant or coordinated-session cutover requirements.

The owner explicitly requested restoring **Continue with Google on localhost**.
That is part of the public signup/login release: select the gateway's renewable
protocol together with the compatible public backend. Preserve the same real
accounts and scores; do not silently switch localhost back to the isolated
database to make the button appear.

### Explicit localhost cutover configuration — 2026-09-21

`VITE_USE_PUBLIC_API=1` continues to select real public accounts and scores.
The separate `VITE_PUBLIC_AUTH_PROTOCOL` accepts only `legacy` (the default) or
`renewable`. Vite and the browser share its parser. Only legacy mode hides
provider/account-management controls and uses verify-only, four-hour sessions;
renewable mode permits discovery and the existing renewal/deletion flows.
The live-account notice remains visible in either development-preview mode.
Production/native API selection and leaderboard sources are unchanged.

Do not set `renewable` until the matching public backend is live. Restart Vite
at cutover and sign in again: the two protocols deliberately have different
cookie namespaces. There is no automatic negotiation or fallback that could
mix challenge/session cookies. No local environment flag or production setting
was changed in this checkpoint.

Read-only activation review still finds unfinished age/consent and published-
privacy work, plus the coordinated schema/deletion/runtime rollout. The initial
audience discussion is superseded by the adult-only signup decision below.
KWS does not block independent development. A fresh Cloud Run metadata read
failed during gcloud auth refresh with a certificate-trust error; dated
cloud/schema/backup observations below must not be presented as current
evidence. TLS verification remains enabled.

Validation: 60 focused tests passed with mocked network requests, including
actual Vite plugin wiring, both cookie protocols, invalid configuration,
provider capability visibility, and unchanged public leaderboard routing:

```text
node --experimental-strip-types --test --test-reporter=spec frontend/ts/config/publicAuthProtocol.test.mjs frontend/ts/services/publicApiPreviewCompatibility.test.mjs frontend/ts/services/publicApiPreview.test.mjs frontend/ts/config/apiBase.test.mjs frontend/ts/services/publicLeaderboards.test.mjs frontend/ts/components/ProviderSignInControls.test.mjs
node frontend/node_modules/typescript/bin/tsc -p frontend/tsconfig.json --noEmit
git diff --check
```

TypeScript and whitespace checks passed. Existing duplicate Capacitor plugin
registration warnings occur across the isolated SSR scenarios. These checks do
not establish real-provider acceptance or public activation; no broad gameplay
or backend test campaign was repeated.

### Adult-only signup preparation — 2026-09-21

The owner approved an initial adult-only new-account flow without invitations,
with KWS test integration in parallel. The later all-ages/parent-managed plan is
not cancelled. This does not activate signup, classify existing users as adults,
or authorize a production deployment or country restrictions.

The registration check must cover password, Google and Apple account creation.
Existing-account login and optional provider linking are separate operations;
do not require linking or age verification merely to show a provider button.
Guest play remains outside the registration flow. This scope is not a claim
that an adult-only label exempts the service from children's privacy obligations.

Use KWS **Age Verification** for registrants verifying their own eligibility,
not Parent Verification as a substitute. The live portal and
[Age Verification setup documentation](https://dev.epicgames.com/docs/kids-web-services/age-verification-service/set-up/av-service-set-up)
require KWS to enable this service before self-service configuration and terms
review. With the owner's explicit approval, the test-access request form was
submitted; it closed after its sending state without a visible error, but no
durable confirmation or case number was captured. Receipt is unconfirmed; do
not automatically resend. This is separate from the earlier privacy enquiry.
No service agreement was accepted, credentials created or test/production
configuration published.

Implementation boundary: account creation must require a server-validated,
single-use eligibility result bound to the registration context and registrant.
Consume it in the same transaction as account creation; browser flags, provider
identity tokens and test-environment results must not authorize production
signup. Keep raw verification inputs out of this application. Validate the
actual result-binding API before adding an adapter or evidence schema. Preserve
OAuth's existing short challenge lifetime; verification must not extend it.
The flow, UI and live integration remain unimplemented at this checkpoint.

### Localhost deletion transport prepared — 2026-09-14

The renewable gateway now forwards both existing self-service deletion flows:
password confirmation at `/auth/delete-account`, and Google `delete` challenges
at `/auth/providers/begin` and `/auth/providers/complete`. Exact request shapes
exclude account selectors; Google deletion is limited to `google-web`. The
backend remains responsible for session ownership, fresh proof and durable
deletion. Loopback/Origin restrictions and the separate public cookie remain.
Confirmed responses relay cookie clearing; pending/failure responses do not
become success or trigger automatic retries.

`node --experimental-strip-types --test frontend/ts/services/publicApiPreview.test.mjs`
passed 20 mocked gateway tests; `node frontend/node_modules/typescript/bin/tsc
-p frontend/tsconfig.json --noEmit` passed. No real accounts or network services
were used. Legacy mode still blocks deletion, and `/account` remains behind its
existing public-preview compatibility guard until coordinated activation.

Remaining work, in order:

1. Complete the approved age/consent and published-privacy requirements for new
   accounts, plus deletion recovery/availability prerequisites. Then apply the
   reviewed schema and narrow runtime grants for the coordinated public web
   signup/login and renewable-session release. Restore the localhost Google
   buttons in that release, preserving password access and score ownership;
   use one focused new/returning Google-user acceptance, not repeated gameplay.
2. Finish Apple's authorization-code exchange, token revocation and revoked-
   credential handling before enabling its implemented signup/deletion paths.
   Activate native Apple capability and perform one focused real-provider
   signup/login/cancel/session/deletion acceptance per implemented platform. Compile the
   new Swift bridge on macOS before any signed rollout. Complete native Google
   SDK/client setup separately, never Google OAuth inside the embedded WebView.
  Treat Apple's web Services ID separately.
   When this backend replaces the legacy public revision, select the frontend's
   renewable public-preview protocol to enable the matching UI, renewal and
   web-cookie mapping. Remove the legacy option after its rollback window closes.
   Keep the separate public cookie namespace and the isolated automated tests.
3. Complete provider disconnect/revocation and privacy disclosures,
   focused real-provider acceptance and separately approved
   deployment. Then resume the remaining Clean Code sweep.

## Focused validation

Native Apple onboarding checkpoint (2026-09-21): 87/87 backend verifier/flow/
account/deletion unit tests, 33/33 router/config tests, 88/88 frontend auth/
signup/component tests and 32/32 provider-client/native source-contract tests
passed. Both TypeScript checks passed. One pinned disposable MySQL provider
group passed 40/40, including Apple relay signup, subject-only returning lookup,
cross-provider deletion rejection and unrelated-account preservation. The
harness removed its test database and network. No real Apple account, production
database, provider configuration or deployment changed. Swift source contracts
are not a macOS compilation or physical-device test.

Commands, from the corresponding package directory:

```text
# backend
node --test -r ts-node/register ts/auth/providerTokenVerifier.test.ts ts/auth/providerAuthFlow.test.ts ts/accounts/providerAccountRepository.test.ts ts/accounts/accountDeletionRepository.test.ts
node --test -r ts-node/register ts/routers/providerAuthRouter.test.ts ts/config/providerAuthConfig.test.ts
node scripts/run-migration-tests.mjs --provider-identities
npm.cmd test
# frontend
node --experimental-strip-types --test ts/services/authApi.test.mjs ts/services/authProviderSignup.test.mjs ts/components/ProviderSignInControls.test.mjs
node --experimental-strip-types --test ts/services/providerClient.test.mjs ts/services/nativeApiFetch.test.mjs
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
```

Passwordless signup checkpoint (2026-09-14): both TypeScript checks passed;
the combined frontend auth/provider tests passed 91/91, password-signup flow
8/8 and native transport/source contracts 14/14. The local launcher checks
passed 8/8; focused migration/schema/replay tests passed 64/64. Config,
legacy controller and auth-router checks passed 55/55. The direct Google
button was visually confirmed on `/signup`; no real Google account was selected.
Real MySQL evidence covers 38 distinct cases: replay 1/1, provider accounts
14/14 and attempts/HTTP 12/12 in the last provider-subset run; sessions 11/11
in a final session-only run using the same disposable harness guards. This is
not a claim that one full run was green. Fixtures were corrected to choose the
last issued session cookie and pin historical session-migration expectations.
Parallel session setup also failed once with a sanitized unavailable error;
only setup was serialized, the intended link race remains concurrent, and the
underlying session-creation cause was left for the focused follow-up below.

Session concurrency follow-up (2026-09-21): a deterministic two-account test
held both real MySQL transactions after their empty session-range scans, before
either insert. The previous implementation failed with sanitized driver codes
`ER_LOCK_DEADLOCK / 1213 / 40001`; the other 38 integration cases passed.
The account-specific named locks did not prevent overlapping index gap locks
under `REPEATABLE READ`. Session creation now uses next-transaction-only
`READ COMMITTED`, retaining the named lock, user-row lock, proof checks,
ten-device cap and fail-closed commit handling. Renewal/logout isolation and
pooled connection defaults are unchanged. This does not claim that all possible
database deadlocks are eliminated. MySQL requires ROW/MIXED binary logging for
this mode, already enforced by the account-identity migration precondition.

After the fix, one complete `--provider-identities` run passed 39/39 (replay 1,
provider accounts 14, attempts/HTTP 12, sessions 12), including independent
authentication/revocation and unchanged pooled isolation. Session unit tests
passed 12/12 and backend typechecking passed. The pinned disposable database
was removed by the harness; no production data, schema, provider flags or
deployment changed. Commands from the repository root:

```text
node backend/scripts/run-migration-tests.mjs --provider-identities
npm.cmd --prefix backend test
```

Backend directory: `node --test -r ts-node/register ts/auth/accountSessionRepository.test.ts`.
References: [MySQL transaction scope](https://dev.mysql.com/doc/refman/8.0/en/set-transaction.html)
and [isolation and gap locking](https://dev.mysql.com/doc/refman/8.0/en/innodb-transaction-isolation-levels.html).

Earlier checkpoint commands (from repository root unless noted):

```text
npm --prefix backend test
npx --prefix frontend tsc --noEmit -p frontend/tsconfig.json
node --test backend/scripts/dev-isolated.test.cjs
npm --prefix backend run test:migrations -- --provider-identities
```

Frontend directory: `node --experimental-strip-types --test
ts/services/authApi.test.mjs ts/services/authProviderSignup.test.mjs
ts/services/providerClient.test.mjs ts/components/ProviderSignInControls.test.mjs`.
The existing password-signup and native-transport test files were run separately.
Native Swift allowlist changes have source-contract coverage, not a new macOS
compile or TestFlight build. Production rollout and real-account acceptance
are separate from these synthetic checks.

`npm --prefix backend test` checks types. `npm --prefix backend run test:unit`
includes signed-token/JWKS, linking, migration/schema and recovery tests.
`npm --prefix backend run test:migrations` uses the existing pinned disposable
MySQL harness with scrubbed database environment and a random loopback port.
It includes real signed-token-to-repository linking, unique-constraint races,
case-sensitive subjects, UUID reuse, account deletion and restored-link/attempt
replay; plus attempt consumption/replacement/capacity races, expiry after lock
waits, uncertain commits and the composed link → login → replay-rejection flow.
No real Google/Apple account or production database is used by these tests.
For changes confined to provider identities and their deletion compatibility,
`npm --prefix backend run test:migrations -- --provider-identities` selects
the provider, session and deletion/replay integration fixtures inside the same isolated harness.

Initial identity-checkpoint results: backend typecheck and the 318-test unit suite passed. The
initial MySQL run passed its 57 preceding cases, then exposed MySQL 8.0.31's
canonical CAST/LENGTH and escaped CHECK-metadata representation. A narrowly
matched normalization fix plus its four focused schema tests passed; the
provider-only rerun passed all seven provider/deletion cases. All disposable
containers and networks were removed. Historical SQL and dependencies were
unchanged; no live login, provider, database or cloud operation was exercised.

One-use checkpoint results: typecheck and the 361-test unit suite passed. The
first isolated database run rejected a non-boolean CHECK expression in the new
0010 migration; changing it to an explicit `CASE ... END = 1` comparison fixed
that without editing historical SQL. The 29-test schema/manifest/runner follow-up
and all 17 focused MySQL cases passed, including composed authentication and
restored-attempt deletion. Both disposable test containers and networks were
removed. No production migration, provider configuration or session was issued.

HTTP/session checkpoint results (2026-09-14): backend typecheck, all 444 unit
tests and all 31 provider/session/deletion MySQL integration cases passed. The
integration harness verified logout and expiry while provider verification was
paused, then rejected linking without changing profiles, scores or provider links.
The disposable container and network were removed. Tests used synthetic provider
proofs and isolated accounts only; no production migration or activation occurred.

Client checkpoint results (2026-09-14): frontend typecheck and all 303 tests,
the production web build, backend typecheck and 38 focused configuration/auth
HTTP tests passed. The final modal-close handoff also passed TypeScript. The
native suite includes source/target membership and logging guards, not a Swift
compile. Google/Apple dialogs have not been exercised with real accounts and
native iOS has not been compiled or tested on a device for this checkpoint.
The unchanged SQL integration suite was not repeated.

Primary references: [Firebase cookie forwarding](https://firebase.google.com/docs/hosting/manage-cache),
[Google token verification](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token),
[Google OpenID Connect claims](https://developers.google.com/identity/openid-connect/openid-connect),
[Google official button, nonce and state](https://developers.google.com/identity/gsi/web/reference/js-reference),
[Apple user verification](https://developer.apple.com/documentation/signinwithapple/verifying-a-user),
[Apple discovery metadata](https://appleid.apple.com/.well-known/openid-configuration),
[Apple native development sample](https://developer.apple.com/documentation/authenticationservices/implementing-user-authentication-with-sign-in-with-apple),
[Apple web prerequisites](https://developer.apple.com/documentation/signinwithapple/configuring-your-environment-for-sign-in-with-apple).
