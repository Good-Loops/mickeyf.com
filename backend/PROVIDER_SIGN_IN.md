# Google and Apple sign-in foundation

## Status — 2026-09-14

Implemented backend identity verification, one-use attempts and an opt-in HTTP
adapter connected to shared sessions; **not an enabled sign-in feature**.
Application bootstrap supplies no provider configuration, so routes and buttons
remain disabled. Username/password and provider issuance reuse UUID-bound,
revocable device sessions; see [session behavior and rollout](SESSION_AUTHENTICATION.md).
No production configuration, provider credentials, HTTP callbacks or provider
native plugins have been activated.

Native iOS sign-in can be developed and tested before publication. Apple's
documented web/other-platform setup requires an existing App Store app using
Sign in with Apple. The pending KWS/privacy work remains part of Ludolume's
release and age/consent plan, not a prerequisite for these synthetic backend
tests; provider sign-in must never bypass those account-creation safeguards.

## Identity and account ownership

`auth/providerTokenVerifier.ts` accepts a signed ID token only after checking
RS256 against the provider's fixed HTTPS JWKS endpoint, issuer, one exact
server-configured audience, expiration, issuance age, and expected nonce.
Google's authorized presenter (`azp`) must also match configuration when present;
a separately configured native presenter must be present in the token.
Configuration belongs to the server, never to submitted request fields.

The successful result contains only `{ provider, subject }`. Its nominal
TypeScript type prevents accidental use of decoded/request claims, but is not
a runtime security boundary. Only the verifier should construct it.

`accounts/providerAccountRepository.ts` maps that identity to `users.account_uuid`.
It does **not** match email addresses or create users. To link an existing
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
  provider email/name, access token, refresh token or raw ID token.
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
already-linked login resolves the verified provider subject without it. It never
creates accounts or matches users by email. `account-verified` is an internal
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
`createAuthRouter` receives explicit enablement and configured clients. Current
`app.ts` does not supply either. The request shapes are:

- `POST /begin`: `{ action: "login" | "link", clientKey }` → `{ state, nonce, expiresInSeconds }`.
- `POST /complete`, login: `{ action: "login", clientKey, state, idToken, rememberMe?: boolean }`.
- `POST /complete`, link: `{ action: "link", clientKey, state, idToken, password }`.

Unknown fields are rejected. Successful login returns `{ success: true, user_name }`;
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

Client integration must serialize provider begin/complete with other auth mutations
through the existing auth queue. Native transport already serializes POSTs, but
still needs explicit provider route allowlisting and a body limit increased from
16 KiB to accommodate a maximum token plus its JSON wrapper. Session renewal can
change the binding during a link attempt, requiring a fresh challenge. Arbitrary
cross-tab/in-flight responses are not canceled by canonical-cookie replacement:
late Set-Cookie ordering needs client acceptance work before activation.

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
Both validate the exact resulting schema before recording history. Readiness and
deletion replay allow pre-0010 backups without the attempt table, but reject a
missing recorded table or malformed cascade. Historical SQL remains unchanged.
These commands are **not** a local-safety guarantee: a loopback proxy may target
production. No production migration was executed in this checkpoint.

Runtime grants now include only the session table access needed by shared login.
Before provider activation, update and test the
reviewed grant manifest for the required provider-table access; do not grant
blanket database privileges. Coordinate that change with schema, recovery
compatibility and the enabled application revision.

Remaining work, in order:

1. Configure approved Google web/native clients and Apple native capability;
   integrate native platform sign-in, not Google OAuth inside the embedded WebView.
   Connect the UI/auth queue and native transport, and add provider-specific
   callback/code exchange where required. Treat Apple's web Services ID separately.
2. Design provider-only signup around the approved age/consent requirements;
   retain username/password access and existing score ownership.
3. Complete provider disconnect/revocation and account-deletion coordination,
   privacy disclosures, focused end-to-end acceptance and separately approved
   deployment. Then resume the remaining Clean Code sweep.

## Focused validation

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

Primary references: [Firebase cookie forwarding](https://firebase.google.com/docs/hosting/manage-cache),
[Google token verification](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token),
[Google OpenID Connect claims](https://developers.google.com/identity/openid-connect/openid-connect),
[Apple user verification](https://developer.apple.com/documentation/signinwithapple/verifying-a-user),
[Apple discovery metadata](https://appleid.apple.com/.well-known/openid-configuration),
[Apple native development sample](https://developer.apple.com/documentation/authenticationservices/implementing-user-authentication-with-sign-in-with-apple),
[Apple web prerequisites](https://developer.apple.com/documentation/signinwithapple/configuring-your-environment-for-sign-in-with-apple).
