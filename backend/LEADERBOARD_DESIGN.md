# Multi-game leaderboard design

Status: Phase 13.1 contract approved by Mike on 2026-08-24. The sanitized live
schema preflight completed on the same date. On 2026-08-25, Mike approved the
end state in which p4-Vega uses the generic leaderboard storage and the legacy
`users.p4_score` column is retired after a verified cutover. The additive
production schema and an initial p4-Vega data seed were applied and verified on
2026-08-26. The exact frozen dual writer still serves 100% of production
traffic, its former enabled revision is retired, and the frozen generic-only
candidate is ready at zero traffic. This document records those completed
changes but does not authorize the generic read/write traffic cutover,
legacy-column removal, or another production mutation.

Production now contains `schema_migrations`, `game_runs`, and
`game_personal_bests` alongside `users`. The initial seed and the later
post-drain backfill both reconcile the same five p4-Vega personal bests exactly;
`game_runs` is empty and `users.p4_score` is unchanged. The frozen dual writer
serves 100% of production traffic, the generic-only candidate has zero traffic,
and no reader cutover has run.

The transitional p4-Vega dual-write repository was implemented and verified
locally on 2026-08-25 with unit, rollback, and concurrent MySQL 8.0.31 tests. It
now serves in the exact frozen production revision recorded below; its former
enabled revision is retired. Migrations `0001` and `0002` are applied and
verified, and the remaining generic-only cutover stages stay gated on separate
review.

The transitional read split was corrected and reverified on 2026-08-26 at
`a127beac14c2662648c8aededa59374f5d7c87dd`. That split still describes the
serving frozen dual-writer revision: its legacy `/api/users` operation reads
`users.p4_score`, while the additive route reads `game_personal_bests`. The
legacy-only and enabled dual-writer drains, post-drain backfills, and
zero-discrepancy reconciliations have completed.

The generic-authoritative p4-Vega writer was prepared and verified locally on
2026-08-26. It holds the shared per-user submission lock, compares the generic
score, and writes only a strict improvement to `game_personal_bests`; it never
reads or writes `users.p4_score`. The legacy
HTTP request and response remain unchanged. The active feature branch now uses
that repository and one generic reader for both HTTP APIs. A disposable MySQL
test physically drops the legacy column before successfully submitting and
reading a score. Type-checking, 125 unit and security tests, 42 isolated MySQL
integration tests, the production bundle, and image-only Cloud Build contract
tests pass. This source is deployed only as the ready, frozen, zero-traffic
candidate recorded below. It has not been activated and does not authorize the
remaining production cutover sequence; production remains on the frozen dual
writer.
The generic-only runtime fixture also creates `users` without the legacy column
and proves both game repositories under the restricted application identity.

On 2026-08-26, detached worktrees verified historical dual-write base
`0dbe3fb8` plus the seven storage-independent freeze-gate changes from
`e8e1faeb`, excluding generic-authoritative writer `2e3d4fde`. Backend
type-check, 84 unit tests, 10 migration tests, 6 dual-write integration tests,
7 backfill/reconciliation tests, the production bundle, 14 frontend tests, and
the frontend build passed. The checks proved frozen requests stop before
database acquisition and enabled requests retain the dual writer's rollback
and concurrency guarantees.

The same composition is retained on `feature/new-leaderboard` at exact commit
`5abdc5bb1ee0a0fb947e7bb1024cec8e68438f64`. It is not an approved main-branch
source, but its exact image was separately approved for the enabled production
dual-writer phase. The enabled and frozen revisions are recorded below.

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
persistence. The canonical main-only Stage B trigger has not run or changed.
The separately approved feature-branch trust path recorded below deployed and
verified the equivalent frozen configuration at zero traffic before its later
separately approved production promotion.

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

