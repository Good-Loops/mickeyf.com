# Multi-game leaderboard design

**Current local storage design (2026-09-08):** permanent personal bests plus
bounded submission receipts now supersede the permanent run-ledger design.
See [Personal bests and bounded submission receipts](RECEIPT_RETENTION.md) for
the authoritative contract, migration 0004/0005, retry semantics and production
activation gates. The dated production passages below remain historical
evidence; this local implementation has not changed live storage or traffic.

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
issues a short-lived signed ticket at normal run start, validates exact
JSON/version/UUID/time/ticket input, derives score server-side,
requires an allowed browser Origin for cookie mutations, serializes immutable
runs and personal bests on one transaction connection, preserves exact replay
outcomes, rejects conflicting reuse, and enforces both database-backed per-user
and per-instance IP limits. Unit, security, rollback, concurrency, and eight
isolated MySQL integration tests passed at the original checkpoint; the Alpha
ticket path later passed ten focused Three Bosses integration tests. These
routes are deployed in the
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
  submission endpoints remain fail-closed until the remaining release gates
  are approved.
- A player identity always comes from verified authentication, never a client
  supplied user name.

The server-owned catalog in `ts/leaderboards/gameCatalog.ts` defines the
current presentation and ordering policy:

| Game ID | Primary order | Rank state | Submission state |
| --- | --- | --- | --- |
| `p4-vega` | score, descending | not applicable | legacy operation, enabled |
| `three-bosses` | completion time, ascending | S–D time bands | runtime-gated |

The p4-Vega completion update accepts scores from 0 through 1000, inclusive,
in increments of 10. The 100th water pickup completes the run without spawning
another hazard; all previously valid 0–990 scores remain accepted. Deploy the
updated backend policy before publishing the client that can submit 1000.
This is score-range validation, not server-side gameplay verification, and
requires no database schema or historical-score changes.

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
- `POST /api/leaderboards/three-bosses/run-tickets` issues an authenticated,
  user/run/version-bound ticket when a normal ranked run begins.
- `POST /api/leaderboards/three-bosses/runs` accepts an authenticated run only
  after Three Bosses submission is enabled and the matching signed ticket is
  valid. p4-Vega continues to write through its legacy operation and has no
  generic run endpoint in version one. The legacy operation keeps its HTTP
  contract while its persistence moves to `game_personal_bests`.

Exact version-one DTOs and mechanical bounds are defined in
`ts/leaderboards/leaderboardContract.ts`. New responses carry
`contractVersion: 1`. Public leaderboard rows contain only `position`,
`userName`, and the game-specific metric fields. They never expose internal
user IDs, run IDs, fingerprints, or timestamps. SQL ordering is selected from
the code-owned game catalog; route input is never interpolated into `ORDER BY`.

Three Bosses submissions, once enabled, use `contractVersion: 1`,
`rulesVersion: 1`, a canonical lowercase RFC 4122 version-four UUID, and an
integer `completionTimeMs` from 10,000 through 86,400,000 inclusive. Before
gameplay, the browser requests a 30-minute HS256 ticket derived from the session
secret with a separate signing context. The ticket stays in memory and binds
the authenticated user, run ID, contract, rules, issuer, audience, purpose,
exact start time, and exact expiry. Submission verifies that the reported
active-combat time does not exceed elapsed wall time beyond a 2.5-second
issuance tolerance. This blocks fabricated instant runs and cross-user/run
reuse, but is deliberately not described as server-authoritative anti-cheat.

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
| Ranked-run ticket is issued | 201 | signed ticket and exact expiry |
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
and one dedicated per-instance IP ceiling permits 30 combined ticket and
submission requests per 15 minutes. Reevaluate a distributed IP limiter before
increasing Cloud Run scale or treating the leaderboard as competitive
infrastructure.

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

