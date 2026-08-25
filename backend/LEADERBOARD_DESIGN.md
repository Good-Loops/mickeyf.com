# Multi-game leaderboard design

Status: Phase 13.1 contract approved by Mike on 2026-08-24. The sanitized live
schema preflight completed on the same date. On 2026-08-25, Mike approved the
end state in which p4-Vega uses the generic leaderboard storage and the legacy
`users.p4_score` column is retired after a verified cutover. This document does
not authorize a production schema or data change.

The transitional p4-Vega dual-write repository was implemented and verified
locally on 2026-08-25 with unit, rollback, and concurrent MySQL 8.0.31 tests. It
has not been deployed and must not receive traffic until migrations `0001` and
`0002` have been applied and verified on the target database.

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

Planned Three Bosses submissions, once enabled, use `contractVersion: 1`,
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

Before enabling writes, add a dedicated fail-closed limit of ten accepted new
runs per authenticated user per 15 minutes, enforced from the shared database
inside the user-locked transaction. Exact idempotent replays return the stored
result without consuming another accepted-run slot. Retain the general API
limit and add a dedicated per-instance IP ceiling of 30 submission requests per
15 minutes; reevaluate a distributed IP limiter before increasing Cloud Run
scale or treating the leaderboard as competitive infrastructure.

## Frontend route contract

- `/leaderboard` redirects to `/leaderboard/p4-vega` for backward-compatible
  navigation.
- `/leaderboard/:gameId` is the direct-linkable selected game state.
- The selector is populated from the server catalog rather than a separate
  client-owned ranking configuration.
- Each selected game owns its loading, empty, success, and error state. A
  failure for one game does not erase a previously loaded result for another.
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
   idempotency.
5. Backfill every non-null legacy value into `game_personal_bests`, even if an
   old stored value does not satisfy today's client validator.
6. Wait for old Cloud Run revisions to drain, then rerun the monotonic,
   idempotent backfill to close the rolling-deployment window.
7. Reconcile with server-side missing, extra, and mismatched-row joins plus
   counts, minimum, maximum, and sum. Do not export player identities.
8. Add the generic read API and the direct-linkable multi-game frontend. Switch
   the existing p4-Vega `submit_score` and `get_leaderboard` implementations to
   `game_personal_bests` without changing their request or response contracts.
9. Stop writing `users.p4_score`, drain every dual-write revision, observe the
   cutover, and rerun the complete reconciliation against the now-static legacy
   column.
10. Prove that no deployable backend revision, job, operational query, or
    rollback candidate still reads or writes `users.p4_score`. Retain at least
    one schema-compatible rollback revision and record a fresh named backup plus
    point-in-time-recovery evidence.
11. Add and separately review a new immutable migration that drops
    `users.p4_score`; do not rewrite the already-applied additive migrations.
    Apply it only after Mike explicitly approves the production contract step.
12. Verify the current p4-Vega submission and leaderboard paths, generic reads,
    migration history, and recovery procedure against the contracted schema.
13. Keep Three Bosses writes disabled until its release and validation policy is
    approved.

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
- During dual writes, application code may roll back to the last dual-write
  revision while preserving both domain tables. A legacy-only revision makes
  `game_personal_bests` stale and must not receive traffic again until the
  backfill and full reconciliation have rerun.
- After writes to `users.p4_score` stop, never roll back to a legacy-only
  revision: the column is stale even before it is dropped. Prefer the last
  schema-compatible dual-write revision or a forward fix. Restoring the legacy
  source of truth would first require an explicitly reviewed reverse
  reconciliation from `game_personal_bests`.
- After the column is dropped, old backend revisions are schema-incompatible
  and must never receive traffic. Roll back with a compatible application
  revision or forward fix; recover data into a separate instance from the
  verified personal-best data, backup, or point-in-time state rather than
  assuming the legacy column still exists.
- Disable new routes before reconciliation rather than deleting submitted data.
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
