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
the reviewed migrations through 0018, and grants the `ludolume_dev` runtime user
only the existing runtime permissions. No website accounts are seeded: register
ordinary dummy accounts through the local website. Account deletion is disabled
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
not automated. Future migrations beyond 0018 require updating and reviewing the
launcher's explicit migration ceiling. These local schema preparations do not
enable Apple sign-in. Provider sign-in is disabled by default; the explicit
Google-only options are described in the
[isolated Google web check](PROVIDER_SIGN_IN.md#isolated-google-web-check).
