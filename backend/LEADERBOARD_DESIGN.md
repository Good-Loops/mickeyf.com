# Multi-game leaderboard design

Status: Phase 13.1 contract approved by Mike on 2026-08-24. The sanitized live
schema preflight completed on the same date. On 2026-08-25, Mike approved the
end state in which p4-Vega uses the generic leaderboard storage and the legacy
`users.p4_score` column is retired after a verified cutover. This document does
not authorize a production schema or data change.

A fresh read-only check on 2026-08-26 confirmed that production still has only
the `users` application table and still includes `users.p4_score`; neither
additive migration has been applied. That is the current incomplete rollout
state and explains why the generic p4-Vega route cannot yet serve live data.

The transitional p4-Vega dual-write repository was implemented and verified
locally on 2026-08-25 with unit, rollback, and concurrent MySQL 8.0.31 tests. It
has not been deployed and must not receive traffic until migrations `0001` and
`0002` have been applied and verified on the target database.

The transitional read split was corrected and reverified on 2026-08-26 at
`a127beac14c2662648c8aededa59374f5d7c87dd`. Its legacy `/api/users`
`get_leaderboard` operation still reads `users.p4_score`, while the additive
`/api/leaderboards/p4-vega` route reads `game_personal_bests`. Tests explicitly
prove that those sources may differ before backfill. The existing production
leaderboard must retain the legacy reader until the old-writer drain, final
backfill, and zero-discrepancy reconciliation have all completed.

The generic-authoritative p4-Vega writer was prepared and verified locally on
2026-08-26. It locks the authenticated user and scoped generic best on one
connection, compares the generic score, and writes only a strict improvement
to `game_personal_bests`; it never reads or writes `users.p4_score`. The legacy
HTTP request and response remain unchanged. A disposable MySQL test also drops
the legacy column before submitting successfully. This candidate has not been
deployed and does not authorize the production cutover sequence below. Its
implementation remains recorded at `2e3d4fde`; it is not the active branch
source while the required transitional dual-write phase is staged.

On 2026-08-26, detached worktrees verified historical dual-write base
`0dbe3fb8` plus the seven storage-independent freeze-gate changes from
`e8e1faeb`, excluding generic-authoritative writer `2e3d4fde`. Backend
type-check, 84 unit tests, 10 migration tests, 6 dual-write integration tests,
7 backfill/reconciliation tests, the production bundle, 14 frontend tests, and
the frontend build passed. The checks proved frozen requests stop before
database acquisition and enabled requests retain the dual writer's rollback
and concurrency guarantees.

The same composition is now retained on `feature/new-leaderboard` at
`c1c742b927844e89fe9f7ab07ddb9a20501399ee`. It is a reviewable source
checkpoint, not an approved main-branch build, image, revision, traffic target,
or production rollback candidate; no live or production state changed.

The revision-scoped p4-Vega submission freeze gate was prepared locally on
2026-08-26. `P4_VEGA_SCORE_SUBMISSIONS_ENABLED=true` is the only value that
permits the legacy `submit_score` operation; missing, blank, or any other value
returns HTTP 503 `SUBMISSIONS_FROZEN` before authentication or database work.
Login, signup, and leaderboard reads remain available, and each revision logs
only the normalized `enabled` or `frozen` state at startup. The gate is
storage-independent so it can be applied to both the transitional dual writer
and the generic writer. The tracked canonical Stage B source remains
deliberately frozen with `P4_VEGA_SCORE_SUBMISSIONS_ENABLED=false`, attests the
exact eight-variable environment including
`THREE_BOSSES_RUN_SUBMISSIONS_ENABLED=false`, and verifies the exact p4 HTTP
503 and Three Bosses HTTP 403 freeze contracts without authentication or
persistence. It has not been synchronized to or verified against the live
source-less inline trigger; no Stage B build ran, no revision was deployed, no
traffic changed, and no production freeze was established.