The approved image-only build
`9a6066b4-4f34-422b-ba33-83d6b0e9a9eb` resolved exact commit
`5abdc5bb1ee0a0fb947e7bb1024cec8e68438f64` and produced immutable digest
`sha256:895c37a932be08721d5977c07577fc7503ae84eed75eb429bccb306fcb061aeb`.
Artifact Analysis finished successfully with continuous scanning active and no
vulnerability occurrences. The signed SLSA v1 occurrence binds the exact
commit, image-only build, trigger, Google-hosted builder, and digest. Mike
explicitly accepted the documented Node 22.23.2 embedded-OpenSSL 3.5.7 bounded
reachability assessment for the zero-traffic candidate. The later explicit
enabled and frozen dual-writer promotion approvals extended that bounded
acceptance only to those exact revisions and digest, not to a future
generic-only image.

Approved one-shot deploy build
`cf494f1b-3842-4150-ba07-59e2176ca752` used config SHA-256
`84859552914f45c5b8b7907ccc66186445802a7ec2a605660ec3b3173ec58bdf`.
It revalidated the exact build, signed provenance, scan, severity policy,
runtime identity, secret references, resources, positive-traffic snapshot, and
environment before creating revision
`mickeyf-org-build-9a6066b44f34422bba3383d6b0e9a9eb` at zero traffic with
`P4_VEGA_SCORE_SUBMISSIONS_ENABLED=true` and
`THREE_BOSSES_RUN_SUBMISSIONS_ENABLED=false`. The anonymous HTTP and database-
read smoke suite passed, including the required p4 401 `UNAUTHORIZED` response
with no-store and no cookie. The temporary tag and deploy trigger were deleted
immediately afterward. Under separate approval, Cloud Run generation 115 routed
100% to this revision. The legacy-only revision was retired and drained, the
repeatable backfill and aggregate reconciliation again reported five exact rows
with every discrepancy count at zero, and the temporary maintenance database
identity was deleted. The legacy reader and `users.p4_score` remain active.

Approved one-shot frozen-candidate build
`c5daa935-39a9-43fb-a7b3-b50cedfbfe25` used config SHA-256
`e9c320e653a4b76cd265bc1470cd92e72fa0253880b07b3115d0a8c8a4f73ebf`
and the same source commit, provenance, and image digest. It created revision
`mickeyf-org-freeze-9a6066b44f34422bba3383d6b0e9a9eb` at zero traffic with
both submission flags false. All eight validation, deployment, attestation, and
smoke steps passed: p4 submission returned HTTP 503 `SUBMISSIONS_FROZEN`, both
p4 reads returned the same five rows, and Three Bosses submission returned HTTP
403 `SUBMISSION_DISABLED`. The temporary tag and deploy trigger were deleted.
At Cloud Run generation 117, production still routed 100% to
`mickeyf-org-build-9a6066b44f34422bba3383d6b0e9a9eb` with no tags, while the
frozen revision remained retired at zero traffic.

Under the next separate approval, an etag-bound traffic-only update advanced
Cloud Run to generation 118 and routed both specified and observed traffic
exactly 100% to the frozen revision with no tag or `LATEST` target. Cloud Run
reported the enabled revision `Active=False` with its infrastructure retired.
A unique logged production probe reached the frozen revision and returned HTTP
503 `SUBMISSIONS_FROZEN` with `no-store`, no cookie, and no redirect; both p4
reads still returned five rows, and Three Bosses remained HTTP 403. Two
consecutive aggregate `INNODB_TRX` samples found zero active runtime
transactions before exact read-only reconciliation reported source and target
count 5, minimum 190, maximum 410, sum 1350, five matches, and every discrepancy
count zero. The temporary PROCESS-capable identity was deleted, and no Cloud SQL
operation, temporary trigger, or build remains pending.

The repeatable, privileged p4-Vega historical-backfill CLI and read-only
aggregate reconciliation command were implemented and verified locally on
2026-08-25. The separately approved initial production seed is recorded below;
the tooling does not authorize a read cutover or removal of `users.p4_score`,
and each later production step retains the approval and evidence gates below.

The generic p4-Vega `get_leaderboard` implementation is now the active local
reader for both APIs without changing the legacy request or response contract.
It is deployed only in a frozen zero-traffic revision and has not been activated
in production. The additive schema, enabled dual-writer rollout, legacy-only
revision drain, frozen dual-writer promotion, post-drain reconciliations, and
generic-only zero-traffic verification are complete; production activation
remains gated on traffic promotion and the later cutover checks. The legacy
column removal is a later separately approved step; the multi-game frontend
slice is recorded below.

