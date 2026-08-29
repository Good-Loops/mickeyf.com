# Multi-game leaderboard design

Status: Phase 13.1 contract approved by Mike on 2026-08-24. The sanitized live
schema preflight completed on the same date. On 2026-08-25, Mike approved the
end state in which p4-Vega uses the generic leaderboard storage and the legacy
`users.p4_score` column was retired after a verified cutover. The additive
production schema and an initial p4-Vega data seed were applied and verified on
2026-08-26. The verified p4-enabled generic-only revision now serves 100% of
production traffic; the exact frozen generic-only revision remains ready at
zero traffic as its schema-compatible rollback. The exact legacy column grants
are retired. The frozen dual writer is therefore no longer a valid rollback
target. This document records the completed traffic cutover, grant retirement,
checksum-recorded column removal, and p4-Vega submission activation.

Production now contains `schema_migrations`, `game_runs`, and
`game_personal_bests` alongside `users`. The initial seed and the later
post-drain backfill and frozen generic-only cutover reconciliations all match the
same five p4-Vega personal bests exactly; `game_runs` is empty and
`users.p4_score` has been removed. The
p4-enabled generic-only revision serves 100% of production traffic, and the
frozen generic-only rollback and drained dual writer have zero traffic.

The transitional p4-Vega dual-write repository was implemented and verified
locally on 2026-08-25 with unit, rollback, and concurrent MySQL 8.0.31 tests.
Its exact frozen revision and former enabled revision are retired and no longer
schema-compatible. Migrations `0001`, `0002`, and `0003` are applied and
verified. p4-Vega submission activation completed under separate review;
Three Bosses submission remains disabled.

The transitional read split was corrected and reverified on 2026-08-26 at
`a127beac14c2662648c8aededa59374f5d7c87dd`. That split now describes the
retired rollback-compatible frozen dual writer: its legacy `/api/users`
operation reads `users.p4_score`, while the additive route reads
`game_personal_bests`. The legacy-only, enabled dual-writer, and frozen
dual-writer drains and their zero-discrepancy reconciliations have completed.

The generic-authoritative p4-Vega writer was prepared and verified locally on
2026-08-26. It holds the shared per-user submission lock, compares the generic
score, and writes only a strict improvement to `game_personal_bests`; it never
reads or writes `users.p4_score`. The legacy
HTTP request and response remain unchanged. The active feature branch now uses
that repository and one generic reader for both HTTP APIs. A disposable MySQL
test physically drops the legacy column before successfully submitting and
reading a score. Type-checking, 125 unit and security tests, 42 isolated MySQL
integration tests, the production bundle, and image-only Cloud Build contract
tests pass. This source now serves as the exact generic-only production image
recorded below. Its frozen cutover, grant retirement, column removal, and later
p4-Vega submission activation are recorded below.
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
identity was deleted. At that checkpoint, the legacy reader and
`users.p4_score` remained active.

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

The generic p4-Vega `get_leaderboard` implementation is now the active production
reader for both APIs without changing the legacy request or response contract.
It now serves in the frozen generic-only production revision. The additive
schema, enabled dual-writer rollout, frozen dual-writer promotion, and
generic-only deployment are complete, along with every drain and exact
reconciliation required for the frozen generic-only traffic cutover.
Legacy-column grant retirement and column removal are also complete. Submission
enablement remains a later separately approved step. The multi-game frontend
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

The exact source-less one-shot package's initial reviewed form had SHA-256
`8afde577fbefe781ed0a0c428f04dad40a5b8f8d147f22f01ccbae86bb9a5bf4`, but Cloud
Build deferred template validation until approval and then rejected ordinary
Bash `$VARIABLE` references. Pending build
`4b6b5c99-e950-4436-a009-4744b77aea8f` never started and was cancelled; its
temporary trigger was deleted. The corrected package used Cloud Build's required `$$`
literal-dollar escape. Decoding that escape produces the exact original runtime
commands, and a regression test enforced paired dollars. The corrected package
SHA-256 is
`a5cd6534c766ecfb9dd9f8440a5c8a7ef709828ee7281ed122ea4952a7c4936d`; all eight
contract tests passed.

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

