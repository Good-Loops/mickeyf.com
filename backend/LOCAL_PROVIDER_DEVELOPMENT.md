# Google and Apple in ordinary local development

The login and signup controls are implemented at `/login` and `/signup`. The backend advertises only configured providers and separately advertises signup after the reviewed country/age policy is available. A rendered button does not prove completed provider authentication.

Normal development continues to use the existing production database through the loopback Cloud SQL proxy. The default development commands and root `.env` remain unchanged. Disposable databases are for automated tests.

## Explicit local provider profile

Review the public profile first:

```powershell
node scripts/start-local-provider-backend.mjs --plan-only
```

The explicit launch command is:

```powershell
npm run backend:dev:providers
```

The launcher loads the public configuration from `scripts/provider-release-us-br.json` into its child process. It does not copy private credentials into a saved profile. The existing backend environment loader supplies the existing private database password and session secret. The session signing key must contain at least 32 characters.

The additional public settings are:

```text
LUDOLUME_LOCAL_PROVIDER_RUNTIME=true
LUDOLUME_LOCAL_PROVIDER_EXPECTED_SERVER_UUID=d1e6865c-ecad-11ee-a6b0-42010a400002
LUDOLUME_LOCAL_PROVIDER_MAINTENANCE_ENABLED=true
NODE_ENV=development
DB_HOST=127.0.0.1
DB_PORT=3306
DB_NAME=cms
DB_USER=cms_mickeyf
```

This profile refuses Cloud Run's `K_SERVICE`, isolated test mode, other database targets/users, inline Apple keys, and `GOOGLE_APPLICATION_CREDENTIALS` file overrides. It binds the backend HTTP listener to `127.0.0.1`. The current frontend uses `http://localhost:8080` and the renewable session protocol.

Before any local Apple credential request, the backend reads the actual database name, effective SQL account and server UUID from a borrowed connection. They must match `cms`, `cms_mickeyf@%`, and the exact server pin. Existing recorded-migration, schema, registration, parent-form, passwordless-account and deletion-readiness checks still run. No migration or grant is applied by startup.

## Private runtime credentials

Production retains its Cloud Run metadata/workload-identity credential path. Local development uses the existing Google Application Default Credentials through `google-auth-library` inside the backend process. An existing authorized-user ADC profile or its service-account impersonation is required. This does not initiate owner login, grant permissions, or create credentials automatically.

The local loader can request only these existing, exact Secret Manager versions:

```text
projects/1012884798546/secrets/ludolume-apple-signin-private-key/versions/1
projects/1012884798546/secrets/ludolume-apple-token-encryption-keys/versions/1
```

Key payloads and access tokens stay in process memory. They are never returned by provider configuration, written to `.env`, included in diagnostics, or exposed to frontend code. Response size, CRC32C, resource/version, redirect and timeout checks also apply locally. A failed identity/ADC/secret check leaves Apple unavailable and preserves independent Google login.

## Maintenance is a real operation

Enabling the local maintenance flag starts actual queue maintenance against the production database. After all startup identity/schema gates pass, the first bounded pass uses the existing maintenance implementation. It can delete expired Apple token/revocation guards, registration authorizations, parent attempts and signed-form requests; update due revocation queue state; and attempt at most 20 due Apple token revocations. The pass verifies the exact target and recorded schema. It does not create accounts or approve parent forms.

Review current queue counts before the first launch. Do not quietly drain an unexpected nonempty queue. Zero affected rows still means the cleanup statements were attempted.

The runner attempts another pass 60 seconds after the previous pass settles. It does not overlap work. An initial pass exceeding 120 seconds stops waiting for readiness, leaves Apple issuance unavailable, and lets the rest of the backend start. The original work retains ownership until it settles; it is not silently retried or treated as cancelled. A late result cannot establish health. Shutdown stops future passes and waits for owned work before closing the pool, subject to the existing process shutdown deadline.

Apple login/signup/linking is advertised only after credential loading and a successful maintenance pass. Failed or stale maintenance blocks new Apple issuance. Public configuration retains the configured Apple identifier with `issuance: false` for deletion proof; login/signup/link controls show temporary unavailability and let the owner check again after recovery. The loaded lifecycle and account deletion remain available through an outage. If initial credential loading itself fails, fix the private configuration and restart the explicit local backend to prepare its provider clients again.

This runner exists only while the local process runs. It does not establish an always-on production retention schedule. The reviewed cloud hourly dispatcher, signed Apple notification delivery, retention monitoring and failure handling still require their own deployment and operational acceptance before a public rollout. Do not treat local test results as proof of those operations.

## Account creation and real acceptance

The approved bundle permits US self-service at 13+, US under-13 accounts through signed parent forms, and Brazil self-service adults at 18+. Brazil minor creation and other countries remain closed. Parent and public-score consent remain separate, and runtime SQL credentials cannot approve forms or modify protected reviewer fields.

Signing in, linking, signup and loading the inline Google widget can write to the real database. The widget creates an anonymous short-lived provider challenge during rendering. Actual account creation, parent-form review, provider linking and deletion should be exercised only with the owner's explicitly chosen account and workflow; automated tests use synthetic providers and disposable databases.

Apple web uses Services ID `com.mickeyf.web`, the exact registered return URI `https://mickeyf.com/login`, and the SDK popup result. Apple requires registered website/return URLs and an HTTPS domain return URI; `localhost` and IP addresses cannot be substituted as the return host. A public HTTPS GET returning successfully does not prove popup completion from a local browser. Real Apple popup completion, Google login, new-account consent, renewal and deletion still need owner-controlled acceptance; code or mocked-SDK tests do not establish it.

Startup diagnostics report only public capability booleans (`googleWebLogin`, `googleWebSignup`, `appleWebLogin`, `appleWebSignup`) and local maintenance readiness. No credential or signed-form content belongs in chat or logs.

References: [Apple web configuration](https://developer.apple.com/help/account/capabilities/configure-sign-in-with-apple-for-the-web), [Apple webpage and popup flow](https://developer.apple.com/documentation/signinwithapple/configuring-your-webpage-for-sign-in-with-apple?changes=latest_major), [Apple return URI requirements](https://developer.apple.com/documentation/signinwithapplerestapi/request-an-authorization-to-the-sign-in-with-apple-server.).
