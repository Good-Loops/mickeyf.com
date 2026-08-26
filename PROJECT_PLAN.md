# Active project plan

This tracked roadmap records the active continuation of the broader migration
and game plan. Detailed implementation decisions remain subject to review at
each phase boundary.

## Phase 12 — Three Bosses local game flow

- Steps 12.1–12.9: implemented on the phase branch and undergoing gameplay and
  presentation polish.
- Step 12.10 — rank calibration: **deferred by owner decision on 2026-08-18**.
  Keep results `UNRANKED`; do not invent thresholds. Resume after several
  representative normal human completion times are available and after run
  timing semantics and transition pacing are finalized. This remains a
  pre-release gate but does not block Phase 13 implementation while rank output
  stays `UNRANKED` and score submission stays disabled.
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
    pickup, and full normal-route check remains before release.

Phase 12 release acceptance still requires Step 12.10, the remaining hands-on
gameplay check, passing Unity compilation and automated tests, clean asset/meta
integrity, and a verified complete normal route. Per the owner's sequencing
decision, those release gates may remain open while Phase 13 is implemented,
provided ranks remain `UNRANKED` and submission remains disabled.

## Phase 13 — Website and leaderboard integration

The local Three Bosses result flow is stable enough for integration work.
Continue Phase 13 on `feature/new-leaderboard`. Completing this broad branch
does not authorize a merge or push to `main`: create the next broad feature
branch from its final commit and retire the old branch instead. Keep `main`
deferred until the Phase 14 site-wide responsive, information-architecture,
and literal-dark redesign is complete and separately approved.

### Step 13.1 — multi-game contract and migration design

**Approved by Mike and live-schema-preflighted on 2026-08-24.** The
server-owned contract uses stable
`p4-vega` and `three-bosses` identifiers. p4-Vega remains score-descending on
its unchanged legacy endpoint. Three Bosses is completion-time-ascending but
remains `UNRANKED` with submission disabled. Persistence will use an immutable
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

The local generic-only grant contract was completed on 2026-08-26. p4-Vega and
Three Bosses now share one database-scoped advisory lock per authenticated user,
acquired before their transaction and released after commit or rollback. An
indeterminate acquisition, release, or rollback invalidates the pooled session,
so neither repository needs `users SELECT ... FOR UPDATE`. The source manifest
now omits `p4_score` entirely and grants no `UPDATE` on `users`. A restricted
MySQL 8.0.31 fixture creates `users` without the legacy column, exercises auth
and both leaderboard repositories, and proves a direct user-row locking read is
denied. Repository concurrency and rollback tests still pass. This was local
code-and-test work only: production remains on the frozen dual writer with its
older transitional `p4_score` grants. The current grant planner deliberately
blocks those now-unexpected grants rather than revoking them, so their live
retirement still requires a separately reviewed exact revoke operation or
equivalent verified maintenance procedure.

The transitional p4-Vega write path was implemented and verified locally on
2026-08-25. That candidate updated `users.p4_score` and
`game_personal_bests` atomically on one acquired connection; either write
failure rolled the transaction back, concurrent submissions converged on the
same maximum, and the legacy HTTP response remained unchanged. The exact
freeze-capable composition first served production with writes enabled. The
same immutable image now serves in the frozen dual-writer revision recorded
below, and the enabled revision is retired.

The active transitional read split was corrected and reverified on 2026-08-26
at `a127beac14c2662648c8aededa59374f5d7c87dd`. While this dual writer is
serving, the legacy `/api/users` `get_leaderboard` operation deliberately keeps
reading `users.p4_score`; the additive `/api/leaderboards/p4-vega` route reads
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
the image-only Cloud Build contract tests pass. This source is not deployed;
production remains on the frozen dual writer, and the production column and
transitional grants are unchanged. The column-drop integration case proves code
and schema independence under the migration-test account; the separate
restricted-runtime fixture now proves the same generic-only paths under the
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
bounded acceptance only to those two rollout stages. It does not cover a future
generic-only image; refresh the pinned runtime or repeat the explicit review
before that deployment.

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
identity was deleted. This establishes the enabled dual-writer phase only; the
legacy read and `users.p4_score` remain in service.

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
still routes 100% to the enabled dual-writer revision with no tags; the frozen
revision is retained retired at zero traffic. No production freeze occurred.

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

