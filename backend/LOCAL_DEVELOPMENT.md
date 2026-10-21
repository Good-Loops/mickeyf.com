# Isolated local backend

This is the optional isolated workflow. The project's selected development
workflow remains `npm run backend:dev:local`, using the Cloud SQL proxy and root
`.env`; this guide does not change that choice. Selecting `VITE_USE_PUBLIC_API=0`
in the frontend only selects `VITE_DEV_API_URL`, not a database.

From the repository root, with Docker Desktop running and port 8080 free:

```sh
npm run backend:dev:isolated
```

This starts the existing backend watcher/server against a separate, persistent
MySQL container, `ludolume-dev-mysql`, published only at `127.0.0.1:3307`. It does
not use the Cloud SQL proxy on port 3306, the production database, production
credentials, or database exports. The frontend/WebGL servers are independent.
Development CORS currently permits `http://localhost:5173`.
An initial development build completes before the watcher/server start, so a
fresh checkout does not need an existing backend bundle.

The launcher creates the empty `ludolume_development` database baseline, applies
the reviewed migrations through 0025, and grants the `ludolume_dev` runtime user
only the existing runtime permissions. No website accounts are seeded: register
ordinary test accounts only after a reviewed registration configuration is available.
Registration, parent management and public participation remain closed by default;
this launcher does not claim a fully activated provider/signup environment. Account deletion is disabled
because its production deletion journal must not be used locally.

Unique local database/session secrets are generated once in the root's ignored
`.env.isolated.local` file (JSON, read only by this launcher). Do not commit, share
or delete that file while keeping the container. POSIX mode 0600 is requested
where supported; Windows access also depends on the containing folder's ACLs.
Missing credentials or mismatched container identity/ports stop setup rather
than resetting data. Remote Docker contexts are refused.

Ctrl+C stops the backend processes, but retains MySQL and local accounts for the
next launch. To stop only this local database afterward:

```sh
docker stop ludolume-dev-mysql
```

The next launch starts it again. Removing the container/volume is deliberately
not automated. Future migrations beyond 0025 require updating and reviewing the
launcher's explicit migration ceiling. These local schema preparations do not
enable Apple sign-in. Provider sign-in is disabled by default; the explicit
Google-only options are described in the
[isolated Google web check](PROVIDER_SIGN_IN.md#isolated-google-web-check).


## One maintained checkout, distinct running services

Use the normal project checkout for edits and both development commands; temporary
validation worktrees are not a second maintained application. Committing or pulling
source updates a checkout, not the running Cloud Run release or database schema.
A Vite restart is required after environment changes; synchronize source before
restarting a backend watcher against a separately verified compatible database.

- The frontend dev server renders the website at `http://localhost:5173`.
- The local Node backend normally listens at `http://localhost:8080`. The selected
  `backend:dev:local` command connects it to Cloud SQL through the proxy; it is not
  an isolated database merely because Node runs on this computer.
- The online Cloud Run backend is a separately deployed immutable build. Public
  preview routes local browser requests to that online service and real accounts.
- `VITE_USE_PUBLIC_API` selects public preview. `VITE_PUBLIC_AUTH_PROTOCOL` selects
  its explicit legacy/renewable contract. The legacy contract deliberately hides
  providers. Do not switch protocols without checking the target backend.
- With public preview off, `VITE_DEV_API_URL` selects the backend. A frontend flag
  does not migrate SQL, grant access, configure OAuth or activate server gates.

For real Google development, verify the exact local browser origin is registered
for the existing web OAuth client, and verify the chosen nonproduction backend
returns `google-web` from `/auth/providers/config`. Signup additionally needs its
separate advertised capability and reviewed registration/deletion prerequisites.
The isolated launcher's Google option uses Google's real token verifier; its
synthetic automated tests are not proof of real account acceptance. Its optional
signup flag alone does not enable the newer registration policy.

Current source includes Apple web popup/state handling and server code exchange.
Its configured Services ID and exact HTTPS domain return URL must match Apple's
registered configuration. Apple's return URL cannot be localhost or an IP address.
Use the already-approved domain/return URL and a verified test backend, or obtain
approval for a dedicated HTTPS development domain and matching provider settings.
Do not silently replace the return URL with localhost, reuse native credentials
as web credentials, or claim a mocked popup validates real Apple login. See
[the Apple activation contract](REGISTRATION_AND_APPLE_WEB.md) for lifecycle,
notification, maintenance, deletion and runtime-secret requirements.

Before moving the current checkout onto a backend with an older schema, obtain a
fresh read-only target/history/grant assessment. Missing migrations or runtime
permissions require their own scoped approval; the dev command must not repair
the Cloud SQL target automatically. The source-sync operation itself must also
avoid triggering an active backend watcher against that unverified target.