The one-shot package was deleted from current source after it completed; its
immutable Cloud Build record and Git history retain the deployment evidence.

## Completed frozen generic-only traffic cutover

On 2026-08-26, under explicit approval, temporary built-in Cloud SQL user
`recon_cutover_215913_8908@%` was created only for reconciliation and drain
inspection through the authenticated loopback proxy. Cloud SQL create-user
operation `92089d9d-e448-4d4d-8350-7c6c00000032` completed successfully, the
connection resolved to database `cms` and that exact account, and its automatic
`cloudsqlsuperuser@%` role was verified. The password remained process-local and
was never written to the repository or output. Before any traffic change, the
read-only reconciliation reported identical legacy and generic aggregates:
five rows, minimum 190, maximum 410, sum 1350, five matches, and zero missing,
score, direction, extra-row, metadata, run-ledger, or rules-version
discrepancies.

A fresh Cloud Run v2 service read verified settled generation and observed
generation 120, the exact candidate digest and frozen environment, explicit
revision-only 100% traffic on the frozen dual writer, and no tag or `LATEST`
target. Etag-bound, traffic-only PATCH operation
`8b0c18a8-805f-494d-97e5-d8523bc10c03` then advanced the service exactly once
to generation 121. The first settled observation at
`2026-08-26T22:04:01.9446033Z` showed specified and observed traffic exactly
100% on
`mickeyf-org-freeze-d5aee625983b4dafa90d0db9898341e8`, still pinned to digest
`sha256:3bba5ca29a474c6b75d92f48f93a9efc6cfa3fe32d3a4ddb7b82f2a610baaa48`.
The service template and both false submission flags were unchanged. The
frozen dual writer remained Ready but became `Active=False`, reason `Retired`.

The nine-request production smoke contract then passed: catalog, generic
p4-Vega, empty Three Bosses, unknown game, unauthenticated state, and legacy
p4-Vega reads were exact; legacy and generic p4-Vega rows were identical; p4
submission returned HTTP 503 `SUBMISSIONS_FROZEN`; Three Bosses submission
returned HTTP 403 `SUBMISSION_DISABLED`; and no checked response set a cookie
or redirected. The drain continued through
`2026-08-26T22:09:16.9446033Z`, 315 seconds after the first settled traffic
observation and beyond the old revision's 300-second request timeout. Two
revision-specific request-log reads at `2026-08-26T22:10:26.7402493Z` and
`2026-08-26T22:12:37.7407309Z` both found zero old-revision request starts from
the traffic observation onward. Two `INNODB_TRX` samples five seconds apart
both found zero active `cms_mickeyf` transactions.

The final read-only reconciliation completed at
`2026-08-26T22:12:52.8700579Z` and exactly repeated the baseline: both stores
had five rows, minimum 190, maximum 410, sum 1350, five matches, and every
discrepancy count zero. The runtime account still had its legacy
`p4_score` `SELECT` and `UPDATE` column privileges; no grant retirement ran.
Cloud SQL backup `1787774400000` completed during the drain before final
reconciliation. Delete-user operation
`34b81b8e-1f0d-4db1-ad39-a3b900000032` then completed successfully, a fresh
user list contained only `cms_mickeyf` and `root`, and a loopback authentication
attempt with the deleted credential failed with `ER_ACCESS_DENIED_ERROR`.
Operator credential environment variables were removed and the PowerShell
session was closed. Final checks found no unfinished Cloud SQL operation,
ongoing build, temporary tag, or one-use deployment trigger.

The retained frozen dual writer was a valid rollback target only while both
legacy `p4_score` column grants remained. The later grant retirement crossed
that boundary, so it must not receive traffic again. This traffic cutover itself
performed none of the later mutations and left `users.p4_score` unchanged.

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
`THREE_BOSSES_RUN_SUBMISSIONS_ENABLED=false`. The Unity caller, receiver, and
browser bridge are connected locally and remain fail-closed behind that gate.