The 2026-09-07 retention check found the manual pre-drop backup
`1787787054951` and pre-backfill/additive snapshots still available, so their
guarded legacy replay path remained necessary then. On 2026-09-12 the owner
approved their permanent retirement after verifying a current-schema replacement
restore. Those named historical restore paths are now retired; see the
[completed retirement set](#backup-retirement-approval-set--2026-09-12-utc).
Keep immutable migrations and checksums. Any removal of obsolete operational
commands belongs in the focused code-cleanup review, not this backup operation.

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

The exact generic-only runtime manifest now lives in
`ts/security/runtimeGrantManifest.ts`. It grants `users` the auth columns
required for `SELECT` and signup `INSERT`, plus read-only `account_uuid`, with
no `p4_score` access and no `UPDATE` privilege. `game_submission_receipts` and
`game_personal_bests` retain their required narrow `SELECT`, `INSERT`, and
personal-best `UPDATE` columns.
The existing-account deletion implementation additionally requires
non-grantable table `DELETE` on exactly those three tables; MySQL has no
column-level `DELETE`. Ownership checks and the transaction constrain deletion
to the authenticated account, with receipts and bests removed before the user.
Identity-epoch verification also needs `SELECT(version, applied_at)` on
`schema_migrations`, not checksum access or migration writes. There is still no
DDL, role, administrative, grant-option, or schema/global DML access. **These
additional deletion grants are local preparation, not an applied production change.** A separately
approved grant plan/apply/verify is required before deploying self-deletion.

The pinned MySQL 8.0.31 integration suite installs the manifest on a separate
disposable runtime identity and a physical `users` table without `p4_score`. It
exercises auth, leaderboard and transactional account-deletion SQL paths and
compares both exact column and table inventories. User-row `FOR UPDATE` is now
permitted by `SELECT` plus `DELETE`; user-column updates, receipt updates,
migration checksum access/deletion, DDL, account creation and grant operations
remain denied. The deletion assertions must pass in the disposable suite before
the new grant deployment; local tests do not themselves change live grants. The earlier
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
    button state machine are connected and tested. The Alpha candidate also
    requires the signed start ticket described above. Enable writes only after
    the content-addressed WebGL release, hosted runtime validation, signed-in
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

### Deleted-account recovery

**2026-09-14 UTC status: identity migrations 0006–0008 and the reviewed runtime
grants are applied. The independent journal identities are verified and the
read-only deletion audit is provisioned. Existing account/score rows are
unchanged. The website deletion/replay release remains disabled: older
automatic backups/PITR still predate the original identity epoch. See the
dated rollout evidence below; do not repeat the completed restore exercise.**
`ACCOUNT_DELETION_ENABLED` defaults to false in every environment; only the
exact value `true`, production mode, explicit approved journal bucket, and an
independently captured original identity epoch permit runtime activation.
Startup verifies the schema and epoch before listening. Missing router or
journal wiring also fails closed. Valid requests reaching the disabled handler return
`503 ACCOUNT_DELETION_UNAVAILABLE` without database access or cookie changes.
Parsing and rate-limit middleware can still reject requests earlier. Session
verification and logout remain available. This switch prevents accidental
activation on ordinary deployment;
it does not establish recovery safety. Do not enable live self-deletion until
the operational work below and separately approved release/grants are complete.
Local tests inject a fake journal and disposable SQL data; they do not point a
developer's ADC credentials at the production journal.

The current deletion transaction safely removes an account and its scores from
the active database, but restoring an earlier backup would undo that deletion.
A tombstone or outbox in that same database would be rolled back too. In
addition, `users.user_id` is an auto-increment number, not an account-incarnation
identity: a restored allocation state can allow an ID to be reused. Therefore
an ID-only deletion list is insufficient, even if stored outside MySQL.

Recovery design and remaining operational requirements:

1. Use one private Cloud Storage journal independent of SQL backups. Restrict
   runtime access to creating new records, with separate recovery-reader and
   authorized retention-management permissions. Do not make it public, grant
   runtime overwrite/delete access, or introduce a scheduler merely to store
   these records. Record only a schema version, stable opaque account identity,
   deletion action and timestamp; exclude usernames, email, passwords, scores
   and raw request bodies. The adapter writes create-only objects to the approved
   destination using ADC, without an extra service-account key.
   Further permission changes and eventual expiry rules need scoped review.
2. Establish immutable account-incarnation identities before allowing deletion.
   New accounts need distinct identities even when numeric IDs repeat. Preserve
   identity through recovery. For pre-identity snapshots, either verify a minimal
   protected mapping or explicitly retire the affected recovery copies under
   approval; rerunning a random UUID backfill cannot recover original identities.
   Until one of those paths is verified, recovery from such copies stays blocked.
3. After password reauthentication under the shared per-user lock, durably record
   the deletion intent **before** SQL deletion. Wrong passwords and missing
   accounts must never create an intent. Success requires both durable intent
   and confirmed SQL commit. Storage or commit timeouts have uncertain outcomes:
   settle them idempotently, never claim success early or promise cancellation,
   and never discard a durable intent just because SQL rolled back. A confirmed
   intent followed by SQL failure returns `ACCOUNT_DELETION_PENDING`; an uncertain
   upload never permits SQL deletion. The UI also explains that an unconfirmed
   request may already be recorded and retrying does not cancel it. Active-mode
   replay can finish pending intents; it is not scheduled or automatic. Assign
   an operator response procedure before activation so pending requests are not
   left until a future restore.
4. Restore to a separately identified, non-public recovery instance and migrate
   it through the supported schema path. Loopback is not proof of isolation:
   the production Cloud SQL proxy also listens on loopback. Validate the exact
   recovery target and journal lineage/completeness before replay. Reject
   unavailable, malformed, incomplete or unverified stale journal snapshots;
   an empty list is not proof that no deletions occurred.
5. Drain source mutations and establish a final current journal checkpoint before
   cutover. Reapply all applicable intents to the restored accounts and owned
   scores/receipts, verify none remain and preserve unrelated accounts. A replay
   taken while new deletion requests continue is not a final recovery check.
   Rotate `SESSION_SECRET` at cutover to revoke pre-restore sessions and Three
   Bosses run tickets; current tokens rely on numeric IDs. UUID-safe replay alone
   does not revoke them. Keep public access off if any prerequisite fails.
6. Expire records only when an actual recovery-copy inventory proves no supported
   backup, manual export, retained version or lawful hold can resurrect the data.
   Do not implement a blind 30-day journal lifecycle while older manual backups
   remain. This is a minimal anti-resurrection record, not permanent user history.
   Future consent withdrawals/child profiles need their own modeled actions;
   this account-only design does not implement those features.

Focused local acceptance covers storage failures and uncertain
acknowledgements, SQL rollback/commit uncertainty after recorded intent,
repeated replay, numeric-ID reuse, pre-identity backup rejection, unavailable or
partial journals, and an isolated restore that removes only marked accounts.
The identity schema, isolated backup/SQL replay exercise, runtime-grant rollout
and journal identity permissions are verified. Actual writer-upload acceptance,
the old-backup transition and the eventual website rollout remain outstanding.
Keep the release switch off. Manual
operations and older binaries can bypass an HTTP switch; the recovery runbook and deployment
review remain necessary.

#### Activation access review — 2026-09-14 UTC

Read-only cloud checks found the verified manual backup `1789172213271` and
eight successful automatic backups: two after the original identity epoch and
six before it. The earliest PITR point was `2026-09-06T20:25:36.943Z`, still
before the independently pinned epoch `2026-09-12 00:15:39.954172` UTC.
Eight-backup retention, seven-day transaction logs, deletion protection and
connector enforcement remain unchanged. No additional backup was deleted.

The runtime remains `mickeyf-runtime` on the same generation-142 backend
revision with 100% traffic. Journal bucket IAM remains create-only for that
identity and read-only for `ludolume-deletion-recovery`, with seven-day soft
delete. Two bounded access checks identified the outstanding execution paths:

- The existing `runtime-grants:plan` failed closed with `SELECT` denied on
  `mysql.user` for `michel_operator`. No complete plan or approved digest was
  produced. Planning can run online, but needs an explicitly authorized
  maintenance identity with privilege/role metadata visibility and effective
  `PROCESS`; do not broaden the ordinary TablePlus account implicitly.
- An all-version journal listing through the recovery service identity was
  denied at impersonation (`iam.serviceAccounts.getAccessToken`), before
  storage access. This is not evidence that the bucket's reader grant is wrong.
  No impersonation permission, key, job or journal object was created.

The required deletion-related privileges are three table `DELETE` grants plus read-only
`users.account_uuid` and `schema_migrations(version, applied_at)`; only a fresh
live plan can establish which are missing. Obtain scoped approval for the
maintenance and service-identity execution paths before proceeding. Any live
writer probe also needs an approved valid synthetic intent and retention
disposition; an arbitrary test object or immediate soft deletion would make
the strict replay reader reject the journal. Grant apply remains a separate,
plan-bound operation with drained runtime sessions; its planner rejects a
locked runtime account, so the identity-migration locking procedure cannot be
copied unchanged. No runtime grant, deployment or activation occurred.

#### Approved access and audit rollout — 2026-09-14 UTC

The owner approved the maintenance execution paths and completing the backend
preparation. This supersedes the access failures above without broadening the
ordinary TablePlus operator. Temporary SQL maintenance accounts and temporary,
service-account-scoped impersonation bindings were removed after use.

- Actual writer credentials passed `buckets.testIamPermissions` for create only;
  recovery-reader credentials passed get/list only. The strict reader verified
  an empty journal across live/versioned/soft-deleted views. No journal object
  was written; permission checks are not an upload acceptance test.
- The existing grant planner produced reviewed digest
  `e161a22a9ebd4e6d8f6de2adb6e1d259092ed0e9b4b6e8a6c5f7cbfe099cd579`, with
  no blockers, role changes or unrelated privileges. During apply, the local
  backend and receipt Scheduler were paused, the untagged Cloud Run service
  was scaled to zero, and zero runtime/cleanup SQL sessions were verified.
  The runtime account stayed unlocked, as required by the planner.
- Applied only DELETE on `users`, `game_personal_bests` and
  `game_submission_receipts`, SELECT on `users.account_uuid`, and SELECT on
  `schema_migrations(version, applied_at)`. Fresh connections passed permitted
  zero-row probes and rejected UUID updates, migration deletion and checksum
  reads. Verification digest
  `ecfddd0ec1670919b026cb1d0b1f99b552b0ea39388620183730150e3968ede5`
  confirmed the reduced compliant grant set. No application rows changed.
- Restored automatic service scaling, the same 100% serving revision
  `mickeyf-org-ios-origin-a1f3ea43-0910`, the receipt schedule and local backend.
  Service generation advanced from 142 to 144 solely for scaling; the CLI made
  automatic/default service scaling explicit while preserving the revision's
  ten-instance cap. Anonymous leaderboard HTTP readback returned 200.
  Frontend and WebGL development servers were not stopped.
- Created `deletion_audit@cloudsqlproxy~%` directly with no administrator role:
  only UUID and migration-epoch column reads. Fresh probes rejected email,
  score and DELETE access. Its version-pinned Secret Manager password is
  accessible to the recovery reader; that identity also received Cloud SQL
  Client for the job socket. It retains read-only bucket access. No key file
  or secret value was stored in Git, logs or the evidence reports.
- Built reviewed source `64e274e1c72855df0c6c770921d6e680e13f7073` in approved
  image-only build `0c99adb9-028c-461e-bb0a-798618788e7b`. Image digest
  `sha256:23d5cd840582c53bad36855e2e37e92ffd203d20821334480a51d36e4d8779c1`
  passed completed image analysis with no vulnerability occurrences. The
  separate read-only Job uses that digest, not the website's default command.
  Its configuration, schedule and operational outcome are maintained in
  [DELETION_AUDIT.md](DELETION_AUDIT.md).

Non-secret, restricted local evidence is retained under
`%LOCALAPPDATA%\Ludolume\Recovery\identity-20260911`: the September 14
`journal-access`, `runtime-grants`, `grant-drain-before` and `deletion-audit-*`
reports. Keep this recovery evidence; it is not disposable preview output.
The six older automatic backups and pre-epoch PITR range found earlier today
remain a genuine activation gate. Retention, backup protection and existing
deployment-trigger states were not relaxed to bypass it.

#### Deployment contract (prepared; website rollout not performed)

The canonical deployment and frozen renderer now carry an exact deletion
environment contract rather than dropping these settings through `--set-env-vars`.
Omitting deletion pins remains default-off. Enabling requires the literal
approved bucket, original epoch and an enable approval bound to the verified
source commit, source build and image digest. An intentional disable/rollback
requires an equally explicit decision if any current template, serving revision
or tagged revision has deletion enabled; a routine default-off deployment must
not silently disable it. Canonical substitutions are `_ACCOUNT_DELETION_ENABLED`,
`_ACCOUNT_DELETION_JOURNAL_BUCKET`, `_ACCOUNT_IDENTITY_EPOCH` and
`_ACCOUNT_DELETION_APPROVAL`.

Frozen deployment/traffic pins use optional `accountDeletion`: omit for the
safe default, `{ "enabled": false }` for reviewed disabling, or
`{ "enabled": true, "journalBucket": "ludolume-deletion-journal-1012884798546",
"identityEpoch": "2026-09-12 00:15:39.954172" }` for reviewed enabling. The
renderer binds the enable/disable approval to the existing source/image pins;
the environment and step digests are checked again before traffic changes.
Arbitrary extra variables, wrong pins and missing/duplicate settings are rejected.
These checks do not inspect backup age or replace the final operational gate.
No trigger was enabled and no website candidate was deployed for this change.
The service UID/generation is rechecked before deployment, but this is not an
atomic lock against an unrelated console deployment: retain the existing
single-writer release discipline. Old eight-variable frozen candidates no
longer satisfy the exact nine-/eleven-variable contract; use a fresh reviewed
immutable revision, including for an intentional disable. The renderer/traffic
suites passed all 64 tests, including Bash/Python syntax and argument-size checks.

#### Pending or unconfirmed deletion response

The owner, Michel, investigates the read-only audit's notifications through the
approved `mickeyf.plays@gmail.com` channel; job/schedule/policy evidence and pause
instructions are in [DELETION_AUDIT.md](DELETION_AUDIT.md). This is detection, not
an automatic reconciler or permission to skip a fresh reviewed replay plan.
Existing controller logs are `Account deletion pending reconciliation`
and `Account deletion unavailable`. Both need attention: an unavailable upload
may already have persisted. A process crash can precede either message, so
error-only alerts cannot guarantee eventual completion. The independent audit
also compares durable intents with remaining accounts to detect that case.

For a reported or discovered unresolved request:

1. Do not promise completion or cancellation, remove an intent, log account
   payloads, or request the user's password. A retry does not cancel a durable
   deletion request. Investigate sanitized logs and the protected journal.
2. Arrange an approved maintenance window and freeze/drain actual writers using
   the existing procedure. Merely turning the HTTP deletion switch off does not
   stop in-flight work, signup, score writers or the receipt-cleanup job.
3. With dedicated credentials and independently checked target/epoch pins, run
   `deletion-replay:plan` in **active** mode against the current database. Review
   the complete plan; run `deletion-replay:apply` only with its approved digest.
   Do not declare a recovery source UUID in active mode or use a stale export.
4. Require confirmed reconciliation and an unchanged fresh journal digest before
   restoring the previous access state. On failure, investigate and review a new
   plan; never improvise account deletion by numeric ID. Report only aggregate
   outcomes. Session-secret rotation is required for a restore cutover, not this
   active-database reconciliation.

#### Identity and replay operations (identity applied; replay not activated)

The three checksummed migrations are deliberately separate: `0006` adds a
nullable unique `account_uuid`, `0007` fills only missing IDs, and `0008` enforces
NOT NULL with a database `UUID()` default. This avoids MySQL's rejection of
adding a nondeterministic default to a populated table with binary logging.
ROW or MIXED logging is required; logging is never disabled. Existing signup SQL
remains unchanged, and the runtime cannot insert or update UUIDs. Generic
`migrations:apply` does not opt into these identity effects.

From `backend`, use `npm run migrations:identity:plan`, then separately approved
`migrations:identity:apply`, then `migrations:identity:verify`. These use dedicated
`MIGRATION_DB_*` credentials and the existing exact database/account/target
confirmations. Apply additionally requires `MIGRATION_ALLOW_APPLY=1`,
`MIGRATION_ALLOW_ACCOUNT_IDENTITY=1`, `MIGRATION_CONFIRM_WRITERS_DRAINED=1`,
`MIGRATION_CONFIRM_SERVER_UUID`, and the reviewed
`MIGRATION_CONFIRM_ACCOUNT_IDENTITY_PLAN_SHA256`. The writer-drain flag is an
operator attestation: the command cannot prove that all clients are stopped.

For an approved live identity migration, take the pre-change backup before
creating temporary maintenance users. Pause the local backend and receipt
Scheduler, restrict public ingress, then temporarily lock the existing customer
database accounts and drain their sessions. Record and restore each account's
original lock state; never modify Cloud SQL's internal system accounts. Ingress
and a request timeout alone do not prevent a running handler from reconnecting.
Distinguish customer `root@%` from Google's managed loopback `root` sessions;
verify the internal accounts and session source, and do not terminate them.
Compare all existing account, score and receipt fields before/after the change,
excluding only the newly added UUID. After schema verification, restore access
and remove temporary users before taking the post-change backup, so neither
named snapshot contains the temporary accounts or maintenance lock state.
PITR points inside the maintenance interval may still contain that temporary
state; inspect and reconcile database accounts before reopening any such restore.
Google documents that a [Cloud Run request timeout](https://docs.cloud.google.com/run/docs/configuring/request-timeout)
does not terminate the handler, and [Cloud SQL restore](https://docs.cloud.google.com/sql/docs/mysql/backup-recovery/restore)
also restores database users. These are separate from application-level checks.

Capture the original `0008_finalize_account_identity` `applied_at` once as UTC
`YYYY-MM-DD HH:mm:ss.ffffff`, in protected configuration outside SQL. Runtime
uses `ACCOUNT_IDENTITY_EPOCH`; replay uses `DELETION_REPLAY_IDENTITY_EPOCH`.
Never obtain the expected value from the restored target. A pre-identity restore
is rejected even if someone reruns the UUID migrations, because the original
epoch differs. It needs approved backup retirement or a separately verified
identity mapping; this tool does not invent that mapping. Preserve original
UUIDs and migration history in supported backups.

Generate a **new** runtime-grant plan after migration. It includes SELECT on
`users.account_uuid` and only `schema_migrations.version, applied_at`, not schema
history writes or DDL. Changed SQL/privileges change the approval hash, so an
older grant approval is not reusable. Activation also requires
`ACCOUNT_DELETION_JOURNAL_BUCKET=ludolume-deletion-journal-1012884798546` and the
production runtime identity's already-approved create-only access.

`npm run deletion-replay:plan` is read-only; `npm run deletion-replay:apply`
requires its exact `DELETION_REPLAY_APPROVED_PLAN_SHA256`. Both require dedicated
`DELETION_REPLAY_DB_HOST=127.0.0.1`, explicit `DB_PORT`, `DB_NAME`, `DB_USER`,
`DB_PASSWORD`, `DB_CURRENT_USER` and `DB_SERVER_UUID` under the same
`DELETION_REPLAY_` prefix. They never fall back to application DB credentials.
The loopback connection must use an authenticated Cloud SQL proxy/tunnel to the
reviewed target. Google ADC must independently have the authorized recovery
reader's permissions; the CLI creates no keys or impersonation grants.

Set `DELETION_REPLAY_MODE=active` for pending requests against the frozen active
database, or `recovery` for an isolated restore. Both require
`DELETION_REPLAY_FREEZE_ACK=public-traffic-and-account-writes-stopped` after
actually stopping and draining writers. Recovery additionally requires the
independently recorded `DELETION_REPLAY_SOURCE_SERVER_UUID` (different from the
target) and `DELETION_REPLAY_RECOVERY_ACK=isolated-restore-and-session-rotation-required`.
These attestations do not technically enforce isolation or rotate credentials.

The reader checks all pages and generations, rejects deleted/unexpected objects,
pins downloads to generations and verifies content checksums. Replay validates
every intent before mutation, compares exact target/epoch pins, rechecks each
UUID under the shared submission lock, and commits scoped account deletions.
Missing UUIDs are repeatable no-ops. A fresh journal digest must match afterward;
failure never authorizes cutover even if some valid deletions already committed.
Drained writers and protected journal retention are essential: pagination and
digest comparisons alone are not an atomic snapshot or proof of absent history.

Default limits are 1,000 intents and a 60-second work budget; explicit
`DELETION_REPLAY_MAX_INTENTS` and `DELETION_REPLAY_MAX_DURATION_MS` are capped at
10,000 and 300,000 respectively. Queries are bounded to ten seconds. The work
budget stops new work; finishing or rolling back an in-flight transaction can
extend it. Exceeding a limit fails closed, never silently truncates the journal.
Review/retry with the documented bounded settings rather than bypassing checks.
No live-object expiry is enabled until the recovery-copy inventory justifies it.

Local validation for this checkpoint: backend `npm test` (TypeScript),
`npm run test:unit` (275 passed), and `npm run test:migrations` (58 passed across
the disposable MySQL suites, including simulated restoration/replay). Frontend
`node --experimental-strip-types --test ts/services/authApi.test.mjs` (16 passed)
and `npx tsc -p tsconfig.json --noEmit` passed. Backend
`npm audit --omit=dev --audit-level=moderate` reported zero vulnerabilities after
using Node's system CA option; TLS verification was not disabled. Temporary
MySQL containers/networks were removed. No cloud journal object was created.

Primary technical references checked 2026-09-11:
[Cloud Storage consistency](https://docs.cloud.google.com/storage/docs/consistency)
documents consistent object writes/reads/listing, not an atomic multi-page
recovery snapshot; the final freeze/checkpoint is our design requirement.
[Cloud Storage IAM roles](https://docs.cloud.google.com/storage/docs/access-control/iam-roles)
documents the create-only role without read, overwrite or delete access; retry
and recovery-reader behavior must respect that separation.
[MySQL auto-increment handling](https://dev.mysql.com/doc/refman/8.0/en/innodb-auto-increment-handling.html)
describes allocation state stored with the database. The reuse risk across an
older restore is inferred from that behavior and our numeric-ID-only identity.

#### Pre-identity backup inventory — 2026-09-11, approximately 23:43 UTC

This was a read-only metadata review, not a restore or deletion. At that time the
identity migrations were local-only, so treat every recovery point below as
pre-identity and unsupported by UUID replay. Backup contents were not restored
or opened, and no production SQL migration/history query was performed here.

Cloud SQL `cms-mickeyf` in `noted-reef-387021` is RUNNABLE, MySQL 8.0.31, with
Standard backups enabled. Retention is **eight automated backups by count**,
not a guaranteed eight-calendar-day expiry. Binary logging and seven-day
transaction-log retention are enabled; instance deletion protection is on.
The inventory returned twelve successful backups:

| Kind | Snapshot dates (UTC) | Count | Disposition before deletion activation |
| --- | --- | ---: | --- |
| Automated | September 4–11, 2026 | 8 | Preserve now; let successful post-identity backups replace them and recheck the actual list. |
| On-demand | August 26 and September 8, 2026 | 4 | Preserve until replacement recovery is verified, then obtain exact-target retirement approval. |

The four on-demand retirement candidates are:

| Backup ID | Started (UTC) | Recorded purpose |
| --- | --- | --- |
| `1787754667930` | 2026-08-26 14:31:07 | Before additive leaderboard migration |
| `1787755849821` | 2026-08-26 14:50:49 | Before p4-Vega backfill |
| `1787787054951` | 2026-08-26 23:30:54 | Before legacy p4_score removal |
| `1788894880118` | 2026-09-08 19:14:40 | Before receipt migration 0004–0005 |

These IDs document candidates, not authorization or a deletion script. Recheck
their metadata and replacement recovery evidence before any later removal.
Standard on-demand backups do not age out automatically; this differs from the
automated backup count. See Google's
[backup-retention documentation](https://docs.cloud.google.com/sql/docs/mysql/backup-recovery/backups#backup-retention).

The reported point-in-time recovery window was
`2026-09-04T21:24:45.390Z` through `2026-09-11T23:43:24.597639300Z`.
After migration, a successful new backup alone does not retire earlier PITR
targets. Before activation, query the window again and confirm its earliest
recoverable time no longer precedes the original identity checkpoint. Do not
disable/reduce PITR merely to shorten this transition.

Project-wide backup listing (`--instance=-`) returned the same twelve records,
with no additional final/deleted-instance backups. Instance listing returned
only `cms-mickeyf`, without replicas. The available operations history returned
no EXPORT/IMPORT/CLONE/RESTORE matches and no unfinished SQL operation. This is
not proof that a client never made a manual dump. Project bucket listing returned
only the approved deletion journal; no separate export bucket was discovered.
The live backend still routes 100% to `mickeyf-org-ios-origin-a1f3ea43-0910`,
without the new deletion activation settings; this review did not deploy code.

Local filename/metadata checks found no database dump in the repository,
documented Mickeyf operator directory, or nine documented `mickeyf-*` temporary
evidence directories. The repository's eight SQL files are migrations. A small
`preservation-snapshot.json` is documented operational evidence, not a database
backup. No payloads, credentials, personal folders or unrelated archives were
opened. The owner confirmed no database exports/backups saved elsewhere on
2026-09-11. Other devices, Downloads, external drives and other cloud accounts
were not independently scanned; that portion relies on the owner's confirmation.
Provider-internal recovery copies are outside this customer-visible inventory.

Recommended order: keep deletion disabled; obtain approval for the identity
migration and replacement backup; verify isolated recovery and preserve the
original epoch externally; retire the specifically approved manual copies;
allow automated backups/PITR to roll beyond the checkpoint; refresh the inventory
if any additional copies are made; then separately approve live activation. No legacy identity-mapping
subsystem, new scheduler or new alert system is proposed. Other development can
continue while the old recovery window rolls forward.

Read-only evidence commands used `gcloud sql instances describe/list`,
`gcloud sql backups list` for the instance and project wildcard,
`gcloud sql instances get-latest-recovery-time`, filtered
`gcloud sql operations list`, `gcloud storage buckets list`, and
`gcloud run services describe` with output limited to relevant metadata. This
documentation-only checkpoint did not rerun application tests or change cloud
configuration, accounts, scores, grants or backups.

#### Production identity checkpoint — 2026-09-12 UTC

Under the owner's approved maintenance window (September 11 local time),
`0006_add_account_identity`, `0007_backfill_account_identity` and
`0008_finalize_account_identity` were applied to `cms-mickeyf`, database `cms`,
on pinned server UUID `d1e6865c-ecad-11ee-a6b0-42010a400002`. The final reviewed
plan SHA-256 was `95530d311f8f18155042965e2224bb51ddd5b0047719c3f658e3a5d8c6bb0ba1`.
All eight migration versions/checksums verified afterward; none were pending
or recoverable. The final UUID column/default/unique index verified, covering
all **12 accounts**. Full before/after fingerprints of the existing account
columns, **nine personal bests** and **zero receipts** matched exactly.

Original identity epoch: **`2026-09-12 00:15:39.954172` UTC**. A copy is retained
outside SQL in the owner-restricted Windows directory
`%LOCALAPPDATA%\Ludolume\Recovery\identity-20260911`, alongside non-secret
operation evidence and recovery notes. Use the independently recorded epoch,
not a value obtained from a restored target.

| Snapshot | Backup ID | Completed (UTC) | Recovery significance |
| --- | --- | --- | --- |
| Before identity migration | `1789171137743` | 2026-09-12 00:00:29 | Permanently retired under exact-target approval on September 12; see completed retirement set below. |
| After identity migration and access cleanup | `1789172213271` | 2026-09-12 00:17:44 | Successful post-identity backup; isolated restoration and synthetic SQL replay verified below. |

Both backups were successful. At that migration checkpoint all twelve previously
inventoried backups remained, for fourteen total; backup/PITR retention was not
shortened. The new pre-identity
snapshot raises the on-demand pre-identity retirement candidates from four to
five. Existing automated/PITR recovery points still need to roll past the
identity checkpoint before deletion activation.

The initial maintenance attempt was aborted before DDL when an unclassified
session was found. Read-only diagnosis identified Google's internal loopback
`root` sessions; they were neither locked nor terminated. A JSON object-key
ordering mismatch in the temporary helper's configuration comparison was also
corrected before production pause. The successful attempt verified locked
customer accounts, no customer sessions or open transactions, no metadata-lock
waiters, and completed cleanup executions before the final plan/apply.

Customer lock states, existing grant fingerprints, receipt Scheduler and public
ingress were restored. Final Cloud Run generation **142** still serves exactly
100% of `mickeyf-org-ios-origin-a1f3ea43-0910`, with no template, image or traffic
change. The four original SQL users remain; every temporary maintenance user
was removed before the final backup. The local backend was restarted with
`npm run backend:dev:local`; frontend/WebGL/proxy processes were preserved.
Public session, catalog, p4-Vega and Three Bosses read endpoints returned HTTP
200 with JSON and `no-store`. No authenticated login/submission retest, account
deletion, journal write, replay, runtime-grant rollout or application deployment
was performed. The existing deletion activation settings remain absent.

The operation used a temporary interactive Node helper calling the repository's
guarded `planAccountIdentityMigration`, `applyAccountIdentityMigration` and
`verifyAccountIdentitySchema` functions, with exact plan/server confirmation.
Google Cloud API backup/ingress/Scheduler operations and read-only `gcloud`
inventory checks supplied the infrastructure evidence. This operations-only
checkpoint did not rerun the already-passing application test suites.

#### Isolated recovery exercise — 2026-09-12 UTC

The owner approved restoring backup `1789172213271` into temporary instance
`ludolume-restore-check-20260912`, never over `cms-mickeyf`. Creation operation
`01ef3cec-150c-49a1-8138-767400000032` and restore operation
`8e1f705c-72d4-49d0-85c7-f39a00000032` completed successfully. The restored
MySQL version was `8.0.31-google`; target server UUID
`37431f47-ae41-11f1-a32f-42010a40001c` differed from the pinned production UUID.

Connector enforcement and encrypted connections were required, with no public
network allowlist. The temporary proxy listened only on `127.0.0.1:3307`, not
production's port 3306. No application, cleanup job or public route was pointed
at the restored instance. Its four inherited customer SQL accounts were locked
before replay; Google's internal system users were left untouched. This was
isolation from application traffic, not from privileged project administrators.

Verified against the independent checkpoint: **12 accounts, nine personal bests,
zero receipts**, all eight migration checksums, UUID/default/index integrity,
and the original epoch `2026-09-12 00:15:39.954172`. Existing-column fingerprints
matched the pre/post-migration evidence. Administrator metadata inspection found
exactly the four expected InnoDB tables and no schema triggers or events.

The helper called the existing `planDeletionReplay`/`applyDeletionReplay`
functions with a target-only SQL account: SELECT/DELETE on the three account
tables and SELECT on migration history, without INSERT, UPDATE, DDL or grant
authority. Separate setup credentials created the dummy data.

- The real GCS reader checked the live journal using existing operator
  credentials and a GET-only transport. Zero intents were present; the reviewed
  empty plan reconciled without deletions. No production marker was written.
- A separate, frozen **in-memory** intent targeted one new dummy account in the
  restored copy, with two game bests and one receipt. Replay removed that account
  and its related rows. Repeating the same plan returned zero deletions and one
  absent account. A replacement with the same numeric ID but a new UUID survived
  another replay. Its fixture was then removed; all original copied rows,
  including account UUIDs, matched their pre-exercise fingerprints exactly.

This verifies actual backup restoration and SQL replay on the restored schema.
It does **not** prove a production marker's persistence, runtime-writer or recovery-
service-account authentication, replay of a fixture present in the original
backup, or session invalidation at cutover. The instance never became live, so
production writers were not paused and production session secrets were not
rotated. Existing local servers remained running. Production instance settings,
the source backup and Cloud Run generation 142/100% revision routing remained
unchanged; deletion activation settings were still absent.

The one-time helper was syntax-checked with `node --check` and executed using
`node --use-system-ca`; this was an operational check of existing implementation,
not a new application-code change or a rerun of the broad test suites. Non-secret
results are retained as `restore-exercise-20260912.json` beside the independently
saved epoch in the owner-restricted recovery directory. No row exports, dummy
passwords or cloud access tokens are retained.

Cleanup: the temporary SQL credentials and proxy container were removed.
Instance deletion `6cd482d2-f4e6-4615-9853-db6800000032` completed at
`2026-09-12T00:36:37.483Z`. Project-wide read-back showed only `cms-mickeyf`, all
14 original successful backups and no backup belonging to the temporary
instance; port 3307 was closed. No final/retained backup was requested for the
disposable copy. The filesystem tool refused removal of the external temporary
helper folder. Its credential-free helper and duplicate aggregate result remain
outside the repository; the exact path and matching evidence hash are recorded
in the protected recovery notes. This local cleanup item is not complete.

#### Backup retirement approval set — 2026-09-12 UTC

Pre-deletion project-wide metadata showed 14 successful backups for `cms-mickeyf`
and no backup for the removed test instance. The owner explicitly approved
permanent removal of these five **manual pre-identity** snapshots:

| Backup ID | Started (UTC) | Purpose |
| --- | --- | --- |
| `1787754667930` | 2026-08-26 14:31:07 | Before additive leaderboard migration |
| `1787755849821` | 2026-08-26 14:50:49 | Before p4-Vega backfill |
| `1787787054951` | 2026-08-26 23:30:54 | Before legacy score-column removal |
| `1788894880118` | 2026-09-08 19:14:40 | Before receipt migration |
| `1789171137743` | 2026-09-11 23:58:57 | Before account identity migration |

**Completed 2026-09-12 at 01:01:35.536 UTC.** All five exact deletions completed
successfully, in sequence. Fresh project-wide read-back matched exactly the nine
protected backups: verified replacement `1789172213271` and all eight automated
backups, each still successful. The database remained RUNNABLE; automated backup,
binary logging, eight-backup COUNT retention and seven-day transaction-log
settings were preserved. These old named snapshot restore points are permanently
removed; no live SQL account or score data was changed. Standard manual
backups remain until explicitly deleted; do not manually remove automated
backups to accelerate the transition ([Google backup retention](https://docs.cloud.google.com/sql/docs/mysql/backup-recovery/backups#backup-retention)).

The post-deletion recovery window still began at `2026-09-04T21:24:45.390Z`, before the
original identity epoch; its reported latest point was
`2026-09-12T01:01:54.602501768Z`. Retirement of the five manual snapshots alone
therefore does not permit activation. Allow automatic history to roll forward
and verify the actual inventory/window once it is eligible; do not rerun the
completed restore test or shorten recovery retention. No new monitor, scheduler,
IAM grant, probe object or deployment was created. Deletion remains disabled.

Operations used guarded `gcloud sql backups delete <approved ID>` calls and
confirmed each returned operation completed without error. The final backup
inventory, instance settings and recovery window were read back. Non-secret
operation IDs/timestamps and the protected backup list are recorded in
`backup-retirement-20260912-0101.json` beside the original epoch in the restricted
recovery directory. Repository changes were documentation-only and passed `git diff --check`;
no application test suite or restore exercise was rerun.

#### Journal storage and IAM checkpoint — 2026-09-11

User-approved provisioning created
`gs://ludolume-deletion-journal-1012884798546` in project `noted-reef-387021`,
using Standard storage in `us-central1` alongside the existing backend region.
Public-access prevention is **enforced** and uniform bucket-level access is on.
Seven-day soft delete is explicit (`604800` seconds); object versioning, lifecycle
expiry and a bucket retention policy are absent. No irreversible Bucket Lock,
scheduler, recovery job, key file or secret was created.

Bucket-scoped access:

- Existing backend identity
  `mickeyf-runtime@noted-reef-387021.iam.gserviceaccount.com` has
  `roles/storage.objectCreator`: new objects, not object read/list/update/delete
  or overwrite. Its only direct project role remains `roles/cloudsql.client`,
  which has no storage permissions.
- New identity
  `ludolume-deletion-recovery@noted-reef-387021.iam.gserviceaccount.com` has
  `roles/storage.objectViewer`: object read/list, not create/change/delete.
  It has no direct project-role grants, user-managed keys or service-account-
  level impersonation bindings and is not attached to a job or service.
  Recovery execution remains separate.
- Preserved the project's owner convenience bindings for bucket/object
  administration. Removed only this newly created bucket's automatic
  Editor/Viewer convenience grants. Project IAM was not changed. Other
  inherited privileged project roles still apply; this is not isolation from
  project administrators or destruction of the entire project.

Read-back verified the project number, region, private-access settings, soft
delete duration, absence of lifecycle/versioning/retention policy, exact bucket
bindings, identity/project roles and live role definitions. Both all-version and
soft-deleted object listings were empty. No probe object or deletion marker was
written. IAM was verified from policy/role reads, not impersonated data-plane
requests; no Token Creator grant was added merely to run a test. The bucket IAM
update used the observed etag to avoid overwriting concurrent policy changes.

The live backend revision/100% traffic target remained
`mickeyf-org-ios-origin-a1f3ea43-0910`; no deployment, database grant, account or
score operation occurred. The deletion release switch was not enabled.

Recovery implementation must account for
[soft-deleted records](https://docs.cloud.google.com/storage/docs/soft-delete),
which ordinary listing does not return and which cannot be read until restored.
An empty ordinary listing must never be accepted as evidence of a complete
journal. Before eventual marker expiry, include the soft-delete recovery window
in the retention accounting. The empty bucket is infrastructure readiness, not
proof that account deletion now survives a database restore.

## Deferred decisions

- Recalibrating the provisional rules-version-1 Three Bosses rank bands after
  observing real completion data.
- Enabling Three Bosses submission.
- Whether an honor-based authenticated completion time is sufficient for a
  competitive leaderboard or stronger run attestation is required.
- A run-ledger retention policy. Deleting ledger rows without idempotency
  tombstones would make old retries unsafe.