The exact frozen generic-only candidate source was reviewed on 2026-08-26 at
commit `e91d3b1177932614c22fbed059a42a05fcb10793`, tree
`1537b61c94edf194edcde47aeda48ba651e0ea96`. The remote feature branch matched
that commit. The image-only configuration and Dockerfile SHA-256 values are
`dccd0bcf976c77abb3e9fa6d39c1ae855ff127fbf4ec67efd3480e20a4afcda4` and
`0754bb3eee99f647f536b682e056dfa6b40ac030700d9c01d754c7bc606f6ac9`,
respectively. The production bundle contains no legacy `users.p4_score` SQL;
type-checking, 133 unit/security tests, 43 disposable MySQL 8.0.31 integration
tests, the bundle, and all three candidate-contract tests passed.

A read-only live preflight still found generation 118 serving only frozen
dual-writer revision
`mickeyf-org-freeze-9a6066b44f34422bba3383d6b0e9a9eb`, with both submission
flags false and the enabled sibling retired. No Cloud Build or Cloud SQL
operation was active. Cloud SQL remained runnable on MySQL 8.0.31 with backups,
binary logging, and seven-day transaction-log retention. The persistent
approval-required feature trigger still exposes only the image build; no
temporary deployment trigger exists.

With explicit approval, image-only build
`d5aee625-983b-4daf-a90d-0db9898341e8` completed successfully for the exact
requested and resolved revision
`e91d3b1177932614c22fbed059a42a05fcb10793`. Its full-length commit tag
independently resolves to immutable digest
`sha256:3bba5ca29a474c6b75d92f48f93a9efc6cfa3fe32d3a4ddb7b82f2a610baaa48`.
Artifact Registry reports SLSA build level 3; signed in-toto SLSA v1 provenance
binds the digest to the build ID, approval-required image-only trigger,
Google-hosted builder, and source commit. Artifact Analysis finished successfully
with continuous analysis active and OS, NPM, and secret analysis complete. It
reported zero vulnerability occurrences, including zero HIGH or CRITICAL
effective-severity findings. The locked production dependency install also
reported zero `npm audit` findings. The build did not deploy: Cloud Run remained
at generation 118 with 100% traffic on the frozen dual-writer revision, and no
revision, traffic, database, grant, trigger, or IAM mutation was requested or
executed.

The exact source-less one-shot package is tracked as
`cloudbuild.generic-only.deploy.json`. Its initial reviewed form had SHA-256
`8afde577fbefe781ed0a0c428f04dad40a5b8f8d147f22f01ccbae86bb9a5bf4`, but Cloud
Build deferred template validation until approval and then rejected ordinary
Bash `$VARIABLE` references. Pending build
`4b6b5c99-e950-4436-a009-4744b77aea8f` never started and was cancelled; its
temporary trigger was deleted. The package now uses Cloud Build's required `$$`
literal-dollar escape. Decoding that escape produces the exact original runtime
commands, and a regression test enforces paired dollars. The corrected package
SHA-256 is
`a5cd6534c766ecfb9dd9f8440a5c8a7ef709828ee7281ed122ea4952a7c4936d`, and all
eight contract tests pass.

With explicit approval, corrected source-less build
`02eb1328-8b12-4b3b-bb0c-c9ef79f4a3a9` ran all eight pinned validation,
deployment, attestation, and smoke steps successfully. It revalidated the exact
source build, approval, SLSA v1 provenance, continuous OS/NPM/secret analysis,
and zero vulnerability occurrences before creating only revision
`mickeyf-org-freeze-d5aee625983b4dafa90d0db9898341e8` at zero traffic from the
exact digest. The revision uses the reviewed runtime identity, resources,
numeric secret references, and both submission flags false. The anonymous smoke
suite proved the catalog, generic p4-Vega board, empty Three Bosses board,
unknown-game response, frozen p4 submission, disabled Three Bosses submission,
and identical legacy/generic p4 rows. Production remained 100% on
`mickeyf-org-freeze-9a6066b44f34422bba3383d6b0e9a9eb`. The public temporary
tag and one-use trigger were deleted immediately; final generation 120 has no
tag or ongoing build. No traffic promotion, database, migration, grant, IAM, or
submission-state change occurred.