The multi-game frontend slice was implemented locally on 2026-08-26.
The canonical `/leaderboards` page is now a catalog-driven hub of leaderboard
destinations, not a duplicate game launcher. Direct detail routes use the
generic GET API, and p4-Vega no longer reads the legacy `/api/users`
leaderboard operation in the browser. The Three Bosses route renders typed
real rows while its catalog reports ranked and submission-disabled. A strict
cookie-bearing POST client and lifecycle-safe Unity host bridge were committed
at `c4349f7c`; they pass only canonical run metrics, never browser credentials,
and preserve the same identity for uncertain retries. The Unity caller,
receiver, and Submit Score state machine use the same canonical result and only
become available when the server catalog reports enabled. The
old singular frontend route is intentionally not retained because the owner
approved a clean URL change before meaningful public adoption. Generic-only
p4 storage, legacy-column removal, and p4 write enablement are complete. The
Unity submission path is connected locally; only Three Bosses production
activation remains incomplete and separately gated.

## Invariants

- Stable game identifiers are `p4-vega` and `three-bosses`.
- The backend owns validation, score derivation, ranking order, submission
  enablement, and rules versions.
- Existing `submit_score` and `get_leaderboard` requests and their p4-Vega
  response bodies remain compatible throughout the migration, including after
  their storage implementation moves to `game_personal_bests`.
- Existing `users.p4_score` values were preserved until every non-null score was
  backfilled and reconciled. The initial additive migrations did not alter the
  column; immutable migration `0003` dropped it only after the verified cutover
  gates below were satisfied.
- The retired p4-Vega backfill was repeatable operational tooling rather than an
  HTTP endpoint or schema migration. Read-only reconciliation remains inside
  the destructive migration plan for safe replay against the pre-drop backup.
- Three Bosses uses the provisional rules-version-1 S–D rank bands; its
  submission endpoint remains disabled until the remaining release gates are
  approved.
- A player identity always comes from verified authentication, never a client
  supplied user name.

The server-owned catalog in `ts/leaderboards/gameCatalog.ts` defines the
current presentation and ordering policy:

| Game ID | Primary order | Rank state | Submission state |
| --- | --- | --- | --- |
| `p4-vega` | score, descending | not applicable | legacy operation, enabled |
| `three-bosses` | completion time, ascending | S–D time bands | disabled |

Only a strict primary-metric improvement replaces a personal best. An equal
result keeps the existing best and its original recorded timestamp. Equal
leaderboard metrics are ordered by `recorded_at ASC`, then internal `user_id
ASC`. Legacy p4-Vega rows share the migration timestamp, so tied imported rows
fall through honestly to the user-ID ordering. Scores from different games are
never compared.

## New API boundary

The multi-game API is additive rather than extending the operation switch
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
displayed score from that same integer. The server calculates arcade-scale
positive scores as
`max(1, min(2147483647, floor(10000000000 / completionTimeMs + 0.5)))`.
The upper bound preserves the signed `INT` storage contract. Unity and backend parity
vectors are required before writes can be enabled. The server never accepts a
client-provided score or rank for Three Bosses.

Rules version 1 derives rank from the same canonical integer: `< 60,000` ms is
S; `60,000–80,000` is A; `80,001–100,000` is B; `100,001–120,000` is C; and
`> 120,000` is D. Boundary parity tests cover Unity and backend. These bands
remain provisional until public write activation.

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

### Completed p4-Vega historical backfill and retained reconciliation

The historical transfer ran only as an operator CLI operation. It was never
exposed through Express, bundled into the runtime server, or callable by a
browser. It reused the migration connection boundary: dedicated
`MIGRATION_DB_*` credentials, the authenticated loopback Cloud SQL proxy, exact
target confirmation, its own mutation gate, the database advisory lock, bounded
waits, and exact migration-history and table-shape verification.

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

Reconciliation remains a read-only gate. It returns only server-side
aggregate evidence: source and target count, minimum, maximum, and sum, plus
counts for missing rows, extra rows, directional score mismatches, unexpected
p4-Vega completion-time or source-run metadata, run-ledger rows, and rules
versions. It never prints or exports player identities. A cutover-quality
reconciliation succeeds only when every discrepancy count is zero and the
aggregate sets match.

That success was point-in-time database evidence, not proof that a legacy-only
writer could not commit after the snapshot. The completed cutover therefore
recorded the Cloud Run revision drain, in-flight request wait, final post-drain
pass, authenticated proxy target, and pinned Cloud SQL server UUID separately.

