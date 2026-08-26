# p4-Vega dual-write freeze-gate compatibility evidence

Status: local compatibility evidence only. This is not a retained release
candidate, deployment revision, rollback target, or production authorization.

## Reproduced composition

On 2026-08-26, a detached worktree reproduced the last complete transitional
dual-writer source plus the storage-independent submission freeze gate:

- dual-write base:
  `0dbe3fb8dc20fef0e0a023a13db834d9c2e91a03`;
- gate source:
  `e8e1faeb1f008f9d34b1c8449a6ceac541c4bec2`;
- resolved seven-file diff SHA-256:
  `2941cdcdcdc6e67c0e0903f773f80467701a6c22af5536b8358ccc4b99cda502`.

The base contains the transactional dual writer and all later non-writer work
through the leaderboard-card polish. The generic-only writer commit
`2e3d4fde` is not in its ancestry. Only these files differed from the base:

```text
backend/ts/app.ts
backend/ts/config/runtimeConfig.test.ts
backend/ts/config/runtimeConfig.ts
backend/ts/controllers/mainController.ts
backend/ts/routers/mainRouter.contract.ts
backend/ts/routers/mainRouter.ts
backend/ts/security/mainController.security.test.ts
```

The dual-write repository, its unit and integration tests, and the migration
harness remained byte-for-byte at the base revision. Resulting file hashes are:

```text
75a8137854e320846e1cb61b347a7d0fbbe81ec4e4cb9b07abcc7ad0a715d63f  backend/ts/app.ts
77eb62dea721149d8950b9ea619af2f48a4be55cc00d5016bddd388f7f8828b3  backend/ts/config/runtimeConfig.test.ts
98b7939ebb34dacccd2f816cf1d13c2f4c9543baba2a37171ef3094074fdafd6  backend/ts/config/runtimeConfig.ts
0a9a53dd36810604cec47c5c999717369e54f715ff105f4c567fdcb3af0c000c  backend/ts/controllers/mainController.ts
6520fdcc23cd2e6df47505d4bb8c8b2c47e67cc3a070f351f39cbcb4c70e63b8  backend/ts/routers/mainRouter.contract.ts
93b20dcc4b24b83993b4d24d6dfde097aa11d86437aab056266f8931ebab7478  backend/ts/routers/mainRouter.ts
95a5a99ec33282fd984a7bd33aa48c541b97be3a19fdf3e3235ac8f2b7e36630  backend/ts/security/mainController.security.test.ts
```

A second clean detached checkout at the same base accepted the recorded diff
with `git apply --check`. This proves the resolved composition can be recreated
without importing the generic-only writer or changing the dual-write boundary.

## Verification

The temporary composition passed:

- `npm --prefix backend run test`;
- `npm --prefix backend run test:unit` — 84 of 84 tests;
- `npm --prefix backend run test:migrations` — 10 migration, 6 dual-write
  integration, and 7 backfill/reconciliation tests;
- `npm --prefix backend run prod`;
- `npm --prefix frontend run test` — 14 of 14 tests;
- `npm --prefix frontend run build`;
- `git diff --check` and the unchanged-writer boundary comparison.

The checks prove that frozen anonymous and authenticated submissions return
HTTP 503 before database acquisition, while the exact positive opt-in still
reaches the transactional dual writer. Improving and concurrent submissions
converge both stores on the correct maximum, generic-write failure rolls back
the legacy update, and no-op or missing-user submissions do not fabricate
generic history.

## Cleanup and remaining boundary

The disposable MySQL container and network stopped and were removed. Both
detached worktrees, their dependency junctions, generated builds, and temporary
patch were removed. The primary worktree remained on `feature/new-leaderboard`
at its original HEAD, and the branch/tag reference fingerprint was unchanged.
No rollout branch, tag, candidate commit, image, Cloud Run revision, live
trigger edit, deployment, traffic change, production database mutation, or
production freeze was created.

A real enabled dual-writer revision remains future work. It requires a reviewed
Stage B state with the exact positive opt-in, a non-mutating enabled-state
probe, an authoritative build and artifact digest, zero-traffic deployment,
and live verification before it can become a rollback target.