The Phase 13.1 repeatable, privileged p4-Vega historical-backfill CLI and
separate read-only aggregate reconciliation gate were implemented and verified
locally on 2026-08-25. The backfill is operational tooling rather than an HTTP
endpoint or numbered schema migration so it can be repeated after the dual
writer is deployed and again after every legacy-only revision drains. It
copies all non-null historical scores monotonically without fabricating run
history; the
reconciliation reports only aggregate equality and missing, extra, score, and
metadata discrepancy counts plus unexpected p4-Vega run/rules counts, never
player identities. Before writing, the command refuses target-ahead scores,
extra rows, metadata anomalies, run-ledger rows, and unexpected rules versions
rather than guessing how to repair them. Every pass reuses the verified
personal-best migration timestamp, so retries remain stable.

The generic p4-Vega `get_leaderboard` path is now the single local reader for
both HTTP APIs. Its request, legacy response fields, ten-row bound, cache
behavior, and numeric historical scores remain compatible. The additive schema,
enabled dual-writer deployment, legacy-only revision drain, repeatable backfill,
zero-discrepancy reconciliation, and production freeze are complete. This code
has not been deployed: the serving frozen dual-writer revision still uses the
transitional legacy reader, and production `users.p4_score` remains present.
The generic-only production cutover and column removal remain incomplete; the
multi-game frontend is recorded below.

The additive backend catalog and per-game routes were implemented and verified
on 2026-08-26. The catalog is projected from server-owned definitions;
the generic p4-Vega response adds only version metadata and one-based positions
to existing rows. Three Bosses reads now query real current-rule personal bests
in deterministic completion-time order even while writes are disabled. Its
authenticated run endpoint is complete behind the exact fail-closed
`THREE_BOSSES_RUN_SUBMISSIONS_ENABLED=true` opt-in: strict JSON/version/UUID/time
validation, explicit cookie-origin protection, server-derived score, immutable
idempotent run history, transactional strict personal bests, and per-user and
per-IP limits are covered by unit, security, rollback, concurrency, and
isolated-MySQL tests. Rank remains `UNRANKED`. These routes have not been
enabled for Three Bosses production writes: the routes are present in the
serving frozen dual-writer revision, but
`THREE_BOSSES_RUN_SUBMISSIONS_ENABLED=false` remains enforced. They do not
replace the remaining p4 cutover or reconciliation gates.

The credential-safe browser submission client and Unity host bridge were
committed at `c4349f7c`. Unity will later send only its canonical run ID and
integer completion time; browser-managed cookies never enter the game binary,
and uncertain results retry with the same identity. The Unity `.jslib` caller,
result receiver, one-source millisecond canonicalization, score/rank parity,
and Submit Score button activation remain deliberately disconnected until the
Three Bosses gameplay and ranking release gates are approved.

The frozen dual writer now serves 100% of production traffic, the enabled
revision and its infrastructure are retired, active runtime transactions were
zero, and the exact frozen reconciliation completed with five matching rows and
no discrepancy. The local generic p4 and Three Bosses lock dependency has been
removed, the source runtime manifest omits `p4_score`, and the no-column
restricted fixture passes. The next local prerequisite is the exact retirement
path for the old live column grants. The next rollout step must then separately
approve deploying the
generic-only writer while it remains frozen, route all traffic to that
exact revision, retire every dual-writer revision, require the serving HTTP 503
contract, and rerun exact reconciliation against the still-static legacy
column. Only then may a separately approved enabled generic revision accept
scores. After generic-only traffic starts, legitimate improvements make exact
equality with the stale legacy column impossible; rollback must use a
generic-authoritative compatible revision or a forward fix, never a dual
writer. After every code, job, tool, grant, and rollback reference is removed,
a new immutable migration may drop `users.p4_score` under separate production
approval. The initial additive migrations remain unchanged.

### Step 13.2 — local Three Bosses website playability prototype (no publication)

Status: In progress. The development-only Games card, route, external asset
server, Unity loader, and first live browser launch/re-entry/fullscreen checks
were implemented on 2026-08-25. The full three-level hands-on browser matrix
below remains a release gate; no WebGL build or route has been published.

