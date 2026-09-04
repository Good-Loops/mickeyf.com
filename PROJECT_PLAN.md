# Active project plan

This tracked roadmap records the active continuation of the broader migration
and game plan. Detailed implementation decisions remain subject to review at
each phase boundary.

Status snapshot (2026-09-04): Alpha 0.6.0 and the site redesign are published
from `main`. Active work continues on `feature/three-bosses-polish`, with mobile
gameplay still gated from production until its physical-device acceptance pass
is complete. Dated deployment and migration passages below are retained as
historical evidence; current operational state must be verified directly.

## Phase 12 — Three Bosses local game flow

- Steps 12.1–12.9: implemented on the phase branch and undergoing gameplay and
  presentation polish.
- Step 12.10 — provisional rank calibration: **implemented on 2026-08-29**.
  Rules version 1 derives rank from the canonical active-combat time: under
  `01:00` is S; `01:00.000` through `01:20.000` is A; `01:20.001` through
  `01:40.000` is B; `01:40.001` through `02:00.000` is C; and anything slower
  is D. The reported `01:22` warm-up is B and remains excluded from the ten
  measured calibration runs. These bands remain provisional; changing them
  after write activation requires an explicit historical reclassification or
  rules-version decision.
- Step 12.11 — edge cases and presentation polish:
  - Step 12.11A — rename permanent Unity Editor utilities: **completed** in
    commit `46c3c775`.
  - Step 12.11B — review and stabilize the existing local UI changes:
    **completed** across commits `ac7ecd84`, `4c20b87d`, and `fa23f916`.
  - Step 12.11C — normalize button hover behavior, including Try Again, Back to
    Menu, and the disabled Submit Score button: **completed** in commits
    `ac7ecd84` and `fa23f916`.
  - Step 12.11D — fix countdown presentation so `3` begins green with no white
    flash and all `3`, `2`, `1`, and `GO!` states use consistent styling:
    **completed** in commits `4c20b87d` and `fa23f916`.
  - Step 12.11E — tune boss-defeat visibility, fade timing, and transition
    screen duration: **completed** in commits `b3308dfa`, `957c8cd7`, and
    `93df8334`.
  - Step 12.11F — add a read-only live timer at the top center of all three
    gameplay scenes using the existing run session and time formatter:
    **completed** in commit `248cfa51`.
  - Step 12.11G — exclude boss-death presentation, fades, illustrated
    transitions, loading, and next-level reveal from completion time and score;
    only active combat time counts: **completed** in commit `5549f30a`.
  - Step 12.11H — complete the full three-boss route, defeat-screen, button,
    audio-persistence, duplicate-event, and interrupted-run smoke tests:
    **controlled full-route validation completed on 2026-08-24**. Automated
    coverage passed 19 EditMode and 18 PlayMode tests, with clean Unity source
    integrity and no Console warnings or errors. Subsequent menu, timer, and
    countdown regression coverage passed 19 EditMode and 20 PlayMode tests in
    commits `7da148d7` and `5062c6b5`. Mike confirmed audible mute/unmute
    behavior on 2026-08-24. His continuous hands-on combat-feel, weapon,
    pickup, and full normal-route check remains before the next Three Bosses
    release.

Phase 12 release acceptance still requires the remaining hands-on gameplay
check, passing Unity compilation and automated tests, clean asset/meta integrity,
and a verified complete normal route. The provisional rank implementation is
complete. Production currently advertises p4-Vega through its legacy submission
path and Three Bosses as enabled, but each new release candidate still requires
the local/live flag and signed-in end-to-end verification recorded under Phase
13.

## Phase 13 — Website and leaderboard integration

The local Three Bosses result flow is stable enough for integration work.
Phase 13 completed on `feature/new-leaderboard` on 2026-08-26 and was later
released through Alpha 0.6.0. Current Three Bosses polish remains isolated on
`feature/three-bosses-polish` until its next reviewed release checkpoint.

### Step 13.1 — multi-game contract and migration design

**Storage migration, feature-branch frontend integration, and p4-Vega
production submission activation completed on 2026-08-26.** Approved by Mike
and live-schema-preflighted on 2026-08-24. The
server-owned contract uses stable
`p4-vega` and `three-bosses` identifiers. p4-Vega remains score-descending on
its unchanged legacy endpoint. Three Bosses is completion-time-ascending with
the provisional S–D rank bands above and submission disabled. Persistence uses an immutable
run ledger for idempotency plus one personal-best row per player, game, and
rules version so incompatible future rules are never compared.

The additive migration, backfill, reconciliation, compatibility, security,
and rollback contract is recorded in
[`backend/LEADERBOARD_DESIGN.md`](backend/LEADERBOARD_DESIGN.md). The sanitized
live preflight confirmed the foreign-key type and current schema constraints,
and the exact additive table migrations, checksum-recorded runner, fail-closed
empty rollback, and isolated MySQL 8.0.31 test harness were implemented and
verified locally on 2026-08-25. The migration adds no backfill and does not
alter `users.p4_score`. At that checkpoint, applying DDL, backfilling data,
changing production credentials, and deploying the new API each still required
separate reviewed approval.

The additive production schema was applied on 2026-08-26 from commit
`abd6ff9d`, after successful on-demand backup `1787754667930` and a clean
two-version plan. `schema_migrations`, `game_runs`, and `game_personal_bests`
now exist with the reviewed checksums and exact shapes. Immediately after that
step both domain tables were empty, `users.p4_score` remained nullable `INT`,
and the identity-free source evidence remained seven users, five scores,
minimum 190, maximum 410, and sum 1350. No API deployment, credential change,
trigger, or destructive migration was performed.

The separately approved initial p4-Vega seed ran on 2026-08-26 from commit
`87ab4954`, after successful on-demand backup `1787755849821`. One transaction
copied the five legacy scores into `game_personal_bests`; an independent
read-only reconciliation confirmed source and target count 5, minimum 190,
maximum 410, sum 1350, five exact matches, and zero discrepancy, metadata,
run-ledger, or rules-version counts. `game_runs` stayed empty and
`users.p4_score` stayed unchanged. This is point-in-time seed evidence only:
the live legacy-only writer can still create drift, so the complete backfill
and reconciliation must run again after dual-writer deployment and the
legacy-revision drain before any cutover.