`main` remains deferred until after Phase 14, so the live main-only Stage A and
Stage B trust chain must not be weakened or repointed. The isolated
`cloudbuild.candidate.yaml` image-only contract was committed at `e68959e9`;
it contains no production Pub/Sub, deployment, secret, Cloud Run, Cloud SQL,
or traffic capability. A separately approved temporary trigger must bind it to
the exact full feature-branch commit with verified Git provenance. Any later
deploy path must independently pin that build identity, commit, image digest,
and dedicated identities. An enabled dual writer must also require the
anonymous HTTP 401 `UNAUTHORIZED` p4 probe with the existing JSON, no-store,
no-cookie, redirect, response-size, and timeout checks. The 401 proves the gate
is open and stops before database acquisition; it does not identify the
persistence implementation, so it is never sufficient without the source and
image pins.

The repeatable, privileged p4-Vega historical-backfill CLI and read-only
aggregate reconciliation command were implemented and verified locally on
2026-08-25. This does not authorize or constitute a production backfill, read
cutover, or removal of `users.p4_score`; each production step retains the
approval and evidence gates below.

The eventual generic p4-Vega `get_leaderboard` implementation was prepared and
verified on 2026-08-25 without changing its request or response contract. It is
not the active transitional reader and has not been deployed or activated in
production. Switching the legacy operation remains gated on the additive
schema, completed backfill, legacy-revision drain, and zero-discrepancy
reconciliation. The generic-only writer is locally prepared, but its
production cutover and the legacy column removal remain later gated steps; the
multi-game frontend slice is recorded below.

The additive backend API was implemented and verified locally on 2026-08-26.
`GET /api/leaderboards` explicitly projects the server catalog, and
`GET /api/leaderboards/:gameId` exposes generic p4-Vega rows with one-based
positions. Three Bosses reads real current-rule personal bests in completion-
time order even while writes are disabled. Its complete authenticated run
route remains fail-closed unless the exact
`THREE_BOSSES_RUN_SUBMISSIONS_ENABLED=true` runtime opt-in is present. It
validates exact JSON/version/UUID/time input, derives score server-side,
requires an allowed browser Origin for cookie mutations, serializes immutable
runs and personal bests on one transaction connection, preserves exact replay
outcomes, rejects conflicting reuse, and enforces both database-backed per-user
and per-instance IP limits. Unit, security, rollback, concurrency, and eight
isolated MySQL integration tests passed. None of this code has been deployed or
activated in production.

The multi-game frontend slice was implemented locally on 2026-08-26.
The canonical `/leaderboards` page is now a catalog-driven hub of leaderboard
destinations, not a duplicate game launcher. Direct detail routes use the
generic GET API, and p4-Vega no longer reads the legacy `/api/users`
leaderboard operation in the browser. The Three Bosses route renders typed
real rows while its catalog remains unranked and submission-disabled. A strict
cookie-bearing POST client and lifecycle-safe Unity host bridge were committed
at `c4349f7c`; they pass only canonical run metrics, never browser credentials,
and preserve the same identity for uncertain retries. The Unity caller and
receiver remain disconnected and the Submit Score button remains inert. The
old singular frontend route is intentionally not retained because the owner
approved a clean URL change before meaningful public adoption. Generic-only
p4 writes, production migration, Unity submission activation, and legacy-column
removal remain incomplete.

## Invariants

- Stable game identifiers are `p4-vega` and `three-bosses`.
- The backend owns validation, score derivation, ranking order, submission
  enablement, and rules versions.
- Existing `submit_score` and `get_leaderboard` requests and their p4-Vega
  response bodies remain compatible throughout the migration, including after
  their storage implementation moves to `game_personal_bests`.
- Existing `users.p4_score` values are preserved until every non-null score is
  backfilled and reconciled. The initial additive migrations do not alter the
  column; a later immutable migration drops it only after the verified cutover
  gates below are satisfied.