The refreshed OpenSSL review found byte-identical Dockerfile, lockfile, pinned
Node base, first four OCI layers, and Node installation layer
`sha256:efbef6f9e333972a10ca323e700496a64e7ddcc3a6725e6afbbae52e690f4a4`
between the previously accepted image and this candidate; both declare Node
22.23.2. Only test/maintenance package scripts changed, and no affected QUIC,
DTLS, CMP, CMS, RPK, or one-shot `EVP_Cipher()` path was added. The technical
reachability evidence therefore transfers at the embedded-component boundary,
but the clean Artifact Analysis result does not scan Node's embedded OpenSSL
3.5.7. OpenSSL 3.5.8 is fixed upstream but not yet present in a released Node 22
build. Mike explicitly accepted the bounded embedded-component risk for this
exact digest and zero-traffic stage. The build passed the two-hour source
freshness gate before its `2026-08-26T23:06:14Z` deadline; the gate was not
relaxed.

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
isolated MySQL integration tests passed. These routes are deployed in the
serving revision, but Three Bosses submissions remain inactive because
`THREE_BOSSES_RUN_SUBMISSIONS_ENABLED=false`; the Unity submission bridge also
remains disconnected.

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
separately approved maintenance credential is supplied only for the reviewed
operation; the runtime identity receives no DDL permission. The runner uses a
database advisory lock so two deploys cannot apply migrations concurrently.
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
against disposable MySQL 8.0.31. Its completed production application is
recorded below; any later schema change remains separately reviewed and
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

The backfill runs only through the fixed CLI operation and its independently
approved action gate. Supply one approved maintenance credential through
`MIGRATION_DB_*`, clear it immediately afterward, and reduce the runtime account
to reviewed DML before candidate deployment. No trigger, view, generated
column, index, or foreign key is added around `users.p4_score`, so the later
contract migration can remove the column cleanly. The transitional command
must itself be removed or disabled, and included in the no-reference proof,
before that drop is approved.

## Completed live metadata preflight

The approved read-only preflight on 2026-08-24 confirmed:

- Cloud SQL runs MySQL `8.0.31-google` as a regional high-availability
  instance with deletion protection, encrypted-only transport, eight retained
  successful backups, binary logging, and seven-day point-in-time recovery;
- database defaults are `utf8mb4` and `utf8mb4_unicode_ci`, transaction
  isolation is `REPEATABLE-READ`, strict SQL modes are active, and foreign-key
  and unique checks are enabled;
- `users` was the only application table at the time and used InnoDB;
- `users.user_id` is `INT NOT NULL AUTO_INCREMENT PRIMARY KEY`, while
  `user_name`, `email`, and `user_password` are non-null `VARCHAR(255)` values
  and `p4_score` is a nullable `INT`;
- `email` is unique, but `user_name` is not schema-enforced unique, so every
  new relationship must use immutable `user_id` rather than display names;
- no foreign keys, `CHECK` constraints, triggers, migration-history table, or
  leaderboard tables existed at the time; and
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

The inspected application database account had broad DDL and DML privileges
through Cloud SQL's `cloudsqlsuperuser` role. Before candidate deployment, that
role was removed and only the reviewed runtime DML was retained. Production
migration commands require an explicitly approved maintenance credential; a
separate maintenance identity is preferred, and any one-time reuse of the
current credential is an explicit exception followed by immediate local
clearing. Future runtime privilege changes remain separately reviewed.
Credential changes and privilege revocation require
their own reviewed approval. The preflight made no database, configuration, or
repository change and returned the local proxy to its original stopped state.

