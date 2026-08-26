# mickeyf.com — BeatCalc Web App

mickeyf.com is an interactive music-and-math platform with games, animations,
educational resources, authentication, and leaderboards.

## Documentation

The generated TypeDoc site is published at
[good-loops.github.io/mickeyf.com](https://good-loops.github.io/mickeyf.com/).
It covers the frontend and backend modules and is updated from `main` by the
documentation workflow.
Pull requests that change documentation inputs build the site for validation,
while only `main` can publish it.

The active cross-project roadmap is tracked in [PROJECT_PLAN.md](PROJECT_PLAN.md).

## Technology

- Frontend: React, TypeScript, Sass, and Vite
- Backend: Node.js, Express, and MySQL
- Unity game: Unity 6.3 LTS (6000.3.8f1), 2D URP, and the Input System
- Hosting: Firebase Hosting and Google Cloud Run
- Database: Cloud SQL for MySQL
- Local database connectivity: Cloud SQL Auth Proxy in Docker Desktop

The application processes run with native Node.js. Docker is used only for
local infrastructure.

## Native Windows development

Native Windows 11 is the supported development environment. The checkout can
live in any local folder; the commands below assume this repository root:

```text
<path-to-your-checkout>\mickeyf.com
```

### Prerequisites

- Git for Windows
- Node.js 22.15 or newer, but lower than 23 (CI/runtime pinned at 22.23.2), and
  npm 11.6.2
- Visual Studio Code for Windows
- Docker Desktop using Linux containers
- Google Cloud CLI when local Cloud SQL access is needed
- Unity Hub and Unity 6.3 LTS editor version 6000.3.8f1 for Three Bosses

### Install dependencies

Open PowerShell in the repository root and run:

```powershell
$env:NODE_USE_SYSTEM_CA = "1"
npm ci
npm --prefix frontend ci
npm --prefix backend ci
```

`NODE_USE_SYSTEM_CA=1` keeps TLS verification enabled while allowing Node and
npm to use the trusted certificates from Windows. Do not disable npm's strict
SSL verification.

These are three independent npm projects; the repository does not use npm
workspaces.

### Configure local environment files

Create the ignored local files when they do not already exist:

```powershell
Copy-Item .env.example .env
Copy-Item frontend\.env.example frontend\.env
```

Fill in the required local values. Never commit `.env`, `frontend/.env`,
database credentials, session secrets, Firebase credentials, or ADC files.

The tracked `compose.yaml` expects the Cloud SQL connection name in the root
`.env`:

```text
CLOUD_SQL_CONNECTION_NAME=project:region:instance
```

p4-Vega score writes use a fail-closed runtime gate. Missing, blank, or any
value other than the exact lowercase string `true` keeps submissions frozen
with HTTP 503 `SUBMISSIONS_FROZEN`; login, signup, and leaderboard reads remain
available. Set this only in the untracked local `.env` when score-write testing
is intentional:

```text
P4_VEGA_SCORE_SUBMISSIONS_ENABLED=true
```

Three Bosses uses a separate fail-closed gate. Its leaderboard remains readable
while run submission is disabled. Set the exact lowercase value `true` only for
intentional local endpoint/bridge testing; the Unity submit control remains a
separate release gate:

```text
THREE_BOSSES_RUN_SUBMISSIONS_ENABLED=true
```

On native Windows, Compose finds the ADC file under `%APPDATA%` automatically.
Set `GOOGLE_APPLICATION_CREDENTIALS_HOST` in `.env` only to override that
location; use forward slashes in an override path. Create or refresh
Application Default Credentials interactively when required:

```powershell
gcloud auth application-default login
```

The ADC file is mounted read-only into the proxy container and must never be
copied into Git.

### Start development

1. Start Docker Desktop.
2. Open the native Windows folder in VS Code:

   ```powershell
   code .
   ```

3. Review the tracked VS Code configuration, trust the repository, and install
   the recommended extensions when VS Code prompts. See
   [`.vscode/README.md`](.vscode/README.md) for the extension and MCP security
   boundaries. The tracked terminal layout then starts four terminals whenever
   the repository opens:

   - `front`, running the frontend Vite server with a cyan browser icon;
   - `back`, starting the pinned Cloud SQL Auth Proxy, backend compiler/watch,
     and nodemon server together with prefixed logs and a red server icon;
   - `docs`, running the TypeDoc development server with a green book icon; and
   - `general`, running Copilot CLI in Git Bash at the repository root with the
     historical orange terminal tint (`terminal.ansiBlue` in the Monokai
     Spectrum theme).

The tracked `.vscode/restore-terminals.json` owns the automatic layout. The
existing `Infrastructure: up`, `Backend: dev`, `Backend: watch`, and
`Backend: dev + watch` entries remain available from `Terminal: Run Task` for
granular recovery. `Backend: local stack` starts the combined backend terminal,
and `Development: app` starts that local stack together with the frontend.

The equivalent manual commands, each in its own terminal, are:

```powershell
npm --prefix frontend run dev
npm run backend:dev:local
npm run docs:dev
```

Default local ports are:

- Frontend: `http://localhost:5173`
- Backend: `http://localhost:8080`
- Cloud SQL Proxy: `127.0.0.1:3306`
- TypeDoc server: `http://localhost:8081`
- Three Bosses WebGL assets (when enabled): `http://127.0.0.1:4174`

If port 8080 is occupied, identify its owning process before stopping it. The
backend start command deliberately does not kill unrelated processes.

### Documentation development

Run the `docs` VS Code task or:

```powershell
npm run docs:dev
```

The command rebuilds the tracked `docs/` output before serving it. Review the
resulting Git diff and do not commit generated changes accidentally.

### Local Three Bosses WebGL prototype

Three Bosses is available on the local Games page only when the development
feature flag is explicitly enabled. It is not included in the public site.

1. Build the Unity project to the external, ignored location documented in
   [`unity/three-bosses/README.md`](unity/three-bosses/README.md).
2. Add this untracked local setting to `frontend/.env.development.local`:

   ```dotenv
   VITE_ENABLE_THREE_BOSSES_LOCAL=1
   ```

3. Start the external asset server in a separate terminal:

   ```powershell
   npm run three-bosses:webgl:serve
   ```

4. Start or restart the frontend, then open
   `http://localhost:5173/games/three-bosses`.

The Games page and route exist only in Vite development mode with that exact
flag. The frontend proxies generated assets through
`/__local/three-bosses/`; nothing is copied into `frontend/`, committed, or
published. Rebuilding in the same external folder does not change the browser
URL because the local manifest discovers the current Unity filenames.

Publishing remains a separate, approval-gated design task. A future Hosting
integration must serve precompressed `.br` files with their original content
type plus `Content-Encoding: br`, support WebAssembly in the Content Security
Policy, use hashed/versioned caching safely, preserve the SPA rewrite, and
recheck Firebase artifact-size limits. Cross-origin isolation headers are only
needed if a future Unity build enables WebGL threads; they must not be added
blindly because they affect every embedded resource on the page.

### Stop development

Stop the active VS Code tasks with `Terminal: Terminate Task` or `Ctrl+C`, then
stop the proxy:

```powershell
npm run infra:down
```

### Checks and production builds

```powershell
npm run docs
npm --prefix frontend run test
npm --prefix frontend run build
npm --prefix backend run test
npm --prefix backend run test:unit
npm --prefix backend run test:migrations
npm --prefix backend run prod
```

The migration integration suite starts its own digest-pinned MySQL 8.0.31
container on a dynamically assigned `127.0.0.1` port and destroys it after the
tests. It never uses the Cloud SQL proxy on port 3306 or the runtime `DB_*`
variables; concurrent worktrees receive separate Compose projects and ports.

The migration CLI uses only dedicated `MIGRATION_DB_*` variables. Its
`migrations:plan` command is read-only. Schema mutations require their own
action-specific gate: `MIGRATION_ALLOW_APPLY=1` or
`MIGRATION_ALLOW_ROLLBACK_EMPTY=1`. The repeatable p4-Vega data tools likewise
use separate `MIGRATION_ALLOW_P4_VEGA_BACKFILL=1` and
`MIGRATION_ALLOW_P4_VEGA_RECONCILE=1` gates; neither schema-action flag
authorizes them. Every privileged command requires `MIGRATION_CONFIRM_DATABASE`
to exactly match `MIGRATION_DB_NAME`. These checks run before a database socket
is opened. `MIGRATION_CONFIRM_TARGET` must also exactly match
`127.0.0.1:<port>/<database>`; remote unencrypted database hosts are rejected,
so production use goes through the authenticated local Cloud SQL proxy:

```powershell
npm --prefix backend run migrations:plan
npm --prefix backend run migrations:apply
npm --prefix backend run migrations:rollback-empty
npm --prefix backend run migrations:p4-backfill
npm --prefix backend run migrations:p4-reconcile
```

Runtime-account privilege reduction has its own fail-closed workflow:

```powershell
npm --prefix backend run runtime-grants:plan
npm --prefix backend run runtime-grants:verify
npm --prefix backend run runtime-grants:apply
npm --prefix backend run runtime-grants:p4-retirement:plan
npm --prefix backend run runtime-grants:p4-retirement:verify
npm --prefix backend run runtime-grants:p4-retirement:apply
```

`plan` inventories every direct privilege channel, the runtime account's lock,
password-expiration and partial-revoke state, each role/default role, and each
proxy relationship without changing grants. It emits the exact
expected `cloudsqlsuperuser@%` to no-database-roles transition, the fixed Cloud
SQL target, the independently observed production server UUID, ordered
operations, blockers, and a deterministic SHA-256. `verify` exits 0 only after
the account has exactly the manifest and no
role; drift exits 2. Unexpected direct privileges, roles, grant/admin options,
proxy relationships, account flags, global role settings, unsupported server
metadata, or a duplicate account name block with zero planned mutations. The
tool deliberately does not guess how to clean them up.

All three commands require the normal exact database, loopback target,
maintenance account, effective `PROCESS` visibility, and
`MIGRATION_CONFIRM_RUNTIME_ACCOUNT=cms_mickeyf@%` confirmations. `apply`
additionally requires the exact reviewed role, Cloud SQL
project/instance/connection name, literal
`cloudsqlsuperuser@% -> no database roles` transition, traffic-drained
confirmation, plan SHA-256, server UUID, and
`MIGRATION_ALLOW_RUNTIME_GRANTS=1`. Before opening MySQL, it independently
verifies the fixed Cloud SQL instance and refuses while any Cloud SQL operation
is unfinished. The MySQL connection must then match the pinned production UUID.
Before its first grant write and again immediately before role removal, it
proves effective `PROCESS` access and zero runtime sessions. It grants and
proves the complete direct manifest, clears the approved default role, rechecks
Cloud SQL operations, and uses Cloud SQL's synchronous zero-role replacement
before proving the final metadata. It never uses `REVOKE ALL`, removes an
unknown role, alters the shared role, changes a
password, or kills a session. Cloud SQL documents the zero-role replacement in
its [database-role procedure](https://docs.cloud.google.com/sql/docs/mysql/create-manage-users#replace_database_roles_for_an_existing_user).

The three `p4-retirement` commands are a separate one-time path, not a general
privilege cleaner. Their plan accepts only the exact generic-only manifest plus
both non-grantable `users.p4_score` `SELECT` and `UPDATE` grants (`ready`), or
the exact manifest with both grants absent (`retired`). A partial pair, a grant
option, any other privilege, a role, or a missing final grant blocks with no
SQL. `verify` exits 0 only for `retired`; drift exits 2. `apply` additionally
requires the fixed Cloud SQL target, the frozen generic-only serving
confirmation `MIGRATION_CONFIRM_GENERIC_ONLY_FROZEN=1`, the literal
`MIGRATION_CONFIRM_P4_GRANT_RETIREMENT="users.p4_score SELECT,UPDATE -> no runtime access"`,
`MIGRATION_CONFIRM_RUNTIME_TRAFFIC_DRAINED=1`, the retirement plan SHA-256 in
`MIGRATION_CONFIRM_P4_GRANT_RETIREMENT_PLAN_SHA256`, the pinned server UUID, and
`MIGRATION_ALLOW_P4_GRANT_RETIREMENT=1`. It locks the same account workflow,
proves zero runtime sessions, runs one exact `REVOKE SELECT (p4_score), UPDATE
(p4_score)` statement without `IF EXISTS`, and requires a fresh exact metadata
verification. A connection loss after invocation is indeterminate and requires
a new plan and verification before any retry. Adding this local tool did not
execute it or change production.

MySQL privilege and role changes are not one transaction. A failed run can
therefore leave the safe prepared state: the direct grants installed, the
broad role still assigned, and its default activation cleared. Drain traffic,
inspect any Cloud SQL operation still in flight, generate a new plan, and only
then retry. A timeout or aborted `gcloud` process is explicitly indeterminate;
the next apply cannot proceed while Cloud SQL reports an unfinished operation.
Completion also requires a fresh runtime connection and positive and negative
application probes; metadata verification is not evidence that a
previously pooled session disappeared. No production privilege change was made
when this local workflow was added.

Every command requires `MIGRATION_DB_HOST=127.0.0.1`, `MIGRATION_DB_PORT`,
`MIGRATION_DB_NAME`, `MIGRATION_DB_USER`, `MIGRATION_DB_PASS`, and the exact
`CURRENT_USER()` value in `MIGRATION_CONFIRM_ACCOUNT`; there is no fallback to
the backend's runtime `DB_*` credentials. Optional bounded settings are
`MIGRATION_ADVISORY_LOCK_TIMEOUT_SECONDS` (default 5),
`MIGRATION_LOCK_WAIT_TIMEOUT_SECONDS` (default 10), and
`MIGRATION_OPERATION_TIMEOUT_MS` (default 30000). The backfill also accepts
`MIGRATION_P4_VEGA_BACKFILL_CHUNK_SIZE` from 1 through 5000 (default 500).
Both p4-Vega data commands use the separate bounded
`MIGRATION_P4_VEGA_OPERATION_TIMEOUT_MS` (default 900000, maximum 21600000), so
the short schema-operation deadline does not strand a multi-chunk pass. Set an
action gate only for the command being reviewed, then remove it from the shell
after the command. After connecting, the CLI also verifies that `DATABASE()` and
the complete account returned by `CURRENT_USER()` match those confirmations.

For production, keep the phases separate and follow the detailed cutover order
in [`backend/LEADERBOARD_DESIGN.md`](backend/LEADERBOARD_DESIGN.md):

1. Verify and record the proxy's exact project, region, and instance first;
   then record a fresh named backup and point-in-time-recovery evidence.
2. Supply one approved maintenance credential only through `MIGRATION_DB_*`,
   confirm its complete account, plan, apply only the additive schema, clear the
   action gate, and plan again. Do not alter `users.p4_score`.
3. Use the committed runtime grant manifest in
   `backend/ts/security/runtimeGrantManifest.ts` as the only intended end-state
   grant source. Do not replace it with improvised grants.
4. Deploy the freeze-capable dual writer, drain legacy-only revisions, then run
   the separately gated monotonic backfill and aggregate reconciliation.
5. For cutover, freeze submissions, drain in-flight dual writers, reconcile,
   deploy the generic-only writer still frozen, drain again, and reconcile
   again. Then separately approve and run
   `runtime-grants:p4-retirement:apply`, recycle runtime sessions, run
   `runtime-grants:p4-retirement:verify`, verify the generic-only manifest, and
   only then enable generic submissions.
6. Clear credentials and close the proxy. Drop and prove absence of an ephemeral
   maintenance account; if it is intentionally persistent, rotate and govern it
   as an administrator. Keep `users.p4_score` until its separately approved
   post-cutover drop migration.

The runtime manifest is deliberately render-only: importing it opens no
connection and changes no privilege. It grants only the columns used by the
application on `users`, `game_runs`, and `game_personal_bests`; it grants
nothing on `schema_migrations`, no `DELETE` or DDL, no role, and no grant
option. The isolated MySQL 8.0.31 suite installs those grants on a disposable
runtime user and a `users` table without `p4_score`, exercises the current
signup, login, p4-Vega, and Three Bosses SQL paths, and proves that user-row
`FOR UPDATE`, migration history, ledger mutation, destructive DML, DDL, account
creation, and grant operations are denied. Both game repositories use the same
database-scoped per-user advisory lock, so the generic-only manifest grants no
`UPDATE` on `users` and no access to `p4_score`.

The separately approved production reduction completed on 2026-08-26 using the
previous transitional manifest: `cms_mickeyf@%` has no database role but still
has the two narrow `p4_score` column grants required by the serving frozen dual
writer. The local generic-only manifest still treats those grants as unexpected
and fails closed. The separate exact retirement workflow is implemented and
locally verified, but has not been run against production.

The p4-Vega backfill verifies the exact applied schema and legacy source,
copies non-null historical scores monotonically in bounded transactions, and
then emits aggregate-only reconciliation evidence. The separate reconciliation
command is data-read-only and emits the same identity-free evidence. Either
command exits with code 2 when comparison drift remains; that is a failed gate,
not permission to cut over. Exit code 2 after a backfill can follow successfully
committed chunks, so it means "rerun/reconcile," not "nothing changed." Exit 1
means configuration, schema, or operational failure; exit 0 means the emitted
snapshot is consistent. Because chunks commit independently, any nonzero
backfill result after processing starts can leave earlier chunks safely
committed; never infer a whole-job rollback. Correct the failure and rerun the
monotonic command. These tools are repeatable rollout operations, not numbered
migrations, and running them in production remains separately reviewed and
approval-gated. Follow the two-run legacy-revision drain sequence in
[`backend/LEADERBOARD_DESIGN.md`](backend/LEADERBOARD_DESIGN.md).

An exit-0 reconciliation proves only that one database snapshot matched. It
does not prove that an old application revision cannot commit afterward. Record
the Cloud Run revision drain and in-flight request wait separately before the
final pass. The CLI confirmation identifies the loopback socket and database,
not the Cloud SQL instance behind the proxy; verify and record the authenticated
proxy's exact project, region, and instance before setting an action gate.

`migrations:rollback-empty` is only a pre-traffic cleanup: it locks and verifies
the reviewed tables, refuses if either domain table contains a row, and then
drops the empty leaderboard schema atomically. Production application remains
separately reviewed and approval-gated.

## Developer tooling

See [`.vscode/README.md`](.vscode/README.md) for the tracked VS Code extension
recommendations, scoped MCP servers, authentication steps, security boundaries,
and verification workflow.

### Git hooks

Run once after cloning, from the repository root:

```powershell
npm run hooks:install
```

This activates the tracked `.githooks/pre-commit` hook, which normalizes
Unity-generated trailing spaces and tabs in staged Unity text assets under
`unity/three-bosses` before a commit is created. If normalization changes
anything, the hook intentionally stops that commit so you can review the
result and commit again; a Unity file that is only partially staged is
rejected instead of being modified. Unity can remain open as long as any
edited scene is saved before you start the commit and is not saved again
while the hook runs. See [`.githooks/README.md`](.githooks/README.md) for
details, including the `--no-verify` bypass.

Test the normalizer itself with:

```powershell
npm run test:unity-yaml-normalizer
```

## Unity project location

The Three Bosses Unity project is stored at:

```text
unity/three-bosses
```

Open that exact directory from Unity Hub with editor version 6000.3.8f1 and
allow the first import to finish. The project uses Visible Meta Files and Force
Text serialization. Its enabled build scenes are, in order:

1. `Assets/Scenes/Level1_BeeBoss.unity`
2. `Assets/Scenes/Level2_CyborgBoss.unity`
3. `Assets/Scenes/Level3_Kraken.unity`

Track `Assets/` with every `.meta` file, plus `Packages/`, `ProjectSettings/`,
and the project documentation. Unity-generated `Library/`, `Temp/`, `Logs/`,
`UserSettings/`, IDE project files, and builds are ignored and must not be
committed. See [`unity/three-bosses/README.md`](unity/three-bosses/README.md)
for controls, verification steps, and licensing links.

## Production architecture

- Firebase Hosting serves the frontend.
- Cloud Run serves the Express API.
- Cloud SQL stores application data.
- Production secrets are referenced through Secret Manager.

[`cloudbuild.deploy.yaml`](cloudbuild.deploy.yaml) is the repository's canonical
copy of Stage B's source-less inline configuration; the live trigger does not
read this file. Editing or merging it alone changes no trigger, Cloud Run
revision, traffic allocation, or score-submission state.

Firebase Hosting path redirects cannot canonicalize hostnames. The
`www.mickeyf.com` → `mickeyf.com` redirect is maintained in Firebase's external
custom-domain configuration and must be reverified there after domain or Hosting
changes.

Production deployments and IAM changes are separate, approval-gated tasks and
are not part of the local development workflow.
