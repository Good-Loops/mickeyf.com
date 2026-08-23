# Git hooks

This directory holds versioned Git hooks that are not part of Git's default
`.git/hooks` search path. Nothing here runs until it is activated.

## Activation

Run once after cloning the repository:

```powershell
npm run hooks:install
```

This sets `core.hooksPath` to `.githooks` for this local checkout only. It
does not modify any other clone or CI.

Verify the setting at any time with:

```powershell
git config --get core.hooksPath
```

It should print `.githooks`.

## What `pre-commit` does

The hook runs `node scripts/normalize-unity-yaml-whitespace.mjs --staged`,
which normalizes Unity-generated trailing spaces and tabs in staged text
assets under `unity/three-bosses` (`.unity`, `.prefab`, `.asset`, `.meta`,
`.mat`, `.anim`, `.controller`).

- If normalization changes any file, the hook **stops the current commit on
  purpose**. Inspect the diff of the newly normalized, already re-staged
  files, then run the commit again. The second attempt proceeds normally
  once no further normalization is required.
- If a staged Unity file also has unstaged changes (it is only **partially
  staged**), the hook refuses to touch it and stops the commit. Stage or
  discard the remaining working-tree changes for the listed paths, then
  retry.
- Unity may stay open while you commit. Save any open scenes **before**
  starting the commit, and avoid saving a scene while the hook is running, so
  Unity does not rewrite a file out from under the hook mid-commit.

## Testing the normalizer

```powershell
npm run test:unity-yaml-normalizer
```

## Bypassing the hook

`git commit --no-verify` skips this hook entirely, including the partial-
staging and whitespace safeguards it enforces. Treat it as an emergency
escape hatch, not routine usage.