- The p4-Vega backfill is a repeatable operational data command, not an HTTP
  endpoint or a one-time `schema_migrations` version. It must run again after
  every legacy-only application revision has drained.
- Three Bosses remains `UNRANKED` and its submission endpoint remains disabled
  until the remaining Phase 12 release gates are approved.
- A player identity always comes from verified authentication, never a client
  supplied user name.

The server-owned catalog in `ts/leaderboards/gameCatalog.ts` defines the
current presentation and ordering policy:

| Game ID | Primary order | Rank state | Submission state |
| --- | --- | --- | --- |
| `p4-vega` | score, descending | not applicable | legacy endpoint only |
| `three-bosses` | completion time, ascending | unranked | disabled |

Only a strict primary-metric improvement replaces a personal best. An equal
result keeps the existing best and its original recorded timestamp. Equal
leaderboard metrics are ordered by `recorded_at ASC`, then internal `user_id
ASC`. Legacy p4-Vega rows share the migration timestamp, so tied imported rows
fall through honestly to the user-ID ordering. Scores from different games are
never compared.

## New API boundary

The multi-game API will be additive rather than extending the operation switch
on `/api/users`:

- `GET /api/leaderboards` lists the server-owned game catalog.
- `GET /api/leaderboards/:gameId` returns exactly the first ten rows for one
  game. Version one has no client-controlled limit or sort parameter.
- `POST /api/leaderboards/three-bosses/runs` accepts an authenticated run only
  after Three Bosses submission is enabled. p4-Vega continues to write through
  its legacy operation and has no generic run endpoint in version one. The
  legacy operation keeps its HTTP contract while its persistence moves to
  `game_personal_bests`.

Exact version-one DTOs and mechanical bounds are defined in
`ts/leaderboards/leaderboardContract.ts`. New responses carry
`contractVersion: 1`. Public leaderboard rows contain only `position`,
`userName`, and the game-specific metric fields. They never expose internal
user IDs, run IDs, fingerprints, or timestamps. SQL ordering is selected from
the code-owned game catalog; route input is never interpolated into `ORDER BY`.

Three Bosses submissions, once enabled, use `contractVersion: 1`,
`rulesVersion: 1`, a canonical lowercase RFC 4122 version-four UUID, and an
integer `completionTimeMs` from 1 through 86,400,000 inclusive. The bound is a
versioned transport and storage safety contract, not a rank threshold.

Unity must first canonicalize its elapsed time using
`Round(elapsedSeconds * 1000, MidpointRounding.AwayFromZero)` and calculate the
displayed score from that same integer. The server calculates positive scores
as `max(1, floor(100000000 / completionTimeMs + 0.5))`. Unity and backend parity
vectors are required before writes can be enabled. The server never accepts a
client-provided score or rank for Three Bosses.

An exact retry of the same `(gameId, userId, runId)` and canonical payload
returns the original outcome with `replayed: true`. Reusing that identity with
different data returns `IDEMPOTENCY_CONFLICT` and changes no rows.

### Exact HTTP behavior

| Condition | HTTP | Error/result |
| --- | ---: | --- |
| Catalog or leaderboard read succeeds | 200 | typed success DTO |
| New Three Bosses run is accepted | 201 | run result, `replayed: false` |
| Exact run retry succeeds | 200 | original result, `replayed: true` |
| Unknown exact game ID on a leaderboard read | 404 | `UNKNOWN_GAME` |
| Known game submission is not enabled | 403 | `SUBMISSION_DISABLED` |
| Unsupported contract or rules version | 400 | corresponding version error |
| Invalid UUID, time, or payload | 400 | `INVALID_RUN` |
| Authentication is absent or invalid | 401 | `UNAUTHORIZED` |
| Same run identity carries different canonical data | 409 | `IDEMPOTENCY_CONFLICT` |
| Submission rate limit is exceeded | 429 | `RATE_LIMITED` |
| Unexpected server failure | 500 | `SERVER_ERROR` |

