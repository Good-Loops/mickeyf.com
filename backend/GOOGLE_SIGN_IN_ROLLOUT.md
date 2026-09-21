# Real-account Google sign-in rollout

Status: preparation only, 2026-09-21. The owner approved preparing this rollout,
not activating public sign-in, modifying production SQL, rotating secrets or
changing traffic. Preserve real public accounts and scores on localhost.

## Verified now

- Localhost serves `VITE_USE_PUBLIC_API=1`. `VITE_PUBLIC_AUTH_PROTOCOL` is absent,
  which deliberately selects the legacy cookie protocol and hides provider UI.
- `GET http://localhost:5173/__public-api/auth/providers/config` returns HTTP 404 with JSON.
  The direct Cloud Run `/auth/providers/config` returns the same response. This is
  not a missing CSS rule or a stale Google button.
- `https://mickeyf.com/auth/providers/config` returns the HTML app shell, not
  provider JSON. The matching Hosting rewrites must be included in the cutover.
- Cloud Run `mickeyf-org`, `us-central1`, serves 100% traffic from
  `mickeyf-org-localhost-dbb80d4f`, source
  `dbb80d4f701da734ea971cb25b5c02d1e5b8d6d8`, source build
  `7c33d90f-281f-45e7-8751-9e9e221ee532`, image digest
  `sha256:1ae9d4894d26be408fe807e2ae35e6b63c3975ac4d116b99a3d2554eb82b1e19`.
- That serving revision has no provider, Google signup, account-deletion,
  Apple notification/lifecycle/maintenance flags or Google web client ID.
- The four global Cloud Build triggers are disabled: `main-push-mickeyf-com`,
  `mickeyf-backend-stage-b-deploy`, `feature-new-leaderboard-candidate`, and
  `frozen-backend-receipts`. No regional triggers were returned for us-central1.
- The existing receipt job still has its 180-second timeout and attached
  `mickeyf-receipt-cleanup@noted-reef-387021.iam.gserviceaccount.com` identity.
  This confirms configuration only, not Apple maintenance operation.

Cloud metadata was read with TLS verification enabled. The initial CLI failure
was caused by its trust store not recognizing the Norton inspection certificate
already trusted by Windows. A temporary public CA file was used only for these
read-only commands; no persistent gcloud configuration or security setting changed.
No secret values, SQL records or KWS account state were inspected.

## Scope: Google browser first, Apple separately

Google web is implemented in source but absent from the deployed backend.
Restoring it on localhost requires that compatible public backend, not a switch
to the isolated database. Native Google SDK/client work is separate.

Apple's prepared credential flow is native iOS only, and remains disabled.
Browser Apple sign-in has no Services ID/callback implementation in this project.
Do not add a decorative or nonfunctional Apple button to localhost. Complete
the [native Apple activation checklist](APPLE_MAINTENANCE.md#notification-endpoint-and-ordered-activation)
separately; Apple maintenance is not a prerequisite for Google-only issuance.

## Ordered preparation and activation

1. **Registration eligibility and privacy.** Finish the approved adult-only,
   non-invite signup safeguards for password and provider registration, and
   publish accurate disclosures before opening new Google accounts. The
   [approved integration boundary](PROVIDER_SIGN_IN.md#adult-only-signup-preparation--2026-09-21)
   requires server-validated, single-use eligibility. A Google token or browser
   checkbox is not that evidence. Existing login, optional linking and guest
   play remain distinct. KWS access/result binding is not verified by this
   checkpoint; do not invent its adapter contract or authorize production using
   synthetic test results.

2. **Make the Google schema rollout executable without coupling it to Apple.**
   Inspect current production history/checksums and target identity read-only;
   no current SQL state is assumed here. After recorded migrations 0001–0008, the Google
   path needs 0009 identities, 0010 attempts, 0011 sessions, 0012 renewal,
   0013 unique usernames, 0014 nullable passwords and 0015 signup/delete attempts.
   The new dedicated `migrations:google-signup:apply` command selects only
   0013–0015; ordinary `migrations:apply` must not acquire those effects.
   Duplicate usernames stop the migration; never rename or delete accounts
   automatically. Reuse the target/account confirmations and reviewed
   writer-exclusion procedure. No migration is executed during preparation.

   **Remaining source change:** prepare a Google-only runtime grant profile.
   The current combined manifest includes Apple tables and 0018 session columns;
   applying it to a Google-only 0015 schema would fail. Prefer the narrow profile
   over silently adding Apple storage/privileges to this release. The Apple
   deletion repository tolerates genuinely absent, unrecorded Apple storage;
   recorded-but-missing tables remain errors.

3. **Prepare the coordinated session cutover.** Current deployment and traffic
   checks pin `SESSION_SECRET:2`. Add explicit, reviewed version pin support
   before the required rotation; do not guess a new version, use `latest`,
   create a secret or weaken image/source/approval checks. Align the backend,
   Hosting and localhost cookie contracts using
   [the session rollout](SESSION_AUTHENTICATION.md#coordinated-activation-not-executed-by-this-checkpoint).
   Old and new sessions are incompatible: require fresh sign-in and avoid mixed
   legacy/new traffic. Coordinate the native adapter before claiming native
   renewal/server-revoked logout; older installed builds are not automatically
   compatible with that behavior.

4. **Approve one concrete production change set.** Refresh database history,
   exact grant plan, recovery inventory and deletion-journal readiness; preserve
   completed restore acceptance rather than repeating it without evidence of
   drift. Review a fixed source/build/image and migration/session-secret plan.
   Full Google release requires enabled deletion and the approved Google client,
   not mandatory linking or a link-only signup substitute. Use existing frozen
   deployment/traffic tooling only after its preceding gaps are resolved.
   Do not enable dormant triggers as a shortcut.

5. **Activate the compatible surfaces together.** Deploy the approved backend
   and Hosting rewrites/headers; keep Apple issuance/maintenance disabled for
   this Google-only release. Verify provider JSON through Hosting and the
   loopback gateway. Only then keep `VITE_USE_PUBLIC_API=1`, set
   `VITE_PUBLIC_AUTH_PROTOCOL=renewable`, restart Front and sign in again.
   Do not make that local change ahead of the compatible backend: it changes
   the cookie namespace, not just button visibility.

6. **One focused acceptance pass.** Returning Google login, one eligible new
   Google signup, existing password access, remembered browser reopen/logout,
   and owner-authorized test-account deletion with journal confirmation. Use
   one disposable account and remove only its data. No broad gameplay retest.

Rollback must restore compatible application/Hosting/session configuration,
require fresh sign-in and preserve migrated storage and deletion/recovery
controls. The old revision is a rollback reference, not automatic proof that it
can safely handle all later passwordless data. Review that compatibility before
opening new registrations.

## This checkpoint

- Read-only HTTP/configuration evidence collected; no production or local
  authentication flags changed and no server restarted.
- Guarded 0013–0015 migration entrypoint prepared:
  `npm --prefix backend run migrations:google-signup:apply`. This command is for
  the later approved migration window; it was not run against any database.
- Validation from `backend`: 51 focused tests passed with mocked database access;
  TypeScript and `git diff --check` passed. No live-provider acceptance is claimed.

  ```text
  node --test -r ts-node/register ts/migrations/migrationRunner.test.ts ts/config/migrationConfig.test.ts ts/migrations/migrationManifest.test.ts
  node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
  ```

- Next source task: separate the Google runtime grants from dormant Apple
  grants, then support the reviewed session-secret version in deployment checks.
  Signup eligibility remains an independent activation requirement throughout.
