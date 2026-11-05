# Worktree lifecycle

Before retiring a temporary worktree, review its changes and commits, integrate the work or preserve it in a recoverable snapshot, then remove the worktree using supported Git or Codex operations. Preserve needed ignored files, release artifacts, and evidence, and keep active checkouts.

# Changelog maintenance

Maintain the root `CHANGELOG.md` for Ludolume's meaningful, user-facing updates.

- Update it only for a release, a major milestone, or a substantial batch of meaningful changes. Do not update it for every commit, minor fix, or cosmetic tweak.
- Keep it short and newest first, with `Unreleased` at the top when needed. Group concise, related user outcomes under `Added`, `Changed`, and `Fixed`; omit empty subsections and implementation details.
- Use existing release versions and verified publication dates (`YYYY-MM-DD`) when available; otherwise use `Unreleased`. Do not invent versions, dates, or releases, or treat package versions, mobile build numbers, or commit dates as proof of a release.
- Verify entries against Git history and the actual changes. Describe what changed for users, and preserve any availability limits for gated features; source changes alone do not establish public availability.
- Preserve earlier release entries unless correcting a verified error. At a release, move the applicable `Unreleased` entries under the verified version and date, leaving pending changes in `Unreleased`.