Before any public release, add Three Bosses to the website on the feature
branch and prove that the actual Unity WebGL game is playable through the
local site. This is a local integration and evaluation step only: do not merge
it to `main`, publish the WebGL build, change Firebase Hosting, or expose a
production game route until Mike separately approves release.

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
`import.meta.env.DEV` and `VITE_ENABLE_THREE_BOSSES_LOCAL=1` are true. Keep the
flag unset in CI and production builds. The integration must:

- add a Three Bosses entry to the local Games page and a dedicated game page
  that follows the existing site's layout, typography, spacing, controls, and
  responsive conventions;
- load the Unity WebGL build from a deterministic local asset location through
  a small React-owned loader that reports loading progress and useful failures,
  disposes the Unity instance when the route unmounts, and never creates a
  second running instance during development remounts;
- provide an appropriately sized game frame plus clear focus and fullscreen
  controls without trapping normal website navigation;
- keep ranks `UNRANKED` and score submission disabled during this prototype;
- keep generated build output separate from hand-authored source and document
  the repeatable external build and local-serve commands before deciding which
  artifacts, if any, should later be versioned or deployed; and
- identify any Content Security Policy, compression, caching, MIME-type, or
  static-path changes that a future deployment would require, but do not apply
  production hosting changes during local playability testing.

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
gameplay acceptance remains desktop while the game requires keyboard controls.
Verify direct navigation and refresh, loading and error states,
canvas scaling, focus recovery, keyboard controls, fullscreen enter/exit,
audio on/off persistence, pause/background behavior, all three boss levels,
defeat/retry/menu flows, completion, route exit/re-entry, browser Console and
network errors, and that the rest of the website still works. Record any
remaining hands-on gameplay or browser-specific defects before public-release
work begins.

Future gameplay polish, deferred until after the current local playability
work: add an in-game pause button and a simple pause menu. Pausing must freeze
gameplay, active-combat timing, and audio consistently, and Resume must restore
them cleanly.

Website presentation polish: **completed and browser-verified on 2026-08-25**.
At a 1920 × 1080 desktop viewport, the Three Bosses frame now matches the
existing p4-Vega canvas footprint and heading scale. This reduces only the
website page heading above the canvas; the title inside the Unity main menu is
unchanged.

### Multi-game leaderboard redesign

Redesign `/leaderboards` as a multi-game experience rather than extending the
current p4-Vega-only list in place.

Frontend hub, generic reads, and the disabled submission transport:
**implemented locally on 2026-08-26**. The plural route contains catalog-driven
leaderboard cards, each linking to its own direct detail route. These are
leaderboard destinations, not playable game cards; game launching remains
under `/games`. The p4-Vega detail now uses the generic GET API, while Three
Bosses reads typed real rows and remains unranked and submission-disabled. The
browser submission transport and lifecycle-safe Unity bridge are complete but
the Unity caller and button remain disconnected. Transport tests, production
build, and desktop plus narrow browser checks pass. A disposable loopback API
verified the populated p4-Vega table without applying approval-gated database
migrations; the unmigrated live local p4 read correctly remains in its bounded
server-error state. The complete route/UI mobile matrix, production migration,
deployment, and Unity submission activation remain separate pending steps.

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

## Phase 14 — Site information architecture, feedback, responsiveness, and literal-dark redesign (deferred)

After the current leaderboard and migration work, redesign the header's
information architecture as a separate site-wide task:

- group Animations, Games, and Leaderboards into an accessible
  **Entertainment** dropdown;
- group Login and Register into an accessible **Account** dropdown, with the
  username and Logout represented coherently when authenticated;
- make the navigation genuinely responsive and verify keyboard, focus, and
  disclosure behavior;
- choose a clearer replacement name for **Social** before changing that area,
  including deliberate handling of the existing route;
- add a dedicated user-feedback page with server-side validation, abuse/rate
  limiting, and an explicit privacy and retention policy; and
- after the navigation and content structure are settled, redesign the full
  website with a more professional, responsive, literally dark visual theme.
  "Dark" here means a deliberate dark color palette with readable contrast,
  not a gloomy or moody creative direction.

## Deferred tooling follow-up

- TypeDoc drift CI guard: **deferred by owner decision on 2026-08-25**.
  Documentation generation is deterministic as of commit `7386191a`. If this
  work resumes, add a `docs:check` command that regenerates the tracked output
  and fails on unexpected output, canonical source-link, local-reference, or
  line-ending drift. This is preventative tooling and does not block current
  Three Bosses work.
