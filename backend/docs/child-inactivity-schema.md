# Child inactivity schema operation

The four activity/warning tables have a separate pinned plan/apply operation; they
are intentionally outside the historical 0001–0026 migration manifest. The
source SQL hashes, exact target, administrative account, existing history,
new-only backend, five-minute drain, backup and PITR observations are checked
before DDL. The same source and release checks are repeated immediately before
the changes. Registration remains closed while this operation is prepared.

Using the existing private, authenticated local SQL proxy and the same
`MIGRATION_*` target confirmations, `CHILD_SIGNED_FORM_SOURCE_COMMIT` and
explicit `CHILD_SIGNED_FORM_RUNTIME_GRANT_PROFILE`
required for the signed-form operation, generate a private plan:

```powershell
npm --prefix backend run --silent child-inactivity:schema -- plan --pins <reviewed-pins.json> > <private-plan.json>
```

After checking the exact plan, set `MIGRATION_APPROVED_PLAN_SHA256` to its
`sha256`, set the already-required mutation authorization and target
confirmations, and supply that exact plan to `child-inactivity:schema -- apply
--pins <reviewed-pins.json>`. The approved plan expires after five minutes.
No credentials or private plan output belong in the repository or shared logs.

DDL is not transactional in MySQL. The operation never drops tables or retries
after an uncertain outcome: an `indeterminate` result means stop, inspect the
exact target and reconcile any partially created tables before
any further migration. A successful schema operation creates no grants. Use
the existing guarded runtime-grant plan/verify/apply operation with profile
`google-apple-parent-signed-warnings`, then run activity continuity and warning-history
readiness checks against the restricted runtime account before enabling the
feature. Table deletion is not a rollback once data may exist; keep the feature
off and use the reviewed recovery procedure instead.
