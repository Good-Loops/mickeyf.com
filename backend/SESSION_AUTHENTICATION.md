# Revocable device sessions

## Behavior

Implemented on the active branch, not deployed. The Login checkbox is unchecked
by default: four hours normally, thirty days when selected. These are fixed
maximum lifetimes, not sliding inactivity timers. Closing the browser does not
end a retained cookie; clearing cookies, private browsing and device/browser
policies can still require signing in again. No indefinite-login promise is made.

The server issues an HS256 v2 token containing the numeric user ID, immutable
account UUID, random 256-bit session identifier and issuance/expiry timestamps.
Its purpose-specific signing key prevents an older numeric-ID-only runtime from
silently accepting the new long-lived token while ignoring revocation.

`account_sessions` stores only SHA-256 of that random identifier, account UUID,
and UTC creation/expiry timestamps. It stores no passwords, raw tokens, IPs or
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

## Coordinated activation (not executed by this checkpoint)

1. Review the actual target and migration plan using the existing maintenance
   identity and explicit write confirmations. Migration 0011 requires recorded
   0001–0010, including the dormant provider tables; it does not enable providers.
   Ordinary `migrations:apply` cannot apply it. The explicit script is
   `npm --prefix backend run migrations:account-sessions:apply`.
2. Review/apply the narrow runtime grant manifest: SELECT/INSERT on the four
   session columns and table DELETE, no UPDATE/DDL or provider-table privileges.
   Keep maintenance credentials out of the application. Verify grants and schema.
3. Coordinate the backend and Hosting release. The new backend refuses to start
   without recorded, valid session storage. Old and new session formats are not
   interchangeable: expect one re-login and invalidate old credentials through
   the existing secret-rotation procedure when completing the cutover. Avoid
   mixed old/new traffic or treating a rollback as session-compatible.
4. Deliver the matching native adapter update before claiming server-revoked
   native logout: older installed binaries erase their cookie before sending
   logout, so the backend cannot identify that lost session to revoke it.
5. Verify one browser close/reopen with the checkbox selected, logout rejection
   of that session, and the matching installed native build. Local tests cannot
   establish Firebase forwarding or real iOS cookie persistence.

On rollback, restore compatible application/Hosting configuration and require
fresh sign-in; do not drop session storage while any new runtime uses it. On
database restore, keep the existing deletion replay and session-secret rotation
requirements before reopening traffic, so restored rows cannot revive access.

## Checkpoint verification — 2026-09-14

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
