# Active project plan

This tracked roadmap records the active continuation of the broader migration
and game plan. Detailed implementation decisions remain subject to review at
each phase boundary.

Current release state (published 2026-09-09 local): see the
[cumulative release/security ledger](RELEASE_READINESS.md). It supersedes stale
pending claims in the dated history below. Named cleanup and the bounded script
audit are complete. Owner-approved PR #322 passed its required checks and CodeQL,
merged as `c94c5de5`, and Firebase run `34305326963` successfully published the
tested Three Bosses package with public mobile gameplay enabled. Hosted
runtime/header checks, gzip negotiation and mobile-emulated Chromium startup
passed; the temporary Hosting preview was deleted. The continuing polish branch
is preserved and synchronized; the already-deployed backend is unchanged. The combined
fresh-load/landscape phone observation is complete: the owner reported about
10 seconds to load and correct Fire/fullscreen-exit behavior on the local
release-candidate preview. This is not a production CDN timing measurement.
S5's exact three-policy/channel readback passed
at 2026-09-09 02:12:46 UTC without cloud changes; it is closed.
No accepted gameplay check is reopened by this reconciliation.
The owner approved S8's exact receipt-image OpenSSL exception through 2026-10-07,
subject to the ledger's earlier reassessment triggers. This is bounded risk
acceptance, not remediation or authorization for a new image/deployment. Do not
repeat the unchanged source/component review without a trigger or expiry.

Focused Three Bosses preparation (2026-09-08): the redundant generic
login/submission blocker is removed; preserve the owner's published-site
confirmation and existing backend receipt/retry acceptance. The short-16:9
exit/Fire hit-area overlap was confirmed and corrected in host CSS, with five
focused style tests and two before/after Chromium layout sizes, not a full
gameplay replay. Unity source/package is unchanged. Ten weapon definitions and
all 21 expected audio references resolve; exhaustive listening/game-feel coverage
is deferred, not represented as manually verified. See the ledger for measured
layout tradeoffs. In the subsequent owner phone check, the existing Front
terminal was restarted with the certified candidate and LAN access; backend
and Docs stayed running. The owner accepted the fresh-load/touch spot-check.
No public mobile gate, account, score or deployment changed.

Current storage checkpoint (2026-09-08): the receipt-based backend is implemented
on `feature/three-bosses-polish` and its production schema/grant cutover is
complete. The accepted receipt-compatible image now serves normal traffic with
both score-submission flags true after the approved production promotion.
Permanent `game_personal_bests` are
independent of short-lived `game_submission_receipts`; Three Bosses retry and
rate-limit receipts have a minimum 24-hour retention. The bounded cleanup job
passed its controlled production run; hourly scheduling and the missing-success
watchdog are now enabled. The final scheduling checkpoint is recorded below.
Historical paragraphs below describing the immutable `game_runs`
ledger remain deployment history, not the new design. See
[`backend/RECEIPT_RETENTION.md`](backend/RECEIPT_RETENTION.md) for the storage
contract, guarded migration/recovery workflow and scoped security disposition.

Approved cutover completed at `2026-09-08T19:26:19.570Z`: fresh successful
backup `1788894880118`, verified writer drain, and guarded migrations 0004/0005
preserved all seven personal bests and five receipts with identical canonical
hashes. All five migrations are recorded; none are pending or recoverable.
The runtime has exactly the reviewed column-level privileges (no DELETE), and
the operator's existing DML rights moved from `game_runs` to
`game_submission_receipts`. Public ingress is restored, Cloud Run generation
130 retains the same frozen image/revision and 100% traffic, and IAM is unchanged.
Both temporary accounts are removed. The original VS Code `back` workload is
running again; frontend, WebGL and SQL proxy listeners were preserved. Public
and local read/frozen-gate checks passed, with identical public board hashes.
Enabled backend acceptance completed at `2026-09-08T19:49:40.355Z` under separate
user approval. A private, temporary Cloud Run service used the same verified
image with both submission flags enabled and one disposable website account.
All 64 HTTP assertions passed: signed-cookie login, real server run tickets,
canonical submissions, exact retries, payload conflict, worse/better scores,
the ten-new-runs database limit, and both leaderboard readbacks. Three Bosses
created ten receipts and one best; p4-Vega kept one best without receipts.
The service was deleted, then only that account's ten receipts, two bests and
user row were removed under the shared user lock and a transaction. The original
seven bests/five receipts, public board responses and production config/IAM
matched their baselines. No browser/gameplay or Safari-cookie test is claimed.
Temporary execution helpers were removed; non-secret evidence is outside the
repository. That acceptance batch left normal traffic frozen at generation 130.

Approved production promotion completed at `2026-09-08T20:01:05.143Z`:
`mickeyf-org-scores-9ec1bd83-0908` uses the same verified image and serves 100%
of intended and observed traffic at generation 132. Generation 131 first staged
it with zero traffic; only the two submission flags and required revision name
changed. All 36 live rollout assertions passed across both public backend
origins, including enabled/authentication gates, leaderboard reads and trusted
website CORS. Public board hashes were unchanged during these checks. No new
synthetic writes, credentials, SQL/schema/grant changes or frontend/Unity builds
were needed. IAM, ingress and other runtime settings are unchanged, deployment
automation is still paused, and the receipt-compatible frozen revision remains
Ready for rollback. The temporary promotion helper was removed; only non-secret
evidence remains outside the repository.

Receipt-cleanup manual acceptance completed (2026-09-08 local;
`2026-09-09T00:03:00.282Z` closeout). The owner confirmed both alert emails.
The dedicated proxy-only SQL account has exactly three-column SELECT plus
DELETE on receipts, with no roles or access to personal bests. Its pinned secret
is accessible to the cleanup identity, which has only Cloud SQL Client at the
project level. The temporary provisioning account was removed; existing SQL
accounts' grants are unchanged.

Execution `mickeyf-submission-receipt-cleanup-k2skb` succeeded and deleted all
five expired receipts, preserving the recent test receipt and all personal
bests. Authenticated retries passed before and after deletion. The disposable
account and its one best/receipt were then removed; the original seven bests
retain their exact baseline hash, with zero remaining receipts/expired rows.
An earlier safety-canceled attempt changed no existing data; it exposed a v2
execution-response mount omission, verified through the same execution's v1
Cloud SQL annotation before retrying. The post-run helper's unrelated row-key
assertion was reconciled read-only, without another cleanup execution.
That manual checkpoint left the job disabled at generation 6, with no hourly
schedule or scheduler identity and the no-success watchdog unarmed. Production
generation 132, traffic, score flags, schema and paused deployment automation
were unchanged. The subsequent approved activation below supersedes this state.

Hourly activation completed at `2026-09-09T00:27:08.024Z` (2026-09-08 local):
cleanup generation 7 is enabled, the UTC-hourly Scheduler is enabled, and the
two-hour missing-success watchdog is armed alongside the delivered failure
alerts. Its separate caller has Run Invoker on this job only, with no SQL,
secret or project-level role. The Google-managed Scheduler service agent keeps
its required service-agent role. The forced Scheduler-to-Job acceptance passed:
`mickeyf-submission-receipt-cleanup-v27kx` completed successfully at
`2026-09-09T00:32:57.235029Z`, deleting zero rows with no backlog. Before/after
read-only snapshots preserve all seven bests, zero receipts, user count and
scoped table definitions; production generation 132 and deployment automation
remain unchanged. No application rebuild or new disposable account was needed.
The first natural hourly tick is now verified (2026-09-08 local): Scheduler's
`2026-09-09T01:00:19.548160Z` attempt returned HTTP 200 and created distinct
execution `mickeyf-submission-receipt-cleanup-zjpfg` through the exact approved
caller. It completed at `01:01:22.324316Z`, with one successful task, zero deleted
receipts and no errors/backlog. Its pinned native v1 template and Cloud SQL/
secret annotations match the accepted execution and current generation-7 Job.
The enabled hourly configuration and production generation 132 with 100% traffic
to the accepted revision are unchanged. No extra run or fresh SQL check occurred.
The limited alert recheck initially lacked complete CLI/browser evidence.
It is now closed: read-only Monitoring API GETs at 2026-09-09 02:12:46 UTC
matched all three policies' filters, thresholds, aggregation, missing-data
behavior, alert strategies and channel IDs to the activation snapshots.
The enabled email channel matches the approved recipient. No test alert or
cleanup run was dispatched; prior owner-confirmed delivery remains the evidence.
One-time follow-up `verify-first-hourly-receipt-cleanup` was deleted after the
checkpoint was synced; removal is verified. Conversation and non-secret JSON
evidence are preserved; the hourly cloud cleanup is not a temporary artifact.

Next: follow the current release/security ledger above. Do not repeat
the completed migration, acceptance or score promotion; do not use a pre-receipt
backend for rollback. No main merge or website deployment is authorized by this
cleanup checkpoint. The re-added bounded package-script audit is now complete;
do not resume the earlier open-ended audit.

Image review completed with user approval (2026-09-08): Cloud Build
`12ec9e8e-ff4a-493c-be8c-025423e5110c` successfully built exact source
`d1d5dbf6fcc1bedd596827a540779f437fe3501f`. Immutable image digest:
`sha256:9ec1bd83ea73a283ad36961b2dcd3022b9b0a40cbf16bd725398ff562015c3c3`.
Source/approval/provenance binding checks passed. Artifact Analysis completed
with active continuous analysis including OS, NPM and SECRET; complete direct
queries returned zero vulnerability and zero secret occurrences. This is a
dated scan result, not a promise about future advisories. The image build did
not change Cloud Run generation 126 or its existing 100% traffic allocation.

Frozen zero-traffic deployment completed with separate user approval
(2026-09-08): build `4e24e8ec-6254-4262-a068-832699ba92ba` succeeded with all
seven steps passing. Revision
`mickeyf-org-freeze-12ec9e8eff4a493cbe8c025423e5110c` is Ready with both
submission flags false. Service generation 127 keeps the original revision at
100% normal traffic and adds only the frozen candidate's zero-traffic test tag.
Runtime, provenance/scan, anonymous authentication, public leaderboard SQL reads
and frozen submission-response checks passed. Canonical Stage A/B were paused
only for deployment, then restored exactly; the manual source trigger is
unchanged and the dedicated frozen-deployment trigger is now disabled.

Existing-account backend acceptance passed at `2026-09-08T18:06:15.6709583Z`:
the operator completed login on the exact frozen HTTPS tag, the helper checked
the Secure/HttpOnly signed cookie and matching authenticated `/auth/verify-token`
response, and service generation/tag mapping remained unchanged. This accepts
the retained frozen backend rollback candidate on the existing schema; it is
not a browser cross-site cookie test. Credentials and session cookies were not
recorded in the evidence files.

Automation pause and read-only traffic planning completed with user approval
(2026-09-08): all four backend Cloud Build triggers in `global` are disabled;
`us-central1` has none. Full trigger configurations are unchanged apart from the
disabled flags, and no pending/queued/working builds remain. The reviewed plan
was generated at `18:13:03.959Z` against service generation 127. It proposes
100% traffic to the accepted frozen revision and removal of its sole test tag.
No traffic patch was sent in that planning checkpoint. The subsequent approved
traffic-only cutover completed on 2026-09-08: fresh plan
`53ce1331052791c90f4a7462235302ae9f2747e8cf9429044438a6d6ddfc6283`
changed generation 127 to 128, routing 100% to the accepted frozen revision and
removing its sole tag. Both public score-submission paths are now frozen.
Runtime/image configuration is unchanged; backend deployment triggers remain
paused. GitHub/Firebase frontend workflows were not changed.

Delayed request-drain checks at `18:26:18.852Z` and `18:26:42.707Z` were both
beyond the 300-second retiring-request limit. All eight non-target revisions
remained retired, with no post-settlement requests found in the fully paginated
log queries. Three samples passed 30 public HTTP checks total; both leaderboard
response hashes stayed identical. This closes the traffic/request checks, not
the database drain gate below.

Database visibility maintenance **completed with separate user approval** on
2026-09-08. Cloud SQL operation `3dc62fba-1eea-4604-8562-4c7600000032` enabled
`performance_schema=on` and restarted the instance; settings version changed
863 to 864, with every other setting preserved and no resize. The temporary
bootstrap administrator was removed before the restart. The inspector had only
PROCESS plus SELECT on the four approved performance-schema tables, no roles,
and was removed afterward. Permanent account grant fingerprints were unchanged
by provisioning; the original three-account inventory was restored.

Two post-restart samples at `18:52:59.580Z` and `18:53:04.750Z` verified enabled
metadata/global instrumentation, zero lost records, zero active transactions
and zero pending metadata locks. All 14 before/after public checks passed with
identical leaderboard hashes. Cloud Run generation 128, frozen score gates and
paused backend triggers are unchanged. No migration, application-data write,
runtime-grant cutover, cleanup activation or write re-enablement occurred.

At that instrumentation checkpoint, migration remained **separately gated**:
five other client sessions were present
and exclusive writer control was not established. Before DDL, approve the
migration principal/rights and write-free window, exclude external writers,
and obtain the fresh guarded plan/drain evidence. Do not repeat instrumentation
setup or reopen resolved test failures. Preserve bests, migrate, replace grants
and verify final schema/read paths; write enablement and cleanup activation
still require their own acceptance/approval. Instrumentation memory overhead
and actual outage duration were not measured by this bounded maintenance run.