That preflight also found that the deployed `cms_mickeyf` account inherited
Cloud SQL's `cloudsqlsuperuser` role. This least-privilege defect was fixed on
2026-08-26 before candidate deployment by removing the role and retaining only
the reviewed direct runtime DML described below. Production migration commands
use one explicitly approved maintenance credential through `MIGRATION_DB_*`; a
separate maintenance identity is preferred, while one-time reuse of the current
credential is an explicit exception followed by immediate local credential
clearing. Runtime
privilege reduction remains a separately reviewed operation for any future
account or manifest change.

The exact column-level runtime grant manifest and isolated verification test
were implemented locally on 2026-08-26. The manifest grants only the columns
used by current auth and leaderboard SQL on `users`, `game_runs`, and
`game_personal_bests`, and nothing on `schema_migrations`. A redundant locking
read was removed so the immutable `game_runs` ledger needs no `UPDATE` grant.
The pinned MySQL 8.0.31 suite proves every current runtime path succeeds while
migration history, destructive DML, ledger updates, DDL, account creation, and
grant operations fail. This closes the code-and-test prerequisite, not the live
operation. The separately approved live reduction described below has now
replaced `cloudsqlsuperuser` with the exact direct grants.

The local privilege-reduction workflow was then completed on
`feature/new-leaderboard`. Its `plan`, `verify`, and `apply` commands bind the
exact runtime account, approved `cloudsqlsuperuser@%` role, Cloud SQL target,
independently observed production server UUID, and observed metadata into one
reviewed SHA-256. The apply path is conservative: it blocks a wrong proxy target,
proves effective `PROCESS` visibility and drained runtime sessions before any
write, adds and proves only the manifest, blocks every unexpected direct
privilege or relationship instead of cleaning it automatically, clears only the
approved default role, rechecks the drain, and delegates the zero-role
replacement to the documented Cloud SQL control plane. It also blocks while a Cloud SQL
operation is unfinished and treats an interrupted external mutation as
indeterminate. Disposable MySQL 8.0.31 tests cover restricted-account PROCESS
proof, pre-write active-session refusal, provider failure and rerun,
unknown-state refusal, final fresh-session role absence, and idempotency. This
was tooling evidence only; the later live operation was authorized and recorded
separately.

The approved production reduction completed on 2026-08-26. After traffic was
drained, the reviewed apply removed every database role from `cms_mickeyf@%`
and retained only the manifest's non-grantable column privileges. A fresh
runtime revision, `mickeyf-org-grants-restored-20260826-a`, then received 100%
traffic on immutable image digest
`sha256:babde939969cc17db89c2138a55f692cef65cc1ab2d2e20de1b06179a456d5c1`.
Standalone verification recorded digest
`0565e5d5532e115d3b4142efcad4c63ed665effc7f838147c8d42a11f177fe7a`,
fresh positive and negative SQL probes passed, public and local leaderboard
reads remained healthy, no temporary database user or revision remained, and
Cloud SQL reported no pending operation. This closes the runtime
least-privilege blocker for the reviewed transitional manifest.

The approved Phase 13 storage end state is for both the existing p4-Vega API
operations and the generic leaderboard read to use `game_personal_bests` as
their source of truth. After transactional dual writes, a complete backfill,
old-revision drain, reconciliation, API cutover, and proof that no deployed or
rollback code depends on the legacy column, a separately reviewed immutable
migration will drop `users.p4_score`. The initial additive migrations remain
unchanged, and the drop requires its own production approval and recovery
evidence.

That storage end state completed on 2026-08-26. Commit `388bf6d5` added
immutable migration `0003_drop_users_p4_score` plus a separately gated,
plan-digest-bound `ALGORITHM=INSTANT` path. After final exact reconciliation,
on-demand backup `1787787054951`, and a live dependency audit, production
recorded migration checksum
`bc4c89691d9d2f729977446e1bde8f168c5ee83c95349e80c3a6deec598a2951`
and removed `users.p4_score`. Generic and legacy-adapter reads still return the
same five p4-Vega rows, Three Bosses remains empty, both submission paths remain
closed, and the temporary maintenance identity was deleted. Because deferred
`main` still contains the legacy writer, its automatic build trigger is disabled
and must remain disabled until `main` becomes schema-compatible.

The p4-enabled revision `mickeyf-org-p4-enabled-d5aee625` uses the same verified
digest as the frozen rollback revision, with p4-Vega enabled and Three Bosses
disabled. After public smoke tests and validate-only traffic and rollback
checks, etag-bound traffic-only operation
`a54a5387-f780-44a9-b38d-d333db988cca` promoted it to 100% at Cloud Run
generation 124. A signed-in p4-Vega game over submitted score 0 with HTTP 200;
the existing 330 personal best remained unchanged, as did the five-row board
(minimum 190, maximum 410, sum 1350). The rollback revision remains ready at
zero traffic, the incompatible `main` trigger remains disabled, and no build or
Cloud SQL operation was unfinished.

Post-cutover cleanup removed the completed one-shot deployment package, the
one-time p4 grant-retirement implementation and tests, and the obsolete
empty-schema rollback. The immutable migrations, migration-0003 replay and
recovery path, generic runtime-grant workflow, and read-only reconciliation
remain. The frontend and Unity audit found no obsolete whole file. The Three
Bosses submission bridge that was retained at this checkpoint is now connected
to the Unity result flow and still fails closed until production activation.
Pushing this branch to `main` would trigger the live Firebase release, so it
remains deferred until the broader release gates are complete.

The local generic-only grant contract was completed on 2026-08-26. p4-Vega and
Three Bosses now share one database-scoped advisory lock per authenticated user,
acquired before their transaction and released after commit or rollback. An
indeterminate acquisition, release, or rollback invalidates the pooled session,
so neither repository needs `users SELECT ... FOR UPDATE`. The source manifest
now omits `p4_score` entirely and grants no `UPDATE` on `users`. A restricted
MySQL 8.0.31 fixture creates `users` without the legacy column, exercises auth
and both leaderboard repositories, and proves a direct user-row locking read is
denied. Repository concurrency and rollback tests still pass. At that local
checkpoint, production remained on the frozen dual writer with its older
transitional `p4_score` grants. The later generic-only traffic cutover is
recorded below, followed by the separately reviewed exact grant retirement.

