# Exact child signed-form schema operation

This source follow-up supplies the missing pending0028 plan/apply/verify commands
and the real default verifier used by strict activation. It is not an executed
production change. The [production sequence](production-cutover-plan.md) still
requires a new compatible creation-closed candidate and fallback, reviewed policy,
fresh recovery evidence and a separately approved schema operation. D0 cannot be
used as a restart-safe fallback after this extension.

## Fixed operation and evidence

The SQL is exactly the existing single ALTER in
[`0028_extend_child_signed_parent_forms.sql`](../../backend/migrations/pending/0028_extend_child_signed_parent_forms.sql),
raw SHA256 `8dddfdda37f24f9842d5ed43b950412ab7218260a3c5a49d01eff9564a951cf8`.
Both literal bytes and this digest must match. The command does not add0028 to the
0001–0026 manifest, invent a history row, apply pending0027, modify grants or
approve any real form. The runtime account remains `cms_mickeyf`@`%` with the exact
`google-apple-parent-signed` profile; review fields stay owner-only.

The metadata observer runs SELECT/SHOW only, with two matching full observations.
It verifies the selected database, CURRENT_USER(), source-pinned server UUID,
exact reviewed server version/vendor, exact history table and all26 checksums,
complete signed-form schema (including enforced CHECK, indexes, foreign keys,
collation and no unexpected triggers), and runtime privileges including unwanted
global, role and proxy grants. It accepts exact legacy or exact extended schema;
partial nullable-only changes fail. It reads no parent or child rows, password
hashes or signing-secret values. SQL identity does not independently prove the
GCP project: the authenticated proxy and separate cloud checks supply that binding.

`plan` first observes authenticated cloud metadata. It requires only the reviewed
new `prepare-child` candidate at100% traffic with no tags, a ready matching
compatible fallback, all four creation flags false, exact runtime/attachment,
all six global triggers disabled, no regional triggers or ongoing builds, and no
pending Cloud SQL operations. It checks regional/deletion/backup protection,
seven days of logs, a successful backup at most two hours old, and PITR no more
than15 minutes behind. Recovery metadata is not a tested restore or a recovery
time guarantee.

It then watches unchanged settled traffic for a real monotonic300 seconds,
checking at most50 seconds apart and rereading all prerequisites afterward. No
database session, transaction or SQL lock is held during that watch. Service
update/ready timestamps alone are not accepted as proof that old requests drained.
The resulting full proof, exact SQL/source/target and SQL baseline are bound into
the plan SHA256. The five-minute plan lifetime starts after the watch and SQL
observation. Stable state drift requires a fresh plan and watch.

`apply` requires the entire approved plan on stdin, its exact digest, explicit
apply authorization and matching identity confirmations. The real cloud reader
rechecks that approved proof before SQL, then again under the database migration
and runtime-grant advisory locks. It reobserves the exact SQL baseline and source
before executing the single ALTER. Identity, history and grants must remain
unchanged afterward, and the schema must be the exact extended capability.
The receipt is minted only from a real, unmodified in-process observation; a
deserialized snapshot cannot mint it. Preserve both the approved plan and final
receipt privately as the before/after audit evidence.

## Operator inputs and commands

Use a **clean checkout of the exact frozen candidate source**, with dependencies
installed. Do not stash or alter the owner's22 unrelated dirty files to make the
main checkout pass. Store plans, pins and receipts outside the checkout and
outside public logs. These examples prepare files only when intentionally run;
they were not used against production in this task.

Privately configure the authenticated loopback Cloud SQL proxy and dedicated
administrative migration credentials. The command accepts no runtime `DB_*`
fallback and rejects the runtime account as operator. Required environment names:

- `MIGRATION_DB_HOST=127.0.0.1`, `MIGRATION_DB_PORT`, `MIGRATION_DB_NAME=cms`,
  `MIGRATION_DB_USER`, `MIGRATION_DB_PASS`.
- `MIGRATION_CONFIRM_DATABASE=cms`, `MIGRATION_CONFIRM_TARGET` equal to
  `127.0.0.1:<port>/cms`, and exact `MIGRATION_CONFIRM_ACCOUNT` from CURRENT_USER().
- `MIGRATION_CONFIRM_CLOUD_SQL_PROJECT=noted-reef-387021`,
  `MIGRATION_CONFIRM_CLOUD_SQL_INSTANCE=cms-mickeyf`,
  `MIGRATION_CONFIRM_CLOUD_SQL_CONNECTION_NAME=noted-reef-387021:us-central1:cms-mickeyf`.
