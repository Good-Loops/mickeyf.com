# Isolated local backend

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
the reviewed migrations through 0012, and grants the `ludolume_dev` runtime user
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
not automated. Future migrations beyond 0012 require updating and reviewing the
launcher's explicit migration ceiling. The older `backend:dev:local` command is
the proxy-backed workflow; it is not this isolated environment.