The transitional p4-Vega write path was implemented and verified locally on
2026-08-25. That candidate updated `users.p4_score` and
`game_personal_bests` atomically on one acquired connection; either write
failure rolled the transaction back, concurrent submissions converged on the
same maximum, and the legacy HTTP response remained unchanged. The exact
freeze-capable composition first served production with writes enabled. The
same immutable image later served in the frozen dual-writer revision recorded
below. That revision and the enabled revision are now both retired.

The transitional read split was corrected and reverified on 2026-08-26 at
`a127beac14c2662648c8aededa59374f5d7c87dd`. While that dual writer served, the
legacy `/api/users` `get_leaderboard` operation deliberately kept reading
`users.p4_score`; the additive `/api/leaderboards/p4-vega` route read
`game_personal_bests`. Unit, controller, security, isolated MySQL, migration,
backfill, and production-bundle checks passed, including a pre-backfill fixture
where the two sources intentionally differ. This prevents the first rollout
from silently switching the existing leaderboard to an empty or incomplete
generic table.

On 2026-08-26, detached worktrees verified historical dual-write base
`0dbe3fb8` plus the seven storage-independent freeze-gate changes from
`e8e1faeb`, excluding generic-authoritative writer `2e3d4fde`. The complete
backend, isolated MySQL, frontend, and production-build checks passed; the
tested composition is now retained on `feature/new-leaderboard` at
`c1c742b927844e89fe9f7ab07ddb9a20501399ee`. No image, Cloud Run revision,
live-trigger edit, deployment, traffic change, production database mutation,
or production freeze resulted.

The generic-authoritative p4-Vega writer was prepared and verified locally on
2026-08-26. It holds the shared per-user submission lock, compares only
`game_personal_bests`, and writes only a strict improvement on the same
transaction connection. It preserves the legacy HTTP contract and
missing-user result, leaves a sentinel legacy score unchanged, survives
concurrent submissions, and was tested after physically dropping
`users.p4_score` in the disposable MySQL fixture. On 2026-08-26 that reviewed
implementation was integrated into the active feature branch: both the legacy
`/api/users` operation and the additive API now use one generic reader locally,
while the legacy response still exposes `p4_score`. Type-checking, 125 unit and
security tests, 42 isolated MySQL integration tests, the production bundle, and
the image-only Cloud Build contract tests pass. At that checkpoint this source
was not deployed and production remained on the frozen dual writer. The later
deployment and cutover are recorded below; the production column and
transitional grants are still unchanged. The column-drop integration case
proves code and schema independence under the migration-test account; the
separate restricted-runtime fixture now proves the same generic-only paths under the
least-privilege application identity.

The revision-scoped p4-Vega submission freeze gate was prepared locally on
2026-08-26. Only the exact runtime opt-in
`P4_VEGA_SCORE_SUBMISSIONS_ENABLED=true` permits score writes; every missing or
other value returns HTTP 503 `SUBMISSIONS_FROZEN` before authentication or
database work while leaving account and leaderboard operations available. The
gate is deliberately independent of the storage repository so the same change
can protect both a transitional dual-write revision and the generic-only
revision. The tracked canonical Stage B source remains deliberately frozen
with `P4_VEGA_SCORE_SUBMISSIONS_ENABLED=false`; it attests the exact
eight-variable environment, including disabled Three Bosses writes, and probes
the exact HTTP 503 freeze contract. The canonical main-only Stage B trigger has
not run or changed. The separately approved feature-branch trust path recorded
below deployed and verified the equivalent frozen configuration at zero
traffic; it did not establish a production freeze.
Because `main` is deferred through Phase 14, the production main-only Stage A
and Stage B trust chain will remain unchanged. An isolated image-only candidate
configuration was committed at `e68959e9`; it has no Pub/Sub, deploy, secret,
Cloud Run, Cloud SQL, or traffic capability. Any later feature-branch build or
deployment still requires a separately approved temporary trigger that pins
the full source commit and verified provenance. An enabled dual-writer
deployment must also pin that exact candidate, set the p4 flag to `true`, and
require a non-mutating anonymous HTTP 401 `UNAUTHORIZED` probe. That probe
proves the gate is open without persistence, but cannot by itself identify the
writer implementation.

The first exact-commit candidate image was rejected on 2026-08-26 after its
registry scan reported ten OpenSSL operating-system package findings. The
shared Docker base now upgrades only Alpine's `libcrypto3` and `libssl3` from
`3.5.7-r0` to the reviewed `3.5.8-r0` revision, verifies both postconditions,
and removes the repository indexes. The existing candidate contract test now
fails if this exact patch moves outside the shared base or another unreviewed
`apk` package mutation appears.

Replacement image-only build `e2a8aa19-de27-4e07-a895-b7d8773d7368`
resolved exact commit `199f834c40240371194064327fb873ff95502f74` and produced
immutable digest
`sha256:47689830d731f8be46fea7ae1e4ed1991fc9fdeb099a5901c54039c7778ea7bb`.
Artifact Registry completed its configured analyses with no package
vulnerability occurrences reported, and signed in-toto/SLSA provenance binds
the commit, image-only recipe, trigger, builder, and digest. That earlier
candidate remained undeployed: Cloud Run generation 106 stayed on
`mickeyf-org-build-c4b3ff0e93bd4f979d93319709e97baa` with 100% traffic after
verification.

Node 22.23.2 separately embeds OpenSSL 3.5.7 inside the executable, so the
Alpine package patch does not alter `process.versions.openssl`. A source and
application reachability review found that this backend does not expose the
affected QUIC, DTLS, CMP, CMS, RPK, or one-shot `EVP_Cipher()` paths. That is an
evidence-based inference, not an upstream Node guarantee. On 2026-08-26, Mike
explicitly accepted that bounded reachability assessment for the exact
zero-traffic candidate only. The later explicit approvals to promote the exact
digest first as the enabled and then as the frozen dual writer extended that
bounded acceptance only to those two rollout stages. It did not cover the later
generic-only image, so that exact digest received the refreshed component review
and explicit acceptance recorded below.