- `MIGRATION_CONFIRM_SERVER_UUID`, `MIGRATION_CONFIRM_SERVER_VERSION` and
  `MIGRATION_CONFIRM_VERSION_COMMENT` from independently reviewed target metadata.
  The server UUID must equal the source pin; the version must be the reviewed8.0.31.
- `CHILD_SIGNED_FORM_SOURCE_COMMIT` equal to the complete clean HEAD/candidate SHA.

Do not paste credentials into chat, a command argument, a committed file or an
output log. Private environment provisioning is separate from these commands.
The cloud subprocess inherits an explicit OS/cloud CLI allowlist, without SQL
credentials or Node preload hooks. It makes authenticated metadata GETs only.

From the repository root in PowerShell, after those prerequisites and the relevant
authorization exist:

```powershell
# Read-only plan; includes the actual five-minute traffic watch.
npm --prefix backend run --silent migrations:child-signed-forms:plan -- --pins C:\private-release\closed-provider-pins.json > C:\private-release\child-schema-plan.json

# Separately review the entire private plan and approve its sha256.
# Set MIGRATION_APPROVED_PLAN_SHA256 to that exact reviewed digest and
# MIGRATION_ALLOW_APPLY=1 only for the explicitly authorized operation.
Get-Content -Raw C:\private-release\child-schema-plan.json | npm --prefix backend run --silent migrations:child-signed-forms:apply -- --pins C:\private-release\closed-provider-pins.json > C:\private-release\child-schema-receipt.json

# Read-only postcondition/grant verification; no cloud watch or SQL mutation.
npm --prefix backend run --silent migrations:child-signed-forms:verify > C:\private-release\child-schema-verified.json
```

Use only valid reviewed provider-traffic pins; there is no force switch,
standalone reader-boundary override, arbitrary SQL input or nonproduction target
option on this CLI. Renew expired plans rather than extending their timestamps.
The default SQL operation deadline is30 seconds (bounded1–120 seconds), lock
acquisition5 seconds and metadata-lock wait10 seconds. Cleanup is also bounded.

If delivery or postconditions become uncertain after DDL begins, the command
returns `CHILD_SCHEMA_INDETERMINATE`, physically discards its dedicated session,
and stops. Do not retry, replay the old plan or issue an inverse ALTER. Reconnect
with an approved read-only verification first; keep creation closed and review
recovery if the exact extended result cannot be established. MySQL ALTER causes
implicit commit; atomic DDL does not make ROLLBACK an undo command.
[Atomic DDL](https://dev.mysql.com/doc/refman/8.0/en/atomic-ddl.html),
[implicit commits](https://dev.mysql.com/doc/refman/8.0/en/implicit-commit.html).
Cloud SQL PITR creates a new instance and needs separate runtime/identity,
deletion-replay and intervening-write review before any traffic change.
[Cloud SQL recovery](https://docs.cloud.google.com/sql/docs/mysql/backup-recovery/pitr).

## Activation and validation boundary

The ordinary provider release CLI now inherits the real read-only verifier by
default. Before strict template or activation writes, both the apply function and
direct cloud adapter rerun it through fixed Node/ts-node arguments and a bounded
asynchronous subprocess. Only explicitly allowed private migration variables are
passed. Raw child stdout/stderr and credentials are never included in failures.
Fresh live target/source/SQL/schema/grant/capability evidence must match every
material field of the reviewed receipt. Time is refreshed after verification,
and expired plans/receipts still block writes. Incident `close-active` retains its
existing guarded closure path without requiring a working SQL verifier.

Local verification includes metadata/core/CLI unit tests, cloud GET/clock and
activation adapter tests, plus a fresh pinned disposable MySQL8.0.31 integration
suite. The integration uses synthetic accounts/forms and synthetic cloud proof,
but real SQL metadata, locks, history, runtime grants, ALTER and postconditions.
The hardened launcher refuses inherited production configuration, remote Docker
endpoints and unverified container identity; cleanup targets only its owned
container. CI runs that suite on both Node22 and production Node26.12.

Local results before the hosted run: backend TypeScript and production build
passed; all1,011 backend unit tests,243 rollout-tool tests, six actual MySQL
integration cases and three launcher safety cases passed with no skips. The
MySQL container was removed by its scoped cleanup. Independent review covered
the operation, CLI, cloud reader, activation hook and disposable launcher.

At the last read-only production metadata check, generation156 still served the
historical D0 revision at100%, all six triggers were disabled, and the most recent
successful backup was1792526400000 (ended2026-10-20T20:58:14.759Z). Those facts do
not satisfy this new cutover gate. No production SQL, backup, deploy, traffic,
signup flag, website merge or store submission was performed here.