The exact generic-only column-level runtime manifest now lives in
`ts/security/runtimeGrantManifest.ts`. It grants `users` only the auth columns
required for `SELECT` and signup `INSERT`, with no `p4_score` access and no
`UPDATE` privilege. `game_runs` and `game_personal_bests` retain only their
required narrow `SELECT`, `INSERT`, and personal-best `UPDATE` columns. It
grants no access to `schema_migrations`, no `DELETE`, DDL, role, administrative
privilege, or grant option. A redundant `game_runs SELECT ... FOR UPDATE` was
removed because the shared application lock already serializes every
submission for that user; the immutable ledger therefore needs only `SELECT`
and `INSERT`.

The pinned MySQL 8.0.31 integration suite installs the manifest on a separate
disposable runtime identity and a physical `users` table without `p4_score`. It
exercises every current auth and leaderboard SQL path, compares the exact column
inventory, and proves that user-row `FOR UPDATE`, migration history, ledger
mutation, destructive DML, DDL, account creation, and grant operations are
denied. This test evidence did not itself change live grants; the earlier
approved production reduction used the previous transitional manifest.
Do not improvise replacement grants. After maintenance,
drop and verify removal of an ephemeral account; if the account is deliberately
persistent, rotate its credential and govern it as a standing administrator.

The local reduction workflow now exposes `runtime-grants:plan`,
`runtime-grants:verify`, and `runtime-grants:apply`. It inventories the exact
account across hosts, lock/password-expiration/partial-revoke state, raw static
and dynamic global privileges, every schema/table/column/routine scope, both role directions,
default roles, both proxy directions, mandatory-role configuration, server
identity, and the manifest's required physical columns. The deterministic plan
also contains the exact `cloudsqlsuperuser@%` to no-database-roles transition
and `noted-reef-387021:us-central1:cms-mickeyf` target. The server UUID observed
through that production proxy is independently pinned, and effective `PROCESS`
access is proved before any zero-session result is trusted. Any unexpected direct
privilege, grant/admin option, role, proxy edge, account flag, server version,
or metadata gap blocks with no operation; the workflow does not act as a
general privilege cleaner.

The separate `runtime-grants:p4-retirement:plan`, `:verify`, and `:apply`
commands handle only the final two legacy column grants. A plan is actionable
only when the account has no role and its direct privileges are exactly the
generic-only manifest plus non-grantable `SELECT (p4_score)` and
`UPDATE (p4_score)` on `users`; the already-retired exact manifest is an
idempotent no-op. Any partial pair or unrelated drift blocks with no operation.
Apply binds the deterministic plan digest and pinned server UUID, requires the
exact Cloud SQL and frozen generic-only confirmations, proves zero runtime
sessions under effective `PROCESS`, and invokes one exact combined `REVOKE`
without `IF EXISTS`. It then performs a fresh complete metadata inspection.
Invocation or post-write verification uncertainty is reported as
indeterminate, never silently retried. The disposable MySQL 8.0.31 test proves
active-session refusal, exact retirement, loss of `p4_score` access, final
manifest compliance, and repeat-apply idempotency. This tooling was not run
against production when committed.

An approved apply first proves effective `PROCESS` access and zero open
`cms_mickeyf` sessions, before any grant write. It grants and proves the complete
direct manifest, clears only the reviewed default role, and repeats the same
session proof immediately before asking Cloud SQL to replace the account's
database-role list with an empty list. Project, instance, connection name, role
transition, plan digest, server UUID, runtime account, maintenance account, database, loopback
target, and traffic drain all have separate exact confirmations. The Cloud SQL
instance is described and matched before MySQL is opened, while the MySQL server
must match the pinned production UUID. Apply refuses while any Cloud SQL operation
is unfinished and repeats that check just before explicit synchronous
`gcloud sql users assign-roles` arguments with no ambient project and no
`--async`. Final success requires a fresh metadata inspection with only the
manifest and no assigned/default role.

