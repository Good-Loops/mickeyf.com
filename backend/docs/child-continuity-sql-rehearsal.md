# Child activity continuity: runtime integration and SQL rehearsal

`createDurableChildActivity` is now the application adapter for enabled child
activity tracking. Account creation, password login, online interaction, both
score repositories and parent keep actions share it. Tracking remains off by
default; enabling it requires the pinned independent store and strict startup
checks. Automatic inactivity deletion remains hard-disabled.

Run from the repository root:

```text
node backend/scripts/run-child-continuity-sql-rehearsal.mjs
npm --prefix backend run test:child-continuity:unit
```

The SQL runner accepts no target arguments. It strips inherited credentials,
checks a fresh disposable local MySQL 8.0.31 container and empty database, and
removes its own container and volume afterward. The fixed fixture must match
the reviewed SQL drafts exactly. A restricted runtime identity uses the explicit
`google-apple-parent-signed-continuity` grant profile; a separate fixture admin
seeds synthetic accounts and injects restore faults. The external transport is
in memory and cannot be rewound by SQL rollback. These tests do not qualify GCS,
real consent, or a production migration.

## Runtime transaction boundary

Every tracked mutation requires an explicitly active guarded transaction and
the existing named child lock. Creation uses the parent lock while the new child
is still uncommitted. The adapter checks the exact database/server UUID and a
SQL clock within five seconds of the application clock. It reads the consent
relationship under a shared row lock and the current witness under an update
lock. The normal activity update obtains its own SQL write lock. This preserves
the runtime account's limited privileges.

Before commit, the adapter verifies old SQL against independent history, makes
the tentative SQL update, appends create-only external evidence, persists the
new SQL witness and operation ledger, then verifies the resulting SQL and
external state again. SQL/provider errors return a generic unavailable result.
It never retries an uncertain external write or silently falls back to SQL-only
activity. Historical accounts without activity stay untracked; missing witness
rows require reconciliation, not backfill.

Canonical state covers child/parent identity, country, consent policy/version
and activity time. External names and bodies use keyed digests, not plain account
IDs, contacts, credentials, scores or game events. Successful repeated activity
is another conservative timer reset. After a lost SQL commit response, a fresh
authenticated keep succeeds only if the previously committed state verifies;
it creates a new event. If external history is ahead of SQL, it holds instead.
The primitive's exact-operation replay tests remain separate.

## Verification coverage

- Actual creation commits a genesis using only its parent lock; unavailable
  history rolls creation and approval consumption back.
- Authenticated activity, password login, both score repositories and parent
  keep actions commit matching evidence. A failed witness rolls related session
  and score writes back. Duplicate score receipts add no activity.
- SQL rollback, lost commit command/response, lost external acknowledgement,
  partial/full older SQL restores, provider failure, and competing late writes
  cannot silently authorize an unwitnessed SQL commit.
- Concurrent activity and keep serialize through commit. Invalid sessions,
  absent locks/transactions, wrong primary, clock drift and missing witnesses
  are rejected. Adult and historically untracked accounts are not backfilled.
- Restricted SQL grants allow the required work and forbid direct witness
  deletion and identity reassignment. Startup checks the draft schema and
  refuses activity rows without continuity records.

The GCS adapter checks bucket/project identity, versioning, uniform private
access, seven-day soft delete, absence of lifecycle rules and selected runtime
permissions. A conditional metadata reread detects changes during that startup
check. Runtime access requires create/get/list plus bucket metadata read;
destructive and policy-changing capabilities are refused. This is a capability
probe, not a complete audit of conditional IAM, administrative identities or
future policy changes. See Google's [IAM permission reference](https://docs.cloud.google.com/storage/docs/access-control/iam-permissions)
and [permission test API](https://docs.cloud.google.com/storage/docs/json_api/v1/buckets/testIamPermissions).

## Activation requirements still open

No cloud resource, key, live SQL schema/grant or feature flag is changed by this
work. The continuity table is a pending draft outside the migration manifest.
The older two-table inactivity schema operation does not install it. A reviewed,
pinned schema operation and rollback procedure must be qualified before use.
The new grant profile is explicit so older schema operations remain unchanged.

The bounded lookup checks the current sequence and later events, not all older
events. Independent protection against event removal and storage rollback,
writer fencing, restore reconciliation, key recovery/rotation, finite retention
and erasure, load/cost and latency remain deployment requirements. In particular,
the 2,048-entry ledger bound and synchronous provider operations require load
qualification. Runtime schema visibility alone cannot audit hidden privileged
triggers; the administrative schema preflight remains required.

Warning preparation/delivery/late failure and contact history, the additional
12-month nonresponse policy, and conditional deletion/recovery are not yet
composed with this activity adapter. Do not remove the deployment hard stop or
mark release step 3 complete based on these tests.
