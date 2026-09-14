# Google and Apple sign-in foundation

## Status — 2026-09-14

Implemented offline backend primitives; **not an enabled sign-in feature**.
Existing username/password routes, sessions, score ownership and production
configuration are unchanged. No provider credentials, token storage, HTTP
callbacks, native plugins or sign-in buttons are added in this checkpoint.

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
account, a caller supplies its authenticated numeric ID, immutable UUID and
password. The repository rechecks UUID and password inside the same per-user
lock used by score submission and deletion, then inserts the link transactionally.

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

**Signature verification alone does not prevent replay or login CSRF.** Before
exposing these functions, implement server-held, short-lived, one-use attempts
bound to the initiating session, intended action/provider/client and nonce.
Do not accept an `expectedNonce`, account UUID or audience from a request as proof.

## Migration and activation boundary

The usual `migrations:apply` deliberately does not apply 0009. After reviewing an
approved target and the existing explicit migration-account/write confirmations:

```text
npm --prefix backend run migrations:plan
npm --prefix backend run migrations:providers:apply
npm --prefix backend run migrations:plan
```

The provider command selects only the new effect, requires recorded migrations
0001–0008, and validates the exact resulting schema before recording history.
These commands are **not** a local-safety guarantee: a loopback proxy may target
production. No production migration was executed in this checkpoint.

Runtime grants are deliberately unchanged. Before activation, update and test the
reviewed grant manifest for the required provider-table access; do not grant
blanket database privileges. Coordinate that change with schema, recovery
compatibility and the enabled application revision.

Remaining work, in order:

1. Implement one-use attempts, callback/code exchange, CSRF/rate limits and
   UUID-bound session issuance for already-linked users and explicit linking.
2. Configure approved Google web/native clients and Apple native capability;
   integrate native platform sign-in, not Google OAuth inside the embedded WebView.
   Treat Apple's web Services ID activation separately.
3. Design provider-only signup around the approved age/consent requirements;
   retain username/password access and existing score ownership.
4. Complete provider disconnect/revocation and account-deletion coordination,
   privacy disclosures, focused end-to-end acceptance and separately approved
   deployment. Then resume the remaining Clean Code sweep.

## Focused validation

`npm --prefix backend test` checks types. `npm --prefix backend run test:unit`
includes signed-token/JWKS, linking, migration/schema and recovery tests.
`npm --prefix backend run test:migrations` uses the existing pinned disposable
MySQL harness with scrubbed database environment and a random loopback port.
It includes real signed-token-to-repository linking, unique-constraint races,
case-sensitive subjects, UUID reuse, account deletion and restored-link replay.
No real Google/Apple account or production database is used by these tests.
For changes confined to provider identities and their deletion compatibility,
`npm --prefix backend run test:migrations -- --provider-identities` selects
only those two integration fixtures inside the same isolated harness.

Checkpoint results: backend typecheck and the 318-test unit suite passed. The
initial MySQL run passed its 57 preceding cases, then exposed MySQL 8.0.31's
canonical CAST/LENGTH and escaped CHECK-metadata representation. A narrowly
matched normalization fix plus its four focused schema tests passed; the
provider-only rerun passed all seven provider/deletion cases. All disposable
containers and networks were removed. Historical SQL and dependencies were
unchanged; no live login, provider, database or cloud operation was exercised.

Primary references: [Google token verification](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token),
[Google OpenID Connect claims](https://developers.google.com/identity/openid-connect/openid-connect),
[Apple user verification](https://developer.apple.com/documentation/signinwithapple/verifying-a-user),
[Apple discovery metadata](https://appleid.apple.com/.well-known/openid-configuration),
[Apple native development sample](https://developer.apple.com/documentation/authenticationservices/implementing-user-authentication-with-sign-in-with-apple),
[Apple web prerequisites](https://developer.apple.com/documentation/signinwithapple/configuring-your-environment-for-sign-in-with-apple).