Cutover preparation (2026-09-08): the existing operator's read-only consistent
snapshot at `19:00:17.660Z` contains seven personal bests (five p4-Vega, two
Three Bosses) and five Three Bosses submission records. Counts and canonical
preservation hashes are recorded in the [cutover proposal](backend/RECEIPT_RETENTION.md#consolidated-cutover-proposal-awaiting-approval).
That snapshot was not the final migration plan: the operator cannot inspect
migration history or establish complete dependency/writer visibility. No access was
elevated or live configuration/data changed during preparation. The subsequent
approval covered the temporary backend ingress barrier, local backend/operator
drain, temporary
bootstrap/admin and scoped migration access, fresh backup/final guarded plan,
exact 0004/0005 transition, runtime/operator grant update and verified restoration
of frozen service.
Login/signup/leaderboard reads will be interrupted during that window; static
content, frontend, WebGL and the local SQL proxy stay available. Preserve the
existing score freeze and leave receipt cleanup disabled.

Local drain-guard hardening completed (2026-09-08): receipt apply now refuses
disabled/inaccessible instrumentation, missing effective PROCESS, malformed
inspection results, lost lock/thread records, active transactions and pending
metadata locks before transition DDL. Empty lock tables alone cannot pass.
The [maintenance record](backend/RECEIPT_RETENTION.md#approved-instrumentation-maintenance-completed-2026-09-08)
contains the executed scope and cleanup evidence. The local CLI guard did not
require a new API image.

Latest code verification: 27 focused guard tests, all 50 disposable MySQL
integration tests, 12 focused runtime-grant unit tests, TypeScript and diff
checks passed. The session-drain fixture race is fixed: mysql2 resolves end()
before the server processes COM_QUIT, so the fixture observes removal of its
exact connection with a strict deadline. Production checks remain unchanged.
The full active-install unit run retains four known `qs` 6.15.3 versus locked
6.16.0 failures (194/198); no active dependencies were replaced. These remain
explicit release limits, not a reason to repeat the completed maintenance.

The local preparation adds `scripts/render-frozen-backend-deploy.mjs` (offline,
hash-pinned canonical derivation with strict feature-source/image provenance and
scan checks, both submission flags false, and a separate approval-required
source-less trigger; no traffic promotion/notifier) and
`scripts/frozen-backend-traffic.mjs` (fresh read-only plan, separately authorized
etag-bound traffic-only apply to the exact frozen revision, all tags removed).
Traffic pins include independently resolved offline deployment-step evidence;
copying live build steps is not an approval substitute. Authenticated Google
provenance binding is checked, not independent signature verification. The
latest completed run passed 57 frozen-rollout checks plus three existing
candidate-image and two cleanup-template contracts (62 total). Independent
review found no remaining P1/P2 findings in this change. Source/provenance checks
now pass against the actual image build after narrow URL-safe signature encoding
and exact Git/builder dependency validation corrections. The frozen deployment
also passed live, and its successful steps exactly match the independently
resolved offline fingerprint. Authenticated backend candidate acceptance also
passed; traffic cutover was complete, but database drain was still blocked at
that checkpoint. The approved database cutover above subsequently resolved it.
PR CI now invokes all these checks.
The Windows traffic CLI now explicitly invokes the installed `gcloud.cmd`
wrapper rather than the execution-policy-blocked PowerShell wrapper; no
execution policy was changed. Live read-only planning passed with system CA
trust enabled, without disabling TLS verification.
The root tooling lockfile's narrow `qs` update to 6.16.0 has an isolated audit
with zero vulnerabilities; this is not new backend-image scan evidence.

Receipt-implementation verification already recorded: 171 unit/security tests
on isolated locked dependencies, 49 local
MySQL integration tests, TypeScript, production API/cleanup bundles, five job/
image contract tests and the single docs rebuild passed. The running local
dependency install still has stale `qs` 6.15.3 rather than locked 6.16.0; refresh
it during a deliberate dev-stack stop, not by weakening its four security tests.
After that, finish the existing release/security gates, then proceed to p4-Vega
pause/touch-page-scrolling improvements and the incremental Clean Code sweep.

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

Personal database inspection/maintenance follow-up (2026-09-07): the owner
approved a separate `michel_operator@cloudsqlproxy~%` account for TablePlus.
It has only `SELECT`, `INSERT`, `UPDATE`, and `DELETE` on the three application
tables (`cms.users`, `cms.game_runs`, `cms.game_personal_bests`), with no schema-
changing, migration-history, grant-option, or role privileges. Fresh logins
through the existing authenticated loopback proxy verified all-column reads
using `LIMIT 0`; permission inspection verified row-edit grants without writing
player data. Runtime `cms_mickeyf` grants were identical before/after. The
short-lived provisioning identity was removed and a fresh operator login
passed afterward. The password is stored only in a current-user DPAPI-encrypted
file outside the repository, with current-user/SYSTEM filesystem access; no
runtime environment or application connection was changed. The owner must
finish the separate TablePlus login. Sanitized verification is in the external
Codex `release-checks-20260907/tableplus-operator-verification.json` record.

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

Three Bosses portrait outcome layout is implemented. The browser now reports
the real outer-viewport orientation to Unity, because the embedded player keeps
rendering at 16:9 even when the phone is upright. Defeat times retain their
painted-readout alignment (including the Cyborg/Kraken offsets documented below),
while the two transition split labels form a compact centered row in
the clear space between the baked logo and result heading; returning to
landscape restores every authored desktop transform exactly. The Bee defeat
screen is verified on a physical Android device and all five scenes have
automated portrait/desktop restoration coverage. Complete the remaining
hands-on scene pass on Android and iOS before enabling public mobile gameplay.

A 2026-09-04 local WebGL browser review confirmed both inter-boss transitions
and the completion screen at 396 x 1216, plus completion-screen resizing to
1440 x 900 and back without displacement or page overflow. The existing layout
fix already covers these screens; no additional positioning changes were needed.
This was a controlled UI-only run with score writes blocked, not gameplay,
ranking calibration, or physical-device acceptance.

For Alpha 0.6.0, playable Three Bosses is desktop-only. Recognized Android and
iOS browsers do not receive the Games card, and direct mobile navigation shows
an explicit desktop-only message without instantiating Unity. The Three Bosses
leaderboard remains available on mobile. Narrow desktop windows and Windows
touch laptops remain supported. The local preview now has verified Android
joystick, action-button, and pause interactions, but public mobile gameplay still
waits for the complete Android/iOS, all-scenes physical-device acceptance pass.

On 2026-09-06, Mike reported that the requested Android simultaneous-control
gameplay checks passed and confirmed the corrected menu audio icon is centered
on the physical phone. Record this as owner-reported acceptance, not as a new
automated all-scenes run. An iPhone is available for the remaining Safari
gameplay checks; those checks remain pending, not waived for lack of a Mac.
Basic browser gameplay testing does not require macOS. Public mobile gates stay
unchanged until the remaining acceptance and release decisions are complete.

Android normal-route acceptance (2026-09-07): **owner-confirmed passed**. In
response to the requested complete three-boss run using touch controls and
pickups, checking controls and audio through both transitions and the final
result, Mike confirmed it is working on Android. This closes that full-run
check, not exhaustive coverage of every weapon/audio clip or separate
Cyborg/Kraken defeat, Try Again, and Back to Menu flows. Public mobile and
submission gates are unchanged; no new automated test run is implied.

Android Cyborg defeat navigation (2026-09-07): **owner-confirmed passed**.
Mike completed the requested Try Again check with restored playable gameplay
and Back to Menu check. This closes Cyborg's Android defeat navigation. No
additional visual check, automated test run, or release activation is implied.

Android Kraken defeat navigation (2026-09-07): **owner-confirmed passed**.
Mike completed the requested Try Again check with restored playable gameplay
and Back to Menu check. This closes Kraken's Android defeat navigation. Visual
alignment stays closed, and public mobile/submission gates remain unchanged.

iPhone Kraken defeat navigation (2026-09-07): **owner-confirmed passed**.
Mike completed the requested Try Again check with restored playable gameplay
and Back to Menu check. This closes the remaining recorded Kraken phone
navigation check. It does not reopen visual alignment or establish exhaustive
weapon/audio, cold-start, or production submission acceptance.

Mute persistence (2026-09-07): **owner-confirmed passed**. In response to the
requested mute-through-gameplay/transitions/retry and menu-unmute check, Mike
reported that mute is working. This is owner-reported acceptance, not a new
automated test or exhaustive weapon/audio verification.

Desktop performance incident (2026-09-07): **recovered after Chrome restart**.
The original report and diagnostic sequence follow; the owner-confirmed recovery
below supersedes their provisional open status. Mike
reports very low FPS that was not occurring before and asks to investigate
later. Mike clarified that this occurs on desktop, including the current public
website; this is not limited to the mobile preview. Mike subsequently identified
Chrome and said the slowdown starts immediately. Hardware and exact affected
profile settings remain unconfirmed. Prioritize reproducing the public desktop
regression and measuring frame times, then compare with the local build and a
previous working build. Inspect rendering resolution/DPR, fullscreen state,
and recent changes without assuming a mobile-only cause. Resolve the regression
before mobile release approval. Preserve the 720p gameplay reference; do not lower quality
or change performance settings without evidence. Investigation is deferred at
the owner's request until the following read-only checkpoint; public
mobile/submission gates remain unchanged.

Desktop FPS diagnostic checkpoint (2026-09-07): the requested next-task pass
compared the public release and local build in isolated, signed-out, headed
Chrome at 1600x1000 with device pixel ratios 1 and 2. Unity's own metrics gave
approximately 60 median FPS in the menu and opening Bee gameplay in all four
cases; sampled browser rAF median was 16.7ms, with gameplay p95 of 16.9-17.5ms.
Mike also confirmed the fresh window runs well. This narrows investigation to
differences in the affected Chrome profile/session, but does not establish a
specific extension, acceleration setting, or resource-contention cause. The
short samples do not certify all bosses, sustained firing, or fullscreen.
Public Unity build `22c75f55...45fa` remains bound to source `ea9e858c`, so the
latest local alignment edits cannot explain its reported slowdown. No game
code/settings, browser preferences, servers, or submission gates were changed;
API writes were blocked in the test browser, which was closed afterward.
Evidence, the diagnostic script, exact commands, and scope limits are retained
outside the repository in `desktop-fps-20260907` under the Codex visualization
folder. The reported regression remains open.

Chrome Incognito comparison (2026-09-07): **owner-confirmed still slow**.
The public game was opened in a maximized Incognito window of Mike's usual
Chrome without changing settings or existing tabs. This does not eliminate
browser-wide configuration or process state: Incognito inherits regular
settings, while the isolated Playwright launch also differs in its background
throttling/occlusion flags. Do not attribute the issue to an extension or claim
the game is fixed. Mike's subsequent manual graphics-status report is recorded
below; browser configuration is the next checkpoint.
No game-quality changes or additional builds are justified by these results.

Chrome software-rendering finding (2026-09-07): **owner-provided diagnostic
evidence**. WebGL and Canvas report "Software only, hardware acceleration
unavailable"; Compositing and Rasterization report hardware acceleration
disabled, and OpenGL is disabled. No separate WebGL2 line was supplied. This
strongly explains low FPS in the affected normal/Incognito browser, while the
isolated Chrome test remains smooth. Mike confirmed Chrome's System graphics-
acceleration setting is already enabled, so an off toggle is not the cause.
The owner's subsequent screenshots show D3D11 device loss (`0x887A0005`),
WebGL context loss, a GPU-process crash, and later software-GL errors. After a
full Chrome restart, the owner supplied a screenshot showing hardware-accelerated
WebGL/Canvas/compositing with the RTX 3090 active and confirmed public gameplay
is smooth again. This closes the reported desktop slowdown as recovered, not a
confirmed game-code regression. The initiating GPU-crash cause remains unknown;
investigate driver/browser crash evidence only if it recurs. No browser settings,
GPU safety overrides, drivers, or game-quality settings were changed by Codex.

On 2026-09-07, Mike confirmed Three Bosses touch controls and pause/resume work
on the physical iPhone. This is owner-reported acceptance of those interactions,
not completion of the all-scenes mobile matrix. A small fullscreen exit-button
overlap with Fire was reported: the compact fullscreen control now anchors to
the safe screen corner rather than the letterboxed canvas corner, preserving
normal-page and larger-desktop placement. Mike subsequently approved the new
fullscreen-button placement on the physical iPhone; public mobile gates are
unchanged. Mike also confirmed that first-boss defeat, portrait/landscape result
and button-label alignment, Try Again with working gameplay controls, and Back
to Menu all pass on the physical iPhone. Mike then confirmed one normal complete
three-boss run, both inter-boss transitions, continued controls, split times, and
final-results readability in portrait/landscape. These are owner-reported device
checks, not automated evidence or acceptance of every remaining mobile scenario.
The final screen initially showed submission locked. The later isolated
cookie-authenticated iPhone submission and readback below passed; normal-backend
and production HTTPS acceptance remain separate.
Five Chromium viewport checks preserve the canvas, aspect ratio, and restored
normal-page button placement. At 393x695, 852x393, and 852x300 the exit control
sits outside the game canvas. All 110 frontend tests and the build pass (existing
large-chunk warning only). Exact 16:9 phones have no letterbox margin; Fire's
expanded invisible hit area still needs a separate physical clearance check.

The 2026-09-06 iPhone review exposed a WebKit canvas-sizing discrepancy: at
390 x 844 / DPR 3, the embedded canvas was 355.59 x 211.13 CSS pixels instead
of 355.59 x 200.13. Its percentage height included the glass frame inset,
changing Unity's menu coordinate scaling and shifting PLAY/audio against the
artwork. The canvas now owns its 1672:941 CSS aspect ratio with automatic height;
no Unity offsets, control sizes, gameplay code, or build assets changed.
WebKit and Chromium geometry checks pass, including fullscreen restoration.
Windows WebKit also renders blank after viewport resizing with both the old
and corrected CSS; this remains a test-engine finding to check on the physical
iPhone, not a confirmed iOS regression or a completed gameplay acceptance pass.
The owner subsequently confirmed that PLAY and the audio icon are centered in
ordinary Safari on an iPhone 14 Pro running iOS 26.6.1. Preserve that accepted
alignment while addressing the separate loading and browser-edge concerns.

The site now requests edge-to-edge viewport coverage, keeps interactive content
inside safe-area insets, and matches browser/installed-app background colors to
the space theme. Home, Games, and Login passed simulated landscape-inset checks;
actual iPhone edge coverage still requires owner confirmation. Native fullscreen
remains preferred where supported. An ordinary iPhone Safari tab uses the
viewport fallback and cannot have its address bar hidden by that CSS mode.
Ordinary Safari is the acceptance target: Home Screen installation is not an
acceptable workaround for this site's visitors. The owner's screenshot shows
solid bands behind Safari's status and address controls, rather than uncovered
space inside the page. A root-gradient/mobile absolute-background experiment
made no visible improvement in the owner's physical-phone check and was removed.
Do not mark browser-edge coverage as fixed from Windows WebKit simulation alone.

The local WebGL server now serves gzip for validated uncompressed build files,
reducing the measured current-build transfer from 94,332,664 to 46,812,192 bytes
through the LAN preview. Existing compressed files are not compressed again.
Compressed payloads are prepared once per current build in memory and sent with
an exact Content-Length; without that header, the generated Unity loader falsely
jumps to 90% before downloading is complete. Conditional HTTP caching revalidates
only after the build-identity/file guards; manifests and errors remain uncached.
The 27 server tests and 76 frontend tests
pass, and the frontend production build succeeds. Windows WebKit cold/warm loads
both reached the main menu without page errors; only the small JavaScript files
were reused on the observed warm reload, while data/Wasm downloaded again.
The owner initially reported roughly five-minute loads and a 90% stall, then
confirmed that the game loads fast. Temporary local phone diagnostics recorded
a 19.7-second warm load: about 15 seconds before the development page started
Unity, cached transfers for all four Unity assets, then normal startup. This
confirms real Safari cache reuse; it does not establish a fresh-install/cold-load
timing. A subsequent direct/proxy A/B reproduced a concrete local transfer stall:
forced-close connections stopped with 58,636 compressed data bytes still missing,
while the identical keep-alive request completed in 0.23 seconds. The Vite local
Unity proxy now uses a keep-alive agent. All six repeated data/Wasm transfers
completed in 0.30-0.39 seconds, and a fresh Windows WebKit context reached the menu
in 7.7 seconds. These are PC measurements, not physical iPhone cold-load timings.
The regression suite checks concurrent, multi-megabyte gzip transfers through
completion. Temporary phone instrumentation has been removed. Keep uncached
Safari timing in the remaining physical-device acceptance checks.
This changes local preview delivery, not the deployed production package or
Unity gameplay, and public mobile availability remains unchanged.

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
rows on both leaderboards. The later owner-confirmed published-site submission
and backend receipt/retry acceptance supersede the blanket per-candidate retest
requirement; reopen it only for relevant changes or a concrete regression.

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

Verification snapshot (2026-09-06): the local backend returned
`SUBMISSIONS_FROZEN` (503) for p4-Vega and `SUBMISSION_DISABLED` (403) for both
Three Bosses mutation endpoints; the two opt-in variables are absent from the
local root `.env`. This is distinct from production: the traffic-serving
`mickeyf-org-build-3db9219129ee44e88daba01bcdcf9c3d` revision had both flags set
to `true` and served 100% of traffic. Its Three Bosses catalog advertised
submissions enabled. Signed-out requests to all three mutation endpoints
returned 401 with `no-store`, no new cookie, and no redirect; both leaderboard
reads returned 200 (five p4-Vega entries and one Three Bosses entry).

Backend type-checking, 141 unit/security tests, frontend type-checking and 76
tests, and the complete isolated MySQL integration suite passed. The isolated
Three Bosses HTTP test covered ticket issuance, submission, identical replay,
and leaderboard readback without duplicate persistence; its disposable
container and network were removed afterward. No live score was written, and
no local or production submission flag was changed. The remaining end-to-end
check is a real browser-cookie-authenticated run: sign in before starting a new
normal run, complete it, submit, and confirm the result and leaderboard readback.
The isolated test's test-only bearer token does not replace that check.

On 2026-09-07, the owner completed the iPhone mobile-preview gameplay run and
reported submission locked. Fresh read-only GETs to the local backend catalog
and the LAN Vite-proxied catalog both returned HTTP 200 with Three Bosses
`submissionState: disabled`. The catalog derives that value directly from the
backend runtime submission gate, so the preview is explicitly write-disabled,
not a demonstrated score-submit failure. No flags, authentication state, or
scores were changed; this local finding does not establish production health.

Isolated browser-cookie acceptance setup (2026-09-07): a disposable harness at
`%TEMP%/mickeyf-score-acceptance-20260907` is running in VS Code's `score-test`
terminal. Its LAN preview uses port 5176, its API is loopback-only on 8082, and
its Docker Compose project is `mickeyf-score-acceptance-20260907`. The existing
pinned MySQL test image runs on a verified ephemeral loopback port, with tmpfs
storage, an empty test schema initialized from the versioned leaderboard tables,
and the production column-grant manifest applied to a separate test runtime user.
No production database data or credentials were imported. Existing frontend,
backend, and WebGL services on 5173/8080/4174 were preserved.

The harness injects the real authentication/submission handlers with a fresh
test session secret and exact LAN-preview Origin allowlist. It intentionally does
not import `app.ts`, the root `.env`, or the global database pool. Both `/api`
and `/auth` proxy exclusively to the disposable API; there is no fallback to the
normal Cloud SQL-backed backend. This is isolated handler/browser acceptance,
not verification of the normal backend bootstrap: the standard development
Origin allowlist remains localhost-only, and its Vite config lacks `/auth`
proxying. Production HTTPS cookie behavior still requires a separate check.

A Chromium browser test through the real login form confirmed a signed,
HttpOnly, SameSite=Lax session cookie with no bearer header; authentication
verification, signed-out and untrusted-Origin rejection (401), ticket issuance
(201), submission (201), exact replay (200), and one persisted run/personal-best
with leaderboard readback. The generated smoke accounts and scores were removed
from this disposable database; the separate `iphone-test` account remains for
the owner's fresh run. Its temporary password is stored only in the external
harness state, not in this repository. The proxied Unity build ID is
`ca711c131c5e6e88a4ab09416b4a20787fffb76891830cf84c5568e8b5a15f2b`;
its menu started without browser runtime errors. The ordinary backend catalog
still reports Three Bosses disabled. No public mobile gate or live score changed.

Physical iPhone acceptance (2026-09-07): the owner completed and submitted a
normal run. Read-only verification against the identified disposable database
confirmed exactly one run and one linked personal best: 92,155 ms (1:32.155),
108,513 points, rank B, matching the isolated leaderboard. No duplicate run IDs
or repeated score/time groups were found. The normal backend remains disabled;
production HTTPS submission and public mobile activation are not verified by
this isolated pass. The owner also reported the final rank letter sitting left
of the baked RANK caption. The value field was centered at source-art x=1135,
but the caption is centered at x=1153; the saved End scene and its generator now
share the corrected x=998 left edge for the existing 310-pixel-wide field.
Font, size, scoring, submissions, and other controls are unchanged.

Rank alignment verification (2026-09-07): both `PortraitOutcomeLayoutTests`
passed, including S/A/B/C/D/UNRANKED under host portrait flags 0/1/0. That test
checks the authored artwork contract, not a real device resize. The Unity static
check and guarded local WebGL build also passed; temporary settings were restored
and no actionable build warnings remained. The local artifact ID is
`70d6a3085fa681aa630943687be437d8ad3c25e45ecffeef418e7ddb3bc5a9af`.
A separate non-submitting Chromium visual fixture inspected the rebuilt End
screen at 1280x590, 393x695, and 1600x1000, with no JavaScript or Unity runtime
errors. It uses synthetic boss completion and a display-only B rank, blocks API
POSTs, and is not gameplay, rank-calibration, or submission evidence. Screenshots
are in the external harness directory (`rank-landscape.png`, `rank-portrait.png`,
`rank-desktop.png`). Mike subsequently confirmed that the corrected rank is
centered on the physical iPhone. This closes that visual check; the owner's
genuine accepted submission above remains separate from the synthetic fixture.

Fullscreen scope decision (2026-09-07): after the additional Apple/WebKit
research, Mike accepted treating occasional address-bar-free iPhone Safari
presentation as browser toolbar state and asked to move on. Keep the existing
native-first request and viewport-filling fallback; do not add forced scrolling,
video conversion, experimental-flag dependencies, or further toolbar diagnostics.
This is an accepted browser limitation, not verified native element fullscreen
support on iPhone, and does not itself authorize public mobile activation.

Automatic background/return pause on iPhone Safari: **owner-confirmed passed
on 2026-09-07**. Mike reported that switching away during active combat and
returning passed the requested audio-suspension, active-combat-time exclusion,
and working movement/fire checks. This is physical-device owner acceptance,
not a new automated test run.

Combined manual/background pause on iPhone Safari: **owner-confirmed passed
on 2026-09-07**. Mike completed the requested manually-pause, switch-away, return,
and Resume check. The pause menu, stopped timer, and silent gameplay audio remain
until Resume, after which controls work. This records owner acceptance of the
combined pause reasons, not a new automated result.

Cyborg (second-boss) player-defeat check on iPhone: **owner-confirmed passed
on 2026-09-07**. Mike first confirmed the buttons work but rejected the time/button
label alignment. After the corrections below and reopening the current mobile
preview on port 5173, he confirmed everything is correctly centered. Navigation
and visual alignment are now accepted. Bee defeat is already accepted;
Kraken's subsequent iPhone navigation acceptance is recorded above.

Cyborg alignment correction is implemented in the builder and saved scene.
An artwork-coordinate regression reproduced the old 26-source-pixel time offset;
all three outcome-layout PlayMode tests pass after correction. Guarded local
WebGL build `build_50a564dbb2b9` succeeded and Chrome synthetic captures at
393x695, 1280x590, and 1600x1000 show the corrected time/button mapping with
round-trip portrait/landscape state; no page errors were reported. API writes
were blocked during that visual fixture. This is browser evidence, not a new
human playthrough or iPhone Safari acceptance. The separate owner confirmation
above closes the subsequent physical-device visual check.

Readout follow-up (2026-09-07): Mike also requested centering both TIME SURVIVED
and its result within the panel itself. Its inner side rims center at artwork
x=856, whereas the old baked caption centered at x=839. Cyborg now uses a native,
non-interactive caption over a small opaque backing that covers the baked text;
caption and result share x=856 (+20 portrait offset). The source PNG and button
positions are unchanged. All three outcome-layout PlayMode tests pass; guarded
WebGL build `build_65fd8396576a` succeeded with no actionable warnings. Synthetic
Chrome captures at portrait, landscape, and desktop sizes show the centered pair
without duplicate lettering or an obvious cover seam; no page errors or API
writes. Mike subsequently confirmed the updated readout and button labels are
correctly centered on iPhone; this records owner acceptance, not another test run.

Kraken and remaining outcome alignment audit (2026-09-07): implemented and
browser-verified. Mike requested centering TIME SURVIVED, its result, and Back
to Menu, and delegated the remaining visual checks rather than repeating them
on his phone. Kraken's measured readout center is artwork x=855, not the image
center x=836 or Cyborg's x=856. A native caption and result now share x=855 in
both host orientations (+19 portrait offset). Both button labels were aligned
to Kraken's own inner rims: Try Again (624,795), Back to Menu (1051.5,795).
The accepted Cyborg arrangement and source PNGs are unchanged.

The wider audit also corrected the victory TIME and SCORE values beneath their
baked captions (x=535 and x=833). Accepted RANK alignment is preserved. The main
menu, all three defeat screens, both transitions, and victory were visually
reviewed in the local WebGL player at 393x695, 1280x590, and 1600x1000; no further
material alignment defects were found. Four focused outcome-layout PlayMode
tests pass, including portrait/landscape restoration and artwork-coordinate
regressions. Guarded build `build_45d9432ed4bd` succeeded with zero actionable
warnings and restored its temporary Unity settings. The initial synthetic
victory capture was invalid because its sub-10-second run violated the score
calculator's minimum; the corrected valid-duration fixture rendered victory
with no JavaScript or Unity console errors and API writes blocked.

This closes the delegated visual-alignment audit, not a new physical-device
gameplay or release acceptance claim. No further owner centering checks are
requested. Public mobile/submission gates remain unchanged. The subsequent
acceptance review is complete, and Android's normal route has since passed as
recorded above. Phone defeat/retry/menu checks are now accepted as recorded.
Mute persistence is now owner-confirmed as recorded above. The desktop FPS
incident is recovered after a Chrome restart, with hardware acceleration and
smooth public gameplay owner-confirmed as recorded above. Do not reopen accepted
visual checks. Exact commands and screenshots are retained outside
the repository in the Codex visualization folder `kraken-alignment-20260907`.

Cookies are not port-scoped, so a private tab avoids overwriting the regular
development site's session. Keep the harness for the remaining visual check.
After acceptance, stop the
`score-test` terminal with Ctrl+C (which removes its verified Docker project),
then explicitly remove the external harness/cache/credential files. Forced
termination or a failed startup can leave the disposable container behind;
verify project/container identity before cleanup. Do not declare this temporary
environment cleaned up while the owner still needs it for the device check.

Acceptance teardown (2026-09-07): after the owner confirmed rank centering and
asked to move on, Ctrl+C was sent to the identified `score-test` terminal. The
test process and listeners on 5176/8082 stopped; the exact Compose-labeled
container and network were removed. Its database used tmpfs and had no mounted
volumes, so the disposable account/run data is gone, not a deleted live score.
The normal 5173/8080/4174 listeners retained their original process IDs. The
three final rank screenshots and sanitized `verification.json` were copied,
with matching SHA-256 hashes, to the external Codex visualization directory
`three-bosses-acceptance-20260907`. File deletion was blocked by the execution
policy: `%TEMP%/mickeyf-score-acceptance-20260907` still contains the stopped
harness, cache, and disposable credential state. Filesystem cleanup is pending;
do not report full temporary-environment cleanup or reuse those credentials.

#### Temporary-artifact cleanup — current scope (2026-09-08)

The owner reaffirmed cleanup of obsolete one-off artifacts and added the
project's `package.json` scripts to this pre-release cleanup, rather than waiting
for the later whole-project Clean Code sweep. The previous stalled audit is not
to be resumed as an open-ended investigation.

1. Reverify the named external acceptance harnesses, preview/cache directories
   and disposable install/build copies before touching them. Resolve exact
   paths, ownership, reparse points, active processes and retained evidence.
   Remove only confirmed disposable artifacts; preserve intentional recovery
   archives, test evidence and normal workspace dependencies/services. Never
   equate an old roadmap entry with proof that a directory still exists.
2. Retire completed one-off scheduled follow-ups after saving their result.
   `verify-first-hourly-receipt-cleanup` is limited to one occurrence and must
   delete only its own automation entry after recording success or failure.
   A failed deletion must be reported and the entry paused, not silently called
   removed. Keep the chat/evidence and production hourly cleanup/alerts.
3. Audit every tracked first-party `package.json`, excluding dependencies,
   generated output and vendored packages. First inventory its script names,
   commands and purpose. Trace nested npm calls, lifecycle hooks, CI workflows,
   Git hooks, VS Code tasks, documentation and supported manual workflows.
   Classify each script as keep, remove, consolidate or needs confirmation,
   with evidence; lack of a text reference or infrequent use alone does not
   prove a script is unused. Preserve required migration/recovery/release tools.
4. End that first audit pass with a concise proposed change list and unresolved
   questions. Then remove only confirmed obsolete scripts and update affected
   callers/docs in reviewable batches, validating the changed paths. Do not
   install dependencies, run every script, rebuild Unity, restart servers or
   expand into dependency upgrades/general refactoring merely for this audit.

Metadata-only inventory at `2026-09-09T00:46Z`: the historical
`mickeyf-score-acceptance-20260907` directory is already absent (not deleted by
this check). The three named Firebase fast-uri, backend qs and frontend xmldom
disposable copies below still exist. Their roots/immediate children have no
reparse points and no readable active command line referenced their exact paths.
Ownership, unique changes, retained evidence, deeper links and open handles
remain unverified; this is not a deletion-safety sign-off. Nothing was deleted.
No package scripts have been removed or certified unused. The natural Scheduler
check can complete independently.

Cleanup completion and bounded script-audit checkpoint (2026-09-08):

- The three documented disposable install copies were moved to the Windows
  Recycle Bin after exact-path/parent checks, ownership/provenance review, a
  bounded deep metadata inventory with zero reparse points, and a fresh readable
  process-command-line check with no matching paths. All three original paths
  are now absent. Inventory: Firebase fast-uri 19,664 files / 200,335,028 bytes;
  backend qs 5,863 files / 57,004,173 bytes; frontend xmldom 15,055 files /
  206,013,447 bytes (40,582 files / 463,352,648 bytes total). Recover through the
  Windows Recycle Bin if needed; space is not reclaimed until it is emptied.
  Process inspection cannot rule out every open handle: 156 processes did not
  expose a command line. No process was stopped, and normal workspace installs,
  servers, retained verification evidence and the Unity recovery archive were
  outside the deletion targets. Each recycled directory was independently found
  in the Recycle Bin with its original Temp location; SHA-256 checks confirm the
  retained release report and all six recovery/archive files are unchanged.
  The acceptance harness was already absent.
- First static script pass is complete: all four tracked first-party manifests,
  61 scripts, 56 keep, two proposed documentation-alias consolidations, three
  needing a manual-workflow/overlap decision, and zero unconditional removals.
  See [the bounded inventory and proposed changes](PACKAGE_SCRIPT_AUDIT.md).
  No scripts/lockfiles changed and no package commands/builds/tests were run.
  Do not repeat the inventory as an open-ended audit; the next batch should
  resolve those named candidates only.
- Two additional root-folder candidates were reported by the owner and checked
  read-only: `Logs` is empty; `NVIDIA Corporation` contains only an empty
  `umdlogs` directory. Neither is tracked or referenced in tracked project files.
  No creator process was established from metadata. They remain untouched;
  these are not evidence that the website needs either directory.

Documentation-alias consolidation completed (2026-09-08): removed only
`frontend/package.json` and `backend/package.json`'s local `docs:json` aliases.
The existing root package-specific/aggregate documentation commands, TypeDoc
configurations and public entrypoints are unchanged. Focused CI/editor/hook/docs
checks found no callers to migrate; README now documents the root commands and
the distinction between `docs:dev` and `docs:dev:fresh`. All four manifests parse,
structural checks confirm no other manifest changes, and Git diff checks pass.
There are now 59 scripts. No dependencies, lockfiles, generated docs, watcher
behavior or receipt-cleanup commands changed; no installs/builds/application
tests or server restarts were required. The remaining bounded decisions are the
two manual receipt-cleanup aliases and the documentation watcher's overlapping
rebuilds, not another full script audit.

Documentation watcher overlap corrected (2026-09-08): `docs:watch` now runs a
small Node controller over the existing Chokidar CLI's documented event stream.
The same watched inputs and debounce remain, but only one documentation build
can run per watcher; changes during it coalesce into one follow-up. Build failures
are reported without retrying unchanged input; stopping drops queued work and
awaits the file-watcher and active build processes. No new dependencies, npm
commands or lock artifacts were introduced. All 13 focused scheduling/process
tests pass and are wired into PR CI; syntax, YAML, manifest and diff checks pass.
Tests use fake child processes/timers, not real docs
builds. Existing watcher/server processes were not restarted. README documents
that the Docs terminal must be restarted to use the new controller, and that a
second watcher or separate manual build is not protected by this per-process
queue. Only the two receipt-cleanup command aliases remain undecided in this
bounded script audit.

Receipt-cleanup alias retirement completed (2026-09-08): removed only backend
`receipts:cleanup` and `receipts:cleanup:local`. Neither had a tracked caller;
the deployed Job invokes the compiled entrypoint directly, independent of npm.
The source shortcut did not guarantee a disposable database, even with a
loopback endpoint. The runbook now makes the pinned Job/checklist the approved
manual path. Cleanup implementation, build entry, safety guards, unit tests,
cloud templates, dependencies and lockfiles are preserved. Manifest parsing,
exact-change/lock-metadata assertions, the two existing template tests and Git
diff checks pass. No cleanup command, build, install or cloud/database mutation
was performed. There are 57 scripts across the four manifests; all five named
candidates in the bounded audit are resolved. Do not restart that audit without
new evidence. Remaining artifact dispositions and release/security gates are
separate work.

Named temporary-artifact dispositions completed (2026-09-08 local):

- Both historical Safari folders (`mickeyf-safari-edge-check-20260906` and
  `mickeyf-iphone-vite-dQirRt`) are already absent; this batch did not delete them.
  No listeners remain on 5175/5176/8082 and no tracked Safari experiment route or
  diagnostic flag remains. Accepted background/fullscreen implementation stays.
- Removed empty root `Logs` and `NVIDIA Corporation/umdlogs` (then its empty
  parent) with non-recursive, empty-only operations after exact-path/no-link
  checks. No files were inside; these directories can be recreated if needed.
- Recycled the additional isolated backend `mickeyf-receipt-locked-unit-075698753cb44a21b0ca7065edbbcc52`
  and root `mickeyf-root-qs-verified-c6949cf50c76471d870f9eb834acd5bb` copies from
  `%TEMP%`: 11,228 files / 109,000,123 bytes. Source/history review found only
  reproducible dependencies, generated bundles and superseded integration-test
  drafts, not unique recovery work or separate evidence. Deep metadata checks
  found no reparse points; no other readable process command line referenced
  either exact path (163 were unavailable, so this is not an all-handles claim).
  Both original paths are absent and their original Temp locations are verified
  in the Recycle Bin. Restore there if needed; space is not reclaimed yet.
- The one-off natural-tick automation is already deleted; hourly cloud cleanup,
  alerts and non-secret evidence remain. Normal 5173/8080/4174/3306 listeners
  retain their process IDs. Release report and all six recovery/archive files
  retain their SHA-256 hashes. Normal installs, generated working outputs and
  intentionally retained verification/recovery material were not cleanup targets.

This closes the named artifact list and bounded package-script audit, not a
whole-filesystem sweep or release/security approval. External evidence is
`release-checks-20260907/temp-artifact-disposition-20260908.json` under the Codex
visualization folder. Validation used filesystem/reference/process checks,
source comparisons, recovery hashes and `git diff --check`; no installs,
application builds/tests, server restarts, database writes or cloud changes.
Next: follow the cumulative release/security gates above. The limited
alert-policy readback is now closed; do not repeat completed cleanup or gameplay checks.

#### Remaining release checks — consolidated checkpoint (2026-09-07)

The owner requested all remaining release checks after confirming the desktop
FPS recovery. **Frontend/backend, browser, and Unity checks pass after fixing
the input-test lifecycle. Release remains blocked by the other gates below.**
This checkpoint does not authorize a merge, deployment, dependency upgrade,
production score write, or public mobile enablement.

Execution order clarified with the owner on 2026-09-07 to avoid circular work:

1. The remaining Firebase `stream-json` assessment is complete: the owner
   approved a static-Hosting-only exception on 2026-09-07 through 2026-10-07,
   subject to the earlier reassessment triggers below. Do not repeat the
   assessment absent an upstream release or deployment/configuration scope
   change. Backend/frontend dependency fixes and the
   Unity input-test lifecycle fix remain closed unless relevant code changes
   or new evidence invalidate them; do not rerun their suites for deployment-only
   edits. The deployment package is an independent install, not the backend.
2. Source/recovery review is complete with no actionable source regressions.
   The owner approved the local source checkpoint on 2026-09-07. All five
   recovery files are archived outside Unity source with matching SHA-256
   hashes; only the saved transition scene's 14 trailing-whitespace lines were
   normalized. The initial checkpoint excluded local `.vscode/settings.json`
   and was local-only. The owner subsequently requested commit-and-sync:
   `8eaa6615` is now on `origin/feature/three-bosses-polish`. Machine-local
   terminal options were moved to VS Code User settings, leaving workspace
   settings unchanged. This does not authorize deployment or a main merge.
3. Fresh certified WebGL candidate completed on 2026-09-07 from `8eaa6615`:
   package `2e660337df60df782451a5d00f85a0591d9a1ba595510da0d61ac382517a7fe7`
   replaces the stale generated release in `frontend/public/unity/three-bosses`.
   The guarded Unity build restored source/index state and certified 996 Unity
   source files. An isolated production-config frontend build, four-asset
   SHA-256/size/provenance validation, local Firebase-header simulation and a
   fresh signed-out Chrome startup smoke all passed. The screenshot visibly
   shows the Main Menu; the packaged manifest is byte-identical to the tested
   candidate. The old generated package remains recoverable from Git.
   This is local candidate evidence, not Firebase CDN, physical-device, FPS or
   authenticated submission acceptance; no live score writes were performed.
   Installed Unity CLI `1.0.0-beta.8` command execution is incompatible with the
   pinned Pipeline `0.5.0-exp.1` command parser. An external MCP transport adapter
   invoked the existing build guard without changing its checks or upgrading
   project dependencies. Standard CLI command compatibility remains separate
   tooling follow-up. Evidence and exact commands are in the external Codex
   `release-checks-20260907` report. Accepted gameplay/visual checks and completed
   dependency assessments are not reopened by this artifact refresh.
4. Follow the current release ledger: preserve accepted login/submission checks,
   finish only the combined loading/layout observation before mobile enablement,
   and resolve or explicitly disposition the remaining cumulative security risks.
5. After explicit publish approval, release and verify delivery. Keep cleanup
   blockers visible; do not call retained external temporary folders removed.
6. Then move to p4-Vega pause/touch-scroll/game polish (Phase 15), followed by
   incremental Clean Code work (Phase 16). The owner re-added the package-script
   audit to pre-release cleanup on 2026-09-08 under the bounded scope above;
   do not resume the previous stalled/open-ended audit.

- **Passed:** frontend TypeScript, 110 frontend tests, Vite production build,
  and 110 release-utility fixture tests (build 20, package 41, server 27,
  hosting 10, smoke 12). Vite retains its large-main-chunk warning.
- **Passed:** backend TypeScript, 42 focused contract/security/HTTP tests, and
  38 real-MySQL integration tests. The latter used an existing pinned image,
  unique loopback/tmpfs database, and verified teardown to zero test-owned
  containers, networks, and volumes. No production scores were written.
- **Passed:** isolated headed Chrome startup, reload, fullscreen round-trip,
  route exit/re-entry, and horizontal canvas containment at compact/landscape/
  ultrawide widths for both the current local and public builds. Main Menu was
  visually verified; there were no page errors or failed HTTP responses.
  The emulated public iPhone route still shows the desktop-only gate and loads
  no Unity runtime. This is not a new physical-phone gameplay run.
- **Passed for the existing public package only:** all four assets match their
  manifest hashes and byte lengths; MIME/CSP/cache headers pass. Separate data
  and Wasm requests negotiated both Brotli and gzip, with decoded hashes and
  lengths matching. Fresh candidate delivery must be checked again after build.
- **Passed:** all 451 tracked Assets content files and 66 asset directories have
  matching metadata; 517 tracked metadata GUIDs are valid/unique, with no missing
  assets, orphan metadata, or non-normal source-index flags.
- **Passed — Unity EditMode:** after the owner saved `Transition_BeeToCyborg`,
  the fresh full first-party EditMode assembly passed 42/42 cases through the
  existing Unity MCP transport, without upgrading Pipeline or the Editor.
- **Fixed and verified — Unity input-test lifecycle:** the initial full PlayMode
  run failed 22/52 cases, starting with Fire and cascading through UI tests.
  Fire and all 17 UI tests passed separately; TouchControls alone reproduced
  2 passed / 5 failed. Removing manual `InputTestFixture.Setup/TearDown` from
  the scene integration tests stopped global input-state resets beneath live UI
  actions. Fire now queues state on its owned, device-restricted Gamepad and
  cleans up owned resources; joystick assertions still verify natural pairing
  and gameplay delivery. A new repeated-scene/input regression and release-event
  assertion preserve and strengthen coverage. Fresh checks: TouchControls 8/8,
  EditMode 42/42, full PlayMode 53/53; zero failed, skipped, or inconclusive.
  No log suppression, gameplay changes, package upgrades, or WebGL rebuild.
- **Preserved after tests:** all 995 tracked Unity files outside the intentionally
  edited `TouchControlsTests.cs` match the pre-fix byte fingerprint. Unity's
  temporary test scene was automatically removed; the owner's saved transition
  scene is open again with no unsaved changes. Its saved diff includes a URP
  camera component and 14 trailing-space lines, left intact for source review/
  normalization before committing. Both edited files pass scoped whitespace
  checks; the whole-worktree check still flags those saved scene lines.
- **Blocked — provenance/package:** Unity outcome edits are uncommitted, five
  ignored `_Recovery` files remain under Assets, and packaged source `ea9e858c`
  predates even committed HEAD `4372a0b8`. Preserve/review the recovery scenes,
  checkpoint the intended source, then create and validate a fresh certified
  release. Do not weaken provenance checks or release the stale package.
- **Fixed — Firebase high-severity dependency finding:** the approved narrow
  follow-up changes only `fast-uri` 3.1.5 → 3.1.7 in the deployment lockfile.
  Version 3.1.7 also covers the subsequent port/bracket security fixes, unlike
  3.1.6. AJV 8.20.0 accepts it within its existing `^3.0.1` range; Firebase CLI
  stays pinned to 15.28.1, with no manifest, override, or workflow changes.
  A disposable locked install, `npm ls --omit=dev`, actual CLI version check,
  all 12 smoke-unit cases, and seven URI/AJV/scope checks pass. Lockfile and
  installed production audits pass the unchanged high threshold: 0 high/critical,
  5 moderate vulnerable packages. Workspace node_modules was not updated.
- **Fixed — backend qs dependency finding:** an exact backend-only `qs: 6.16.0`
  override replaces 6.15.3 without upgrading Express 4.22.2 or body-parser 1.20.6.
  Both parents currently restrict qs to `~6.15.1`; remove/reassess the override
  when compatible parent releases include the security fixes in their ranges.
  Only the qs version/tarball/integrity fields change in the lockfile. Six new
  request-parsing tests are registered in `test:unit`: four advisory regressions
  fail on old qs, then all six pass after a clean isolated install. Full backend
  unit/HTTP tests pass 147/147, TypeScript and production webpack build pass,
  and installed production audit reports 0 findings. Default query/JSON behavior
  and runtime code are unchanged; no proven app exploit path is claimed.
- **Fixed — backend build-tooling dependency gate:** the separate approved
  follow-up patches development-only `fast-uri` 3.1.5 → 3.1.7 in the backend
  lockfile. AJV 8.20.0 already accepts it; no new override or manifest change.
  Only its version/tarball/integrity fields change from the prior qs checkpoint.
  Reused the verified isolated backend copy for a clean install; full installed
  audit at CI's unchanged low threshold reports 0 vulnerabilities, including
  development packages. All 147 unit/HTTP cases, TypeScript, webpack production
  build, full dependency-tree validation and an AJV/URI compatibility probe pass.
  Earlier production-only audits had omitted this finding. The qs override/tests,
  working node_modules, normal servers and other dirty source files are unchanged.
- **Fixed — frontend XML dependency gate:** lock-only `@xmldom/xmldom` patches
  0.8.14 → 0.8.15 (Pixi runtime) and 0.9.11 → 0.9.12 (plist/Capacitor tooling)
  fit their existing parent ranges. Exactly two version/tarball/integrity entries
  change; no override, manifest, application source, or other package updates.
  A clean isolated install passes the full low-threshold audit with 0 findings,
  all 110 frontend tests and TypeScript, production compilation, and dependency
  validation. Seven XML/entity/SVG/bitmap-font/plist checks pass; four security
  cases fail as expected on the old installed versions. The existing large-chunk
  warning remains. This is not a certified WebGL package or physical-device test;
  working node_modules/dist and normal servers remain unchanged. No current app
  exploit is claimed; well-formed serialization must still be explicitly enabled
  to reject a manually mutated invalid entity name.
- **Fixed — Firebase deployment qs finding:** the approved follow-up adds only
  a deployment-package exact `qs: 6.16.0` override and changes its single lock
  entry's version/tarball/integrity. Firebase 15.28.1 and fast-uri 3.1.7 stay
  unchanged. Express 4/body-parser 1 restrict qs to `~6.15.1`; reassess/remove
  the override once compatible parents accept the patched range. The other four
  direct consumers already accept 6.16.0. Reused the existing credential-free
  isolated install: all 18 advisory/consumer checks and 12 smoke-unit cases pass,
  including actual query/form parsers, exegesis deepObject and mocked Google API
  serialization. Before patching, 12 advisory cases fail as expected. Installed
  audit falls from 5 to 2 moderate vulnerable packages, with no high/critical;
  the unchanged high CI threshold passes. CLI version/tree and exact-delta checks
  pass. No frontend/backend/Unity suites or live deployment were rerun.
- **Accepted, time-limited — stream-json (owner approval 2026-09-07):** the
  unchanged Firebase lock still has stream-json 1.9.1 and its parent as the two
  moderate entries from the previous audit. Official registry metadata shows
  no patched 1.x backport; even latest Firebase 15.29.0 retains `^1.7.3`.
  Fixed stream-json 3.5.0+ changes exports, case-sensitive filenames and APIs:
  Firebase's legacy `filters/Pick`, `filters/Filter` and streamer imports would
  no longer resolve. Do not force a major override, downgrade Firebase, or
  silently introduce a maintained fork just to clear an audit count.
  Source review locates affected processing in Auth JSON import, Realtime
  Database import and Next.js dependency analysis. Current deployment uses
  `hosting:channel:deploy`, prebuilt `frontend/dist`, no hosting.source, no
  function/run rewrite, and no import commands. Firebase's framework preparation
  skips configurations without source. The dependency is absent from root,
  frontend and backend lockfiles. These findings support a limited deployment
  exposure assessment, not proof that every Firebase command is safe.
  **Owner-approved exception:** allow GHSA-528h-pc64-c93x only for
  the current static-Hosting pipeline through 2026-10-07 or earlier compatible
  upstream remediation; reassess immediately if enabling imports, framework
  builds, untrusted JSON inputs, or changing the CLI/config/workflow scope.
  Keep the high audit gate, exact pin, locked install and existing timeout intact;
  keep both moderate entries visible. This accepts the bounded risk, not a
  dependency fix or release approval. No dependency/source patch, threshold
  change, new install, build, suite rerun or deployment occurred in this
  acceptance/source-review pass.
- **Reviewed — source checkpoint preparation (2026-09-07):** independent Unity
  review found the Cyborg/Kraken/End scene values consistent with the builder
  and alignment contracts; the touch-test lifecycle changes preserve the shared
  input runtime and remove only their injected device. The alignment tests
  exercise authored reference dimensions and mode switching, not actual browser
  resizing. Existing physical-device approvals stay closed; no suites rerun.
  The owner's saved Bee-to-Cyborg transition contains Editor serialization
  changes, not changed layout or transition-controller values; preserve these.
  Its 14 trailing-whitespace findings are the only `git diff --check` failures.
  `_Recovery/0.unity` and `0 (1).unity` are byte-identical test-runner scenes,
  with no gameplay objects, no build-list entry, and no tracked GUID references.
  Preserve both scenes, their metadata and `_Recovery.meta` in an approved
  external archive before removing them from Unity's source roots; ignored
  imported files correctly block certified provenance. Do not weaken that guard.
  Leave the local terminal MCP additions in `.vscode/settings.json` out of the
  release checkpoint. The reviewed security package fixes, backend parser test,
  frontend fullscreen positioning and Unity changes are the intended checkpoint
  scope. The packaged manifest still names source `ea9e858c`, so a fresh
  certified build is required after checkpointing. All source/recovery files
  remained untouched during that review. In the owner-approved checkpoint
  follow-up, all five recovery files were moved intact to the external Codex
  release evidence folder `release-checks-20260907/unity-recovery-archive-20260907`.
  Each archive hash matches its reviewed original; both recovery source paths
  are absent, and the files remain recoverable. The saved transition's only
  follow-up change removes the 14 trailing spaces; normalized text comparison
  confirms no scene content change. Prior successful suites were not rerun for
  archiving, whitespace normalization or checkpointing. No push or deployment.
- **Remaining scope, superseded by the current ledger:** release completed by
  PR #322 and Firebase run `34305326963`; retained maintenance/deferred work is
  listed in the ledger. The combined mobile load/touch observation is now owner-accepted (see R2).
  Generic login/submission
  replay and exhaustive weapon/audio coverage are no longer release blockers. Existing
  accepted owner gameplay and visual checks stay closed. Read-only catalog
  probes show local Three Bosses submissions disabled and the configured Cloud
  Run production API enabled; both leaderboard reads return 200.
- **Cleanup pending:** previously documented external acceptance/preview
  folders remain; the last listener check found none on 5175/5176/8082. The
  reviewed Unity recovery scenes are now intentionally preserved in the archive
  above, not discarded. Disposable credential contents were not read or deleted.
  This checkpoint does not
  claim full temporary-environment cleanup or full-project security closeout.
  The new credential-free `mickeyf-firebase-fast-uri-238b5de4909d4a79a7152f4cbe1153c6`
  disposable install also remains under `%TEMP%`: policy rejected its scoped
  removal. It runs no service; exact path and audit evidence are in the report.
  The subsequent credential-free `mickeyf-backend-qs-57a8ce3ea78e467598cc4112825683c7`
  install/build directory also remains after the same scoped-cleanup rejection.
  Test servers closed; normal workspace dependencies/services were not replaced.
  The credential-free frontend XML verification copy also remains in
  `mickeyf-frontend-xmldom-e78a13f330034ba89a71fdb54029e096` under `%TEMP%` after
  scoped removal was rejected. No verification service remains running;
  exact commands, before/after audits and compatibility evidence are retained.

Exact commands, scope limits, browser evidence, and the cumulative scoped risk
ledger are retained outside the repository in `release-checks-20260907` under
the Codex visualization directory. The Unity follow-up changed only this roadmap
and `TouchControlsTests.cs`; the subsequent Firebase security fix changes this
roadmap and `.github/firebase-deploy/package-lock.json`. All pre-existing
source/scene/settings changes were preserved. No commits, pushes, deployment,
production writes, or public-mobile activation were performed.
The subsequent backend qs follow-up adds its manifest override/test registration,
single lock-entry update, `ts/security/requestParsing.test.ts`, and roadmap notes.
The backend fast-uri follow-up changes only its lock entry and this roadmap;
exact commands and before/after audits are retained in the same external report.
The frontend xmldom follow-up changes only its two lock entries and this roadmap;
all 14 other pre-existing changed files were verified byte-for-byte unchanged.
The deployment qs follow-up changes only its manifest override, single lock
entry, and this roadmap. All 14 other dirty files match their pre-turn hashes.
It reuses the already-retained Firebase verification directory, creates no new
temporary install, and does not retry the previously rejected deletion.
The subsequent stream-json assessment changed only this roadmap and its external
evidence report. All 18 snapshotted source/dependency/workflow/config files remain
unchanged in that checkpoint. Its initially pending disposition was subsequently
explicitly accepted by the owner under the dated static-Hosting exception above.

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

Pending shared-shell follow-ups from the 2026-09-06 physical-device review:

- **Safari background integration:** the owner selected the non-scrolling
  treatment and physically confirmed the preview's rotation, address-bar keyboard
  recovery, flash-free loading/rotation, zoom boundaries, and zoomed-refresh fixes.
  The accepted behavior is now in the shared application shell, scoped to ordinary
  iPhone Safari 26+; Android, desktop, older Safari, and standalone/native views
  keep their existing shell. Pinch zoom remains enabled. Short routes lock at the
  painted inset; tall content can scroll within its real bounds, input focus
  releases alignment, and native/CSS-fallback fullscreen owns scrolling until exit.
  Home -> Connect -> Home on the normal development site was confirmed by the
  owner on iPhone. Nineteen controller regressions and the full 95-test frontend
  suite pass, as does the production frontend build. Chromium with an iPhone
  identity passed navigation, forms, tall content, fullscreen and history checks;
  it is not an iOS rendering substitute. Windows WebKit emulation did not activate
  the computed CSS inset, so that run is not counted as a pass. The owner confirmed
  integrated Log in keyboard show/dismiss preserves both painted bars, but reported
  unwanted field focus zoom and black bands after Dancing Circles fullscreen exit.
  Compact Log in/Sign up fields now have a 16px minimum font, with pinch zoom still
  enabled. Safari-edge fullscreen now locks only the root while keeping body
  overflow visible, preserving the existing document scroll container. A Chromium
  fallback check confirmed unchanged inset, visible body overflow and root lock
  before/during/after fullscreen, and realignment to shell top on exit. This does
  not prove Safari toolbar painting: the owner confirmed field auto-zoom is fixed,
  but fullscreen exit still restores black bands. Fullscreen recovery remains open;
  do not count the CSS-only change or Chromium geometry pass as an iPhone fix.
  A subsequent failure-path reproduction showed that deferred scroll alignment on
  fullscreen exit permanently disposed the controller, so later Home navigation
  could not recover. Position verification now keeps the inset/controller mounted
  and permits two delayed retries, then yields to browser events without looping.
  Three regressions cover delayed exit, exhausted retries with later recovery, and
  position movement immediately after locking. Chromium fault injection recovered
  after an 800ms ignored-alignment window. The owner still observed black bars
  after fullscreen exit with this newer fix, so recovery remains unresolved.
  A one-shot DEV-only diagnostic on the existing route, enabled solely by
  `fullscreen-debug=1`, reports phase/inset/viewport/overflow/fullscreen state in
  an on-device popup. The owner screenshot confirmed a healthy locked controller:
  inset/scroll/visual page top 695px, shell top 0, scale 1, root overflow hidden,
  body overflow visible, and neither fullscreen mode active. Both browser bars
  instead retained the fullscreen canvas's solid blue. The diagnostic has now
  been removed from development source after capturing this evidence.
  WebKit's `Page::updateFixedContainerEdges` retains the last sampled fixed
  element's color while it remains visible, even after it stops being fixed.
  A neutral `backdrop-filter: saturate(1)` candidate passed Chromium geometry,
  color and native/fallback checks, but the owner reported black bands on the
  first iPhone enter/exit. That unsuccessful filter has been removed, not retained
  as extra compositor work. Source evidence at WebKit commit
  `a09cbd759c1a2625ac0e34ddf8a488dc154fe582`, `Source/WebCore/page/Page.cpp`
  (`updateFixedContainerEdges`) and `LayoutTests/fast/page-color-sampling/`
  `color-sampling-ignores-backdrop-filters.html`; this does not establish the
  behavior of the owner's deployed Safari version.
  The accepted recovery uses the retained-color code's hidden-renderer check:
  after an explicit Safari CSS-fallback exit, temporarily hide only the exiting
  wrapper across two animation callbacks, then restore its original visibility.
  The canvas remains mounted, with no new scroll/zoom adjustments or game restart.
  A 150ms deadline and tab-visibility cleanup bound the operation; re-entry and
  unmount restore it immediately. Both click and Escape await restoration before
  focus returns, with stale async completions ignored. Native fullscreen and
  non-Safari exits bypass this pulse. The owner subsequently confirmed on the
  physical iPhone that fullscreen enter/exit no longer restores the black bands.
  Preserve this accepted recovery while adjusting fullscreen canvas sizing.
  Eleven deterministic fullscreen lifecycle regressions cover restoration,
  cancellation, timeout, ownership and browser scope; the complete frontend suite
  passes 106 tests. `npm test && npm run build` and `git diff --check` pass (the
  existing large-chunk build warning remains). Chromium repeated click/Escape
  cycles restore focus and retain the same canvas node, including landscape;
  native fullscreen and desktop fallback never receive the visibility pulse.
  Automated checks establish lifecycle safety; the owner's physical confirmation
  establishes acceptance of the browser-bar recovery on that tested iPhone.
  Separately, the Dancing Circles fullscreen black canvas was traced to the shared
  fullscreen selector outranking its blue page override and hiding the breathing
  layer. The page selector now matches that scope and keeps the existing layer
  edge-to-edge. Native/fallback browser checks preserve breathing blue and custom
  colors; 95 frontend tests and the build pass. Physical iPhone color confirmation
  remains pending.
  The bottom browser fade remains accepted, unresolved polish. No deployment
  or release is implied by this local integration.
- **Compact fullscreen aspect ratio (2026-09-07):** reproduced the landscape
  distortion at 852x300: a 1920x1080 canvas was stretched to 852x300 because
  fullscreen forced full width while independently clamping height. The shared
  fullscreen mixin now uses intrinsic auto sizing, percentage content-box bounds,
  and no flex shrink only within the existing named compact-viewport mixin.
  The same canvas now fits at approximately 533x300; backing dimensions and
  animation/game state remain unchanged. Portrait, short landscape, native and
  fallback Circles checks pass; Fractals and P4 Vega also preserve their ratio.
  Larger desktop sizing, including enlargement to 2560x1440, is unchanged.
  Three compiled-Sass regressions were added; `npm --prefix frontend test`
  passes 109 tests and `npm --prefix frontend run build` passes with the existing
  large-chunk warning. Eight Chromium scenarios retain canvas identity, exit
  focus and button containment, with breathing colors still changing. Physical
  iPhone verification of round circles and retained exit recovery is pending.
  Ordinary iPhone Safari's address bar and cached toolbar tint are browser-owned;
  native video fullscreen is not an interactive-canvas replacement. Do not add
  continuous repaint/scroll tricks or promise animated toolbar colors. Larger
  landscape tablets outside the compact breakpoints retain the previous sizing.
  On 2026-09-07 the owner accepted the visible Safari address bar and static
  toolbar tint as limitations not worth further work. Do not pursue a video
  streaming workaround. Resume Three Bosses physical iPhone gameplay acceptance;
  this decision does not mark the pending Circles device check or temporary
  Safari experiment cleanup as completed.
- **Mobile landscape navigation:** the owner supplied an iPhone Safari
  screenshot where the glass navigation rail collapses to a thin strip and its
  labels extend outside it, and reports the same issue on Android. Cause: the
  width-only compact breakpoint stopped applying after rotation, restoring a
  fixed 5svh header that was shorter than its links. A shared compact-viewport
  Sass mixin now also covers landscape height <= the named 500px token, applying
  intrinsic shell/header sizing and the existing compact navigation together.
  The owner's follow-up screenshot showed insufficient canvas separation; compact
  main content now has a minimum 1.6rem top inset. Chromium verified 844x390,
  932x430, 915x412 and both sides of the 780px width boundary, dropdown containment,
  Tab/Escape focus recovery and rotation with a dropdown open. Desktop header
  geometry at 1440x900 is unchanged; ordinary taller desktop sizing is out of scope.
  The canvas gap measured 16px at short landscape sizes without resizing the canvas.
  Frontend tests and build pass. Still verify the spacing and both dropdowns with
  expanded/collapsed browser bars on physical iPhone and Android before closing.
- **Safari experiment cleanup:** after the background comparison is finished,
  remove all disposable test/preview pages and instrumentation, stop only the
  isolated preview, and remove its temporary cache. Confirm no experiment files
  remain in the project; preserve the normal development stack and only retain
  an explicitly accepted production implementation.
  Integration is now implemented, but the combined stop/delete command was
  rejected by the execution policy on 2026-09-06. Cleanup is therefore unfinished:
  the disposable files remain outside the repository in
  `%TEMP%/mickeyf-safari-edge-check-20260906` and
  `%TEMP%/mickeyf-iphone-vite-dQirRt`. A read-only check on 2026-09-07 found no
  port-5175 listener; the directories still exist. No preview routes were copied
  into the project. The temporary
  `fullscreen-debug` effect in `useSafariBackgroundEdges.ts` was removed after
  receiving the owner's geometry screenshot; no diagnostic button or alert remains
  in that hook. External preview/cache cleanup remains outstanding.
  Complete this explicit cleanup before closing the background task.
  Superseded by the 2026-09-08 artifact disposition above: both exact external
  folders are now absent, no preview listeners or active runtime diagnostic
  flags remain (historical roadmap references are intentionally preserved),
  and accepted production background/fullscreen code is preserved. This closes
  the Safari experiment cleanup, not unrelated physical-device checks.

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

**Stay signed in checkpoint (2026-09-14):** implemented the optional, unchecked
renewable Login control; ordinary sign-in remains four hours. Sign up now exposes
the same choice for its existing automatic-login flow. Both forms share a round,
glass-styled accessible 14px checkbox without the private-device hint. The owner chose
revocable per-device sessions instead of accepting stateless-token replay risk.
Migration 0011 stores only hashed random session identifiers, immutable account
UUIDs and UTC timestamps, capped at ten sessions per account. Logout and cookie
replacement revoke the old session; deletion cascades all sessions. Protected
writes recheck the session inside the existing per-user transaction lock.
No password, token or preference is stored in browser-readable storage.
Production website API calls now use Firebase same-origin rewrites and its
forwarded `__session` cookie; native transport keeps the OS cookie store and
waits for server-confirmed logout. Implementation is not a production activation:
schema/grants, coordinated backend/Hosting deployment, one expected re-login,
and browser/native acceptance remain pending. See [session behavior and rollout](backend/SESSION_AUTHENTICATION.md).

**Renewal extension (2026-09-14):** selected sessions expire after thirty days
without renewal, with no fixed 90-day cutoff. Foreground activity renews via an
explicit signed-cookie POST, with fifteen-minute throttling and a 120-second
predecessor grace for concurrent tabs. Migration 0012 adds bounded rotation
metadata to the same device row; no new service or cleanup job. Existing 0011
sessions remain non-renewable. Password reauthentication remains required for
account deletion. Production activation still requires the coordinated steps above.
Renewal validation passed 418 backend unit tests, 39 isolated MySQL integration
tests and 56 focused frontend tests. Added `backend:dev:isolated` so the local
server can use the new schema without migrating production; its persistent
loopback-only database starts empty, with no production accounts or scores.

## Phase 15 — p4-Vega improvement and mobile polish

Branch handoff (2026-09-09): active work continues on
`feature/p4-vega-improvements`, created from the synced canvas-scrolling checkpoint
`59db12d4` and renamed from the initial `codex/` name at the owner's request.
The owner superseded the earlier instruction to preserve
`feature/three-bosses-polish`: its release-documentation and canvas-scrolling
commits are both retained on the active branch, so the old local/remote branch
and superseded remote `codex/p4-vega-improvements` were deleted. Stale remote
references were pruned, and local `main` was fast-forwarded to `origin/main`.
No work was merged into `main` or deployed by this cleanup. Physical phone checks
remain explicitly deferred, not passed, and do not block starting p4-Vega work.

Branch policy: use descriptive `feature/`, `improvement/` or `fix/` prefixes,
not `codex/`. Keep local `main` and the active development branch; retire completed
branches only after verifying their work is safely retained. Keep remote branches
only while useful. After each branch creation or development handoff, post the
dated single-paragraph development log to Slack `#dev-log` (channel
`C0A4J46RSP7`) and confirm delivery; writing it only in chat is not sufficient.
Commit and sync to the active branch; merging to `main` and deployment remain
separate decisions.

Dependency closeout (2026-09-09): at the owner's request, the exact updates from
Dependabot PRs #321, #323, #324 and #325 were consolidated into dependency-only
PR #326. Combined web audit/test/build, documentation, Unity integrity and CodeQL
checks passed; protected merge `78295368` brought the updates into `main`, then
merge `92cf0d87` synced them into the active p4-Vega branch. Original proposals
were closed as superseded and their branches pruned; the temporary
`fix/dependency-updates` branch and worktree were removed. Only `main` and the
active feature branch remain. The separate existing deployment-tooling
`stream-json` advisory is not resolved by these four updates. Both missing
branch-transition logs and the latest public-release feature summary were posted
to Slack `#dev-log`. Firebase Hosting run `34309113940` completed successfully
for `78295368`; no p4-Vega pause or newer inline-scrolling source was published.

Pause implementation (2026-09-09, development branch only): an icon Pause/Resume
button and a compact glass menu are available inline and in fullscreen. Explicit
loading/running/paused/game-over transitions stop the private ticker, only the
currently playing sprites, and the game-owned audio context without resetting
the run, score, frames or music position. Held keys and joystick captures are
cleared; Space still activates focused controls and restarts a finished run.
Slow score requests no longer block the end screen/retry, and late responses
cannot display a personal-best popup over a newer run. Aborted route loads and
navigation dispose the owned renderer, listeners, sprites and audio context.

The 21 focused pause/input/restart tests and TypeScript checks passed with the
updated frontend dependencies. Vite production build passed with the existing
large-chunk warning, and generated documentation was refreshed successfully.
The root locked install initially hit a Windows certificate-chain error; rerunning
with Node's `--use-system-ca` resolved it without disabling TLS verification.
Isolated Chrome verified a pixel-stable paused canvas,
stopped/resumed audio clock, keyboard Resume, portrait/landscape menu fit,
fullscreen presence and route teardown without browser errors. This is not a
physical-device or listening test; owner-deferred phone checks remain pending.
Controls/onboarding guide (2026-09-09, development branch only): How to play opens
a compact glass card from the controls panel or fullscreen pause menu. It explains
movement, water/black-hole rules, pause/restart, music/key/scale options, mobile
controls and automatic best-score submission. Opening it pauses an active run;
closing it leaves Resume explicit. The native modal contains keyboard focus and
keeps its close button visible while content scrolls on short screens. Chrome
verified portrait/landscape fit, touch/keyboard closing, focus return and native/
fallback fullscreen. TypeScript, 21 focused tests and the production build passed
(existing large-chunk warning only). Score rules are unchanged.

Game-feel/results batch (2026-09-09, development branch only): implemented the
owner-approved upgrades together. A bounded fixed 60Hz simulation preserves the
original 60Hz movement feel on different refresh rates, explicitly retaining
faster diagonals. The analog joystick supports proportional speed and keyboard
priority per axis. A live score display and reusable +10/ripple effect make
pickups visible. Centered 80% hitboxes and a 0.6-second non-lethal spawn pulse
are the trial collision/readability change, pending the owner's gameplay judgment.
Spawn selection now has a bounded fallback rather than an unbounded retry loop.

Boundary correction follow-up (2026-09-09): blue/red hazards use center anchors
while yellow uses a top-left anchor. Spawn placement now translates full rendered
bounds into the correct sprite position and reserves a 16px arena-space inset,
including fallback corners. Bounces clamp both axes and turn velocity inward,
so even an idle out-of-bounds axis cannot remain clipped. All 15 rules tests
passed with `node --experimental-strip-types --test ts/games/p4-Vega/p4Rules.test.mjs`
from `frontend`; `npx tsc -p tsconfig.json --noEmit` also passed. Isolated Chromium
verified all three actual sprite variants at all four spawn extremes, stationary
axis correction, right-edge reflection, and desktop/320px rendering. Player
movement, faster diagonals, pickup scoring and the spawn warning are unchanged.

The 100th pickup awards the final ten points and completes the run at **1000**,
without requesting a 101st hazard. A responsive glass results card handles
defeat/victory, restart, guide access, signed-out messaging, personal bests and
submission failure/retry. Restart does not wait for networking; aborted or late
old-run responses cannot replace current UI. Catch-up pickup notes use strictly
increasing audio times, and optional sound errors cannot stop the simulation.
The guide reflects these rules. Removed the replaced canvas game-over helpers,
unused old collision helper and their now-unused webfontloader dependencies.

Validation: frontend TypeScript and all 164 tests passed; the Vite production
build passed with the existing large-chunk warning. Backend TypeScript and 31
focused policy/auth/controller/repository tests passed. Isolated Chromium checked
320/390px portrait results, desktop and landscape native fullscreen, a controlled
100-pickup victory, the warning-to-collision transition, analog partial/full tilt,
restart/pause and mocked submission failure/retry/pending-request restart. No real
scores, accounts or database rows were written. Generated API docs were refreshed
by the existing watcher. Physical phone feel/acceptance remains deferred, not claimed.

Validation commands for this batch:
- In `frontend`: `npm test` and `npm run build`.
- In `backend`: `npm test` and
  `node --test -r ts-node/register ts/security/p4VegaScorePolicy.test.ts ts/security/scoreSubmissionAuthorization.test.ts ts/security/mainController.security.test.ts ts/leaderboards/p4VegaScoreRepository.test.ts`.
- At the repository root: `git diff --check`.

Release dependency: deploy the backend's compatible 0–1000 validation policy
**before** the frontend that submits 1000. Previous scores, ten-point increments,
personal-best storage, authorization and database schema remain unchanged. This
batch does not deploy either service or change leaderboard history.

Phone acceptance and scope closeout (2026-09-10): after testing the current
p4-Vega page on iPhone, the owner reported that gameplay was good and requested
the fullscreen joystick at the bottom corners. `91c6503e` implements that placement
for the existing left/right preference, retaining the enlarged touch target and
clearance for the fullscreen exit. `665c76cf` adds fullscreen-only selection and
touch-callout suppression for the score/HUD; eight focused style tests and
isolated native/fallback browser checks passed. The latter is not a new physical
iPhone confirmation. Live and results scores show only the score, without /1000.

The owner explicitly accepted the rare, intermittent Safari edge bands and asked
to move on. Record these as an **accepted visual limitation, not fixed**; do not
reopen the investigation or add further preview/repaint experiments unless the
owner requests it or a materially worse regression appears. The possible
paint/geometry timing interaction remains unconfirmed. Existing Safari recovery
and page zoom behavior are unchanged.

Release acceptance (2026-09-10): the owner subsequently reported "Done. All good.
Approved. Proceed." for the remaining focused device/scrolling check and release.
Carry forward that closeout, completed keyboard/browser checks and iPhone gameplay
acceptance. Do not repeat the old login/submission campaign, package-script audit
or complete game checklist. Release approval is separate from accepting the
Safari limitation and does not silently extend the exact-image S8 security
exception in `RELEASE_READINESS.md`.

Backend-first release preparation (2026-09-10): backend-only PR #327 passed the
required Web/Unity checks and CodeQL, then merged as
`7cfe7b5c7bd24e3362c7e2c089cde81999339d99`. Cloud Build
`397a07e2-d007-4306-be6c-9f60112a809e` successfully built that exact source as image
`sha256:6c5a8859328daa79423b23ae8e248191f73e62db2a563e9e907cd5a92a366331`.
The image retains the current Node/OpenSSL base. The owner explicitly approved
this exact replacement-image exception on 2026-09-10 with the October 7 expiry
and earlier-reassessment conditions unchanged, as recorded in
`RELEASE_READINESS.md`. Backend staging/promotion follows that decision.
That prerequisite is now complete: generation135 serves 100% of traffic on
`mickeyf-org-p4-1000-6c5a8859-0910`, with the exact reviewed image and unchanged
runtime configuration. The temporary candidate tag was removed. Anonymous
catalog/leaderboard delivery and CORS/no-store checks passed without account or
score writes.

The guarded Unity release build refreshed the unreleased canvas-scroll bridge:
certified build `5473694d…4ba7`, packaged release `97daf31c…c098`, source
`346491b4`, Unity 6000.3.8f1, 1004 source files. Package provenance/hash validation
passed. The obsolete packaged release was replaced and remains recoverable from
Git; the ordinary local WebGL server's output was not changed. This carries
forward the owner's device acceptance, not a claim of another physical-device
test. The Unity CLI/Pipeline compatibility follow-up below remains open.

Published release closeout (2026-09-10): PR #328 merged as `b6888bc2` after required
CI/CodeQL passed. Firebase workflow `34481007522` succeeded, including isolated
preview validation, Three Bosses startup/payload checks, live promotion/payload
verification and deletion of its temporary preview channel. A fresh signed-out
public Chromium check loaded p4-Vega's canvas, current How to Play card (including
1000-point completion), and plain score counter without page errors. This is a
delivery check, not another physical-device or score-persistence test. Release
acceptance is closed; do not reopen its device, Safari, script-audit or generic
login/submission checklists. Next planned phase is the bounded Clean Code inventory
below. The dated security exceptions remain accepted, not fixed.

Site-wide canvas scrolling (2026-09-09, implemented locally): the owner chose to retain
inline Three Bosses gameplay, reserving gestures that start on its actual UI
controls and allowing other vertical drags to scroll. PIXI canvases now allow
native vertical pan/pinch gestures; fullscreen retains gesture capture. p4-Vega
restart requires a tap, not a drag or cancelled scroll. Three Bosses loading/error
surfaces also allow native scrolling; the running game forwards non-control drags
through a small Unity/browser bridge, without moving the page in fullscreen or
escaping the existing viewport lock. Frontend type checking, 128 tests, a Vite
build, and Chromium touch/fullscreen checks passed. Unity compilation and all ten
focused gesture tests passed; guarded build `build_e494f313e54a` succeeded with
zero actionable warnings and restored its guarded settings. In mobile-emulated
Chromium, 70px/35px open-canvas drags produced matching scroll distances, menu
audio/joystick/Fire drags produced no page movement, and fullscreen stayed fixed.
The existing VS Code Front terminal now serves that local build on LAN port 5173;
backend and Docs were not restarted. Physical iPhone/Android confirmation of this
new scroll behavior is deferred by the owner, not claimed. Temporary browser and
Editor-transport helpers were removed. This is not a public deployment.
The pause implementation above builds on this unreleased scrolling behavior.

Tooling follow-up discovered here: installed Unity CLI 1.0.0-beta.8 rejects
parameterized commands against the project's older Pipeline command parser.
This build used the same Editor's authenticated structured API through the
existing guarded builder's injected transport; no package/version was changed.
Resolve that CLI/Pipeline compatibility in a bounded tooling maintenance task.

Begin this phase after the current Three Bosses polish milestone is stable.
Preserve p4-Vega's ten-point pickups and faster diagonal keyboard movement while
improving the game incrementally; the owner approved extending completion to 1000:

- [x] Add a real pause button and a simple pause menu with explicit, testable pause
  state transitions (owner device acceptance completed 2026-09-10).
- [x] Stop the canvas from swallowing ordinary vertical touch-scroll gestures, so a
  visitor can scroll the page even when the gesture begins over the canvas,
  while preserving deliberate interactions with actual game controls
  (owner device acceptance completed 2026-09-10).
- [x] Prioritize and implement the approved game-feel, analog-input, feedback,
  results/retry and 1000-point completion batch described above.
- [x] Before publishing that batch, deploy the backend's 1000-point acceptance
  policy first; do not reset previous personal bests or change the database schema.
- [x] Verify keyboard behavior plus real Android and iOS touch, orientation,
  scrolling, and fullscreen behavior before release. Carry forward completed
  keyboard/browser checks and the owner's 2026-09-10 device closeout. Rare Safari
  edge bands are accepted and are not a release blocker.

## Phase 16 — Whole-project Clean Code sweep

**2026-09-10 inventory checkpoint:** classified all 1,586 tracked files at
`3af15ecb` by ownership and purpose; this is not a completed line-by-line code
review. See [CLEAN_CODE_INVENTORY.md](CLEAN_CODE_INVENTORY.md) for the complete
category totals, subsystem queue, protected/generated boundaries and teaching
example. The active branch is `improvement/clean-code-sweep`.

- [x] Inventory tracked first-party, generated, native and third-party areas.
- [x] First code slice: extract the existing leaderboard detail-state loader
  from `GameLeaderboard.tsx` into a React/environment-independent adjacent
  module with explicit readers; separate its logic tests from JSX/view tests.
  Effect cleanup, rendering, HTTP contracts and decision body remain unchanged.
  Completed 2026-09-10: 13 direct Node loader cases; TypeScript and all 185
  frontend tests passed; production build passed with the existing chunk-size
  warning; local browser detail/hub navigation and both tables verified.
- [x] Second slice: consolidated the duplicated Three Bosses mutation
  preconditions in `threeBossesMutationAuthorization.ts`, preserving guard
  order, response contracts, router middleware and persistence. Backend
  TypeScript, 8 policy cases, 7 existing HTTP/router cases and webpack build
  passed on 2026-09-10; no production/authentication campaign was repeated.
- [x] Simplified frontend test discovery to a quoted Node glob: the same 19
  files and 185 passing tests, no coverage removed or dependency added.
- [x] Corrected stale backend paths in `.github/copilot-instructions.md` and
  retired the unused 586-line `resources/project-structure.txt` plus its
  dedicated attribute rule. All 18 guide paths and tracked references checked;
  no application changes, replacement generator or repeated build/test run.
- [x] Login/signup request-boundary review: moved all four auth HTTP operations
  into independently testable `authApi.ts`, kept configured exports in
  `authService.ts`, and removed the session username `any` cast. Existing
  forms, alerts, cookies and response contracts preserved. On 2026-09-10,
  9 transport cases, TypeScript/all 194 frontend tests and Vite build passed;
  existing chunk warning remains. No real auth requests or new dependency.
- [x] Initial session verification now ignores results after a newer login/logout
  starts or the effect is cleaned up. Deferred browser responses verified that
  signup auto-login survives a late signed-out startup response.
- [x] Owner-requested signup improvement: create the account, sign in through the
  existing cookie-based login, show one welcome message and navigate Home.
  Failed automatic login preserves account creation and routes to Log in;
  duplicate submissions are guarded. Shared SweetAlert2 glass styling matches
  the site without a replacement library. On 2026-09-10, TypeScript/all 200
  frontend tests and Vite build passed (existing chunk warning); mocked browser
  success/error/fallback and desktop/portrait/landscape checks passed. No real
  accounts or backend changes; physical iPhone dialog behavior is not verified.
- [x] Route loading/performance and owner-requested status screens (2026-09-14):
  destinations load on demand behind one shared cosmic loading/error boundary;
  Home, navigation and 404 recovery remain immediately available. Pixi's native
  CSP compatibility registration moved with each graphics experience, not out of
  the application. Initial minified JavaScript fell from 1,115,199 to 354,416
  bytes (gzip 330,294 to 110,125); no build chunk exceeds the unchanged 500 kB
  warning threshold. A matching custom 404 supplies Home/Games actions. Motion
  respects reduced-motion preferences, without artificial loading delays.
  TypeScript/all 265 frontend tests and production build passed. Built-browser
  experience rendering, route recovery and genuine stalled/failed chunk states
  were checked; desktop and 390x844 status screenshots inspected. This is not a
  new physical-iPhone acceptance or production/native deployment. See the
  [teaching checkpoint](CLEAN_CODE_INVENTORY.md#route-dependencies-and-shared-status-screens--2026-09-14).
- [x] Animation music-upload boundary (2026-09-14): both pages now use one
  `MusicUpload` control with MIME plus explicit audio-extension picker hints for
  the owner's Safari Files report. Removed duplicated refs/effects/keyboard
  handlers and the engine's UI-listener adapter; playback/visual behavior is
  unchanged. Five focused tests, frontend TypeScript/all 373 tests and Vite build
  passed. The owner confirmed Files selection/playback on iPhone on 2026-09-15;
  this is local acceptance, not a deployment or every-codec claim.
  See the [teaching checkpoint](CLEAN_CODE_INVENTORY.md#shared-music-picker-and-audioui-boundary--2026-09-14).
- [x] Three Bosses browser-bridge teardown (2026-09-14): extracted only the
  identical best-effort submission/layout/visibility release sequence into one
  local function. Failed startup and normal shutdown keep their distinct
  submission-disable policy, ordering, errors and once-only behavior. Five
  mocked lifecycle tests, frontend TypeScript/all 378 tests and Vite build
  passed; no Unity rebuild, gameplay/device retest or deployment.
  See the [teaching checkpoint](CLEAN_CODE_INVENTORY.md#three-bosses-browser-bridge-teardown--2026-09-14).
- [x] Renderer/upload cancellation ownership (2026-09-14): late Dancing Circles
  startup is disposed after unmount; cancelled/replaced uploads cannot resume
  playback, overwrite current state or clear a newer track during old cleanup.
  Reused mount/session guards and captured-resource teardown, without changing
  visuals, DSP or autoplay ordering. Three renderer and eight audio cases,
  frontend TypeScript/all 389 tests and Vite build passed. Device acceptance and
  Safari Files check remain deferred; no deployment.
  See the [teaching checkpoint](CLEAN_CODE_INVENTORY.md#renderer-and-upload-cancellation-ownership--2026-09-14).
- [x] Audio transport intent (2026-09-15): shared guarded playback now prevents
  pending Play, upload autoplay and interruption recovery from overriding a
  later Pause/Stop. Old success/failure cannot disrupt a newer Play. Track
  loading/ownership, Pause position and Stop rewind are preserved. All 26 audio
  cases, frontend TypeScript/all 407 tests and Vite build passed; no deployment
  or repeated device acceptance. See the
  [teaching checkpoint](CLEAN_CODE_INVENTORY.md#audio-transport-intent--2026-09-15).
- [x] Shared hooks/dropdown boundary (2026-09-15): both hooks reviewed and kept
  unchanged. Shared dropdown now makes closed options inert, supports Escape
  and predictable focus return, closes when disabled and scopes its outside
  listener to the open state. Six regression cases, real Chrome keyboard/
  pointer checks, touch emulation, TypeScript/all 413 tests and Vite build
  passed. Styling/callers unchanged; no physical-device retest or deployment.
  See the [teaching checkpoint](CLEAN_CODE_INVENTORY.md#shared-hooks-and-dropdown-interaction--2026-09-15).
- [x] Safari preview styling fix (2026-09-15): reproduced the owner's unstyled
  page in WebKit by stalling Google Fonts imports. Separated optional font
  downloads from local layout CSS, preserving families/weights and fallbacks.
  Both animation pages stay styled with fonts stalled; failure/normal loading,
  TypeScript/all 415 tests and build passed. The owner still saw unstyled content
  on the built preview; the live development preview on LAN port 5173 restored
  the test path. The owner then confirmed Files selection/playback works.
  No public/native deployment or definitive phone-network diagnosis is claimed.
- [x] Password-account persistence boundary (2026-09-15): moved the three
  signup/login queries and unique-key error translation out of the HTTP
  controller into `passwordAccountRepository.ts`. Explicit credential projection
  keeps database column names/driver fields out of controller decisions.
  Validation, bcrypt ordering/cost, session proof/commit/cookies and legacy DTOs
  remain unchanged. Eight repository cases and 16 controller cases (including a
  duplicate-preflight short-circuit check), backend TypeScript and webpack
  production build passed; independent review found no regression. No real
  account or database operation.
  Reviewed both score repositories and left their ordered transactions intact.
  See the [teaching checkpoint](CLEAN_CODE_INVENTORY.md#password-account-persistence-boundary--2026-09-15).
- [x] Main-router database injection (2026-09-15): bootstrap now passes its
  existing pool to `createMainRouter`; the router no longer imports runtime
  database configuration. One required dependency matches the other routers,
  without a fallback or new abstraction. Registration, limiter order/thresholds,
  controllers, session/SQL/cookie policy and feature gates are unchanged.
  The four-file pre-change baseline passed 43 tests; the requested five-file
  post-change batch passed 50, including seven actual-router cases with fake
  persistence and a cold child-process import without database configuration.
  Both batches had zero failures, cancellations or skips. Backend TypeScript,
  webpack and `git diff --check` passed using Node 22.23.2/npm 11.6.2 and a
  worktree-local locked install with lifecycle scripts disabled. This is focused
  coverage, not the full backend suite or a database/provider integration run.
  No commit, deployment, development-server restart or branch cleanup occurred.
  See the [teaching checkpoint](CLEAN_CODE_INVENTORY.md#main-router-database-injection--2026-09-15).
- [x] Native sign-in cancellation ownership (2026-09-21): native retries now
  remain blocked until the previous cancellation is acknowledged, even after
  the cancelled operation returns a late token. Cancellation failures remain
  blocked until client reload; user cancellation itself still returns promptly.
  Three new regressions failed before the fix, then all 21 provider-client and
  73 auth transport/signup cases passed; frontend TypeScript and build passed. Google,
  native Swift code and disabled Apple activation flags are unchanged. This
  does not complete Apple's token-revocation lifecycle or prove device timing.
  See the [teaching checkpoint](CLEAN_CODE_INVENTORY.md#native-sign-in-cancellation-ownership--2026-09-21).
- [ ] Complete subsequent subsystem reviews one at a time; choose actual
  improvements from evidence, not file length or similar-looking syntax.
- [x] Gameplay note-selector cleanup (2026-09-21): fixed lookup tables are shared
  readonly data, semitone offsets are local, and redundant C-only key history is
  explicit. Eight focused selector/playback tests and frontend TypeScript passed.
  No musical policy or random-call ordering changed. See
  [the teaching checkpoint](CLEAN_CODE_INVENTORY.md#gameplay-note-selection-state-and-fixed-data--2026-09-21).
- [x] Corrected the note-selector findings (2026-09-21): transposition wraps by
  twelve pitch classes, Hz ratios become semitone intervals, and an empty
  candidate pool restarts on the selected tonic. Normalized two G-frequency
  rounding mismatches in the scale catalog. Seventeen focused tests and frontend
  TypeScript passed; playback timing/range and gameplay are unchanged. No deploy.
  See [the teaching checkpoint](CLEAN_CODE_INVENTORY.md#pickup-pitch-and-missing-note-corrections--2026-09-21).
- [x] Three Bosses Figma/UI Toolkit compatibility review (2026-09-21): the
  installed/pinned Editor is 6000.3.8f1 with Web support. Existing screens use
  uGUI/TMP; at review time there were no UI Toolkit documents/styles in Assets. Unity's official
  `com.unity.ui.figma` 0.1.0-exp.1 supports 6000.3+, so a major Editor upgrade is
  not required for a pilot. The connector is experimental; it requires Figma
  desktop and Design-mode edit access. The plugin is free, including on editable
  Starter files. See the [official announcement](https://discussions.unity.com/t/experimental-ui-toolkit-connector-for-figma-design/1736969).
  The [Unity package registry](https://packages.unity.com/com.unity.ui.figma)
  confirms a Pipeline 0.6.0-exp.1 dependency; the review found 0.5.0-exp.1, so
  connector setup must include a reviewed dependency update. Read-only CLI
  commands: `unity --version` (1.0.0-beta.10), `unity editors --installed --format
  json`, and `unity editors upgrade 6000.3.8f1 --dry-run --format json` (offers
  6000.3.24f1). No Editor, dependency, scene or build changed; no tests were run.
- [x] Isolated Main Menu UI Toolkit pilot (2026-09-22): implementation is in
  `Assets/Scenes/UI/MainMenuToolkitPilot.unity`, excluded from builds. Production
  Main Menu, HUD, touch controls and gameplay remain unchanged. Actual Figma
  values from file `hH2nXiz3n12LclUjpsPgui`, root `3:2`, were imported through
  the official `figma_import` Pipeline command, with no USS errors or notes.
  Experimental pins are `com.unity.ui.figma` 0.1.0-exp.1 and
  `com.unity.pipeline` 0.6.0-exp.1; the Editor version is unchanged. Generated
  assets stay separate from the pilot controller and owned presentation USS.
  Existing `Menu.png` is reused directly; Oxanium Bold intentionally replaces
  Liberation Sans in the pilot only. The focused PlayMode run passed 2/2 tests
  in 2.81 seconds across eight viewport sizes and three rotation/safe-area repeat
  steps: centers within 1px, minimum 48px targets, focused/unfocused audio icons,
  mute, and PLAY starting a new run/loading Level 1. All eight actual UIDocument
  captures were visually inspected, with no clipped labels observed. Desktop
  Figma-plugin pairing was not validated; the official import command was.
  Production adoption remains pending. Verify WebGL/browser-ready signaling,
  page/Toolkit touch ownership in the currently uGUI-specific `WebPageTouchScroll`, and physical
  phone/browser behavior. No production migration or release is included.
  On 6.3 retain margins instead of imported gap and avoid unsupported blur/shadow
  assumptions. See the [pilot record](unity/three-bosses/Assets/UI/Pilots/README.md)
  for source, file ownership and remaining gates.
- [x] p4-Vega entity ownership (2026-09-21): player/collectible updates now use
  their stored sprites, removing redundant sprite arguments from the game loop.
  Five entity tests, fifteen existing rule tests and frontend TypeScript passed.
  Gameplay and audio rules are unchanged; no deployment or Unity change.
  See [the teaching checkpoint](CLEAN_CODE_INVENTORY.md#p4-vega-entity-sprite-ownership--2026-09-21).
- [x] Same-note color recovery (2026-09-21): reproduced stale idle policy state
  after sustained silence, including its effect on a subsequent phase reset.
  Continuous rendering already retained the correct pitch anchor. The policy now
  remembers pitch color separately from idle output; tracker commit signals,
  palette, drift and timing are unchanged. Three regression cases failed before
  the fix; all nine focused color tests and frontend TypeScript pass afterward.
  See [the teaching checkpoint](CLEAN_CODE_INVENTORY.md#pitch-color-recovery-after-silence--2026-09-21).
- [x] Shared hue-distance calculation (2026-09-21): interpolation and pitch-color
  transition settling now reuse the same existing-utility function. Preserved
  wraparound, signed half-turn ties, rounding and thresholds. Four focused tests,
  frontend TypeScript and whitespace checks passed; no full-suite/device retest.
  See [the teaching checkpoint](CLEAN_CODE_INVENTORY.md#shared-hue-distance-calculation--2026-09-21).

Record-notification follow-up (2026-09-10): p4-Vega's existing results-card badge
was not a SweetAlert, and Three Bosses had no browser record announcement. Both
now use the shared glass `PersonalBestAlert` after server confirmation. Receipt
replays can supply the first confirmation but repeated Three Bosses run IDs do
not repeat the announcement. Existing p4 badge, scores, ranking, submission
contracts and Unity build are unchanged. Mocked browser checks covered desktop,
portrait, native/fallback fullscreen, focus, help-dialog deferral and cleanup;
physical-device record notification checks remain unverified.

**Learning handoff:** show actual before/after code for each implementation,
explain the project boundary and general coding principle, state trade-offs and
preserved behavior, and report checks actually run. Proposed examples must be
clearly distinguished from implemented changes. The inventory now records
the implemented examples and their exact verification scopes.

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

The focused first-party `package.json` script audit (originally requested
2026-09-06) was moved into the bounded pre-release temporary-artifact cleanup
above by the owner on 2026-09-08. Do not duplicate that audit in this later phase
unless relevant changes or new evidence warrant it.

### Pending Git branch/worktree hygiene

- [ ] Git branch/worktree hygiene — after this refactor is reviewed and
  safely preserved:
  - Inventory all local branches, remote branches, tracking references,
    worktrees, and relevant open/merged pull requests.
  - Establish the intended retained development/release branches; do
    not assume main is the comparison baseline.
  - Verify current remote state before proposing deletions.
  - Check unique/unpushed commits and actual integration evidence,
    including squash/cherry-pick cases where applicable.
  - Preserve active worktrees, dirty/untracked/ignored local work,
    protected/default branches, release/rollback references, and
    anything whose purpose or integration is uncertain.
  - Produce a keep/delete-candidate/uncertain table with exact names,
    tip SHAs, and reasons. Age, naming, or a missing upstream alone
    does not prove a branch obsolete.
  - After approval of exact candidates, delete only the approved
    obsolete local/remote branches and prune verified stale tracking
    references. Preview worktree-metadata pruning separately.
  - Do not force-delete branches, prune tags, expire reflogs, run
    git prune, or remove active worktrees.

## Phase 17 — Ludolume native stores and social sign-in

Owner direction confirmed 2026-09-10: publish Ludolume through Capacitor to both
Google Play and Apple's App Store. The owner has an Apple Developer membership
but no Mac. The owner selected `com.mickeyf.app` on 2026-09-10 to match the
reverse-domain convention for `mickeyf.com`. Capacitor, Android and iOS now use
that identifier consistently; local configuration alone does not reserve it
with Apple or Google Play.

Immediate priority reaffirmed by the owner on 2026-09-10: finish this bounded
branding/account setup, complete Apple distribution signing and a signed
TestFlight build for the owner's iPhone, implement Google and Apple sign-in,
then resume the incremental Clean Code sweep. Do not skip the TestFlight/device
milestone. Public store publication still requires separate release approval.
Do not let App Store Connect's stale bundle-description label expand this work
into repeated refreshes, a replacement app/identifier or broader CI permissions.

Owner reaffirmed on 2026-09-10: finish the scoped Clean Code pass and its security
closeout before public store publication, together with the privacy/release
deliverables below. TestFlight builds are not a public store release. Google
sign-in and native iOS Sign in with Apple can be implemented and tested before
publication; do not treat public release as their shared prerequisite. Apple's
web/other-platform service has a separate documented prerequisite for an
existing App Store app using Sign in with Apple. Keep that activation separate;
do not accelerate publication solely to enable it. This clarification does not
itself activate, implement or defer both providers.

- [x] Register the Apple bundle ID and create the App Store Connect record.
  Apple Developer registration verified 2026-09-10: explicit `com.mickeyf.app`
  under team `AX4Z7T24C9`, description Ludolume. After the original listing name
  was rejected, Apple accepted the owner-selected Ludolume: app `6810735137`,
  iOS, English (U.S.), SKU `ludolume-ios`, status Prepare for Submission.
  Registration alone did not upload or submit a binary. App Store Connect's
  bundle selector still displayed the previous description after refresh, although
  Apple Developer's Identifiers list confirmed Ludolume with `com.mickeyf.app`.
- [x] Set App Information categories: Entertainment (primary), Music (secondary).
  Saved in App Store Connect and verified after a page reload on 2026-09-10.
  Exact API reads also reconfirmed Ludolume for both app and bundle records;
  the selector's previous description remains an Apple UI inconsistency, not
  evidence that `com.mickeyf.app` needs replacing. No store submission occurred.
- [ ] Confirm Google Play developer account access and create its app record.
- [ ] Preserve the PWA track and review the existing Android/iOS shells. Build
  Android on Windows; use GitHub Actions macOS/Xcode for iOS (owner approved
  2026-09-10), with protected signing credentials, bounded cost and manual release
  approval. Manual unsigned simulator workflow and a shared Xcode scheme are
  prepared. Approved workflow-only PR #330 merged to `main` on 2026-09-10;
  it did not publish the pending website/authentication changes. The first
  [manual cloud build](https://github.com/Good-Loops/mickeyf.com/actions/runs/34494943864)
  passed on development commit `aa83270262ce579826eab79bc85ee55f85139da9`:
  all 202 frontend tests, Vite build, Capacitor/CocoaPods sync, Xcode unsigned
  simulator compilation and artifact upload succeeded. This is not physical
  iPhone validation or a signed store build. Android native compilation is
  still unverified; the local Java/Android SDK toolchain is not configured.
  See `frontend/ios/BUILDING.md`; that unsigned run did not upload to TestFlight
  or publish a store release. The signed iOS checkpoint is recorded below.
- [x] Create the Apple distribution identity and configure protected signing secrets.
  With owner approval on 2026-09-10, the account-holder UI created Apple
  Distribution certificate `Q4FS72TU6B` (expires 2027-09-10) and active
  `IOS_APP_STORE` profile `Z392C733U4`, “Ludolume App Store 2026-09-10”
  (UUID `e312aedc-9b44-4464-8ce9-0e0f0fb39c0a`), for exactly
  `AX4Z7T24C9.com.mickeyf.app`. After Chrome downloads were blocked, the existing
  Developer-role API key retrieved both by exact GET (HTTP 200), without role
  escalation. The RSA key matches the leaf certificate; Apple WWDR G3 leaf and
  profile CMS signatures, profile/certificate matching and helper guards passed.
  An AES-256-encrypted P12 and DPAPI-protected password are backed up locally
  with restricted access. `ios-testflight` holds `ASC_PRIVATE_KEY_P8` and all
  three iOS signing secrets; the exact `improvement/clean-code-sweep` branch
  restriction and `Good-Loops` reviewer remain in place.
- [x] Build, verify and upload the signed iOS app to internal TestFlight.
  [Protected run `34505852569`](https://github.com/Good-Loops/mickeyf.com/actions/runs/34505852569)
  passed on exact commit `cd59d311e8b866f77477f8867a6334544a89a066`: signed
  archive/export, IPA metadata and leaf-certificate verification, upload and
  credential/artifact cleanup all succeeded. App Store Connect GET (HTTP 200)
  confirms Ludolume 1.0 build `4.1.0`, ID
  `2999535d-e87d-47e1-91cf-ce2bb4bbd4ea`, processing `VALID`, audience
  `INTERNAL_ONLY`, not expired. The initial `MISSING_EXPORT_COMPLIANCE` state
  cleared after the owner personally submitted Apple's encryption declaration
  on 2026-09-10; the live App Store Connect UI now confirms **Ready to Test**.
  The **Ludolume Internal** group initially had one tester (the existing Account Holder)
  and only build `4.1.0`; automatic distribution is disabled. The owner installed
  TestFlight version 1.0/build `4.1.0` on the iPhone. The owner reports other
  tested functionality working, but p4-Vega shows “The game could not load.
  Please refresh to try again.” After the CORS rollout below, the owner confirms
  password login works. A subsequent native-cookie correction in build `6.1.0`
  passed the owner's login/logout and full close/reopen check on 2026-09-10;
  signup, offline logout and expiry have not been separately rechecked.
  p4-Vega still fails on that installed build. A deterministic Pixi custom-scheme
  asset URL bug is now fixed locally, with five focused regression tests,
  TypeScript and a production build passing. Signed build `7.1.0` is uploaded
  and Apple-processed; owner export answers are saved and the existing internal
  group has access (`IN_BETA_TESTING`). The owner confirms p4-Vega loads/plays.
  Portrait HUD offsets and unwanted native outer-page scrolling reported next
  are included in combined build `8.1.0` with the Home fix. Apple has processed
  it; owner export answers are saved and existing internal access is verified
  (`IN_BETA_TESTING`). The owner accepts those three corrections in `8.1.0`;
  follow-up native fullscreen, canvas-frame and p4 inner-scroll issues are below.
  See `frontend/ios/BUILDING.md`.
  Provider login follows.
  No roles, public testing, public store submission or website release were
  enabled by this setup.
- [x] Before public app release, accept small-screen Home typography and full
  quotes on the iPhone. Implemented locally: smaller welcome/quote text, balanced
  wrapping, separate author and stable normal-flow placement. All 61 quotes fit
  at 320×568 and 844×390; portrait/landscape/desktop visual checks, TypeScript and
  production build passed. This change postdates TestFlight `7.1.0` and is in
  available internal build `8.1.0`, accepted by the owner. Global Safari edge
  handling is unchanged.
- [x] Accept native fixed-screen layout and p4-Vega portrait HUD in that combined
  update. Local corrections scope safe insets to fullscreen and lock only the
  outer native document, preserving overflow access for long forms/lists.
  Thirty focused tests, TypeScript/build and simulated portrait bounds passed;
  the owner confirms those corrections in `8.1.0`. Subsequent issues remain below.
- [ ] Accept the follow-up native p4-Vega screen-fit/fullscreen corrections on an
  installed build. Local fixes preserve rounded inline corners, fit controls
  without main scrolling, remove fullscreen frame decoration, use in-app CSS
  fullscreen on iOS, and preserve navigation state across overlapping requests.
  Forty focused tests, TypeScript and production build pass. Approved internal
  build `9.1.0` uploaded from `bd107c54`; all 226 cloud tests and signing/upload
  cleanup passed. Owner export answers are saved, and existing internal-group
  access is verified (`IN_BETA_TESTING`). Only the focused device check remains.
  Do not repeat Home/loading tests.
- [x] Create matching celestial/glass Ludolume native icons and launch artwork.
  Sources and prompts live in `frontend/resources/README.md`. Android adaptive
  icons have a real alpha foreground, extracted using the owner-approved chroma
  key method; iOS retains an opaque 1024-square icon. Portrait/landscape exports,
  XML/asset references and duplicate-resource checks passed. Native device
  appearance remains part of signed-build acceptance, not a completed device test.
- [ ] Add Google and Apple sign-in while retaining username/password accounts
  and score ownership. Verify provider identities on the backend; require proof
  before linking an existing account, never match solely on an email string.
  Web and native clients need their own provider configuration and approved
  sign-in flows; do not load Google OAuth inside Capacitor's embedded WebView.
  **Backend foundation checkpoint (2026-09-14):** signed Google/Apple ID-token
  verification, password-proven linking to immutable account UUIDs, conflict-safe
  identity lookup/storage and migration 0009 are implemented offline. Deletion
  readiness and restored-backup replay validate and remove provider links.
  No provider routes/buttons, session changes, production schema/grant changes
  or deployment are included. **One-use flow checkpoint (2026-09-14):** migration
  0010 and bounded five-minute attempt storage, trusted session/origin context,
  consume-before-verify orchestration, and deletion/replay compatibility are
  implemented offline. No scheduled cleanup service is introduced. The internal
  account-verification result does not issue a session. **Session checkpoint
  (2026-09-14):** shared issuance/consumers now require v2 UUID-bound, revocable
  device sessions, including score/ticket/deletion authorization and the internal
  provider context. Username/password login supports an optional 30-day session.
  **HTTP/session checkpoint:** shared provider issuance, exact-origin/signed-cookie
  binding, rate limits and final locked link-session checks are implemented;
  the 444-test backend suite and 31 isolated MySQL cases passed. **Client checkpoint:**
  opt-in configuration/discovery, serialized frontend provider authentication,
  login/link controls, and a disabled-by-default native Apple bridge are implemented.
  The brief route loader is reduced to dots and Loading…; 404/error recovery remains.
  **Authorized-origin checkpoint (2026-09-14):** saved and read back exactly
  `http://localhost:5173`, `https://mickeyf.com` and `https://www.mickeyf.com` on the
  existing `MickeyFOrg Client`. Its name/client ID and credentials are unchanged;
  redirect URIs remain empty. **Branding/header checkpoint (2026-09-14):** Google
  confirmed saving `Ludolume` and `https://mickeyf.com`; existing contacts/domain
  and Testing status remain unchanged. Privacy/terms URLs and logo remain unset.
  The privacy-policy draft is private, not a published link. Local Hosting CSP
  now allows only the documented GIS resource paths, with popup-compatible COOP;
  the seven focused policy/API-base tests pass. No provider activation, database
  or deployment change occurred. Live headers require separate approval for the
  Google resource trust and popup opener change. **Isolated Google checkpoint
  (2026-09-14):** the local launcher accepts an explicit Google web client ID,
  blocks inherited provider settings/root `.env` fallback, and adds only scoped
  local provider grants. Seven launcher/bootstrap tests and backend typecheck
  passed. The local runtime-role probe passed and rolled back all fixture rows;
  Google's real button and cancellation worked in Chrome. Only Back restarted;
  Front, Docs and WebGL stayed running. Real-account link/login/session acceptance
  remains pending. The owner-approved fourth origin `http://localhost` was saved
  and read back on the existing client; other origins, credentials, scopes and
  publication status were preserved. No production
  schema, grants, provider flags or deployment changed. Next: focused local
  real-account acceptance, a published privacy policy before public activation,
  approved native Apple capability/profile,
  focused real-provider acceptance and native Google SDK/client configuration.
  **Owner clarification (2026-09-14):** Continue with Google on both Login and
  Sign up must sign in returning Google users directly and onboard new Google
  users without requiring password-account creation or linking. Linking an
  existing password account is optional, not the primary entry flow. Localhost
  public preview and the public site must use the same real accounts/scores.
  A link-only rollout is not completion; retain the existing privacy/age/deletion
  requirements for production account creation rather than silently bypassing them.
  **Deployment preparation (2026-09-14):** canonical/frozen deployment and traffic
  validation now carry full Google signup/login settings with the exact approved
  client and enabled-deletion prerequisite. Default-off cannot silently disable
  an already-active provider; intentional enable/disable is source/image-bound.
  Offline renderer/traffic checks passed 73 tests. No deployment occurred.
  The owner explicitly requested returning the localhost Google buttons: restore
  them on both forms when switching the gateway to the compatible public backend,
  preserving real accounts/scores instead of selecting the isolated database.
  **Localhost deletion transport (2026-09-14):** renewable gateway supports both
  password-confirmed and Google-confirmed self-deletion, with exact body shapes,
  session-cookie isolation and unchanged pending/error outcomes. Twenty mocked
  gateway tests and frontend typechecking passed. Legacy mode and UI remain
  unchanged; no real deletion or production activation occurred. At cutover,
  retire the Manage account compatibility guard along with the sign-in guards.
  **Passwordless signup checkpoint (2026-09-14):** owner-approved Google-web
  signup now has a direct official button, username onboarding, atomic NULL-password
  user/Google-link creation and the shared renewable session. Fresh Google proof
  also authorizes deletion of that account under its live-session/deletion-journal
  safeguards; password accounts keep their existing flow. Opt-in migrations
  0013–0015 enforce username uniqueness, nullable passwords and purpose-bound
  signup/delete challenges. Public signup remains disabled and subject to the
  age/consent backlog; production requires available deletion, reviewed grants,
  migration and explicit deployment approval. No native Google or cloud rollout.
  **Session concurrency follow-up (2026-09-21):** reproduced different-account
  first-session creation failing with `ER_LOCK_DEADLOCK / 1213 / 40001` when
  both transactions held overlapping empty-index gap locks. Creation now uses
  next-transaction-only `READ COMMITTED`; per-user/proof/cap locks, commit
  safeguards, renewal/logout isolation and pool defaults remain unchanged.
  One combined disposable provider/replay/session run passed 39/39, session
  unit tests 12/12 and backend typechecking passed. No production change.
  Copilot's router dependency-injection checkpoint `8c5dc7e1` is preserved and
  synced. KWS's pending response does not block provider
  implementation/testing; all-ages public activation keeps its consent gates.
  **Native Apple onboarding (2026-09-21):** implemented a shared login/signup
  username continuation, signed verified shared/private-relay email, immutable
  provider-subject ownership, remembered-session reuse and fresh-proof SQL
  deletion. Account management now discovers Apple capabilities. Existing
  accounts do not have to link, and email never auto-merges accounts. Apple
  signup/deletion and native capability remain disabled: complete authorization-
  code exchange/token revocation and revoked-credential handling before activation.
  Focused backend tests passed 87+33, frontend tests 88+32, both typechecks and
  disposable MySQL provider group 40/40. No real Apple, macOS/TestFlight or
  production rollout was performed. Next: finish that Apple lifecycle, native
  Google SDK/client setup, then the remaining Clean Code sweep.
  See [scope, migration boundary and remaining steps](backend/PROVIDER_SIGN_IN.md).
  **Apple token lifecycle preparation (2026-09-21):** native authorization-code
  transport, server exchange with nonce/subject binding, encrypted refresh-token
  storage and transactional deletion/retry state are implemented behind the
  existing disabled capabilities. Owner approved encrypted post-deletion retry
  retention for at most seven days, erased sooner on confirmed revocation.
  Backup replay preserves the earliest deadline and never contacts Apple.
  Migration 0016 and the bounded explicit worker are source preparation only;
  no production schema, keys, jobs, provider settings or deployment changed.
  Before activation, document this privacy exception, verify the maintenance
  execution/expiry path and grants, finish revoked-credential/session handling,
  then perform the native build/device check. No repeat gameplay or general
  login acceptance is requested. KWS remains a separate signup-audience gate.
  **Native Apple credential-loss checkpoint (2026-09-21):** signed session
  provenance now distinguishes Apple login from merely having a linked Apple
  identity, survives renewal, and is absent from password/Google sessions.
  The native-only credential lookup and platform startup/resume/revocation
  checks reuse current-device logout without deleting accounts or scores.
  Checks and logout are serialized with login; unconfirmed logout hides local
  auth and retries without claiming server success. Unknown/platform-error
  states do not trigger logout. No schema, keys, cloud jobs or activation changed.
  **Signed Apple notification checkpoint (2026-09-21):** independent disabled
  receiver verifies Apple's signature/audience and revokes only pre-event Apple
  sessions. Original proof time survives renewal. Expiring hashed-subject
  cutoffs and account locks close concurrent-login/signup races, including
  unknown subjects; duplicate/late events preserve newer authorizations.
  Migrations0017/0018, scoped grants, compatible restore verification and bounded
  cleanup in the existing explicit Apple maintenance command are prepared.
  Six focused disposable SQL cases and fifteen restricted-grant cases passed;
  no live migration, provider setting, cloud job or deployment changed.
  Remaining: approve/document the cutoff's short-lived security-data processing
  and physical purge bound; publish the encrypted-token retention exception;
  configure/verify the maintenance path and registered HTTPS receiver; invalidate
  any legacy Apple sessions without provenance; then native build/lifecycle
  acceptance. Restored sessions must be invalidated before reopening traffic.
  KWS remains a separate signup-audience gate. Do not repeat accepted gameplay.
  **Apple maintenance preparation (2026-09-21):** packaged a standalone production
  entrypoint and separated verified DB-only expiry cleanup from Apple retry-key
  parsing. Bounded drains, real backlog probes and work/shutdown deadlines replace
  the single-pass command. Live read-only inventory found only the two existing
  receipt/audit jobs; none were changed. The notification endpoint and draft privacy insert are documented
  in [APPLE_MAINTENANCE.md](backend/APPLE_MAINTENANCE.md). No policy was published.
  **No-new-recurring-spend revision (2026-09-21):** the owner rejected the
  separate five-minute job; it was never created and is no longer recommended.
  Confirmed local deletion now attempts one account-scoped Apple revocation,
  bounded to ten seconds, leaving durable retries on failure. Implemented the
  disabled workload-identity-protected backend maintenance endpoint and a single
  call from the existing hourly receipt dispatch, independent of receipt failure.
  Receipt work and dispatch run concurrently and both are awaited; either
  failure fails the existing job. Backend work is capped at 90 seconds, dispatch
  at 110 seconds, alongside the unchanged 120-second receipt budget/five-second
  shutdown, fitting the existing 180-second job timeout. Keep
  Apple keys/token SQL access in the backend; do not broaden either restricted
  worker's SQL grants, add a schedule, increase frequency or set minimum
  instances. Application code now loads pinned numeric Apple Secret Manager
  versions after container startup; the HTTP path rejects inline/injected Apple
  keys. A bootstrap secret outage hides only Apple until process restart; Google,
  notifications and DB purge remain available. Each maintenance pass reloads
  keys after DB-only purge. Queued credentials are purged beginning on day six,
  leaving 24 hours of headroom within the original seven-day deadline, not an
  outage-proof deletion guarantee. All new flags remain off; no live resource,
  grant, key or deployment changed. Before activation, verify the exact caller
  numeric uniqueId/service-base audience, schema/runtime settings, honest
  retention wording and one real-path dummy retry/purge/failure acceptance.
  Existing-resource reuse avoids the new fixed setup but does not promise zero
  metered usage. Source verification passed 182 focused tests, backend
  TypeScript, isolated production server/receipt builds and the disabled
  compiled-entry smoke check; exact test commands are in the maintenance runbook.
  The owner approved the CORS-only backend deployment for exactly
  `capacitor://localhost`, and renewed the same temporary Node/OpenSSL exception
  through 2026-10-07 only for the matching unchanged-runtime/base/dependency
  replacement, with earlier-review conditions unchanged. PR #332 merged as
  `ff9c79bedb1b3c8ca4e671ed8a9ac00739863f80`. The reviewed image from source
  `a1f3ea4331ea28f7477a7addfd21d34ecd13d39e` now serves 100% at generation138,
  revision `mickeyf-org-ios-origin-a1f3ea43-0910`, with no temporary tags and
  unchanged runtime/configuration. All six live preflights and the unauthenticated
  session probe passed; the prior p4 revision remains intact for rollback.
  Exact build/deployment evidence and scope are in `RELEASE_READINESS.md`.
  Native login/session acceptance and that scoped origin change belong to this
  provider-login milestone, not the initial signed gameplay-build checkpoint.
- [ ] Configure Apple's primary Sign in with Apple App ID, web Services ID,
  return URLs and protected signing key. Configure/test native iOS authentication
  separately from web/other-platform Services ID activation. Apple's documented
  web-service prerequisite is an existing App Store app using Sign in with Apple;
  do not assume a developer membership or TestFlight build alone satisfies it.
- [ ] Review native session persistence, provider disconnect/revocation and
  current store policies before submission. Privacy disclosures and account
  deletion are tracked in the approved implementation backlog below; coordinate
  them with provider login rather than creating separate competing auth flows.
- [ ] Complete Android internal testing and obtain separate approval for each
  public store release. iPhone installation/login are accepted; native p4-Vega,
  session persistence and the unverified signup path remain open as recorded above.

Primary references checked 2026-09-10:
[Capacitor build requirements](https://capacitorjs.com/docs/getting-started/environment-setup),
[Codemagic Capacitor signing and distribution](https://docs.codemagic.io/yaml-quick-start/building-an-ionic-app/),
[Google native sign-in restrictions](https://developers.google.com/identity/protocols/oauth2/native-app),
[Google OAuth client setup](https://support.google.com/cloud/answer/15549257?hl=en),
[Apple native sign-in sample and development setup](https://developer.apple.com/documentation/authenticationservices/implementing-user-authentication-with-sign-in-with-apple),
[Apple web/other-platform prerequisites](https://developer.apple.com/documentation/signinwithapple/configuring-your-environment-for-sign-in-with-apple),
[Apple web sign-in setup](https://developer.apple.com/help/account/capabilities/configure-sign-in-with-apple-for-the-web/),
[Apple login/account review requirements](https://developer.apple.com/app-store/review/guidelines/).
Provider login and store publication are planned, not implemented or verified.

### Public-account preview cutover checkpoint — 2026-09-21

Localhost now has an explicit, validated legacy/renewable authentication selector
separate from the real-account API choice. Default legacy behavior is unchanged;
the provider controls, remembered sessions and account management are available
to the renewable protocol once the compatible public backend is deployed.
No environment flag, cloud resource, database or live account was changed.
See [the cutover contract](backend/PROVIDER_SIGN_IN.md#explicit-localhost-cutover-configuration--2026-09-21).

The owner subsequently approved initial adult-only new-account signup without
invitations, while retaining the all-ages/parent-managed flow as later work.
Apply eligibility to password, Google and Apple account creation; preserve
existing-account login, optional linking and guest play. Do not assume existing
accounts are adult-verified or change country availability. A checkbox or a
Google identity is not verified age, and this audience decision does not itself
resolve regional privacy obligations.

KWS Age Verification is the candidate for adult self-registration, distinct from
Parent Verification. Its portal requires service enablement before test setup.
The owner authorized the test-access contact request; submission closed without
a visible error, but receipt is unconfirmed because no durable confirmation was
captured. Do not resend automatically. No agreement was accepted or service
activated. See the [signup preparation and integration boundary](backend/PROVIDER_SIGN_IN.md#adult-only-signup-preparation--2026-09-21).

Next: obtain test access, review the applicable agreement and result-binding
contract, then implement and narrowly test one server-enforced eligibility flow
across all new-account paths. Independent development need not await the older
privacy enquiry. Published privacy information and backend/deletion/schema
readiness still need completion before public signup activation. No release is
authorized by this planning checkpoint.

**Real-account rollout preparation (2026-09-21):** read-only cloud access was
restored using Windows' existing trusted CA, without disabling TLS or changing
persistent settings. Production still serves `mickeyf-org-localhost-dbb80d4f`;
its provider-config endpoint returns 404, explaining the absent localhost Google
button. Added a guarded command for Google signup migrations 0013–0015 without
expanding ordinary migration behavior (51 focused mocked tests and typecheck
passed). The Google-only runtime grant profile is now prepared too: shared
permissions remain centralized, Apple permissions are separate, and the selected
profile is bound to the reviewed approval hash. Existing Apple schema/privileges
block a Google-only downgrade; direct maintenance schema visibility and migration
history are checked before inspection. The 79 focused grant/CLI/configuration
tests and typecheck passed. No live SQL, grants, flags, deployment or servers
changed. Explicit session-secret version pinning is now prepared in the frozen
deployment/preflight/traffic tools: approval and runtime checks use the same
reviewed version, with no default or alias. The canonical main deployment remains
unchanged. Next review the concrete production migration/grant/recovery state;
server-validated registration eligibility remains required before activation.
Apple browser sign-in
is separate unimplemented work, not a hidden completed button. See the
[ordered real-account rollout](backend/GOOGLE_SIGN_IN_ROLLOUT.md).

### Approved privacy implementation backlog — not implemented

Owner decisions confirmed during the 2026-09-10 privacy-policy review. The
owner approved the account-deletion flow, including dependent child-profile
deletion, and explicitly requested these changes be recorded for later
implementation. Keep this work pending during policy drafting; approval of the
design is not approval to delete live data, change cloud settings or publish.
The owner-review policy draft remains private and outside this public repository.
These are required deliverables for the agreed child-account/store launch,
coordinated with the existing social-sign-in work before returning to the
incremental Clean Code sweep. Preserve accepted device/gameplay checks.
Existing hourly submission-receipt cleanup is complete and is not reopened by
the support-message and backup-retention work below.

- [ ] **Resolve child-account prerequisites:** the owner approved worldwide
  availability wherever eligible, with necessary country exceptions presented
  individually before changing availability. Confirm actual regional eligibility,
  applicable age/consent rules and a proportionate parental-verification method.
  Include Brazil's LGPD and ECA Digital, not only an under-13 consent check.
  All ages is the audience decision, not automatic Kids Category enrollment or
  a universal account-age threshold. Provider purchases/activation and extra
  identity-data collection require their own reviewed scope.
  The owner approved provider-hosted verification, with Epic Kids Web Services
  (KWS) as the preferred candidate, subject to agreement/privacy/regional checks.
  This is not contract acceptance or service activation. Keep raw identity,
  biometric and payment verification inputs out of Ludolume's servers; confirm
  provider retention/deletion and consent-withdrawal behavior before integration.
  Adult verification is distinct from guardianship and each consent choice;
  validate results and enforce separate publication permissions on the backend.
  Deep public terms/privacy/technical review completed 2026-09-11. The owner
  approved proceeding with KWS Parent Verification plus Ludolume-managed consent;
  PV alone does not obtain consent.
  Full KWS Consent Management is not an immediate integration requirement.
  Confirm parent-email ownership and bind each verified result to the correct
  authenticated parent/attempt; AgeGraph recognition alone is not ownership.
  Service-specific controller/processor roles differ, so do not describe all KWS
  data as ours to erase. Its DPA's 30-day termination download window is not a
  deletion deadline. Resolve provider-data handling and relevant Brazil
  processing/transfer safeguards before real-data activation, including request
  expiry, cancellation, refusal and deletion of independently controlled records
  and backups. Confirm the authenticated API contract, result binding, duplicates
  and retries during implementation, not as a broad enquiry blocker. Enforce our
  own consent/withdrawal/deletion lifecycle with private defaults; independent
  development can continue while awaiting provider evidence.
  AgeGraph opt-out is separate from local consent withdrawal and account deletion.
  The owner must review broad indemnities and the standard GBP 100 liability
  cap before accepting. On 2026-09-11, the authorized Individual Ludolume
  organization (Brazil) and bare Ludolume product record were created; the
  private support form required a product. The reduced two-question privacy
  enquiry was submitted under Kids Web Services through
  `https://eoshelp.epicgames.com/s/eos-case-page?casetype=Private`; the UI confirmed
  successful case creation. Awaiting response. No KWS terms were accepted and
  KWS was not activated; no attachments or parent/child data were submitted.
  Keep case details private; do not repeat the public review absent material change.
  Check relevant regional game-distribution prerequisites (including mainland
  China and Vietnam) against the actual app; no country exclusion is approved
  merely by listing this work. Review automatic future-storefront expansion
  separately at release. Store availability does not restrict the public website.
- [ ] **Parent-managed profiles and private results:** use the parent's contact
  email, separate child identities and generated nonidentifying nicknames.
  Implement required consent notices/evidence and parental review/withdrawal
  controls. Save child results privately by default; enforce separate parental
  opt-in for public leaderboards on the server, not only in the UI. Withdrawing
  public-display permission must remove that visibility without forcing loss
  of private results. Do not recreate a permanent history of all game runs.
- [ ] **Unfinished signup/consent retention (approved 2026-09-11; implementation
  pending):** use 24-hour expiry for a future adult email-verification attempt
  and seven-day expiry for an adult-initiated parental-consent attempt. Current
  signup creates normal accounts immediately; do not relabel or expire existing
  users under a pending-registration rule. Minimize preliminary data, use the
  parent's own initiated setup, and do not store child-supplied contact details
  under a supposed universal seven-day exception. Resends/callbacks cannot extend
  original expiry; cancel on refusal, cancellation or permanent delivery failure.
  Reject stale callbacks and delete live pending data, not only expire links;
  validate cleanup timing before publishing a retention maximum. Preserve other
  independently valid profiles. Apply the approved completed-evidence design;
  validate provider cancellation/deletion separately. Neither flow is activated.
- [ ] **Completed consent evidence (approved 2026-09-11; not implemented):**
  retain minimal purpose-specific proof while the relevant processing relies on
  it, with retrievable non-personal notice/flow documentation. Remove evidence
  no longer necessary when processing ends; include receipts in account deletion
  unless a specific legal retention requirement applies. No automatic support-
  period or multi-year archive. Preserve separate valid permissions and only
  necessary denied-state/restore markers; missing proof cannot grant permission.
  Exclude raw verification inputs and full provider payloads. Validate KWS fields,
  contractual obligations and deletion interfaces separately; local deletion is
  not a promise to erase provider-held AgeGraph data. Implementation is pending.
- [ ] **In-app and web account deletion:** add Account → Manage account → Delete
  account with proportionate reauthentication and explicit permanent-deletion
  confirmation. Delete the live account, personal bests, public entries and
  remaining submission receipts. A parent can delete one child independently;
  deleting the parent deletes all dependent child profiles/results, listed in
  the warning. Enforce ownership, reject old sessions/run tickets and score
  retries, handle concurrent submissions transactionally, and report completion
  only after durable success. Use narrow database privileges. Preserve guest
  access; handle provider-token revocation when social sign-in is added.
  - [x] **Existing password-account implementation (2026-09-11, local only):**
    `/account` exposes a responsive themed confirmation, current-password
    reauthentication and typed DELETE. The server derives ownership from the
    signed session, checks trusted Origin/JSON, and limits password attempts.
    Deletion shares the games' per-user lock and removes all owned bests,
    receipts and the account in one transaction. Session verification and new
    run tickets check account existence; stale p4-Vega/Three Bosses submissions
    cannot recreate records. Success alone clears auth; uncertain responses do
    not imply deletion. The native endpoint allowlist/cookie cleanup is updated.
    Focused HTTP, transaction/race and isolated MySQL restricted-role checks
    cover this path. No live account/data/privilege changes or deployment.
  - [ ] **Release and future-profile work:** apply the reviewed table-scoped
    DELETE grants through the existing approval workflow, coordinate backend,
    web and signed iOS rollout, and verify on-device cookie cleanup. Complete
    deletion-aware restore before enabling live self-deletion. Parent/child
    cascades, consent evidence and provider-token revocation remain pending
    their corresponding models/integrations; do not mark all deletion work done.
- [ ] **Privacy-request handling (drafted 2026-09-11; implementation pending):**
  use the privacy mailbox and a minimal restricted case record for manual
  requests; no new helpdesk service is required. Add proportionate ownership
  recovery and representative/parent checks, secure delivery, relevant provider
  notifications and truthful completion/refusal notices. Track receipt and the
  applicable request-specific deadline, not a universal 30-day waiting period;
  do not add support contact as a prerequisite for normal in-app deletion.
  Valid erasure and mandatory shorter retention override routine support limits,
  including prompt removal for COPPA's one-time child-contact exception. Minimize
  request evidence and document any distinct lawful hold and expiry. Operational
  readiness and regional requirements remain to be verified before publication.
- [ ] **Renewable dormant profiles (approved 2026-09-11; not implemented):** after
  24 months without meaningful activity or affirmative renewal, notify the user
  or managing parent and allow 30 days to renew. Intentional renewal keeps the
  profile, username and results and restarts the period; no new score is needed.
  Without renewal or qualifying activity, delete the expired profile and its
  results, including public entries. Keep management/removal access usable;
  dormancy is not deletion or anonymization, and no permanent archive is added.
  Apply child-profile activity separately, preserve an active child's managing
  account, and never treat renewal as public opt-in or restored consent. Earlier
  deletion requests and applicable parental withdrawals override the schedule.
  Before enforcement, establish reliable activity data, notify existing users,
  handle notice failures and recheck activity/renewal atomically with deletion.
  Background requests or email previews must not renew profiles. Validate the
  legal basis and regional requirements before publishing promises. This design
  approval does not authorize deleting live accounts or enabling cleanup now.
- [ ] **Retention enforcement:** implement the approved 90-day post-resolution
  limit for routine support messages and our copies of beta feedback/diagnostics,
  using the simplest reliable operational process rather than assuming a new
  service is necessary. Enforce the approved 30-day maximum for ordinary recovery
  copies under our control, preserving shorter automated-backup rotation and
  seven-day recovery logs. Cover manual backups/exports and relevant retained
  copies; verify provider-controlled retention before publishing a broader
  guarantee. Scope/document legal exceptions. Review exact existing-backup
  deletions and recovery coverage separately before execution.
- [ ] **Deletion-aware restore:** keep only the minimal protected identifiers,
  actions and timestamps needed to prevent deleted data or withdrawn permissions
  from returning. The record must survive database rollback and expire once no
  recoverable copy can resurrect the affected data, accounting for lawful holds.
  Restore in isolation and reapply deletions/withdrawals before public access;
  do not expose restored data if the current record is unavailable. This is not
  permission to retain names, email addresses, passwords or gameplay history.
  - [x] **Release safeguard (2026-09-11, local only):** added an exact-opt-in
    `ACCOUNT_DELETION_ENABLED` runtime switch, disabled by default in every
    environment. Disabled deletion returns the existing unavailable response
    without database access or cookie mutation; session verification and logout
    remain usable. Config and HTTP checks cover the default and enabled paths.
    This is a release switch, not a completed restore safeguard. No live settings,
    database grants, account data or cloud resources changed.
  - [x] **Journal storage/IAM (2026-09-11, explicitly approved):** provisioned the
    private `ludolume-deletion-journal-1012884798546` Cloud Storage bucket in
    `us-central1`, with public-access prevention, uniform access, create-only
    backend access and a separate read-only recovery identity. Preserved owner
    access, removed new-bucket Editor/Viewer convenience grants, and left project
    IAM unchanged. Verified policy/settings and empty current/versioned/soft-
    deleted listings. Seven-day soft delete; no live-object lifecycle expiry,
    Bucket Lock, scheduler, user-managed keys or deployment. No live account or
    score changes.
  - [x] **Independent journal and replay implementation (2026-09-11, local):**
    added three explicit identity migrations, create-only write-ahead intents,
    truthful pending responses, startup schema/original-epoch checks, and a
    bounded plan/apply recovery tool. UUIDs prevent reused numeric IDs from
    targeting another account. Runtime grants add only UUID and migration-epoch
    reads, never identity writes. The tool also finishes pending requests on an
    explicitly frozen active database. No production migration, grant change,
    journal object, replay or deployment was performed in this implementation.
  - [ ] **Recovery activation and evidence:** the identity schema, runtime SQL
    grants and journal identity permissions are verified; the independent
    read-only pending-request audit is provisioned. Resolve the remaining
    pre-identity automatic/PITR history without shortening retention, then
    finish actual writer-upload acceptance and the reviewed website rollout.
    The isolated
    backup/SQL replay exercise is verified below; any actual recovery cutover
    still requires a final drained-writer checkpoint and session-secret rotation.
    The exercise does not replace those cutover safeguards.
    Keep deletion disabled until these items and the separate rollout are
    approved. Commands and limitations are in
    [Deleted-account recovery](backend/LEADERBOARD_DESIGN.md#deleted-account-recovery).
    - **Read-only inventory (2026-09-11):** found eight automated backups,
      four on-demand migration snapshots, and a seven-day PITR configuration.
      All are treated as pre-identity; no live migration or backup deletion was
      performed. Project-wide SQL listing found no additional instance/retained
      backup; bounded local metadata searches found no database dumps. The owner
      confirmed no exports/backups saved elsewhere. Preserve current
      recovery until a post-identity backup/restore is verified, then retire
      exact approved manual copies and let automated/PITR history roll forward.
      See the [inventory and activation order](backend/LEADERBOARD_DESIGN.md#pre-identity-backup-inventory--2026-09-11-approximately-2343-utc).
    - **Live identity checkpoint (2026-09-11 local / September 12 UTC):**
      approved migrations 0006–0008 applied and verified for all 12 accounts;
      every existing account field and all nine personal bests were preserved.
      Captured the original epoch outside SQL. Pre-change backup `1789171137743`
      and clean post-change backup `1789172213271` succeeded; all twelve older
      backups remain. Original grants, sign-in lock states, public ingress,
      cleanup schedule and local backend were restored; temporary SQL accounts
      removed. No new runtime grants, deletion activation, journal write, replay
      or deployment. Next is one approved isolated restore/replay exercise and
      the remaining old-backup/PITR transition, not another generic login test.
      See the [production checkpoint](backend/LEADERBOARD_DESIGN.md#production-identity-checkpoint--2026-09-12-utc).
    - **Isolated restore/replay verified (2026-09-12 UTC):** restored the clean
      post-identity backup into a temporary, separately addressed Cloud SQL
      instance. All 12 accounts, nine bests, eight migration checksums and the
      independently saved identity epoch matched. The actual journal was empty
      and readable with the existing operator credentials. A separate in-memory
      dummy intent exercised restricted SQL replay, repeat safety and numeric-ID
      reuse without changing the original copied rows or writing a live marker.
      This proves backup restoration and SQL replay, not live journal-writer/
      recovery-service authentication, session invalidation or a public cutover.
      Temporary Cloud SQL instance, SQL credentials and proxy were removed;
      all 14 source backups remain. External helper-folder removal was refused
      by the filesystem tool and remains a small explicit cleanup item; no
      helper was added to the repository. Production remained online with
      deletion disabled. See the
      [exercise evidence](backend/LEADERBOARD_DESIGN.md#isolated-recovery-exercise--2026-09-12-utc).
    - **Activation preparation (2026-09-12 UTC):** fixed the replay CLI's rejection
      of exact Cloud SQL `cloudsqlproxy~%` account hosts; the focused config suite
      passed (four tests). Recorded the five exact manual-backup retirement
      candidates, preserving the verified replacement and automatic/PITR history;
      exact retirement approval was subsequently obtained and completed below.
      Prepared pending/unconfirmed-request
      handling, including crash-before-log outcomes; an accepted operator and
      reliable notification/reconciliation arrangement remain prerequisites, not
      an implicitly created service. Runtime SQL grants, keyless service-identity
      access/probe disposition and eventual rollout still require scoped approval.
      That preparation changed no cloud resources; the approved retirement is
      recorded below. See the [retirement set](backend/LEADERBOARD_DESIGN.md#backup-retirement-approval-set--2026-09-12-utc).
    - **Manual backup retirement completed (2026-09-12 UTC):** deleted only the
      five specifically approved pre-identity manual snapshots. Verified exactly
      nine successful backups remain: the restored-and-verified replacement and
      all eight automatic backups. The live database and recovery settings were
      preserved. Older automatic/PITR history still precedes the identity epoch,
      so deletion remains disabled; no repeat restore or new deployment occurred.
    - **Access review (2026-09-14 UTC):** recovery history is rotating normally,
      but six automatic backups and the earliest PITR point still predate the
      identity epoch. The ordinary operator lacks the MySQL metadata access
      needed for an exact runtime-grant plan; recovery-service impersonation
      also failed before storage access. No privileges were broadened, objects
      written or deployment made. Authorize the narrow execution paths before
      the live plan/service-identity checks; do not repeat the restore exercise.
      See the [access review](backend/LEADERBOARD_DESIGN.md#activation-access-review--2026-09-14-utc).
    - **Approved access rollout (2026-09-14 UTC):** applied the existing
      planner's exact additive runtime grant plan under a verified writer drain;
      fresh allowed/denied zero-row probes and grant verification passed.
      Actual writer and reader credentials verified create-only versus get/list
      bucket permissions; strict reader authentication/listing passed. No real
      account/score rows or journal objects changed. Restored the same backend
      revision, receipt schedule and local backend; removed temporary SQL and
      impersonation access. Created a separate audit SQL account that cannot
      read passwords, emails or scores and cannot delete anything. See the
      [rollout evidence](backend/LEADERBOARD_DESIGN.md#approved-access-and-audit-rollout--2026-09-14-utc).
    - **Read-only audit implementation (2026-09-14 UTC):** added bounded
      journal-to-account comparison, earliest-request retry handling, strict
      target/identity validation and aggregate-only logging. Eleven focused
      tests and backend typechecking passed. The reviewed image-only cloud
      build succeeded and completed vulnerability analysis found no
      occurrences. Job, schedule and alert acceptance are tracked in
      [DELETION_AUDIT.md](backend/DELETION_AUDIT.md). This detector is not an
      automatic deletion/replay service and does not enable self-deletion.
    - **Audit operational acceptance (2026-09-14 UTC):** enabled the hourly
      minute-20 UTC schedule and forced one dispatch through Scheduler's actual
      identity. Execution `ludolume-account-deletion-audit-pcmdg` succeeded with
      a correlated clear/zero-pending log. Read back all three enabled policies
      on the existing approved email channel; missing-success monitoring was
      armed after that success. Removed the temporary image-build trigger and
      verified all four old deployment triggers still disabled. No duplicate
      restore/login/score testing or natural-tick claim is added.
      Local removal of today's five non-secret external helper scripts was
      refused by the filesystem tool and remains explicitly outstanding;
      [the audit runbook](backend/DELETION_AUDIT.md) records the exact folder.
    - **Deployment contract preparation (2026-09-14 UTC):** canonical/frozen
      deployments and traffic validation now carry exact optional deletion
      pins, default off. Explicit enable/disable decisions are tied to reviewed
      source/image inputs; active template/serving/tagged revision checks prevent
      a normal default-off deployment from silently disabling the feature.
      Intentional disable/rollback remains supported. No website deployment,
      trigger activation or backup-gate bypass was performed. See the
      [deployment contract](backend/LEADERBOARD_DESIGN.md#deployment-contract-prepared-website-rollout-not-performed).
- [ ] **Finish and publish accurate privacy information:** resolve remaining
  retention/rights/provider/market decisions; implement the approved safeguards
  before claiming they exist. Preserve the no-sale/no-targeted-advertising
  commitment without promising that the app is forever free or ad-free. Add an
  accessible HTTPS policy page and in-app/registration links, then matching
  App Store Connect/App Privacy and Google Play data disclosures under the
  appropriate publication approval. Review actual Google/Apple login data flows
  when implemented; do not predeclare them. Keep private operator/reviewer
  records out of this roadmap.
- [ ] **Focused acceptance and security closeout:** verify account/child isolation,
  parental visibility choices, deletion with stale credentials and submission
  races, failure/retry behavior, retention expiry and a deletion-aware restore.
  Use bounded fixtures/disposable data where authorized, not repeated checks of
  already-accepted gameplay or generic login. Retain outstanding evidence and
  implementation gaps explicitly; no public release/compliance claim follows
  merely from completing the policy wording.

Regional scope references checked 2026-09-10:
[Apple availability and future storefronts](https://developer.apple.com/help/app-store-connect/manage-your-apps-availability/manage-availability-for-your-app-on-the-app-store/),
[Apple regional game-distribution requirements](https://developer.apple.com/help/app-store-connect/reference/app-information/app-information/),
[ANPD ECA Digital](https://www.gov.br/anpd/pt-br/assuntos/eca-digital/eca-digital-english).
These identify review requirements, not completed regional clearance.

## Deferred tooling follow-up

- TypeDoc drift CI guard: **deferred by owner decision on 2026-08-25**.
  Documentation generation is deterministic as of commit `7386191a`. If this
  work resumes, add a `docs:check` command that regenerates the tracked output
  and fails on unexpected output, canonical source-link, local-reference, or
  line-ending drift. This is preventative tooling and does not block current
  Three Bosses work.