The disabled-state and validation checks happen before a database connection is
acquired. Tests must prove disabled Three Bosses submissions perform zero
ledger or personal-best writes.

The implemented endpoint enforces a fail-closed limit of ten accepted new runs
per authenticated user per 15 minutes from the shared database inside the
user-locked transaction. Exact idempotent replays return the stored result
without consuming another accepted-run slot. The general API limit remains,
and a dedicated per-instance IP ceiling permits 30 submission requests per 15
minutes. Reevaluate a distributed IP limiter before increasing Cloud Run scale
or treating the leaderboard as competitive infrastructure.

## Frontend route contract

- `/leaderboards` is the server-catalog-driven hub. Its cards navigate to
  leaderboard details only; playable game cards remain under `/games`.
- `/leaderboards/:gameId` is the direct-linkable selected game state.
- The hub and selected-game metadata are populated from the server catalog
  rather than a separate client-owned ranking configuration.
- Each direct game route owns a bounded loading, empty, success, and error
  state. Navigating between routes performs a fresh read; version one does not
  promise a cross-game client cache.
- Unknown game IDs show a bounded not-found state with links to known games;
  they are not silently normalized to a different identifier.

## Additive persistence model

The code catalog remains authoritative, so no mutable games configuration
table is required. Two domain tables plus one administrative migration-history
table are planned:

### `schema_migrations`

Stores the immutable migration version, SHA-256 checksum, and applied time. A
separate, short-lived migration principal receives only the reviewed schema,
migration-history, backfill, and reconciliation privileges required for the
approved run; the runtime identity receives no DDL permission. The runner uses
a database advisory lock so two deploys cannot apply migrations concurrently.
Checksums cover the exact committed LF SQL bytes. Each version contains one
statement because MySQL DDL commits implicitly; the runner verifies the exact
table shape before recording or recovering a version. The CLI accepts only the
authenticated loopback proxy target and requires exact database, target, and
action-specific confirmation before opening a connection for any mutation.
The dedicated session forces autocommit for durable history rows.

The repeatable p4-Vega backfill is deliberately not recorded as a numbered
schema migration. Migration history proves structural evolution; it must not
make a required second backfill run appear already complete.

### `game_runs`

An immutable authenticated submission ledger containing:

- internal primary key;
- `game_id`, `rules_version`, exact `user_id`, and client `run_id`;
- canonical integer score and optional integer completion milliseconds;
- a server-computed payload fingerprint;
- whether the submission improved the personal best; and
- server submission timestamp.

UTC `DATETIME(6)` fields deliberately have no session-dependent default;
approved write SQL supplies `UTC_TIMESTAMP(6)` (or an explicitly validated UTC
value for the shared backfill timestamp).

The table has a unique constraint on `(game_id, user_id, run_id)`. Rules version
and every canonical metric are included in the payload fingerprint. For the
version-one Three Bosses request, the fingerprint is SHA-256 over the UTF-8
string `1\nthree-bosses\n<userId>\n<runId>\n1\n<completionTimeMs>\n`, with
each placeholder replaced by its canonical decimal or lowercase UUID value.
Reusing a run ID under a different rules version or metric value therefore
conflicts. The table keeps non-best runs so retries remain idempotent and
auditable.

### `game_personal_bests`

One row per `(game_id, rules_version, user_id)` containing the indexed best
metrics, recorded timestamp, and an optional reference to its source run.
Generic reads filter to the current catalog rules version. A composite foreign
key proves that any source run belongs to the same game, rules version, and
user. Legacy p4-Vega rows are backfilled directly into this table with a null
source run and no fabricated historical ledger entry.

Foreign-key types must exactly match the live `users.user_id` definition.
Machine identifiers use an ASCII binary collation; display text remains
`utf8mb4`. The exact additive SQL lives in `backend/migrations` and is verified
against disposable MySQL 8.0.31. Applying it remains separately reviewed and
approval-gated.

