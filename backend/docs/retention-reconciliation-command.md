# Conditional retention reconciliation command

This command is prepared for a reviewed release; it has not been used against
production and does not create or activate the GCS guard. Run it only from the
exact clean reviewed commit in a private terminal. Its inventory contains
account UUIDs and must not be copied into public logs or chat.

The command uses the existing loopback-only authenticated SQL proxy and
`MIGRATION_DB_*`, `MIGRATION_CONFIRM_DATABASE`, `MIGRATION_CONFIRM_TARGET`,
`MIGRATION_CONFIRM_ACCOUNT`, `MIGRATION_CONFIRM_SERVER_UUID`, and
`MIGRATION_ALLOW_APPLY=1` pins. Set `RETENTION_ORIGINAL_SERVER_UUID` to the
original primary UUID, `RETENTION_RECONCILIATION_SOURCE_COMMIT` to the exact
reviewed clean source commit, and `RETENTION_JOURNAL_BUCKET` plus
`RETENTION_CONFIRM_BUCKET` to the exact same separately provisioned bucket.
Load the same private `CHILD_INACTIVITY_KEYS` bundle used by the runtime; it
contains three independently generated 32-byte hexadecimal keys separated by
colons. The first signs journal records; the third signs receipt and
domain-separated administrative evidence. Never put the bundle or its parts in
a command transcript or source control.

Read the private inventory:

```powershell
'{}' | npm --prefix backend run --silent child-inactivity:reconcile -- inventory
```

For initial provisioning only, an operator can create a hold in an empty
conditional-intent bucket using
`{"confirmation":"INITIALIZE RETENTION HOLD"}` with `initialize-hold`.
The write is create-only and refuses a previously soft-deleted guard; it does
not activate deletion.

Before restoring, set the signed guard to hold on the original primary:

```powershell
'{"confirmation":"HOLD RETENTION FOR RESTORE"}' | npm --prefix backend run --silent child-inactivity:reconcile -- hold
```

Stop and drain **all** old writers and maintenance jobs, including identities
other than the normal application SQL user. For a specific unresolved intent,
pass the exact `intent` object from private inventory on standard input with
the confirmation `ORIGINAL PRIMARY DRAINED AND ACCOUNT ABSENT` to
`confirm-deleted`. The command pins the original SQL identity, takes a short
global read lock, checks direct PROCESS visibility and no normal application
SQL sessions, verifies account absence and the exact intent, and records an
append-only outcome. The lock blocks all database writes on that SQL server
while it is held. It does not establish that every writer stays stopped after
it is released. An uncertain command outcome requires fresh inventory and
manual review; do not blindly retry.

To apply that exact confirmed outcome, point the SQL proxy and migration pins
at a **different isolated restored server**, keep the original guard on hold,
and supply the same intent with
`ISOLATED RESTORE FENCED AND DELETION VERIFIED` to `apply-restored`. The
operation locks the parent and child, rechecks target SQL identity and the
signed outcome, and refuses newer restored activity. Neither command proves
that Cloud Run or another external writer has been fenced; the operator must
keep all old writers stopped and restored traffic isolated throughout.

After every intent has a verified outcome and that outcome matches the
isolated target, an administrator can use `activate` with
`{"confirmation":"ALL WRITERS FENCED AND INTENTS RECONCILED"}`. It checks the
held guard, SQL identity, privileges, runtime sessions, every signed intent and
outcome, and target account state under a short global SQL read lock, then
updates the guard using its exact generation. It refuses unresolved or changed
inventory. It cannot itself prove Cloud Run or other external writers are
stopped; keep them fenced through traffic cutover. If activation is
unconfirmed, inspect the guard and keep traffic stopped rather than retrying
blindly.

The command does not create a bucket, grant permissions, apply database
migrations or switch traffic. An active guard lasts 364 days at most. Review it
with the annual privacy/security review; after expiry, deletion holds until the
reviewed procedure is repeated. Automatic renewal is intentionally absent: it
could not detect an undeclared restore.