The exact enabled dual-writer candidate was built and deployed at zero traffic
on 2026-08-26 from commit
`5abdc5bb1ee0a0fb947e7bb1024cec8e68438f64`. Approval-required image build
`9a6066b4-4f34-422b-ba33-83d6b0e9a9eb` produced immutable digest
`sha256:895c37a932be08721d5977c07577fc7503ae84eed75eb429bccb306fcb061aeb`;
Artifact Analysis completed with continuous scanning active, no vulnerability
occurrences, and exact signed SLSA v1 provenance. Approval-required deploy build
`cf494f1b-3842-4150-ba07-59e2176ca752` used reviewed one-shot config SHA-256
`84859552914f45c5b8b7907ccc66186445802a7ec2a605660ec3b3173ec58bdf`
and created revision
`mickeyf-org-build-9a6066b44f34422bba3383d6b0e9a9eb` with the p4 opt-in
enabled, Three Bosses submissions disabled, and zero traffic. Runtime and
unchanged-traffic attestation passed, followed by the anonymous 401
`UNAUTHORIZED`, catalog, leaderboard, disabled-submission, and database-read
smoke suite. The short-lived direct tag and temporary deploy trigger were then
deleted. Under separate approval, Cloud Run generation 115 routed 100% to this
revision. The legacy-only revision was retired and drained, the repeatable
backfill and aggregate reconciliation again reported five exact p4-Vega rows
with every discrepancy count at zero, and the temporary maintenance database
identity was deleted. This established the enabled dual-writer phase only; at
that checkpoint, the legacy read and `users.p4_score` remained in service.

The exact frozen dual-writer configuration was then deployed at zero traffic
under separate approval on 2026-08-26. Approval-required build
`c5daa935-39a9-43fb-a7b3-b50cedfbfe25` used reviewed one-shot config SHA-256
`e9c320e653a4b76cd265bc1470cd92e72fa0253880b07b3115d0a8c8a4f73ebf`
and the same source commit, provenance, and image digest to create revision
`mickeyf-org-freeze-9a6066b44f34422bba3383d6b0e9a9eb` with both p4-Vega and
Three Bosses submissions disabled. All eight validation, deployment,
attestation, and smoke steps passed: p4 submission returned HTTP 503
`SUBMISSIONS_FROZEN`, both p4 leaderboard reads returned the same five rows,
and Three Bosses submission returned HTTP 403 `SUBMISSION_DISABLED`. The
temporary tag and deploy trigger were removed. At generation 117, production
still routed 100% to the enabled dual-writer revision with no tags; the frozen
revision was retained retired at zero traffic. No production freeze had yet
occurred.

Under the next separate approval, an etag-bound traffic-only update advanced
Cloud Run from generation 117 to 118 and routed both the service specification
and observed status exactly 100% to the frozen revision, with no tag or
`LATEST` target. Cloud Run then reported the enabled revision `Active=False`
and `ResourcesAvailable` retired while the frozen revision became active. A
unique logged production probe reached that exact revision and returned HTTP
503 `SUBMISSIONS_FROZEN` with `no-store`, no cookie, and no redirect; both p4
leaderboard reads still returned the same five rows, and Three Bosses remained
HTTP 403 `SUBMISSION_DISABLED`. Two consecutive aggregate `INNODB_TRX` samples
found zero active `cms_mickeyf` transactions before the read-only reconciliation
reported source and target count 5, minimum 190, maximum 410, sum 1350, five
exact matches, and every discrepancy count zero. The temporary PROCESS-capable
maintenance identity was deleted, and no Cloud SQL operation, temporary trigger,
or build remains pending. This establishes the production submission freeze;
it does not perform the generic read/write cutover or alter `users.p4_score`.

The repeatable p4-Vega historical backfill and separate aggregate
reconciliation gate completed the cutover without fabricating run history or
exposing player identities. After migration `0003` removed the source column,
the mutating backfill and standalone operator commands were retired. The
read-only exact reconciliation remains internal to the destructive migration
plan so the drop can be safely replayed against the fresh pre-drop backup.

The generic p4-Vega `get_leaderboard` path is now the single production reader
for both HTTP APIs. Its request, legacy response fields, ten-row bound, cache
behavior, and numeric historical scores remain compatible. The additive schema,
enabled dual-writer deployment, repeatable backfill, production freeze, and
every drain and exact reconciliation required for the frozen generic-only
traffic cutover are complete. Production `users.p4_score` and its runtime grants
are removed; migration history and post-drop API checks passed. The multi-game
frontend is recorded below.

The additive backend catalog and per-game routes were implemented and verified
on 2026-08-26. At that checkpoint, the catalog was projected from server-owned
definitions; the generic p4-Vega response added only version metadata and
one-based positions to existing rows. Three Bosses reads queried real
current-rule personal bests in deterministic completion-time order while writes
were disabled. Its authenticated run endpoint was complete behind the exact
fail-closed
`THREE_BOSSES_RUN_SUBMISSIONS_ENABLED=true` opt-in: strict JSON/version/UUID/time
validation, explicit cookie-origin protection, server-derived score, immutable
idempotent run history, transactional strict personal bests, and per-user and
per-IP limits are covered by unit, security, rollback, concurrency, and
isolated-MySQL tests. The server derived the provisional S–D rank and
arcade-scale score from the same canonical integer millisecond result. At that
checkpoint, these routes had not been enabled for Three Bosses production
writes: the routes were present in the serving p4-enabled generic-only revision,
but `THREE_BOSSES_RUN_SUBMISSIONS_ENABLED=false` was enforced. Later activation
and current verification are recorded in the status section below.

The credential-safe browser submission client and Unity host bridge were
committed at `c4349f7c`; the Unity caller, receiver, canonical millisecond
result, arcade score/rank parity, exact-run retry state machine, and end-screen
Submit Score control were connected at `d1303eeb`. Unity sends only its run ID
and integer completion time; browser-managed cookies never enter the game
binary. The browser enables the Unity control only when the backend catalog
reports submissions enabled, while the backend runtime opt-in remains the
authoritative fail-closed gate.

The exact frozen generic-only revision first received 100% of production
traffic at Cloud Run generation 121. The p4-enabled generic-only revision now
serves 100% at generation 124; the frozen revision remains ready at zero traffic
as the schema-compatible rollback target.
The frozen dual writer is Ready but
`Active=False`, reason `Retired`. Its 315-second drain, two delayed
revision-specific zero-request log checks, two zero-transaction samples, the
complete frozen public contract, and baseline/final reconciliation with five
matching rows and no discrepancy all completed on 2026-08-26. The temporary
maintenance account was deleted and negative authentication verified. The local
generic p4 and Three Bosses lock dependency has been removed, the source runtime
manifest omits `p4_score`, and the no-column restricted fixture passes.

