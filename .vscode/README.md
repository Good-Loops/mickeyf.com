# VS Code developer tooling

This guide documents the project-owned Visual Studio Code recommendations and
Model Context Protocol (MCP) servers under `.vscode`. The tracked configuration
is intentionally small: it should make the supported Windows workflow
reproducible without turning every developer's personal editor setup into
repository policy.

## Visual Studio Code extensions

Open the repository root with `code .`, review the tracked `.vscode` files, and
trust the workspace only after that review. VS Code then offers the extensions
listed in [`extensions.json`](extensions.json):

| Extension | Project use |
| --- | --- |
| `ReinaldoJavierMenendezAlonso.restore-terminals-color-icon` | Restores the tracked frontend, backend, documentation, and general terminal layout. |
| `VisualStudioToolsForUnity.vstuc` | Connects VS Code to the Three Bosses Unity Editor workflow. |
| `GitHub.vscode-github-actions` | Inspects the repository's GitHub Actions workflows and runs. |
| `ms-azuretools.vscode-containers` | Inspects and troubleshoots the tracked Dockerfile and Compose services. |

Recommendations are prompts, not forced installations. Personal extensions do
not belong in this file unless the repository depends on them. Linters,
formatters, and test explorers should be added only when the corresponding tool
and configuration are pinned in the relevant npm project.

The extension recommendations cannot pin versions. The versions audited on
2026-08-25 were Restore Terminals 1.0.1, Visual Studio Tools for Unity 1.3.1,
GitHub Actions 0.32.3, and Container Tools 2.5.0. Review permissions and release
notes after updates, especially for Restore Terminals and extensions that add
their own dependencies. GitHub Actions and Container Tools both expose
write-capable commands; the GitHub MCP read-only setting does not constrain
either extension. Run mutation, secret-management, image push/prune, and deploy
commands only deliberately.

### Automatic terminal startup

The Restore Terminals extension reads the tracked
[`restore-terminals.json`](restore-terminals.json) and runs the configured
commands when a trusted workspace opens. The `general` terminal intentionally
starts `copilot --allow-all`; this gives Copilot CLI broad command and file
access. Workspace Trust persists for the folder and does not reapprove commands
after a branch switch. Once the folder is trusted, reopening it can therefore
run commands changed by the newly checked-out branch without another trust
prompt. Inspect `restore-terminals.json` before reopening an unfamiliar branch,
or disable Restore Terminals for this workspace without changing the tracked
file.

The terminal profile in [`settings.json`](settings.json) expects Git for Windows
at `C:\Program Files\Git\bin\bash.exe`. A custom Git installation path must be
adjusted locally before the automatic Bash-based commands can start.

## MCP servers

VS Code reads the project-level configuration from [`mcp.json`](mcp.json). It
contains no API keys, tokens, cookies, service-account files, or credential
paths. Authentication remains local to each developer.

| Server | Scope | Authentication and boundary |
| --- | --- | --- |
| `github` | Repository, pull request, issue, Actions, code-scanning, Dependabot, and secret-scanning reads | VS Code OAuth. Access is not limited to this repository; it follows the signed-in identity. `X-MCP-Readonly: true` removes mutation tools. `X-MCP-Lockdown: true` reduces exposure to untrusted public-repository content but is not an authorization boundary. |
| `firebase` | `firebase_get_environment`, `firebase_get_project`, and `auth_get_users` only | Firebase CLI login or Google Application Default Credentials (ADC). The last tool returns user data and must be treated as private. |
| `playwright` | Browser navigation, inspection, and interaction in an isolated profile | No stored project credential. `--isolated` discards session storage when the MCP browser closes. It does not prevent side effects on websites. |

The local servers use exact package versions:

- `firebase-tools@15.28.1`
- `@playwright/mcp@0.0.79`

Exact pins prevent an unreviewed npm release from changing the available tools
on the next start. `npx -y` may still download and cache that exact package on
first use; this is a version pin, not a repository lockfile integrity pin. The
remote GitHub server can evolve independently, so its exposed tool families
must be rechecked periodically.

Both stdio servers set `NODE_OPTIONS=--use-system-ca` so Node can use trusted
Windows certificates without disabling TLS verification. Use Node 22.15 or
newer, but lower than Node 23; the project is tested in CI with Node 22.23.2.

### Local authentication

For GitHub, open the MCP server list in VS Code, start `github`, and complete the
GitHub OAuth prompt. Do not add a personal access token to `mcp.json`.

Firebase uses the same credentials as Firebase CLI. Either authenticate the
pinned CLI:

```powershell
npx -y firebase-tools@15.28.1 login
```

or refresh ADC when the Google Cloud workflow already uses it:

```powershell
gcloud auth application-default login
```

The active project comes from the local CLI/ADC context and the repository's
`.firebaserc`. Confirm it with `firebase_get_environment` before invoking
`auth_get_users`, especially when the identity can access production.

Playwright needs no login for local testing. Do not add `--storage-state`, a
persistent user-data directory, `--no-sandbox`, unrestricted file access, or
browser-extension mode merely for convenience; each weakens isolation or makes
authenticated browser state easier to reuse.

## Security boundaries

- Firebase's `--only auth` option also retains its core feature group. The
  explicit `--tools` allow-list is therefore the control that limits this
  project to the three named read-only tools.
- GitHub read-only mode prevents repository, issue, pull-request, and workflow
  mutation through this MCP server. Lockdown mode is a best-effort prompt-
  injection filter, not a replacement for least-privilege GitHub access. The
  OAuth identity, rather than the workspace folder, defines which repositories
  the server can read.
- Playwright isolation protects profile persistence, not the target website. A
  browser action can still submit a form, change remote data, download a file,
  or expose page content to the model. Default to the local site and obtain
  approval before causing an external side effect. No domain allow-list is
  configured, so keep normal tool/result review enabled outside the local app.
- MCP restrictions do not constrain terminals, other extensions, or a
  developer's direct CLI commands. Firebase tool filtering, for example, is
  not IAM.
- VS Code MCP process sandboxing is unavailable on Windows. Treat every change
  to `mcp.json` as executable configuration and review it before
  trusting the workspace.

Read-only tools can still expose sensitive information, including private
source, security alerts, workflow logs, repository discussions, and Firebase
Authentication user records. Use only the minimum data required for the task
and never paste returned secrets or personal data into tracked files.

## Verification

Run these checks from PowerShell at the repository root after changing the MCP
configuration or a package pin:

```powershell
Get-Content -LiteralPath .vscode\mcp.json -Raw |
  ConvertFrom-Json | Out-Null

npx -y firebase-tools@15.28.1 --version
npx -y firebase-tools@15.28.1 mcp --help |
  Select-String -Pattern '--dir', '--only', '--tools'

npx -y @playwright/mcp@0.0.79 --help |
  Select-String -Pattern '--isolated'

git status --short
```

Then use `MCP: Reset Cached Tools` and `MCP: List Servers` in VS Code:

1. Confirm Firebase exposes exactly `firebase_get_environment`,
   `firebase_get_project`, and `auth_get_users`; verify the active project
   before requesting Authentication records.
2. Confirm GitHub is authenticated, shows only the configured tool families,
   and exposes no mutation tools.
3. Confirm Playwright starts in isolated mode and can inspect the local site.
4. Close the Playwright browser and run `git status --short` again; a simple
   inspection session must not create workspace files.

## Troubleshooting

- GitHub `401` or repeated initialization waits: use the server's Manage menu
  to connect the intended GitHub account, then restart only that server.
- Stale tools after a configuration change: run `MCP: Reset Cached Tools`, then
  restart the affected server.
- Certificate errors on a managed Windows network: keep
  `NODE_OPTIONS=--use-system-ca`; do not disable strict SSL or HTTPS checks.
- Slow first startup: allow the exact npm package to download and initialize.
  Upstream deprecation warnings are not automatically repository defects.
- Unexpected files after browser use: inspect them before deletion, stop the
  server, and verify that isolated mode is still present.

## Updating the configuration

Update one MCP server at a time from an authoritative release. Never replace an
exact package version with `@latest`. Review the diff, reset cached tools, and
repeat the verification checklist before committing. Update `mcp.json` and this
guide together whenever capabilities or trust boundaries change.

Extension updates require the same review even though `extensions.json` cannot
pin their versions. Reconfirm activation events, Workspace Trust behavior,
commands, dependencies, and write capabilities before changing the audited
version record above.

## Maintenance references

- [VS Code MCP server configuration and security](https://code.visualstudio.com/docs/agent-customization/mcp-servers)
- [GitHub MCP server configuration](https://github.com/github/github-mcp-server/blob/main/docs/server-configuration.md)
- [Firebase MCP server](https://firebase.google.com/docs/ai-assistance/mcp-server)
- [Playwright MCP server](https://github.com/microsoft/playwright-mcp)
- [Node `--use-system-ca`](https://nodejs.org/api/cli.html#--use-system-ca)

## Related project documentation

- [Native Windows development](../README.md#native-windows-development)
- [Tracked VS Code tasks](tasks.json)
- [Git hook setup](../.githooks/README.md)
- [Three Bosses Unity setup](../unity/three-bosses/README.md)