The mutating backfill, standalone reconciliation command, and their action gates
were retired after migration `0003`. The aggregate reconciliation logic remains
only as a pre-DDL safety check when planning or replaying the drop against the
fresh pre-drop backup.

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

The final two legacy column grants were retired through a separate, exact,
plan-bound one-time path. After the successful production operation and column
drop, that p4-specific implementation and its tests were removed. The generic
runtime-grant workflow remains and verifies the current least-privilege
manifest without any `p4_score` access.

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
source manifest did not itself retire the older live grants: the general planner
correctly blocked those unexpected privileges rather than guessing how to clean
them up.

The separately approved exact grant retirement completed on 2026-08-26 from
ready-plan digest
`34096d0896b45d4cc827ad71d0a5eee676aed51ab7a8555673f5d26be01065ba`.
Fresh p4 verification reported `retired`, compliant, zero blockers, and digest
`862cdb077448351ba3c9c4bba3ec2c72d558411244be40a178740b9f7f3df498`;
full runtime verification reported `reduced`, compliant, zero blockers, and
digest `9f7cc4bae03325f8969a37d3cfdda8d74b487288f3334801f9853ef77fe6fb043`
on pinned server UUID `d1e6865c-ecad-11ee-a6b0-42010a400002`. A fresh runtime
connection could read `users.user_id`, received
`ER_COLUMNACCESS_DENIED_ERROR` for `users.p4_score`, and remained denied access
to `schema_migrations`. The public catalog, generic and legacy p4 leaderboards,
empty Three Bosses leaderboard, authentication state, unknown-game path, both
submission freezes, no-store headers, and no-cookie/no-redirect constraints all
passed; the five p4 rows still had minimum 190, maximum 410, and sum 1350.

Temporary-user operations `2fffed86-890b-49d4-9869-e1f900000032` and
`3df1c523-bcbe-4d07-b0b2-d1e300000032` completed successfully. The deleted
credential then failed with `ER_ACCESS_DENIED_ERROR`, the final user list
contained only `cms_mickeyf` and `root`, and no Cloud SQL operation or build was
unfinished. Cloud Run remained at generation 121 with 100% traffic on
`mickeyf-org-freeze-d5aee625983b4dafa90d0db9898341e8`; both submission flags
remained false.

## Completed production p4_score removal

On 2026-08-26, commit `388bf6d5` introduced immutable migration
`0003_drop_users_p4_score` with explicit `ALGORITHM=INSTANT`, exact source-shape
and dependency checks, a deterministic reviewed plan, an irreversible-effect
gate, and recovery for completed DDL whose history insert was interrupted.
Ordinary migration apply cannot execute the drop.

The final live plan on pinned server UUID
`d1e6865c-ecad-11ee-a6b0-42010a400002` again found five exact source/target
matches, minimum 190, maximum 410, sum 1350, and zero discrepancy, metadata,
run-ledger, or rules-version counts. On-demand backup `1787787054951` completed
successfully in location `us`; binary logging, Cloud Storage transaction logs,
and seven-day PITR retention remained enabled. Because deferred `main` still
contains the old writer, trigger `main-push-mickeyf-com` was disabled without
changing its repository, branch, filename, included files, or service account.
It must remain disabled until `main` is schema-compatible.

The apply recorded checksum
`bc4c89691d9d2f729977446e1bde8f168c5ee83c95349e80c3a6deec598a2951`
and verified all three migrations applied with nothing pending or recoverable.
The public catalog, generic and legacy-adapter p4 reads, empty Three Bosses
board, unknown-game response, authentication state, both submission freezes,
no-store headers, and no-cookie/no-redirect constraints passed after the drop;
both p4 APIs retained the same five scores. The temporary maintenance account
was deleted and then failed authentication, the Cloud SQL user list again
contained only `cms_mickeyf` and `root`, and no build or Cloud SQL operation was
unfinished. At that checkpoint, submission enablement remained a separate
product decision.