The exact fail-closed plan/verify/apply path for the old live column grants was
implemented and verified locally on 2026-08-26; it accepts only both old grants
present or both absent, invokes one exact atomic revoke, and treats an uncertain
result as indeterminate. MySQL applies direct table- and column-privilege changes
on an existing client's next request; the disposable integration test proved
that behavior across an open runtime connection, so this operation needed no
traffic drain or runtime-pool recycle. The production apply completed on
2026-08-26 from exact ready-plan digest
`34096d0896b45d4cc827ad71d0a5eee676aed51ab7a8555673f5d26be01065ba`.
Fresh p4-retirement verification recorded retired/compliant digest
`862cdb077448351ba3c9c4bba3ec2c72d558411244be40a178740b9f7f3df498`,
and full source-manifest verification recorded reduced/compliant digest
`9f7cc4bae03325f8969a37d3cfdda8d74b487288f3334801f9853ef77fe6fb043`.
The runtime identity can read ordinary `users` columns but receives
`ER_COLUMNACCESS_DENIED_ERROR` for `p4_score`; public leaderboard and
submission-freeze smoke tests passed. The subsequent checksum-recorded migration
removed `users.p4_score` after fresh recovery evidence, and post-drop public
verification passed. The separately approved enabled generic revision now
accepts p4-Vega scores; a signed-in zero-score smoke request returned HTTP 200
without changing its existing personal best. The retired frozen dual writer is
no longer schema-compatible; rollback must use the retained frozen generic-only
revision or a forward fix. The initial additive migrations remain unchanged.

The frozen generic-only candidate source was locally frozen and reviewed on
2026-08-26 at exact commit
`e91d3b1177932614c22fbed059a42a05fcb10793` (tree
`1537b61c94edf194edcde47aeda48ba651e0ea96`). The remote feature branch matched
that commit. Its image-only Cloud Build configuration SHA-256 is
`dccd0bcf976c77abb3e9fa6d39c1ae855ff127fbf4ec67efd3480e20a4afcda4`;
the Dockerfile SHA-256 is
`0754bb3eee99f647f536b682e056dfa6b40ac030700d9c01d754c7bc606f6ac9`.
The production bundle contains generic personal-best storage references and no
legacy `users.p4_score` SQL. Type-checking, 133 unit/security tests, 43 isolated
MySQL 8.0.31 tests, the production bundle, and all three image-only candidate
contract tests passed.

The same day's read-only production preflight found Cloud Run generation 118
still routing exactly 100% to frozen dual-writer revision
`mickeyf-org-freeze-9a6066b44f34422bba3383d6b0e9a9eb`; its enabled sibling
remained retired and both submission flags remained false. Cloud SQL was
runnable on MySQL 8.0.31 with backups, binary logging, and seven-day transaction
log retention enabled. No Cloud Build or Cloud SQL operation was active. The
approval-required `feature-new-leaderboard-candidate` trigger remained bound to
the image-only configuration and has no deploy or traffic capability; the only
deployment trigger was the existing source-less canonical Stage B trigger.

With explicit approval, image-only build
`d5aee625-983b-4daf-a90d-0db9898341e8` then completed successfully. Its requested
and resolved Git revision, full-length image tag, and signed provenance all bind
to exact commit `e91d3b1177932614c22fbed059a42a05fcb10793`; the tag independently
resolves to immutable digest
`sha256:3bba5ca29a474c6b75d92f48f93a9efc6cfa3fe32d3a4ddb7b82f2a610baaa48`.
Artifact Registry reports SLSA build level 3, and the signed in-toto SLSA v1
statement binds that digest to the build ID, trigger, Google-hosted builder, and
source commit. Artifact Analysis finished successfully with continuous analysis
active and OS, NPM, and secret analysis complete; it reported zero vulnerability
occurrences and therefore zero HIGH or CRITICAL effective-severity findings. The
locked production dependency install also reported zero `npm audit` findings.
The image-only build created no deployment: a post-build check still found Cloud
Run generation 118 and exactly 100% traffic on the frozen dual-writer revision.
No revision, traffic, database, privilege, trigger, or IAM mutation was requested
or executed.

The source-less one-shot deployment package's initial SHA-256 was
`8afde577fbefe781ed0a0c428f04dad40a5b8f8d147f22f01ccbae86bb9a5bf4`. It was
never executed: Cloud Build rejected its unescaped Bash dollar references
during approval-time validation, the pending build was cancelled before
starting, and the temporary trigger was deleted. The corrected package used
Cloud Build's required `$$` escape, had SHA-256
`a5cd6534c766ecfb9dd9f8440a5c8a7ef709828ee7281ed122ea4952a7c4936d`, and passed
all eight image/deployment contract tests. Its bounded contract contained no
source, build artifacts, available secrets, Slack notification, traffic
promotion, migration, grant, database, IAM, or trigger mutation step.

Under explicit approval, source-less build
`02eb1328-8b12-4b3b-bb0c-c9ef79f4a3a9` deployed only frozen revision
`mickeyf-org-freeze-d5aee625983b4dafa90d0db9898341e8` at zero traffic and
passed provenance, scan, runtime-setting, catalog, leaderboard, and freeze
checks. Its public tag and one-use trigger were then deleted. A later separately
approved etag-bound traffic-only PATCH, operation
`8b0c18a8-805f-494d-97e5-d8523bc10c03`, produced the first settled candidate-
only traffic observation at `2026-08-26T22:04:01.9446033Z`. The drain evidence,
exact reconciliation, and temporary-account cleanup summarized above completed
without a rollback or any change to the runtime account's grants, schema/data,
IAM, or submission state. The temporary account lifecycle was the only database-
account privilege change in this cutover. The one-shot package was deleted from
current source after successful execution; its immutable Cloud Build record and
Git history retain the audit evidence.

