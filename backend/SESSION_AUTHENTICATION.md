# Revocable device sessions

## Behavior

Implemented on the active branch, not deployed. The Login and Sign up checkbox is unchecked
by default: four hours normally, renewable when selected. Remembered sessions
expire thirty days after the last successful renewal. Regular use can keep a
session alive without a fixed calendar cutoff; there is no 90-day forced logout.
Closing the browser does not end a retained cookie; clearing cookies, private
browsing and device/browser policies can still require signing in again.
Sign up already creates the account and then logs in automatically; its checkbox
selects the lifetime of that login, without changing the account-creation payload.
Both forms share one round, glass-styled 14px native checkbox with a 44px tap row,
keyboard focus and screen-reader support. The private-device hint has been removed.

The server issues an HS256 v2 token containing the numeric user ID, immutable
account UUID, random 256-bit session identifier and issuance/expiry timestamps.
Its purpose-specific signing key prevents an older numeric-ID-only runtime from
silently accepting the new long-lived token while ignoring revocation.

Apple login/signup additionally signs `authenticationMethod: 'apple'`; renewal
preserves that verified claim. Password/Google and older unmarked sessions stay
unmarked, even if their account has linked Apple. The disabled native Apple
credential-loss guard uses this provenance to revoke only the current Apple
device session through ordinary logout. Linking alone never opts another login
method into Apple checks. The prepared signed server receiver also revokes older
Apple sessions across devices, using original authentication time rather than
cookie-renewal time. See [server revocation and activation boundaries](PROVIDER_SIGN_IN.md#signed-apple-server-notifications--prepared-not-activated-2026-09-21).

`account_sessions` stores only hashed current/previous identifiers, account UUID,
remembered choice and UTC creation/renewal/expiry/grace timestamps. Migration 0018
adds nullable Apple client/subject hash and original authentication time;
password/Google rows leave both null and renewal preserves them. It stores no passwords, raw tokens, IPs or
device fingerprints. Each account has at most ten sessions; a new login removes
expired entries and evicts the oldest when necessary. Expired rows cannot
authenticate but can remain until another login or account deletion. No new
cleanup job, cloud service or recurring task is introduced.

JWT signature validation is only the first step. Verification, ticket issuance
and protected mutations require a matching live database session. Score writes,
receipt replay, account deletion and logout serialize through the same per-user
lock. Thus a write cannot pass a stale pre-lock session check after logout has
completed. Account UUID matching also prevents recycled numeric IDs inheriting
old access. Deletion and restored-backup deletion replay cascade all sessions.

Logout revokes the presented session before clearing its cookie. A network or
database failure is not reported as successful sign-out. Signing in again first
revokes the presented previous session after password verification, then creates
a replacement; failure between those operations requires another login. Other
devices remain signed in. There is no device-management screen in this change.

## Activity-based renewal

`GET /auth/verify-token` remains read-only. The explicit `POST /auth/renew` requires
an approved Origin, signed cookie and empty JSON object; Bearer headers and
unsigned session cookies are rejected. Missing, invalid, expired or revoked
credentials cannot create a session. Invalid/delayed renewal never clears cookies,
because another tab might already have signed in. Outages return a sanitized 503.

The frontend renews at startup and on trusted foreground activity, throttled to
one successful attempt per fifteen minutes. After a network failure, another
foreground activity can retry after fifteen seconds, within the predecessor grace.
There is no idle/background keep-alive timer.
The server independently throttles rotation to fifteen minutes, and chooses
thirty days from its database clock as the next expiry. Ordinary four-hour and
pre-0012 sessions never become remembered sessions through renewal.

Rotation uses the existing per-user transaction lock. The old hash is retained
for 120 seconds so concurrent tabs or a lost response can recover the same
replacement. A domain-separated HMAC derives that replacement without storing
raw credentials. Retries return the committed timestamps: they do not rotate
again or extend expiry. Only one predecessor is retained. Logout can revoke the
current or retained predecessor even after grace expires; authentication cannot
use an expired predecessor. Nothing is issued before commit is acknowledged.

This is a usability/security trade-off, not a guarantee against session theft:
someone actively using a stolen current credential could renew it until revoked.
Sensitive account deletion still requires password reauthentication. Database
revocation remains authoritative even if a delayed response overwrites a cookie.
Inactivity is measured from successful renewal, with up to fifteen minutes of
activity-throttling granularity, not from an exact last mouse movement.

## Browser and native transport

Production browser requests use `/api/**` and `/auth/**` on the website's own
origin. Firebase Hosting rewrites these to the existing `mickeyf-org` Cloud Run
service in `us-central1`, before the SPA fallback, without a revision pin/tag.
The signed `__session` cookie is Secure, HttpOnly, host-only, SameSite=Lax and
has the same lifetime as its JWT. API responses are private/no-store. Login
requires JSON and an exact approved Origin; cookie-bearing mutations retain
explicit origin checks. API/auth paths must not be cached by a service worker.

Firebase forwards only its specially named `__session` cookie to rewritten
backends. This avoids relying on third-party cookies between Firebase and the
separate Cloud Run hostname. The native adapter still uses the explicit backend
origin and its existing OS-managed `session` cookie, with SameSite=None/Secure.
Native logout must send that cookie and only erase local storage after the
server confirms revocation. No credentials are returned in login JSON or saved
in JavaScript storage. In-page auth mutations are serialized so response order
cannot let an earlier login undo a later logout.

Development retains its configured API endpoint. `vite preview` alone does not
implement Firebase rewrites: use a separately configured local test backend or
a reviewed Hosting preview for built-browser authentication testing.

## Cutover review — 2026-09-30

Preparation is complete for this checkpoint; activation is still pending. The
owner accepted the reviewed OpenSSL risk, not unrelated release gaps. The source
baseline is `6efbab08295ef1f79d256ef43086585e1c9b6335`, whose PR checks and CodeQL
passed. The following readbacks are current, not assumptions from the earlier
migration proposal.

| Surface | Verified baseline / rollback reference |
| --- | --- |
| Cloud Run | Project `noted-reef-387021`, service `mickeyf-org`, region `us-central1`; generation 146, 100% traffic to `mickeyf-org-localhost-dbb80d4f`, no traffic tags; Ready/Active |
| Serving image | `us-central1-docker.pkg.dev/noted-reef-387021/cloud-run-source-deploy/cloud-run-source-deploy@sha256:1ae9d4894d26be408fe807e2ae35e6b63c3975ac4d116b99a3d2554eb82b1e19` |
| Runtime secrets | `DB_PASS:1`, `SESSION_SECRET:2`; session version 2 enabled, version 1 disabled. Only metadata/references were read; no new version exists from this preparation |
| Hosting | `sites/noted-reef-387021/versions/aa252183c0ed4b85`, live release `1789045977054000` from `b6888bc2`; only the SPA rewrite, no API/auth rewrites or matching no-store path headers |
| Cloud SQL | Runtime identity/server pin matched; migrations exactly 0001–0012, renewable session schema and direct session column/table grants match the committed manifest; no grant option |
| Build controls | All four global Cloud Build triggers disabled; none in `us-central1`; no Cloud Build image receipt for source `6efbab08` |
| Native build evidence | Latest successful `ios-build.yml` run is `34542319206`, source `39fcfd74` (September 10). No later signed build is established by this check; current source includes renewal and server-first logout |

The runtime-only database check completed at `2026-09-30T20:39:30.691Z`.
Stored checksum verification is carried forward from the approved September 29
maintenance execution: this restricted runtime account cannot read checksums.
No temporary administrator, migration, grant, user, score or session write was
needed. Existing Cloud SQL remains the development database.

### Concrete release order

1. Resolve the existing registration and native compatibility requirements
   before public activation. The approved adult-only, server-validated signup
   eligibility flow is still unimplemented, including password signup; disabled
   Google/Apple flags do not close that gap. Do not silently change that policy
   or close registration. Deliver a compatible iPhone build before claiming
   renewable sessions and server-enforced logout on the installed app. These are
   separate from the accepted OpenSSL risk.
2. Build the final reviewed source with the image-only candidate configuration,
   record its actual Cloud Build ID, source identity and registry digest, and
   obtain Artifact Analysis evidence. The local C7 image/scan is supporting
   evidence, not a substitute for those deployment pins. Prepare a dedicated
   manual candidate configuration; preserve the disabled legacy triggers.
3. In the approved release window, create a fresh signing-secret version and
   bind its returned numeric version to the candidate and approval. Do not
   assume the next version number, use `latest`, or rotate the currently serving
   revision during preparation. Database migrations/grants are not repeated for
   a session-only release; provider activation retains its separate review.
4. Prepare an exact zero-traffic backend revision with both existing score
   submission flags enabled, the reviewed runtime identity/SQL connection and
   explicit secret pins. **The current frozen renderer/traffic tool is not the
   final release path:** it forces both score flags off. Its guards must be
   retained in an enabled-score deployment plan, not bypassed or relabeled.
5. Use a short coordinated release window: move backend traffic to the reviewed
   compatible revision without a legacy/new traffic split, then publish the
   matching Hosting artifact/rewrites/headers. The two services cannot switch
   atomically; old web/native clients may require refresh or update and fresh
   sign-in during the transition. Do not merge PR #341 first: main automatically
   starts the Hosting release workflow. Keep Google/Apple disabled until their
   own activation requirements are met.
6. After the compatible public release, retain `VITE_USE_PUBLIC_API=1`, set
   `VITE_PUBLIC_AUTH_PROTOCOL=renewable`, restart only the local frontend and
   sign in again. One focused browser/iPhone check covers remembered reopen,
   renewal and revoked-session rejection after logout. Use an explicitly
   designated test account; no broad gameplay replay or migration rerun.

### Promotion guard and rollback

The existing Firebase promotion step now probes anonymous `POST /auth/renew`
with empty JSON and the approved website Origin against both the direct backend
and the Hosting preview. It requires HTTP 200, exactly `{"loggedIn":false}`,
JSON, no-store and no Set-Cookie before promoting the frontend. No credentials
are sent and no authenticated session is renewed. Existing enabled-score checks
remain. This detects a legacy backend or missing preview rewrite; it does not
prove authenticated cookie forwarding, real renewal, native persistence or
prevent another operator changing backend traffic after the check.

The live legacy backend returned 404/`NOT_FOUND`; the existing local backend
returned the required anonymous response with no cookie and no-store. Both
probes used no credentials. Thus the new gate intentionally blocks publishing
this frontend against today's serving backend.

Rollback restores the recorded Hosting version and the old backend image with
compatible settings, while preserving migrated tables, accounts and scores.
Prepare a rollback revision using a fresh, explicitly pinned signing-secret
version before changing traffic. Simply restoring the untouched old revision
would also restore secret version 2 and could revive old login cookies; a
written instruction to sign in again does not invalidate them. Do not destroy
the active secret or drop session storage as a rollback shortcut. Rollback and
retry both require fresh sign-in and coordinated configuration.

Validation: seven offline cases against the actual embedded promotion script
passed (compatible responses, legacy 404, missing rewrite/HTML, unexpected
authenticated result, numeric false substitute, Set-Cookie, cacheable response);
workflow YAML parsed.
Read-only Cloud Run/secret/trigger/Hosting metadata, the scoped SQL readiness
probe and the two anonymous HTTP probes are recorded above. The credential-free
helpers are `%TEMP%/mickeyf-session-cutover-readiness-20260930.cjs` and
`%TEMP%/mickeyf-session-promotion-gate-test.py`; commands were `node --check`,
`node` and `python` on those files. No broad suite, cloud build, native upload,
secret rotation, merge, deployment or traffic change was performed.

## Coordinated activation (original implementation checklist)

Steps 1–2 below were completed for the session-only schema/grants on September
29 and rechecked above. They document the implementation order, not work to
repeat. The September 30 cutover review records the remaining release work.

1. Review the actual target and migration plan using the existing maintenance
   identity and explicit write confirmations. Migration 0011 requires recorded
   0001–0010, including the dormant provider tables; it does not enable providers.
   Ordinary `migrations:apply` cannot apply it. The explicit script is
   `npm --prefix backend run migrations:account-sessions:apply`. Then apply 0012
   using `npm --prefix backend run migrations:session-renewal:apply`; it requires
   recorded 0001–0011. Existing session rows default to non-renewable, preserving
   their original expiry. Neither command is part of ordinary application startup.
2. Review/apply the narrow runtime grant manifest: SELECT on all eight session
   columns, INSERT on the six creation fields, table DELETE and UPDATE only on
   the five rotation fields. No UPDATE to account UUID, creation time or remembered
   choice or DDL. The current combined manifest also defines narrow provider
   identity/attempt privileges; apply it only after those required tables are
   present. See `PROVIDER_SIGN_IN.md` for the separately gated provider activation.
   Keep maintenance credentials out of the application. Verify grants and schema.
3. Coordinate the backend and Hosting release. The new backend refuses to start
   without recorded 0011/0012 and valid session storage. Old and new session formats are not
   interchangeable: expect one re-login and invalidate old credentials through
   the existing secret-rotation procedure when completing the cutover. Avoid
   mixed old/new traffic or treating a rollback as session-compatible.
4. Deliver the matching native adapter update (including the `/auth/renew` POST
   allowlist) before claiming renewal or server-revoked
   native logout: older installed binaries erase their cookie before sending
   logout, so the backend cannot identify that lost session to revoke it.
5. Verify one browser close/reopen with the checkbox selected, logout rejection
   of that session, and the matching installed native build. Local tests cannot
   establish Firebase forwarding or real iOS cookie persistence.

On rollback, restore compatible application/Hosting configuration and require
fresh sign-in; do not drop session storage while any new runtime uses it. On
database restore, keep the existing deletion replay and session-secret rotation
requirements before reopening traffic, so restored rows cannot revive access.

## Renewal verification — 2026-09-14

- `npm --prefix backend test`: TypeScript passed.
- `npm --prefix backend run test:unit`: 418 tests passed.
- `npm --prefix backend run test:migrations -- --provider-identities`: 28 isolated
  MySQL tests passed, including concurrent renewal, lost commit acknowledgement,
  idle expiry, predecessor grace, revocation and migration recovery.
- `npm --prefix backend run test:migrations -- --runtime-grants`: 11 isolated
  MySQL tests passed, including actual renewal with the restricted runtime user.
  Both test containers/networks/volumes were removed afterward.
- From `frontend`: `node --test ts/services/authApi.test.mjs
  ts/services/nativeApiFetch.test.mjs ts/services/sessionRenewalActivity.test.mjs
  ts/pages/signupFlow.test.mjs` passed 56 tests; `npx tsc --noEmit` and
  `npm run build` passed. The existing large-chunk warning remains.
- `npm run test:backend-isolated`: three local-launcher guard tests passed.
  The [isolated local backend](LOCAL_DEVELOPMENT.md) is separate from production;
  no real accounts or scores are copied into it.

No production schema/grant/deployment changes or native build upload were made.

## Earlier fixed-lifetime checkpoint — 2026-09-14

The results below describe the earlier implementation, not the renewal changes.

- `npm --prefix backend test`: TypeScript passed.
- `npm --prefix backend run test:unit`: all 402 tests passed, including copied
  cookie rejection, session replacement, expiry, UUID reuse, origin checks and
  server-first logout failure handling.
- `npm --prefix backend run test:migrations -- --provider-identities`: 22 isolated
  MySQL 8.0.31 cases passed, including session lifecycle and restored deletion.
- `npm --prefix backend run test:migrations -- --runtime-grants`: 11 isolated
  MySQL cases passed, including session startup and create/read/revoke under the
  restricted runtime grants; unauthorized UPDATE is rejected.
- From `frontend`: `npx tsc --noEmit`, the 40 focused tests in
  `ts/services/authApi.test.mjs`, `ts/config/apiBase.test.mjs` and
  `ts/services/nativeApiFetch.test.mjs`, and `npm run build` passed. The build
  still reports its existing large-JavaScript-chunk warning.
- Local browser check: unchecked default, working checkbox and visible form at
  desktop and 390px width. No account or password was submitted.

Both disposable database projects and the temporary browser tab were removed.
Native source/transport checks are not an Xcode build or installed-device test.
Neither Firebase forwarding nor production browser persistence was exercised.

Primary references: [Firebase Cloud Run rewrites](https://firebase.google.com/docs/hosting/cloud-run),
[Firebase cookie and cache behavior](https://firebase.google.com/docs/hosting/manage-cache),
[WebKit third-party cookie blocking](https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/).