### p4-Vega historical backfill and reconciliation

The historical transfer is an operator-only CLI operation. It is never exposed
through Express, bundled into the runtime server, or made callable by a browser.
It reuses the migration connection boundary: dedicated `MIGRATION_DB_*`
credentials, the authenticated loopback Cloud SQL proxy, exact database and
target confirmation, a p4-Vega-backfill-specific mutation flag, the database
advisory lock, bounded waits, and exact migration-history and table-shape
verification.

Each run copies every non-null `users.p4_score` by immutable `user_id` into the
`p4-vega`, rules-version-1 personal best. Historical integers are copied even
when today's client validator would reject them. New rows reuse the verified
`game_personal_bests` migration's UTC `applied_at` timestamp on every pass,
with null `completion_time_ms` and null `source_game_run_id`. A conflicting
target row changes only when the legacy score is strictly greater; an equal
source preserves the target timestamp. A target score higher than legacy is
not silently accepted: preflight refuses the whole run before writes, as it
does for extra generic rows, unexpected p4-Vega metadata or run-ledger rows,
and unexpected p4-Vega rules versions. The operation never changes `users`,
decreases or deletes a target score, or creates a historical `game_runs` row.

Reconciliation is a separate read-only gate. It returns only server-side
aggregate evidence: source and target count, minimum, maximum, and sum, plus
counts for missing rows, extra rows, directional score mismatches, unexpected
p4-Vega completion-time or source-run metadata, run-ledger rows, and rules
versions. It never prints or exports player identities. A cutover-quality
reconciliation succeeds only when every discrepancy count is zero and the
aggregate sets match.

That success is point-in-time database evidence, not proof that a legacy-only
writer cannot commit after the snapshot. The separately recorded Cloud Run
revision drain, in-flight request wait, and final post-drain pass remain
mandatory. Likewise, the loopback target confirmation cannot identify the
Cloud SQL instance behind the proxy; operators must verify and record the
authenticated proxy's exact project, region, and instance before enabling a
data action.

The backfill uses a short-lived least-privilege principal with only the source
reads and target reads/inserts/score-and-timestamp updates required for the
reviewed operation. Migration history is read-only to this principal, so the
shared recorded timestamp cannot be edited between passes. It receives no
permission to update `users` or to delete, alter, drop, trigger, export, or
grant. No trigger, view, generated column, index, or foreign key is added
around `users.p4_score`, so the later contract migration can remove the column
cleanly. The transitional command must itself be removed or disabled, and
included in the no-reference proof, before that drop is approved.

## Completed live metadata preflight

The approved read-only preflight on 2026-08-24 confirmed:

- Cloud SQL runs MySQL `8.0.31-google` as a regional high-availability
  instance with deletion protection, encrypted-only transport, eight retained
  successful backups, binary logging, and seven-day point-in-time recovery;
- database defaults are `utf8mb4` and `utf8mb4_unicode_ci`, transaction
  isolation is `REPEATABLE-READ`, strict SQL modes are active, and foreign-key
  and unique checks are enabled;
- `users` is the only current application table and uses InnoDB;
- `users.user_id` is `INT NOT NULL AUTO_INCREMENT PRIMARY KEY`, while
  `user_name`, `email`, and `user_password` are non-null `VARCHAR(255)` values
  and `p4_score` is a nullable `INT`;
- `email` is unique, but `user_name` is not schema-enforced unique, so every
  new relationship must use immutable `user_id` rather than display names;
- no foreign keys, `CHECK` constraints, triggers, migration-history table, or
  leaderboard tables currently exist; and
- aggregate-only checks found that every stored non-null p4-Vega score satisfies
  the current integer, range, and divisibility contract. Player identities and
  row-level data were not selected or recorded.