These account-management statements are not one transaction. An interruption
before control-plane role removal leaves the deliberately recoverable prepared
state: exact direct grants are present and the broad role still exists, although
default activation may already be cleared. A timeout or abort makes the external
outcome indeterminate; inspect Cloud SQL operations and re-plan before retrying.
Traffic must remain drained through the operation because an already-open session can
retain active role state; afterward, recycle every application pool and run
fresh-connection positive and negative probes. The local implementation and
disposable MySQL 8.0.31 tests changed no production privilege.

The separately approved production reduction completed on 2026-08-26. With
traffic drained, the apply removed every database role from `cms_mickeyf@%`
and retained only the manifest's non-grantable column privileges. Fresh
revision `mickeyf-org-grants-restored-20260826-a` then received 100% traffic on
immutable image digest
`sha256:babde939969cc17db89c2138a55f692cef65cc1ab2d2e20de1b06179a456d5c1`.
Standalone verification recorded digest
`0565e5d5532e115d3b4142efcad4c63ed665effc7f838147c8d42a11f177fe7a`;
fresh positive and negative SQL probes passed, public and local leaderboard
reads remained healthy, and no temporary database user, maintenance revision,
or pending Cloud SQL operation remained. The reviewed transitional runtime
least-privilege blocker is closed.

The local generic p4 writer and Three Bosses now serialize with one shared,
database-scoped per-user advisory lock acquired before the transaction. It is
released after commit or rollback; any indeterminate lock or rollback state
destroys the session so a pooled connection cannot retain an uncertain lock.
This removes both `users SELECT ... FOR UPDATE` dependencies without adding a
table, migration, or artificial user-column grant. Removing `p4_score` from the
source manifest does not itself retire the older live grants: the current
planner correctly blocks unexpected privileges rather than revoking them, so
the separately reviewed retirement workflow must still be approved and run
only after the frozen generic-only deployment and drain evidence.

This evidence satisfied the metadata gate for the exact SQL and isolated local
migration tests completed on 2026-08-25. That preflight did not by itself
authorize production DDL, backfill, credential rotation, or deployment.

## Completed production additive schema

On 2026-08-26, the exact schema from commit `abd6ff9d` was applied through the
authenticated loopback proxy to
`noted-reef-387021:us-central1:cms-mickeyf`, database `cms`. On-demand backup
`1787754667930` completed successfully first, with binary logging and seven-day
transaction-log retention verified. Immediately before DDL there were no
active transactions, metadata-lock waiters, in-use tables, or Cloud SQL
operations.

The runner recorded the reviewed migrations and SHA-256 checksums:

- `0001_create_game_runs`:
  `9A797EDD514DFC946783CF66CF80EE8DFA774210A0D100946C3A9A822596CA00`;
- `0002_create_game_personal_bests`:
  `01EADE4CFC8E1131BE79DF43881A9BC7A538AAF0E1E1D3F470DEB6C21EAAED3A`.

Post-apply planning reported both versions applied with nothing pending or
recoverable. The three new tables use InnoDB and `utf8mb4_unicode_ci`;
immediately after this schema step both domain tables contained zero rows.
`users.p4_score` remained nullable `INT`, and the aggregate-only source evidence
remained seven users, five scored rows, minimum 190, maximum 410, and sum 1350.
No trigger, backfill, deployment, credential change, rollback, or destructive
migration was performed during this step. The runtime `cloudsqlsuperuser`
finding remains; the exact manifest and isolated verification were completed
later on the feature branch without changing production privileges.

## Completed initial production p4-Vega seed

On 2026-08-26, the separately approved initial seed ran from commit `87ab4954`
after on-demand backup `1787755849821` completed successfully. The exact proxy,
database, resolved account, schema history, checksums, table shapes, and legacy
source shape were reverified before the data action. The pre-seed reconciliation
reported five missing rows and no other anomaly.

The monotonic backfill processed one chunk and reused
`0002_create_game_personal_bests.applied_at` as the single historical
`recorded_at`. A separately authorized read-only reconciliation then reported
source and target count 5, minimum 190, maximum 410, sum 1350, five exact
matches, and zero missing, mismatch, extra, metadata, run-ledger, or unexpected
rules-version counts. `game_runs` remained empty, `users.p4_score` remained a
nullable `INT`, and the seven-user source aggregates were unchanged.

