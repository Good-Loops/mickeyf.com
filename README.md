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
- Node.js 22 (CI/runtime pinned at 22.23.2) and npm 11.6.2
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
2. Start the Cloud SQL Auth Proxy from the repository root:

   ```powershell
   npm run infra:up
   ```

3. Open the native Windows folder in VS Code:

   ```powershell
   code .
   ```

4. On first use, allow the automatic workspace tasks when VS Code prompts in
   this trusted repository. VS Code then starts three native workspace tasks
   whenever the repository opens:

   - `front`, running the frontend Vite server with a cyan browser icon;
   - `docs`, running the TypeDoc development server with a green book icon; and
   - `general`, an idle PowerShell at the repository root with the historical
     orange terminal tint (`terminal.ansiBlue` in the Monokai Spectrum theme).

5. For backend development, run `Terminal: Run Task`, then select
   `Backend: dev + watch`.

The `Workspace: startup` compound task owns the automatic layout. You can
also run it manually from `Terminal: Run Task`. The separate `Development: app`
compound task starts the frontend Vite server, backend webpack watcher, and
backend nodemon server. Infrastructure is never started implicitly.

The equivalent manual commands, each in its own terminal, are:

```powershell
npm --prefix frontend run dev
npm --prefix backend run watch
npm --prefix backend run dev
```

Default local ports are:

- Frontend: `http://localhost:5173`
- Backend: `http://localhost:8080`
- Cloud SQL Proxy: `127.0.0.1:3306`
- TypeDoc server: `http://localhost:8081`

If port 8080 is occupied, identify its owning process before stopping it. The
backend start command deliberately does not kill unrelated processes.

### Documentation development

Run the `docs` VS Code task or:

```powershell
npm run docs:dev
```

The command rebuilds the tracked `docs/` output before serving it. Review the
resulting Git diff and do not commit generated changes accidentally.

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
npm --prefix backend run prod
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

Firebase Hosting path redirects cannot canonicalize hostnames. The
`www.mickeyf.com` → `mickeyf.com` redirect is maintained in Firebase's external
custom-domain configuration and must be reverified there after domain or Hosting
changes.

Production deployments and IAM changes are separate, approval-gated tasks and
are not part of the local development workflow.