The snapshot also found no competing transaction, table-in-use signal,
metadata-lock waiter, or in-flight Cloud SQL operation. `performance_schema` is
disabled, so direct inspection of `metadata_locks` was unavailable; repeat the
alternate checks immediately before applying any statement. The server's
default metadata-lock timeout is one year and statement execution is otherwise
unbounded, so the migration connection must set a short session
`lock_wait_timeout` and the runner must enforce its own fail-fast operation
deadline.

The inspected application database account currently has broad DDL and DML
privileges. Do not reuse it as the long-term migration boundary. Before
production rollout, provision and validate a least-privilege runtime database
identity and use a separate short-lived migration principal. Credential changes and
privilege revocation require their own reviewed approval. The preflight made no
database, configuration, or repository change and returned the local proxy to
its original stopped state.

This evidence satisfied the metadata gate for the exact SQL and isolated local
migration tests completed on 2026-08-25. It does not authorize production DDL,
backfill, credential rotation, or deployment.

## Expand, backfill, and cutover

1. Use the versioned, checksum-recorded `mysql2` migration runner with its
   dedicated migration configuration and a short-lived migration principal.
2. During Mike's reviewed migration approval, assess every proposed statement's
   online-DDL and metadata-lock behavior. Then record and verify a fresh named
   pre-migration backup plus point-in-time-recovery evidence.
3. Apply the administrative history table and two domain tables only; do not
   alter `users.p4_score`.
4. Deploy transactional p4-Vega dual writes to `users.p4_score` and
   `game_personal_bests` while preserving the legacy API. The legacy request
   has no run ID, so it never fabricates a `game_runs` row or claims request
   idempotency. During this phase, keep the legacy leaderboard read on
   `users.p4_score`; do not expose an incomplete generic table as its source.
5. With a short-lived least-privilege principal and the dedicated action
   confirmation, run the repeatable monotonic p4-Vega backfill. Copy every
   non-null legacy value, even if an old stored value does not satisfy today's
   client validator; do not create a historical run row.
6. Wait for every legacy-only Cloud Run revision to drain, prove it can no
   longer receive traffic, then rerun the same idempotent backfill to close the
   rolling-deployment window.
7. Run the read-only aggregate reconciliation gate with server-side missing,
   extra, score-mismatch, and metadata-mismatch counts plus source and target
   count, minimum, maximum, and sum. Require an exact match and do not export
   player identities.
8. Verify the additive generic read API against the reconciled table, then
   switch the existing p4-Vega `get_leaderboard` implementation to
   `game_personal_bests` without changing its request or response contract.
   Prepare the direct-linkable multi-game frontend and generic-only writer, but
   do not route production traffic to the generic-only writer yet.
9. Retain and review the dual-writer-plus-gate source on the feature branch.
   Leave the production main-only triggers unchanged. Under separate approval,
   create a temporary manual candidate trigger for the isolated image-only
   config, run it against the exact full source commit, and verify trigger,
   repository, config path, requested and resolved revision, provenance, image
   tag, digest, and scan evidence.
10. Under a separate review, create a temporary candidate-deploy trust path
    whose validation rejects every build and commit except the exact reviewed
    dual-writer image, sets and attests the literal p4 positive opt-in, keeps
    Three Bosses disabled, and requires the non-mutating anonymous HTTP 401
    probe. Verify that temporary trigger exactly, deploy the zero-traffic
    candidate, then route all traffic to it and prove every no-gate revision
    and admitted request has drained; only this freeze-capable dual writer may
    serve as the pre-cutover rollback target.
11. Under another review, use the same pinned candidate-deploy path to deploy
    the freeze-capable dual writer without the p4 positive opt-in. Keep Three
    Bosses disabled, route all traffic to the frozen revision, prove every
    enabled revision and in-flight score request has drained, and require HTTP
    503 `SUBMISSIONS_FROZEN` from the serving revision before rerunning the
    complete reconciliation. Low traffic or a quiet interval is not evidence
    of a write freeze.