This is an initial point-in-time seed, not cutover evidence. The serving
production revision returned HTTP 401 rather than the freeze gate's 503 for an
anonymous score-submission probe, proving production remained unfrozen. No
freeze-capable dual-writer deployment occurred in this task. A complete
backfill and exact reconciliation remain mandatory after that writer is
deployed and all legacy-only revisions and in-flight requests have drained. No
API deployment, traffic change, privilege change, trigger, column drop, or
reader/writer cutover occurred in this step.

Under later separate approval, the exact dual-writer revision
`mickeyf-org-build-9a6066b44f34422bba3383d6b0e9a9eb` received 100% traffic.
Every legacy-only revision was retired and drained before the repeatable
backfill and independent reconciliation ran again. Source and target each had
five rows, minimum 190, maximum 410, sum 1350, five exact matches, and zero
missing, extra, score, metadata, run-ledger, or rules-version discrepancies.
The temporary maintenance database identity was then deleted. This is the
completed enabled dual-writer checkpoint, not the generic read/write cutover;
`users.p4_score` remains present and authoritative for the legacy reader.

## Expand, backfill, and cutover

1. Use the versioned, checksum-recorded `mysql2` migration runner with its
   dedicated migration configuration and an approved maintenance credential.
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
5. With the approved maintenance credential and dedicated action confirmation,
   run the repeatable monotonic p4-Vega backfill. Copy every
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
   tag, digest, and scan evidence. **Completed on 2026-08-26 for exact commit
   `5abdc5bb1ee0a0fb947e7bb1024cec8e68438f64`.**
10. Under a separate review, create a temporary candidate-deploy trust path
    whose validation rejects every build and commit except the exact reviewed
    dual-writer image, sets and attests the literal p4 positive opt-in, keeps
    Three Bosses disabled, and requires the non-mutating anonymous HTTP 401
    probe. Verify that temporary trigger exactly, deploy the zero-traffic
    candidate, then route all traffic to it and prove every no-gate revision
    and admitted request has drained; only this freeze-capable dual writer may
    serve as the pre-cutover rollback target. **The temporary trust path,
    zero-traffic deployment, smoke suite, tag removal, positive-traffic
    routing, legacy-only drain, repeat backfill and reconciliation, and trigger
    cleanup completed on 2026-08-26.**
11. Under another review, use the same pinned candidate-deploy path to deploy
    the freeze-capable dual writer without the p4 positive opt-in. Keep Three
    Bosses disabled, route all traffic to the frozen revision, prove every
    enabled revision and in-flight score request has drained, and require HTTP
    503 `SUBMISSIONS_FROZEN` from the serving revision before rerunning the
    complete reconciliation. Low traffic or a quiet interval is not evidence
    of a write freeze. **The exact frozen revision, zero-traffic smoke suite,
    tag removal, and trigger cleanup completed on 2026-08-26 in build
    `c5daa935-39a9-43fb-a7b3-b50cedfbfe25`. Generation 118 positive-traffic
    routing, enabled-revision infrastructure retirement, serving freeze proof,
    two zero-transaction samples, exact reconciliation, and temporary identity
    cleanup also completed on 2026-08-26.**
12. Deploy the generic-only writer while it remains frozen, route all traffic to
    it, drain every dual-write revision, and require the same exact
    reconciliation again against the still-static legacy column. With no old
    writer or pooled session remaining, run the separately approved exact
    column-grant retirement, recycle the generic-only runtime pool, and verify
    the fresh restricted identity exactly matches the source manifest before
    enabling submissions. **The frozen generic-only zero-traffic deployment,
    smoke suite, tag removal, and trigger cleanup completed on 2026-08-26 in
    build `02eb1328-8b12-4b3b-bb0c-c9ef79f4a3a9`. Production traffic remains
    100% on the frozen dual writer; promotion, drain, reconciliation, and grant
    retirement remain pending.**
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

For a generic run submission, the server authenticates and feature-gates before
database work, acquires the shared per-user submission lock, and then starts one
transaction. It resolves any existing scoped run, compares the
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
