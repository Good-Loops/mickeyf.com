---
applyTo: "unity/three-bosses/**"
---

# Three Bosses Unity project context

- The repository root is a monorepo, not a Unity project.
- The Unity project is located at `unity/three-bosses`.
- On Windows, resolve that directory to an absolute Windows path before
  project-scoped Unity CLI commands. The current CLI can fail to match a live
  Editor when `--project-path` receives the relative monorepo path. In
  PowerShell use `(Resolve-Path 'unity/three-bosses').Path`; in Git Bash use
  `cygpath -w "$(pwd)/unity/three-bosses"`.
- Before changing scenes, GameObjects, prefabs, or Unity assets, run
  `unity status --project-path "<resolved absolute project path>"`.
- When Pipeline reports a ready Editor, prefer live `unity command`
  operations and save through Unity instead of hand-editing serialized YAML.
- If no Editor is reachable, say so explicitly before falling back to file
  edits.
- Preserve every Unity `.meta` file and its GUID relationship.
- Do not execute project-wide Editor builders unless the task explicitly
  requires them.
- Treat unrelated `ProjectSettings.asset` rewrites from test or batch
  startup as incidental until their diff is reviewed.
- Write test reports, logs, builds, and temporary files outside the
  repository unless the task explicitly requires a tracked artifact.
- Unity-specific instructions do not apply to frontend, backend,
  documentation, infrastructure, or other non-Unity files.