12. Deploy the generic-only writer while it remains frozen, route all traffic to
    it, drain every dual-write revision, and require the same exact
    reconciliation again against the still-static legacy column.
13. Revoke operational authorization for further legacy backfills, retire exact
    legacy equality as a cutover gate, verify the generic-authoritative rollback
    candidate, and only then deploy an explicitly approved revision with the
    positive opt-in enabled. Once new generic-only scores are accepted, exact
    equality with the stale legacy column is no longer expected.
14. Remove the transitional backfill command, then prove that no
    deployable backend revision, job, operational query, or rollback candidate
    still reads or writes `users.p4_score`. Retain at least one
    generic-authoritative, schema-compatible rollback revision and record a
    fresh named backup plus point-in-time-recovery evidence.
15. Add and separately review a new immutable migration that drops
    `users.p4_score`; do not rewrite the already-applied additive migrations.
    Apply it only after Mike explicitly approves the production contract step.
16. Verify the current p4-Vega submission and leaderboard paths, generic reads,
    migration history, and recovery procedure against the contracted schema.
17. Keep Three Bosses writes disabled. Its backend, browser client, and host
    bridge are prepared, but do not enable them until Unity canonicalizes one
    integer millisecond result for display, score, and transport; the Unity
    caller/receiver and button are connected and tested; and its release,
    ranking, and validation policy is approved.

Transactions must use one acquired MySQL connection; transaction statements
must not be issued through unrelated pooled queries.

For a future generic run submission, the server authenticates and feature-gates
before database work, then starts one transaction and locks the authenticated
`users` row with `FOR UPDATE`. It resolves any existing scoped run, compares the
stored canonical fields and fingerprint, inserts a new ledger row if absent,
and updates the versioned personal best only on strict improvement. The run
stores the original `personalBest` outcome before commit so exact retries return
the same response. Unique constraints remain a final concurrency guard, not the
only serialization mechanism.

## Rollback

- Before generic traffic, the explicit `rollback-empty` operation may remove
  the reviewed schema only after taking write locks and proving both domain
  tables are empty. It atomically drops `game_personal_bests`, `game_runs`, and
  their initial `schema_migrations` history so a clean reapplication is
  possible. It refuses partial, unknown, checksum-drifted, or populated state.
- During dual writes, application code may roll back to the last compatible
  dual-write revision while preserving both domain tables. Once the freeze gate
  enters the rollout, rollback must preserve the required gate state and must
  not restore a no-gate writer. A legacy-only revision makes
  `game_personal_bests` stale and must not receive traffic again until the
  backfill and full reconciliation have rerun.
- A completed historical backfill is not rolled back by deleting imported
  personal-best rows: those rows may already include legitimate dual writes.
  Correct drift by rerunning the monotonic command and reconciliation, or use
  the recorded recovery procedure when data is damaged.
- After generic-only traffic starts, never roll back to a legacy-only or
  dual-write revision: the stale column could produce incorrect `personalBest`
  responses even before it is dropped. Use a retained generic-authoritative,
  schema-compatible revision or a forward fix. Restoring the legacy source of
  truth would first require an explicitly reviewed reverse reconciliation from
  `game_personal_bests`.
- After the column is dropped, old backend revisions are schema-incompatible
  and must never receive traffic. Roll back with a compatible application
  revision or forward fix; recover data into a separate instance from the
  verified personal-best data, backup, or point-in-time state rather than
  assuming the legacy column still exists.
- Freeze score submissions before the final exact reconciliations rather than
  deleting submitted data.
- If data recovery is required, restore the recorded backup or point-in-time
  state into a separate recovery instance first; do not overwrite production
  as the initial response.

## Deferred decisions

- Three Bosses rank thresholds and labels.
- Enabling Three Bosses submission.
- Whether an honor-based authenticated completion time is sufficient for a
  competitive leaderboard or stronger run attestation is required.
- A run-ledger retention policy. Deleting ledger rows without idempotency
  tombstones would make old retries unsafe.