An enabled p4-Vega candidate, `mickeyf-org-p4-enabled-d5aee625`, was then
created at zero traffic from the exact verified digest. Read smoke tests passed,
anonymous p4 submission reached authentication with HTTP 401, and Three Bosses
submission remained disabled with HTTP 403. Its temporary tag was removed. On
2026-08-26, validate-only preflight passed and etag-bound traffic-only operation
`a54a5387-f780-44a9-b38d-d333db988cca` promoted the candidate to 100% at
generation 124. A signed-in game over submitted score 0 with HTTP 200 on that
revision without changing the existing 330 personal best or the five-row board
(minimum 190, maximum 410, sum 1350). The frozen generic-only revision remains
ready at zero traffic; an etag-bound validate-only rollback check passed. The
incompatible `main` trigger remains disabled, Three Bosses remains disabled,
and no build or Cloud SQL operation was unfinished.

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
at that checkpoint, `users.p4_score` remained present and authoritative for the
legacy reader.

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
    writer remaining, run the separately approved exact column-grant retirement
    and verify the restricted identity exactly matches the source manifest
    before enabling submissions. **The frozen generic-only zero-traffic deployment,
    smoke suite, tag removal, and trigger cleanup completed on 2026-08-26 in
    build `02eb1328-8b12-4b3b-bb0c-c9ef79f4a3a9`. Generation 121 promotion, the
    315-second frozen dual-writer drain, repeated zero old-revision request-log
    checks, two zero-transaction samples, exact final reconciliation, and
    temporary-identity cleanup also completed on 2026-08-26. Exact grant
    retirement, runtime SQL probes, public smoke tests, and second temporary-
    identity cleanup completed later the same day. p4-Vega submission activation
    completed under Step 13; Three Bosses remains disabled.**
13. Revoke operational authorization for further legacy backfills, retire exact
    legacy equality as a cutover gate, verify the generic-authoritative rollback
    candidate, and only then deploy an explicitly approved revision with the
    positive opt-in enabled. Once new generic-only scores are accepted, exact
    equality with the stale legacy column is no longer expected. **Legacy
    backfill commands are retired; the exact p4-enabled generic-only revision
    was promoted to 100% at generation 124 on 2026-08-26.**
14. Remove the transitional backfill command, then prove that no
    deployable backend revision, job, operational query, or rollback candidate
    still reads or writes `users.p4_score`. Retain at least one
    generic-authoritative, schema-compatible rollback revision and record a
    fresh named backup plus point-in-time-recovery evidence. **Completed for
    the active production path on 2026-08-26; the incompatible deferred-main
    trigger remains disabled until that branch is updated.**
15. Add and separately review a new immutable migration that drops
    `users.p4_score`; do not rewrite the already-applied additive migrations.
    Apply it only after Mike explicitly approves the production contract step.
    **Completed on 2026-08-26 as migration `0003`.**
16. Verify the current p4-Vega submission and leaderboard paths, generic reads,
    migration history, and recovery procedure against the contracted schema.
    **Completed on 2026-08-26; p4-Vega submissions are enabled and verified,
    while Three Bosses submissions remain disabled.**
17. Keep Three Bosses writes disabled by default. Its backend, browser client,
    host bridge, Unity caller/receiver, canonical score/rank calculation, and
    button state machine are connected and tested. Enable writes only after the
    content-addressed WebGL release, hosted runtime validation, signed-in
    end-to-end run, and explicit production opt-in are approved.

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

- Before generic traffic, an explicit `rollback-empty` operation was available
  only after taking write locks and proving both domain tables empty. It was
  retired, and its implementation removed, once production contained durable
  leaderboard data.
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
- The retained schema-compatible rollback is
  `mickeyf-org-freeze-d5aee625983b4dafa90d0db9898341e8`, ready at zero traffic
  with both submission flags false. Its generation-124 etag-bound validate-only
  rollback check passed without changing live traffic.
- Freeze score submissions before the final exact reconciliations rather than
  deleting submitted data.
- If data recovery is required, restore the recorded backup or point-in-time
  state into a separate recovery instance first; do not overwrite production
  as the initial response.

## Deferred decisions

- Recalibrating the provisional rules-version-1 Three Bosses rank bands after
  observing real completion data.
- Enabling Three Bosses submission.
- Whether an honor-based authenticated completion time is sufficient for a
  competitive leaderboard or stronger run attestation is required.
- A run-ledger retention policy. Deleting ledger rows without idempotency
  tombstones would make old retries unsafe.