The embedded-OpenSSL evidence was separately refreshed. The previously accepted
and new images use identical Dockerfile blob
`2b3c60894c2a73e701230482f3b722a72e017725`, production lockfile blob
`65759ac60e8a6f6bc90f19cab2cd2d18cb8750dc`, and pinned Node base. Their OCI
manifests share the first four layers byte-for-byte, including Node installation
layer `sha256:efbef6f9e333972a10ca323e700496a64e7ddcc3a6725e6afbbae52e690f4a4`;
both image configurations declare Node 22.23.2. The only `package.json` changes
are test and maintenance scripts, and the application diff adds none of the
affected QUIC, DTLS, CMP, CMS, RPK, or one-shot `EVP_Cipher()` paths. This makes
the earlier reachability evidence applicable at the component level, but the
clean package/OS scan does not inspect Node's embedded OpenSSL 3.5.7. Mike
explicitly accepted the bounded component-level assessment for this exact
digest, and the separately approved cutover remained pinned to that digest;
the acceptance does not transfer to another image. OpenSSL 3.5.8 is the
upstream security fix, while Node 22.23.2 remains the latest published 22.x
release and the [Node 3.5.8 update](https://github.com/nodejs/node/pull/65542)
is still open; see the [OpenSSL 3.5 release
notes](https://www.openssl-library.org/news/openssl-3.5-notes/index.html) and
[Node release list](https://nodejs.org/en/blog/release). The completed build
passed its historical two-hour source-freshness gate before
`2026-08-26T23:06:14Z`; the gate was not weakened.

### Step 13.2 — Three Bosses WebGL integration and production preparation

Status: Desktop Alpha released; mobile polish and acceptance in progress. The
Games card, route, external development asset server, Unity loader, and first
live browser launch/re-entry/fullscreen checks were implemented on 2026-08-25.
The production path now uses a same-origin,
content-addressed Firebase Hosting release plus a no-store stable manifest,
Firebase-managed transport compression, exact MIME/cache headers, a
source-bound release certificate, and
offline plus hosted-byte validation. A fresh production candidate was built,
packaged, validated through the Firebase Hosting emulator, and started in a
real Chrome canvas on 2026-08-29, and the desktop WebGL route was subsequently
published with Alpha 0.6.0. The full three-level hands-on browser matrix below
remains a gate for the next Three Bosses release. On
2026-08-31, the Alpha score path gained a server-issued, user/run/version-bound
30-minute ticket, a 10-second minimum completion bound, exact-replay safety,
and one authenticated HTTP/MySQL integration covering ticket issuance,
submission, replay, personal best, and leaderboard readback.

Three Bosses is published for desktop and locally playable at
`/games/three-bosses`. Before the next release, complete the remaining hands-on
gameplay matrix, mobile-device acceptance, and a signed-in canonical submission
check. Merge and publish only after Mike separately approves that release.

Keep `/games/three-bosses` as the stable browser-facing local URL. Updating the
game replaces the build at the same external location, so it normally does not
require a new browser-facing link. Internal Unity loader, data, framework, and
WebAssembly filenames may change between builds, especially if hashed filenames
are later enabled; the React loader must resolve the current generated build
configuration instead of hard-coding asset filenames. Keep generated WebGL
output outside the repository at
`%LOCALAPPDATA%\mickeyf.com\three-bosses-webgl`, serve it only on loopback at
`127.0.0.1:4174`, and proxy it through the Vite development server at
`/__local/three-bosses/`. Register the card and route only when both
`import.meta.env.DEV` and `VITE_ENABLE_THREE_BOSSES_LOCAL=1` are true. Release
builds instead require both `import.meta.env.PROD` and
`VITE_ENABLE_THREE_BOSSES_RELEASE=1`, and load the packaged same-origin player
from `/unity/three-bosses/`. The local prototype notice and
`/__local/three-bosses/` path are development-only; PR and Firebase release
workflows reject a production bundle containing either one. The integration
must:

- add a Three Bosses entry to the local Games page and a dedicated game page
  that follows the existing site's layout, typography, spacing, controls, and
  responsive conventions;
- load the Unity WebGL build from a deterministic local asset location through
  a small React-owned loader that reports loading progress and useful failures,
  disposes the Unity instance when the route unmounts, and never creates a
  second running instance during development remounts;
- provide an appropriately sized game frame plus clear focus and fullscreen
  controls without trapping normal website navigation;
- display the provisional S–D ranks and arcade-scale score while keeping the
  server's default fail-closed and verifying the separately deployed runtime
  opt-ins before every release;
- keep development WebGL output outside the repository; create production
  output only with `three-bosses:webgl:release:build`, then package the
  certified bytes into one content-addressed release plus the stable manifest
  with `three-bosses:webgl:package`; and
- validate the packaged release before the frontend build, then verify Firebase
  preview bytes, headers, CSP, negotiated compression, MIME types, cache policy,
  and actual Unity startup before promotion.

Before each build, require the Unity Editor to be ready, stopped, and not
compiling. Afterward, review Git status and reject incidental `ProjectSettings`,
asset, scene, prefab, or `.meta` changes. Test the production-style WebGL build
through the real local frontend rather
than opening Unity's generated `index.html` directly. Run the normal local
frontend, backend, database proxy, and WebGL asset server together so existing
authentication checks are healthy; a disconnected-backend `Failed to fetch`
message is not an acceptable clean-console result. Use the local browser to
inspect the new Games entry and game page at desktop, narrow/mobile, and
ultrawide sizes. Narrow/mobile acceptance covers the responsive website shell;
the 2026-08-29 shell audit added gesture isolation to the canvas and removed
page-only glass framing from fullscreen. The internal gameplay reference remains
intentionally fixed at 1280 × 720 after the 2026-09-04 resolution audit. A
1920 × 1080 Pixel Perfect reference would expose 50% more world at the existing
32 pixels per unit and change gameplay; future sharpness work must stay
render-only unless a world-framing redesign is explicitly approved.
Movement, jump, dash, aim, and fire now route through shared actions, and one
native touch HUD is reused across all three boss scenes on the polish branch.
Until that slice passes real Android and iOS multitouch, rotation, safe-area,
fullscreen, performance, and scene-transition checks, production gameplay
acceptance remains desktop.
Verify direct navigation and refresh, loading and error states,
canvas scaling, focus recovery, keyboard controls, fullscreen enter/exit,
audio on/off persistence, pause/background behavior, all three boss levels,
defeat/retry/menu flows, completion, route exit/re-entry, browser Console and
network errors, and that the rest of the website still works. Record any
remaining hands-on gameplay or browser-specific defects before public-release
work begins.

The Alpha 0.6.0 pre-release pause slice is implemented in all three battle
scenes: a compact pause-icon button opens a simple Resume/Main Menu overlay. User
pause and browser-visibility pause compose safely, gameplay input is gated,
and gameplay, active-combat timing, and audio restore only after every active
pause reason is released. The pause button, panel, and actions received the same
procedural translucent-glass design as the mobile HUD in commit `c7b9973f`.

Three Bosses desktop onboarding now includes a concise glass keybindings strip
below the game on desktop-sized layouts only. It documents the primary movement,
aiming, jump, dash, fire, and pause bindings without obstructing the canvas, and
its regression test checks those labels against the Unity Input System asset so
the guide cannot silently drift from the game. The polish branch now supplies
mobile guidance through its icon-based touch HUD.

Inter-boss split presentation was completed on 2026-09-04. The Bee and Cyborg
transition screens now show the cumulative active-combat time recorded at that
boss defeat, using the same canonical timer formatting and each scene's accent
color. The completion screen's existing total time remains the final Kraken
split, so this presentation change does not alter timing, scoring, ranks, or
submission behavior.

Deferred Three Bosses mobile UI polish: center the text groups in
`Transition_BeeToCyborg`, `Transition_CyborgToKraken`, `Defeat_Bee`,
`Defeat_Cyborg`, and `Defeat_Kraken` at portrait aspect ratios without changing
their desktop composition. Verify every affected screen on Android and iOS
before enabling public mobile gameplay.

For Alpha 0.6.0, playable Three Bosses is desktop-only. Recognized Android and
iOS browsers do not receive the Games card, and direct mobile navigation shows
an explicit desktop-only message without instantiating Unity. The Three Bosses
leaderboard remains available on mobile. Narrow desktop windows and Windows
touch laptops remain supported. The local preview now has verified Android
joystick, action-button, and pause interactions, but public mobile gameplay still
waits for the complete Android/iOS, all-scenes physical-device acceptance pass.

The battle-scene spawn correction was completed in commit `c0bd6d35`: all
three scenes now begin at the grounded position, and `PlayerMotor` baselines its
grounded state before evaluating landing feedback. The fresh external WebGL
build was loaded and browser-verified on 2026-09-01; countdown timing and
legitimate airborne-to-ground landing feedback remain covered by regression
tests.

Three Bosses loading presentation polish was completed on 2026-09-01. The
lightweight, CSS-only glass surface uses the three encounter colors, geometric
signals, and Unity's real loading progress without adding a duplicate image
download. Errors retain a dedicated alert surface, reduced-motion users keep a
static presentation, and the React layer releases before Unity's `Made with
Unity` splash so the two layers never overlap.

Website presentation polish: **completed and browser-verified on 2026-08-25**.
At a 1920 × 1080 desktop viewport, the Three Bosses frame now matches the
existing p4-Vega canvas footprint and heading scale. This reduces only the
website page heading above the canvas; the title inside the Unity main menu is
unchanged.

### Multi-game leaderboard redesign

Redesign `/leaderboards` as a multi-game experience rather than extending the
current p4-Vega-only list in place.

Frontend hub, generic reads, and the fail-closed submission transport:
**implemented on 2026-08-26, connected to Unity on 2026-08-29, and published
with Alpha 0.6.0**. The plural route contains catalog-driven
leaderboard cards, each linking to its own direct detail route. These are
leaderboard destinations, not playable game cards; game launching remains
under `/games`. The p4-Vega detail now uses the generic GET API, while Three
Bosses reads typed real rows and derives S–D ranks while the backend retains a
fail-closed default. The browser transport, lifecycle-safe Unity bridge,
Unity caller/receiver, and end-screen submission state machine are connected.
The 2026-08-31 release candidate adds a server-signed run-start ticket kept only
in browser memory, binds it to the authenticated run, and rejects impossible or
expired completion claims before persistence.
Transport tests, production build, and desktop plus narrow browser checks pass.
Production storage, generic backend reads, and both submission paths are
deployed. A 2026-09-04 read-only live check found Three Bosses advertised as
enabled, authenticated boundaries reachable for both games, and database-backed
rows on both leaderboards. A fresh signed-in write/replay/readback check remains
required for each release candidate.

#### Leaderboard submission status verification

Before declaring either game submission path healthy for a release, verify one
fresh matrix rather than inferring deployed state from source configuration:

- record the local `P4_VEGA_SCORE_SUBMISSIONS_ENABLED` and
  `THREE_BOSSES_RUN_SUBMISSIONS_ENABLED` values and confirm the matching catalog
  and endpoint behavior;
- inspect the traffic-serving Cloud Run revision and its actual runtime values;
- verify signed-out rejection, then perform signed-in p4-Vega submission and
  Three Bosses ticket, submission, exact replay, personal-best, and leaderboard
  readback checks; and
- reconcile the observed state with `cloudbuild.deploy.yaml`. A tracked `true`
  value is a deployment intention, not proof of the currently serving revision.

The design must include:

- a clear, responsive game selector, such as tabs, cards, a dropdown, or
  direct game-specific routes;
- direct-linkable game selection;
- game-specific score, time, and rank labels and ranking rules;
- independent loading, empty, and error states for each game;
- storage and API contracts keyed by a stable `gameId`;
- a backward-compatible migration that preserves existing p4-Vega scores;
- authenticated, validated, idempotent Three Bosses score submission; and
- desktop and mobile tests covering selection, sorting, refresh, empty states,
  failures, and preserved legacy results.

Do not assume that scores from different games have the same meaning or can be
ranked together.

## Phase 14 — Site information architecture, feedback, responsiveness, and literal-dark redesign

**Core redesign completed and published with Alpha 0.6.0.** Preserve the
existing Sass architecture, sparse compositions, generous whitespace, Space
Mono/Space Grotesk typography, and quiet outlined interactions. Use deep
navy/black as the foundation and retain the existing light blue, green, and
cyan palette as restrained stars, nebulas, borders, and interaction highlights.
Broader physical-device acceptance and the deferred enhancements below remain.

Work in this order:

1. Establish the shared animated space background with a static reduced-motion
   fallback and no additional canvas or GPU renderer. Its refined version uses
   seeded star atlases, small transparent realistic galaxies, nebulae, quasars,
   and stellar dust shells, mathematically closed animation and glow loops,
   restrained ambient color, and shared dark surface colors.
   **Implemented and verified on 2026-08-28.**
   The dedicated celestial-glow polish pass was implemented and browser-verified
   on 2026-08-28 with independently staggered silhouette auras and core breathing,
   plus static reduced-motion and canvas-route performance safeguards.
2. Redesign Home while preserving its minimal welcome-and-quotes identity.
3. Continue page by page, including the information-architecture and feedback
   work below, without globally restyling unfinished pages.
4. Make the shared shell and ordinary page content responsive last.
5. Apply a CSS-first responsive display pass to the animation and game canvases
   while preserving their fixed 16:9 internal worlds. If that expands into
   dynamic renderer resizing, touch controls, or a large Dancing Fractals panel
   redesign, defer that subproject and finish Three Bosses scoring plus its
   production asset/route/bridge publication work before the approved push to
   `main`. Visual canvas fit and true mobile playability are separate scopes.

The header's information architecture must:

- group Animations, Games, and Leaderboards into an accessible
  **Entertainment** dropdown;
- group Login and Sign up into an accessible **Account** dropdown, with the
  username and Logout represented coherently when authenticated;
- make the navigation genuinely responsive and verify keyboard, focus, and
  disclosure behavior;
- replace **Social** with one **Connect** destination that combines the existing
  external-profile links with a clearly separated user-feedback form; handle
  the existing route deliberately when that page is redesigned;
- keep the current provider-neutral email composer unless direct server-side
  submission is later approved; that replacement would require validation,
  abuse/rate limiting, and an explicit privacy and retention policy; and
- after the navigation and content structure are settled, redesign the full
  website with a more professional, responsive, literally dark visual theme.
  "Dark" here means a deliberate dark color palette with readable contrast,
  not a gloomy or moody creative direction.

The desktop glass header and its information architecture were implemented and
browser-verified on 2026-08-28: Home, Entertainment, Connect, and Account now
form the top level; both dropdowns use active states, outside-click and Escape
dismissal, focus restoration, a reduced-motion-safe slide, and authenticated
Account content in place of the old corner label. The final responsive phase
still owns full mobile-device navigation acceptance, but the compact glass
header is now visible and browser-verified on the existing vertical web layout.

The Dancing Circles visual pass was implemented and browser-verified on
2026-08-29. It removes the visible page title, preserves the PIXI/audio logic,
adds a transparent canvas with an accessible glass control rail, provides a
dark-blue breathing background and a full in-page color picker, and keeps the
fullscreen presentation consistent. Its desktop and vertical web layouts are
complete for this redesign phase; broader physical-device and canvas
responsiveness remain in the final responsive phase.

The Dancing Fractals visual pass was implemented and browser-verified in both
the vertical in-app layout and desktop Chrome on 2026-08-29. The canvas,
stationary audio transport, fractal selector, configuration controls, and
statistics now use the shared glass system; the visible title is removed while
the accessible heading remains. The vertical canvas frame matches the control
panel width, the desktop grid reserves independent panel and stage columns,
and auto-dispose now defaults to off. Fractal rendering and audio behavior are
otherwise unchanged.

The canonical `/connect` profile hub was implemented and browser-verified on
2026-08-28 with accessible external-profile links and the shared glass-card
system; the retired `/social` route now resolves through the ordinary Not Found
page. Its feedback composer opens the visitor's configured email handler with a
prefilled message, so the website stores and transmits no feedback itself. A
future server-submitted replacement remains deferred until its validation,
abuse controls, privacy language, and retention policy are designed together.

The Login page's glass form shell was implemented and browser-verified on
2026-08-28 with visible field labels, password-manager autocomplete hints,
custom cursor continuity, and a static reduced-motion-safe panel. Its existing
authentication requests, alerts, loading guard, and success redirect remain
unchanged. The companion Sign up pass replaces `/register` with `/signup` and
retires the legacy form mixin without changing the registration contract.
Alpha 0.6.0 authentication hardening keeps the login JWT exclusively in the
signed HTTP-only session cookie; the successful login JSON now returns only
`success` and `user_name`. Existing cookie authentication and the backend's
Bearer-token compatibility path remain unchanged.

An optional **Stay signed in for 30 days** Login control is approved but still
open. Unchecked sessions must retain the current four-hour lifetime; checked
sessions may use a server-controlled thirty-day JWT and signed HTTP-only cookie
without storing passwords or preferences in browser-readable storage. The
stateless token's lack of per-session revocation must be tested and recorded as
an accepted risk before this item is closed.

## Phase 15 — p4-Vega improvement and mobile polish

Begin this phase after the current Three Bosses polish milestone is stable.
Preserve p4-Vega's existing score rules and keyboard behavior while improving
the game incrementally:

- add a real pause button and a simple pause menu with explicit, testable pause
  state transitions;
- stop the canvas from swallowing ordinary vertical touch-scroll gestures, so a
  visitor can scroll the page even when the gesture begins over the canvas,
  while preserving deliberate interactions with actual game controls;
- audit and prioritize further upgrades to game feel, onboarding, controls,
  visual and audio feedback, performance, responsive/fullscreen behavior, and
  score/leaderboard UX rather than committing to speculative rewrites; and
- verify keyboard behavior plus real Android and iOS touch, orientation,
  scrolling, and fullscreen behavior before release.

## Phase 16 — Whole-project Clean Code sweep

After Three Bosses and the p4-Vega improvement phase are stable, inspect every
tracked first-party source, test, configuration, and documentation area using
Robert C. Martin's *Clean Code: A Handbook of Agile Software Craftsmanship* as
a review reference. The user-provided local copy is
`C:\Users\User\Desktop\Pastas\Books\CleanCode.pdf`. Inventory generated,
vendored, and third-party files, but do not refactor them as if they were owned
source.

This is an evidence-led, subsystem-by-subsystem cleanup, not a blanket rewrite.
Preserve behavior, public APIs, database schemas, migration history, and release
contracts; identify dead, duplicated, over-specific, or misplaced code; improve
names, function and class responsibilities, dependency boundaries, error
handling, comments, formatting, and tests where the evidence supports it. Keep
each subsystem change reviewable and run its complete relevant checks before
moving to the next one. The user-provided PDF is a local reference only and must
not be copied into the repository.

## Deferred tooling follow-up

- TypeDoc drift CI guard: **deferred by owner decision on 2026-08-25**.
  Documentation generation is deterministic as of commit `7386191a`. If this
  work resumes, add a `docs:check` command that regenerates the tracked output
  and fails on unexpected output, canonical source-link, local-reference, or
  line-ending drift. This is preventative tooling and does not block current
  Three Bosses work.
