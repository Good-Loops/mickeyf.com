# Personal bests and bounded submission receipts

Current checkpoint: 2026-09-08. The storage contract below is implemented and
**migrated in production**; exact runtime/operator grants are verified and the
receipt-compatible image now serves normal traffic with both score flags
**enabled** after approved acceptance and promotion. Receipt cleanup passed a
controlled production execution; hourly scheduling and the missing-success
watchdog are now enabled after separate approval. Both failure-alert emails are
owner-confirmed; restricted credentials are provisioned. The first natural
hourly tick passed; the final three-policy/channel readback also passed at
2026-09-09 02:12:46 UTC. No receipt-cleanup configuration gate remains open.
The [cumulative release/security ledger](../RELEASE_READINESS.md)
records the bounded current-image OpenSSL exception and remaining release gates.
Historical migrations 0001–0003 are unchanged. Dated preparation entries below
are historical; the final section records the current scheduling checkpoint.

## Storage contract

- `game_personal_bests` is permanent: one row per game, rules version and user.
  Existing score/time values and `recorded_at` are preserved by the transition.
  No source-receipt foreign key is needed to display or retain a best.
- `game_submission_receipts` replaces `game_runs` in place. It is short-lived
  retry/rate-limit state, not a permanent play-history feature. It keeps the
  existing `game_run_id` primary key to avoid an unnecessary identifier change.
- `improved_personal_best` means **this accepted submission improved the best at
  that moment**, not that it remains the player's current best. The HTTP field
  remains `personalBest`; an identical retry returns its original outcome.
- Three Bosses keeps an accepted receipt even when the score is not an
  improvement. Otherwise repeated non-best submissions could evade the existing
  ten-submissions-per-fifteen-minutes limit or return inconsistent retry results.
  p4-Vega continues its existing best-only write path and creates no receipts.
- Receipts remain for at least 24 hours. The hourly bounded cleanup deletes
  only rows strictly older than that cutoff. Normal retention is about 24–25
  hours; outages/backlog can extend it. Expiry is not renewed by retrying.
- While a receipt exists, identical retries are replayed and changed payloads
  conflict. Once deleted, historical UUID recognition is no longer guaranteed;
  a valid new submission is compared against the permanent best again. The
  signed run-ticket lifetime stays 30 minutes and is never extended by this job.
- Submission/replay and deletion take the same per-user MySQL lock. Cleanup
  commits each bounded deletion before releasing that lock. Account deletion's
  existing user-owned cascading deletion semantics remain unchanged.

## Reviewable migration commands

From the repository root:

```text
npm --prefix backend run migrations:receipts:plan
npm --prefix backend run migrations:receipts:apply
npm --prefix backend run migrations:receipts:verify
```

The existing dedicated migration connection configuration is required; commands
never fall back to the website credentials. Plan/verify need the exact
`MIGRATION_CONFIRM_DATABASE`, `MIGRATION_CONFIRM_TARGET` (`host:port/database`)
and resolved-account confirmation. Plans report target identity, immutable SQL
checksums, schema/history state and ordered data counts/hashes, not player rows.

Apply additionally requires all existing mutation confirmations plus:

```text
MIGRATION_ALLOW_APPLY=1
MIGRATION_ALLOW_RECEIPT_TRANSITION=1
MIGRATION_CONFIRM_SUBMISSIONS_DRAINED=1
MIGRATION_CONFIRM_RECEIPT_TRANSITION=game_runs -> bounded submission receipts
MIGRATION_CONFIRM_RECEIPT_PLAN_SHA256=<reviewed plan digest>
MIGRATION_CONFIRM_SERVER_UUID=<independently verified server UUID>
```

These are guards, not instructions to run against production now. A submitted
plan digest is rechecked under the migration lock before DDL. The production
`cms` name also requires the independently pinned Cloud SQL UUID. Generic
`migrations:apply` cannot perform these two migrations.

## Production cutover checklist — separate approval required

1. Review the exact source commit, new SQL, target identity, grants and
   backup/PITR restore procedure. Inventory readers, writers, scheduled jobs,
   views, routines, events and foreign keys, including the TablePlus operator's
   old-table grants. Before DDL, obtain the receipt-compatible image's immutable
   digest, authenticated Google provenance binding and completed vulnerability-
   scan evidence.
   A successful local build is not that production artifact evidence.
2. With separate deployment approval, prepare the exact receipt-compatible
   image as a **frozen, zero-traffic revision before DDL**. Both
   `P4_VEGA_SCORE_SUBMISSIONS_ENABLED` and
   `THREE_BOSSES_RUN_SUBMISSIONS_ENABLED` must be `false`. Verify the complete
   revision configuration, login and leaderboard reads on the existing schema,
   plus p4's HTTP 503 `SUBMISSIONS_FROZEN` and Three Bosses' HTTP 403
   `SUBMISSION_DISABLED` contracts. Retain this tested frozen revision/digest as
   the post-migration service rollback target. Keep the prior image for
   pre-migration rollback; do not assume an old enabled revision can serve the
   new schema. The canonical main-only Stage B enables both games and therefore
   is not the frozen deployment path. The frozen deployment preflight requires
   canonical Stage A/B and any unreviewed triggers disabled, no competing active
   builds, and its reviewed source/deployment triggers still enabled.
3. **After the zero-traffic deployment succeeds**, separately approve and verify
   disabling every Cloud Build trigger in `global` and `us-central1`, including
   the reviewed manual source and frozen-deployment triggers. Disabling those
   two before the deployment preflight would prevent it from passing. Verify
   no pending, queued or working builds in either region. Then review and
   separately approve a fresh, etag-bound traffic-only plan routing 100% to the
   verified frozen revision and removing **all** revision tags, including
   reachable zero-traffic enabled candidates. A traffic plan expires after five
   minutes; expired or changed state requires a new plan/review. After routing
   settles, wait **longer than 300 seconds**, the reviewed old-request maximum
   (or longer if any retiring revision has a larger timeout), then repeat
   delayed checks of retired revisions, outstanding requests and SQL activity.
   Routing success is not proof of drain. Confirm no enabled revision is still
   reachable and drain operator edits and background score writers. Keep
   receipt cleanup disabled. Freezing score submission does not make the whole
   website read-only: signup can still insert users. The advisory lock alone
   does not freeze the API. Verify no active transactions or pending metadata
   locks with a maintenance identity able to inspect that metadata;
   denied/incomplete visibility is a blocker, not a reason to remove preflight.
4. Capture/review the plan only after draining writers. Record best/receipt
   counts and hashes as preservation evidence. Approve that exact plan and
   target, then run the guarded apply. `0004` atomically detaches the best's
   source dependency; `0005` atomically renames the receipt table/boolean and
   replaces the obsolete source index with a covering expiry index. Neither
   migration deletes bests or receipts. Verify the final state and compare the
   before/after preservation hashes while writers remain frozen.
5. Cut over privileges explicitly: MySQL table rename does **not** migrate
   table/column grants. Review/revoke the exact obsolete `game_runs` grants,
   then plan/apply/verify the new runtime manifest. Its unexpected-grant check
   deliberately refuses to silently retain or broadly revoke obsolete grants.
   Review the operator account separately. Do not add DELETE to the API account.
6. Reverify final schema/history, exact privileges, login and unchanged
   leaderboard ordering while the tested receipt-compatible revision remains
   frozen. Only then separately approve an enabled revision of that same image
   and its reachable test endpoint. Test authorized first acceptance, identical
   retry, payload conflict, worse score, best improvement and rate limiting on
   an approved test account before approving normal enabled traffic. Anonymous
   HTTP 401 probes only demonstrate an open gate, not working persistence.
7. Only afterward follow the [cleanup activation runbook](../.github/receipt-cleanup/README.md):
   dedicated least-privilege SQL/job/scheduler identities, pinned image and secret
   version, execution/backlog/missing-run alerts, a reviewed manual run, then the
   hourly schedule. Prove expired cleanup leaves personal bests unchanged.

## Frozen rollout tooling — separate approval per live action

- `scripts/render-frozen-backend-deploy.mjs` derives a separate source-less
  deployment document offline from a hash-pinned canonical Stage B recipe. Its
  contract pins the reviewed feature source and immutable image, requires
  provenance/scan validation, sets both submission flags to `false`, and uses
  a separately approved, approval-required trigger. It neither changes the
  canonical main trigger nor includes traffic promotion or a notifier. Rendered
  output still needs review and explicit approval before any cloud execution.
- `scripts/frozen-backend-traffic.mjs` separates a fresh read-only routing plan
  from an explicitly authorized, etag-bound traffic-only apply. Its cutover is
  to the exact verified frozen revision, with all revision tags removed; it is
  not an image deployment, schema migration or write-enablement command.

The renderer takes one reviewed source-pin JSON file and prints the deployment
configuration as JSON (also valid YAML); it performs no cloud actions:

```text
node scripts/render-frozen-backend-deploy.mjs <reviewed-source-pins.json>
```

That file must contain `sourceBuildId`, `sourceCommit`, `imageDigest`,
`sourceTriggerId`, `sourceTriggerName`, `sourceRef`, `deploymentTriggerName` and
`sessionSecretVersion`, with only the optional `accountDeletion` and
`googleSignIn` configurations allowed in addition.
Use the exact successful feature image build, full 40-character commit and
`sha256:` image digest. The dedicated source trigger/ref must match that build;
neither canonical main trigger is a feature-image source. Keep the reviewed
rendered configuration and evidence outside deployable project assets. Creating
the source-less, approval-required deployment trigger, starting its pending
build and approving it are separate live actions, not consequences of rendering.

Before approving that deployment, derive its expected steps digest from the
**offline reviewed configuration**, not from steps returned by the live build.
Use the same reviewed pins and unchanged reviewed checkout, plus the actual
pending deployment build ID and exact deployment trigger ID:

```text
node scripts/render-frozen-backend-deploy.mjs --steps-sha256 <reviewed-source-pins.json> <pending-deployment-build-id> <deployment-trigger-id>
```

This re-renders the configuration and resolves its Cloud Build substitutions
before hashing. The live build's `_DEPLOY_TRIGGER_ID` must be that trigger UUID;
its `_APPROVAL` must be exactly
`freeze-zero-traffic:<sourceCommit>:<sourceBuildId>:<imageDigest>:session-secret:<sessionSecretVersion>`. The generated
defaults are deliberately `INVALID`. Do not hash the unresolved template or
copy a hash of live steps: either loses the independent review boundary. The
successful approved deployment must attest the source provenance, image scan
and exact reviewed steps before traffic planning. The provenance check uses
authenticated Google API evidence and validates envelope metadata plus
source/image/build binding; it is **not** independent cryptographic signature
verification. The source image build still requests
`requestedVerifyOption: VERIFIED`.

`sessionSecretVersion` is a reviewed positive decimal **string**, without leading
zeros, whitespace or aliases such as `latest`. Supply the same version in the
source and traffic pins; neither file contains the secret value. It is bound to
the approval, rendered deployment, runtime verification and resolved steps digest.
Old pin files/approvals must be updated, re-rendered and reviewed, not silently
defaulted. This changes only the frozen rollout package: `DB_PASS:1` and the
canonical main deployment's `SESSION_SECRET:2` remain unchanged. Do not reactivate
the canonical trigger for a rotated-session rollout until it is separately aligned.
No secret version is created or rotated by rendering.

Frozen revision names still derive from the source build ID. The existing guard
refuses to reuse an already-created revision, including after a version change;
obtain a newly reviewed candidate build instead of attempting an overwrite.

After the successful frozen deployment and the trigger/build freeze in step 3,
prepare a **separate** traffic-pin JSON file with exactly these fields:

```json
{
  "sourceBuildId": "<reviewed feature image build UUID>",
  "sourceCommit": "<full 40-character source commit>",
  "imageDigest": "sha256:<64-character image digest>",
  "sessionSecretVersion": "<reviewed positive decimal version>",
  "deploymentBuildId": "<successful approved frozen deployment build UUID>",
  "deploymentTriggerId": "<reviewed frozen deployment trigger UUID>",
  "deploymentStepsSha256": "<64-character offline resolved steps digest>"
}
```

The placeholders are deliberately invalid until replaced with reviewed evidence.
The following plan reads live state and writes a new local review file; it does
not change cloud routing. The output path must not already exist:

```text
node scripts/frozen-backend-traffic.mjs plan --pins <reviewed-traffic-pins.json> --output <new-plan.json>
```

Review the target revision, prior routing, all tags to remove and printed
`planSha256`. Only with separate approval for that exact traffic change, within
the five-minute plan lifetime:

```text
node scripts/frozen-backend-traffic.mjs apply --plan <new-plan.json> --confirm-plan <planSha256> --confirm-freeze-all-traffic
```

Apply rechecks the disabled trigger inventory, absence of active builds,
deployment evidence, frozen revision and service etag before changing only
traffic to 100% frozen with no tags. It does not disable triggers itself, freeze
operator sessions, drain database writers or make signup read-only. Keep those
operational checks explicit; settled routing alone is not permission for DDL.

The frozen deployment, read-only traffic planning and separately approved
traffic apply have been exercised against live resources as recorded below.
The session-version preparation passes all 94 tests in `npm run test:frozen-backend`,
including generated Bash syntax and embedded Python checks. Traffic
drain, migration and write enablement remain separate gates.

## Failure and recovery

Keep writers frozen on any failure. MySQL DDL is not transactionally rolled
back together with `schema_migrations`. If either atomic ALTER succeeds but its
history insert fails, inspect the actual schema, produce a **new** recovery
plan, compare its data hashes with the original approved evidence, and approve
that new digest. The runner verifies the entire expected stage before recording
missing history; do not edit old SQL checksums or manually mark a migration done.

After cutover, route service rollback only to the receipt-compatible frozen
revision verified and retained **before** DDL. The old generic-only image can
serve the unchanged leaderboard reads with its gates closed, but must not be
re-enabled: `0004` removes the source column used by its p4 improvement writes,
and `0005` removes the table name used by its Three Bosses submissions.
Returning to the old ledger schema/image requires a separately reviewed
restore/reverse migration. Once cleanup deletes expired receipts, that history
cannot be reconstructed from best rows; it is intentionally disposable. Stop
cleanup by pausing its schedule, cancelling active executions and disabling its
flag. Permanent best rows must never be deleted as part of that rollback.

## Scoped security disposition

- **Fixed locally:** receipt retention no longer controls best retention;
  per-user locking covers cleanup/replay; cleanup has only the required SELECT
  columns and receipt DELETE; target/grants verified before access; bounded
  queries/execution; sanitized failures; migration plan and data-preservation
  checks; original immutable migration checksums preserved. Frozen-rollout
  tooling independently pins approved deployment steps and image provenance,
  requires frozen flags and automation exclusion, and limits the traffic patch
  to the reviewed revision under its fresh service etag. Receipt apply now
  rejects missing/incomplete lock instrumentation and ineffective PROCESS
  access before transition DDL; empty lock tables cannot establish readiness.
- **Accepted design:** UUID recognition ends when its receipt is deleted;
  retention can exceed 24 hours during job failure/backlog; existing ticket
  expiration and game validation remain unchanged.
- **Operational limitation:** repeated trigger/build checks and service etags
  are not a distributed IAM lock. An explicitly controlled maintenance window
  must prevent other operators/automation from re-enabling triggers, routing
  traffic or starting writers between checks. Google-authenticated provenance
  binding is not independent signature verification; do not claim otherwise.
- **Resolved instrumentation gap:** separately approved maintenance enabled
  performance_schema and verified effective PROCESS, metadata/global
  instrumentation and zero lost records using a restricted temporary inspector.
  Both temporary accounts were removed; permanent account grants are unchanged
  by provisioning. The existing operator intentionally remains unprivileged for
  global inspection. Future migration access must be scoped separately.
- **Resolved migration window and cutover:** the approved public ingress
  barrier, local backend pause, admitted-request wait and exact session drain
  preceded the guarded 0004/0005 apply. Complete instrumentation showed zero
  active transactions/pending locks; all best/receipt hashes survived. Exact
  runtime/operator grants, public restoration and temporary-account removal
  passed. The receipt-compatible frozen image is the rollback target, not an
  older pre-receipt writer. Instrumentation memory overhead remains unmeasured.
- **Resolved controlled enabled acceptance:** the separately approved private
  service used the verified image and a disposable website account. All 64 HTTP
  assertions passed, including authenticated submission/replay and database rate
  limiting. Its service, account and synthetic score rows were removed; original
  data hashes and public production config/IAM/board responses were preserved.
  This was backend HTTP acceptance, not a physical-device/browser-cookie test.
- **Resolved normal score-write promotion:** separate approval enabled both
  score flags on the verified image, first at zero traffic and then at 100%.
  Generation 132 passed all 36 live rollout assertions. IAM, ingress and other
  runtime settings are unchanged; the receipt-compatible frozen rollback is
  Ready. Existing deployment automation remains paused.
- **Resolved cleanup activation:** separately approved credentials/IAM, alert
  routing, manual cleanup/retry validation, hourly activation and first natural
  execution are complete, as recorded in the final checkpoint. The final
  three-policy/channel comparison also passed; no new dispatch or provisioning
  is needed.
- **Accepted bounded release disposition:** on 2026-09-08 local, the owner
  explicitly approved the current receipt image's exact-digest embedded-OpenSSL
  exception through 2026-10-07, subject to earlier reassessment triggers. See
  `RELEASE_READINESS.md` for the exact digest, limitations and remaining release
  gates. This is risk acceptance, not remediation or authorization for a new
  image/deployment; no earlier image-specific exception was transferred.
- **Resolved fixture race:** server-side teardown is now observed explicitly
  before the integration test asserts drainage; all 50 MySQL tests pass without
  weakening production checks. The active dev install still retains four known
  parser failures until a deliberate refresh to the locked dependencies.
- **Resolved temporary-access lifecycle:** separately approved bootstrap access
  provisioned the inspector and was removed before restart; the inspector was
  removed after verification. Original user inventory restored, no credentials
  persisted, no root password reset and no permanent account elevation.

## Local verification checkpoint (2026-09-08)

- `npm --prefix backend test`: TypeScript passed.
- `npm --prefix backend run test:unit`: 171 passed with a fresh, isolated
  `npm ci --ignore-scripts --no-audit --no-fund` installation from the unchanged
  backend lockfile. The active development install instead produced 167 passes
  and four pre-existing parser-security failures: installed `qs` 6.15.3 differs
  from the locked 6.16.0. Running-server dependencies were deliberately not
  replaced; align that local installation before using it as release evidence.
- `npm --prefix backend run test:migrations`: all 49 isolated MySQL 8.0.31
  integration tests passed. Includes exact best/receipt preservation, interrupted
  DDL recovery, BIGINT pagination, concurrent retry/cleanup, per-user rate limits,
  signed-in HTTP round trip and actual cleanup under the restricted account.
  The disposable Docker database and its network were removed afterward.
- `npm run prod` in the isolated locked backend: both API and cleanup bundles
  built. `RECEIPT_CLEANUP_ENABLED=false node dist/submission-receipt-cleanup.min.js`
  returned the expected exit 1 and one sanitized configuration-failure event.
- `npm run test:receipt-cleanup`: 2 template contracts passed.
  `npm run test:cloudbuild-candidate`: 3 image-only contracts passed.
- `npm run docs`: passed once with the overlapping watcher paused; generated
  docs have no tracked diff. `git diff --check` passed.

Temporary validation files initially remained outside version control because
filesystem deletion was blocked. They are not deployable release artifacts.
The later approved artifact cleanup recycled the isolated backend copy
`mickeyf-receipt-locked-unit-075698753cb44a21b0ca7065edbbcc52` from `%TEMP%` after
source/provenance and no-link/process checks; its original path is absent and
recovery is available through the Recycle Bin. Verification results and recovery
evidence are retained. The receipt-implementation checkpoint changed no
dependency versions, feature flags, Unity assets or production resources.

The subsequent local rollout-preparation checkpoint updates the root tooling
lockfile's `qs` from 6.15.3 to 6.16.0. An isolated root dependency audit reported
zero vulnerabilities. This is separate from the backend lockfile and does not
establish a newly scanned Cloud Build image or change the running dev install.
The combined command
`node --test --test-reporter=spec scripts/render-frozen-backend-deploy.test.mjs scripts/frozen-backend-traffic.test.mjs scripts/cloudbuild-candidate.test.mjs .github/receipt-cleanup/templates.test.mjs`
passed all 61 checks: 11 renderer/preflight, 45 traffic guard, three existing
image-only and two cleanup-template contracts. This includes Bash/Python syntax
checks without executing deployment commands. PR CI YAML parsing and test-step
wiring passed using the existing Node YAML parser; system Python has no PyYAML.
Independent scoped review found no remaining P1/P2 findings. Cloud API response
normalization and a real approved zero-traffic deployment remain unverified.

Removal of the isolated root verification directory was initially blocked by
filesystem policy. It contained reproducible test dependencies, not release
assets or credentials. The later approved artifact cleanup recycled exact path
`C:\Users\User\AppData\Local\Temp\mickeyf-root-qs-verified-c6949cf50c76471d870f9eb834acd5bb`
after manifest/history and no-link/process checks. The original path is absent;
restore through the Recycle Bin if needed. See the named artifact dispositions
in `PROJECT_PLAN.md`; neither the active install nor verification evidence was
removed. No permanent-deletion fallback was used.
No live build, CI trigger, deployment, traffic, schema, grants or cleanup
activation is authorized by these local preparation changes.

## Approved image-build review (2026-09-08)

The user subsequently approved the exact candidate image build and scan review,
not deployment, traffic, schema/grant changes or cleanup activation.

- Source: `d1d5dbf6fcc1bedd596827a540779f437fe3501f`.
- Manual source trigger: `648fadca-3cd1-4b57-9d35-0f62a1468443`
  (`feature-new-leaderboard-candidate`). Its default ref remains
  `refs/heads/feature/new-leaderboard`; the explicit `--sha` override selected
  the reviewed commit for both requested and resolved Git source. No trigger
  configuration was changed.
- Build: `12ec9e8e-ff4a-493c-be8c-025423e5110c`, approved at
  `2026-09-08T17:28:37.010377Z`, successful at
  `2026-09-08T17:30:24.913932Z`.
- Image repository:
  `us-central1-docker.pkg.dev/noted-reef-387021/cloud-run-source-deploy/cloud-run-source-deploy`.
- Immutable digest:
  `sha256:9ec1bd83ea73a283ad36961b2dcd3022b9b0a40cbf16bd725398ff562015c3c3`.
- Source, exact image-only steps, fixed build identity, approval and authenticated
  provenance binding all passed against actual records. The live envelope uses
  URL-safe base64 for its signature; its payload exactly equals the displayed
  statement. The two resolved dependencies are the exact Git commit and pinned
  Docker builder. The checker now requires that exact pair rather than a loose
  builder-URI prefix; signature metadata remains distinct from independent
  cryptographic signature verification.
- Scan discovery: `FINISHED_SUCCESS`, continuous analysis `ACTIVE`, last scan
  `2026-09-08T17:30:35.899738685Z`; completed types include OS, NPM and SECRET.
  Direct regional Container Analysis queries for this exact image returned
  HTTP 200 `{}` for both VULNERABILITY and SECRET, with no pagination token:
  zero occurrences in either complete result. Recheck before deployment;
  advisories and the two-hour source-build freshness gate can change readiness.
- Cloud Run remained at generation 126, with 100% traffic to
  `mickeyf-org-build-3db9219129ee44e88daba01bcdcf9c3d`. No revision, traffic,
  SQL, IAM, scheduler or trigger configuration was changed.

The queued raw build configuration was compared with the committed image-only
recipe before approval. Commands used were `gcloud builds triggers run` with
the exact trigger/`--sha`, then `gcloud beta builds approve` for that one build.
The installed stable track has no `builds approve` command; the successful
approval was verified from the authoritative build record. Registry discovery
and direct occurrence reads followed success. Operational checker/documentation
fixes do not change the application image's pinned source commit above.

Next gate: separately approve the frozen zero-traffic revision and necessary
automation exclusions described in checklist step 2. Do not infer approval for
traffic cutover, migration or write enablement from this image-build checkpoint.

## Approved frozen zero-traffic deployment (2026-09-08)

The user subsequently approved checklist step 2, including temporary pauses of
the two canonical automatic deployment triggers. No traffic cutover, database
mutation, IAM/grant change, cleanup or scheduler action was performed.

- Deployment build: `4e24e8ec-6254-4262-a068-832699ba92ba`, approved at
  `2026-09-08T17:43:48.258676Z`; all seven steps succeeded at
  `2026-09-08T17:49:12.520244Z`.
- Dedicated source-less, approval-required trigger:
  `1c9c6502-f53f-4e04-ac9e-06bf49668acf` (`frozen-backend-receipts`). Its inline
  configuration and the pending build were compared exactly to the locally
  reviewed renderer output before approval; no source/event binding was added.
- Source/image pins are unchanged from the approved image-build review above.
  Independently resolved deployment-step SHA-256:
  `8effa287403d64d0184169a5a4a517a3b725926fee95f9f38add1dcfee8bc783`.
  The successful build's executable steps exactly matched this offline evidence.
- Ready revision: `mickeyf-org-freeze-12ec9e8eff4a493cbe8c025423e5110c`.
  Both score-submission flags are `false`; the complete runtime contract and
  provenance/scan checks passed, including the post-deployment exclusion check.
- Service generation changed from 126 to 127. The prior revision
  `mickeyf-org-build-3db9219129ee44e88daba01bcdcf9c3d` still has 100% normal
  traffic. The only added routing entry is the zero-traffic frozen test tag:
  `https://f-12ec9e8eff4a493cbe8c025423e5110c---mickeyf-org-j7yuum4tiq-uc.a.run.app`.
- Public leaderboard/database reads, unknown-game/legacy read contracts,
  anonymous authentication, Three Bosses HTTP 403 `SUBMISSION_DISABLED` and
  p4-Vega HTTP 503 `SUBMISSIONS_FROZEN` checks passed. The SDK emitted an API-
  enablement precheck warning; actual revision readiness and database reads
  succeeded, so no permission or API configuration was changed.
- After terminal success, the dedicated deployment trigger was disabled and
  canonical Stage B then Stage A were restored to their original enabled states.
  Full configurations matched the captured originals; the manual source trigger
  stayed unchanged. No pending/queued/working builds remained in either region.
  This is not the all-trigger maintenance freeze required by checklist step 3.

At deployment completion, existing-account login remained untested; anonymous
smoke alone could not accept that part of the rollback candidate. The subsequent
operator-assisted acceptance below closes that backend gate. Checklist step 3
still requires separate maintenance-freeze and traffic-plan approval. The schema
migration must not start yet.

## Existing-account backend acceptance (2026-09-08)

The operator entered an existing website account's credentials into a masked
VS Code terminal prompt, not chat or a saved credential file. The one-shot
helper pinned the exact frozen HTTPS origin and revision/image above, refused
redirects, retained TLS verification and kept the cookie jar in memory only.
The check completed successfully at `2026-09-08T18:06:15.6709583Z`:

- Anonymous `GET /auth/verify-token` returned `loggedIn: false` without a cookie.
- Existing-account `POST /api/users` login succeeded with the expected identity.
- Exactly one signed `session` cookie had Secure, HttpOnly, SameSite=None and
  Path=/ attributes, with no Domain broadening.
- The same in-memory cookie jar's `GET /auth/verify-token` returned
  `loggedIn: true` and the matching identity. No bearer token shortcut was used.
- Post-login cloud reads confirmed the same settled service generation 127 and
  exact zero-traffic tag mapping. An independent subsequent read confirmed the
  pinned image, both submission flags false and unchanged original 100% traffic.

This verifies password-column access, bcrypt/JWT issuance and the signed-cookie
backend round trip. It does not assert browser cross-site cookie compatibility.
No signup, score write, database mutation or traffic change was performed.
The retained non-secret result contains only pass/stage, UTC timestamp,
revision, image digest and test scope; the username/password/cookie are absent.
The frozen backend rollback candidate is now accepted on the existing schema;
post-migration schema/grants/read-path validation remains mandatory.

## Approved automation pause and read-only traffic plan (2026-09-08)

After backend acceptance, the user approved pausing backend deployment automation
and preparing the traffic-freeze plan. The three still-enabled triggers were
patched using only `updateMask=disabled`; the already-disabled frozen deployment
trigger stayed disabled. Full before/after comparisons confirmed no other
configuration changes:

- Stage A: `ef5a2981-95be-4f4d-af91-f997fde73356` — disabled.
- Stage B: `d71109da-8350-4f2f-a3be-2053bb6ccd45` — disabled.
- Manual image source: `648fadca-3cd1-4b57-9d35-0f62a1468443` — disabled.
- Frozen deployment: `1c9c6502-f53f-4e04-ac9e-06bf49668acf` — remains disabled.

The `us-central1` trigger inventory is empty. The planner's paginated checks
verified no pending, queued or working builds in either region. These backend
Cloud Build triggers remain paused pending controlled cutover; GitHub/Firebase
frontend workflows were not changed. If the cutover is abandoned, restore only
the captured original enabled states after checking drift: frozen deployment
must stay disabled. Do not silently leave backend deployment automation paused.

The exact existing source/deployment pins and independently reviewed steps hash
above produced the following **read-only** plan:

- Created: `2026-09-08T18:13:03.959Z`; generation `127`, with an etag-bound
  service/configuration fingerprint and exact frozen-revision fingerprint.
- Plan SHA-256: `d488bb2c40889ccfae4c72477581d5457055dfd50755e25f3bcc04c30fe84da4`.
- Before: original enabled revision at 100%, accepted frozen candidate at zero
  traffic via its `f-12ec9e8eff4a493cbe8c025423e5110c` tag.
- Proposed: exact accepted frozen revision at 100%, all revision tags removed
  (the current inventory has only that one tag).
- Not executed: no traffic PATCH, schema/data/grant changes or cleanup actions.
  Public score writes remain enabled on the old revision until traffic changes.
- Validity: five minutes from creation; an expired/drifted plan must be freshly
  generated and reviewed, never applied by bypassing the time/etag guards.

The Windows token launcher needed one fixed-command correction from `gcloud`
to `gcloud.cmd` inside its existing noninteractive PowerShell child. Timeout,
output sanitization and no-stdin behavior are preserved; execution policy was
not altered. The exact corrected token launch and live planning succeeded.
The planning invocation used `node --use-system-ca
scripts/frozen-backend-traffic.mjs plan --pins <reviewed-traffic-pins.json>
--output <new-plan.json>` so Node trusts the existing system certificate store
without disabling TLS checks. All 62 targeted rollout contracts and
`git diff --check` passed; no application/Unity rebuild was required.

Next approval can batch traffic freezing with read-only readiness/drain checks.
The freeze temporarily rejects score submissions, but preserves login and
leaderboard reads. Readiness and the mandatory old-request drain are distinct;
signup/operator sessions can still write and must be accounted for before DDL.
Database migration, grant changes and score-write enablement remain outside
this approval boundary.

## Approved traffic-only freeze and database-readiness blocker (2026-09-08)

The user approved routing all traffic to the accepted frozen backend and the
bounded read-only readiness/drain checks, excluding migration and permission
changes. A fresh plan at `18:19:24.571Z` matched the previous plan's routing,
source/deployment pins and service fingerprints exactly; only its timestamp
changed. Its SHA-256 was
`53ce1331052791c90f4a7462235302ae9f2747e8cf9429044438a6d6ddfc6283`.
The guarded command was:

```text
node --use-system-ca scripts/frozen-backend-traffic.mjs apply --plan <reviewed-plan.json> --confirm-plan 53ce1331052791c90f4a7462235302ae9f2747e8cf9429044438a6d6ddfc6283 --confirm-freeze-all-traffic
```

The etag-bound, traffic-only PATCH completed successfully. Cloud Run reported
Ready at `18:20:20.586249Z`, service generation 128, exactly 100% to
`mickeyf-org-freeze-12ec9e8eff4a493cbe8c025423e5110c`, and no revision tags.
An independent settled observation was recorded by `18:20:38Z`; this later
time is the conservative start of the old-request drain window. The complete
runtime configuration and frozen revision fingerprints are unchanged. All four
backend triggers remain disabled and no active builds were found.

The first public check passed all ten anonymous HTTP/database-read contracts:
root and unknown-game responses, anonymous auth/no cookie, catalog, both
leaderboards, both Three Bosses 403 gates, p4-Vega's 503 frozen gate, and legacy
p4 leaderboard parity. Signed-in login is the earlier accepted exact-revision
check, not a newly repeated browser test. No authenticated score write or signup
was attempted. All eight non-target revisions were listed as retired and had
300-second timeouts. These checks alone did not complete the delayed drain.

The delayed samples completed at `18:26:18.852Z` and `18:26:42.707Z`, respectively
340.852 and 364.707 seconds after the conservative settled observation. Each
rechecked exact generation/routing/configuration, frozen revision pins, all
eight retired states and timeouts, and paused automation/no active builds.
Complete paginated request-log queries found zero non-target-revision requests
with timestamps at or after `18:20:38Z`. These two samples were 23.855 seconds
apart; explicit result assertions verified zero old requests and all retired
states rather than treating successful collection as a pass. All three samples
passed ten public HTTP checks each (30 total), with identical p4-Vega and Three
Bosses response hashes throughout. This is bounded traffic/request-drain
evidence, not proof that database or external writers are idle.

At `18:23:36.091Z`, a read-only SQL probe through the verified existing Cloud SQL
proxy used the existing `michel_operator@cloudsqlproxy~%` account. Database `cms`
and server UUID `d1e6865c-ecad-11ee-a6b0-42010a400002` matched the pinned target.
The effective PROCESS probe returned `ER_SPECIFIC_ACCESS_DENIED_ERROR`, and
`@@performance_schema` was 0. Therefore neither full transaction visibility nor
instrumented metadata-lock visibility was available. No player rows were read,
no credentials were emitted or persisted, and no SQL/grant/instance mutation
was made. Existing local encrypted credentials were used only in memory through
the child process's standard input.

**Database drain remains unverified and migration is blocked.** The existing
operator must not be silently elevated, and enabling server instrumentation is
not authorized here. The next maintenance plan must resolve full activity/lock
visibility and the migration preflight's disabled-instrumentation case, then
repeat drain evidence while operators and external writers are excluded.
Signup remains writable on the frozen backend. No migration, cleanup job,
Scheduler activation or write re-enablement has occurred. The migration's
metadata-lock preflight has subsequently been hardened locally to fail closed
when instrumentation is disabled or invisible. Merely granting PROCESS would
not resolve the independently confirmed production instrumentation gap.

The dated non-secret plan and three readiness snapshots, SQL-visibility result
and one-shot probes are retained outside the repository in the operator's
`mickeyf-traffic-cutover-20260908-1819` temporary evidence folder. No production
source changed in this checkpoint; tracked changes record the rollout and
blocker in this runbook and `PROJECT_PLAN.md`. `git diff --check` passed;
application/Unity builds and unit suites were not rerun for documentation-only
changes.

## Local visibility guard verification (2026-09-08)

Receipt apply checks `@@performance_schema`, effective PROCESS through
`INNODB_BUFFER_POOL_STATS`, enabled metadata-lock instrumentation and the global
instrumentation consumer. Lost metadata-lock/thread-instance counters must be
zero both before and after reading transactions and pending locks. Missing,
denied or malformed results fail closed with sanitized errors. This does not
replace maintenance-window writer exclusion or reconstruct unrecorded locks.

Commands run from `backend`:

- `node --test -r ts-node/register ts/migrations/receiptTransition.test.ts`:
  27/27 passed, including unavailable/disabled instrumentation and lost records.
- `npm run test`: TypeScript passed.
- `npm run test:unit`: 194/198 passed. The four existing Express/body-parser
  parser checks fail with installed `qs` 6.15.3 versus locked 6.16.0. No active
  installation changes or weakened assertions were used.
- `npm run test:migrations`: 49/50 passed in the guarded disposable MySQL
  8.0.31 container, including all 19 migration tests. New refusal cases preserve
  schema, history and data; the existing successful transition test also passes.
  The unchanged runtime-grant session-drain test found an open session after
  client close. A teardown timing race is a hypothesis, not a verified cause.
  The runner removed its container and network; no production SQL was involved.

## Maintenance-access proposal (not executed)

A read-only instance description verified `cms-mickeyf` in `noted-reef-387021`:
MySQL 8.0.31, Enterprise, regional, tier `db-custom-1-3840` (3.75 GB), with no
explicit database flags returned. This tier supports `performance_schema`
without resizing. Enabling it requires a database restart and adds memory
overhead; database-backed login/leaderboards can be interrupted during restart.
Disabling it again also requires a restart. [Cloud SQL flag requirements](https://docs.cloud.google.com/sql/docs/mysql/flags).

The next approval may cover this bounded maintenance/inspection batch only:

1. Capture fresh instance settings/flags and version, backup/PITR readiness and
   active-operation state. Preserve unrelated flags and configuration when
   enabling `performance_schema`; do not clear flags wholesale. Keep the frozen
   revision, score gates and paused backend triggers unchanged. Any rollback
   restores the captured flag state with its separately understood restart.
2. Reuse an already approved maintenance identity if available; otherwise use
   an authorized administrator to create one short-lived inspector through the
   existing Cloud SQL proxy. Leave `michel_operator` and the API account alone.
   Grant only global PROCESS plus SELECT on these exact tables:
   `performance_schema.metadata_locks`, `performance_schema.setup_instruments`,
   `performance_schema.setup_consumers`, `performance_schema.global_status`.
   This inspector needs no player-table, DDL/DML, GRANT OPTION or connection-kill
   privileges. PROCESS exposes server-wide activity: collect aggregates only.
   Avoid inherited `cloudsqlsuperuser` access; use explicit SQL grants or verify
   and remove broad defaults before use. [Cloud SQL user roles](https://docs.cloud.google.com/sql/docs/mysql/users).
3. After the controlled restart, verify enabled metadata/global instrumentation
   and zero lost-record counters; keep them enabled for the entire window.
   Do not treat enabling a previously disabled instrument mid-session as
   recovery of earlier locks. Obtain fresh bounded transaction/lock and writer
   exclusion evidence; signup and external operators can still write despite
   the score freeze. [MySQL metadata-lock instrumentation](https://dev.mysql.com/doc/refman/8.0/en/performance-schema-metadata-locks-table.html),
   [lost-record counters](https://dev.mysql.com/doc/refman/8.0/en/performance-schema-status-variables.html).
4. Close inspector sessions, remove its temporary access/account, and verify
   removal when inspection ends. Report failures instead of leaving elevated
   access silently. If no authorized administrator exists, stop for a separate
   access-bootstrap decision rather than escalating the application account.

This proposal does not authorize migration DDL, runtime-grant cutover, cleanup,
IAM/scheduler activation or score re-enablement. The migration principal and
its DDL rights require their own reviewed scope; the inspector is not that
principal. Resolve the existing grant-test failure before any grant cutover.
No instance, account, production data or traffic changes were made while
preparing this plan.

## Session-drain fix and approved maintenance preflight (2026-09-08)

The prior test failure is resolved. In the installed mysql2 implementation,
`PromiseConnection.end()` resolves the Quit callback before `Quit.start()`
writes COM_QUIT, so client completion does not establish server session removal.
Only the integration fixture changed: poll its exact connection ID with a
five-second deadline and bounded queries after each relevant close. SQL errors
and an unclosed session still fail; production drain checks are unchanged.

Verification: focused runtime-grant unit tests passed 12/12; the full guarded
`npm run test:migrations` run passed 50/50, including all five runtime-grant
operation tests. `npm run test` (TypeScript) and `git diff --check` passed.
The disposable container and network were removed and their absence verified.
No dependencies were installed or refreshed.

The user then authorized the maintenance batch above. Fresh read-only Cloud SQL
checks found settings version 862, unchanged tier/HA configuration, no explicit
database flags and no active operation. Automated backups and binary logging
are enabled with seven-day transaction-log retention; the latest backup
`1788811200000` completed successfully at `2026-09-07T22:07:09.495Z`.
Cloud Run still reports generation 128 with 100% traffic to the same frozen
revision and no tags; all four global backend deployment triggers remain
disabled.

Access preparation is blocked before restart: the configured operator lacks
provisioning rights, the earlier temporary provisioning identity was removed,
and no usable administrator connection is configured. Cloud SQL lists only
`root@%`, `cms_mickeyf@%` and `michel_operator@cloudsqlproxy~%`; the scoped secret
metadata lookup found only the runtime DB credential, not an administrator
credential. No passwords were read or tested against another account.

The restart/flag update and inspector creation have not been attempted. Use an
existing authorized SQL administrator connection or separately approve a
short-lived bootstrap administrator solely to provision the minimal inspector,
then remove the bootstrap access. Both temporary identities must be removed
and their absence verified when their respective work ends. No production
mutation or outage was introduced by this preflight. Recheck operation/settings
drift before executing the already approved instrumentation maintenance.

## Approved instrumentation maintenance completed (2026-09-08)

The user explicitly approved the temporary bootstrap administrator and the
previously planned maintenance batch. Execution completed at
`2026-09-08T18:53:46.453Z` with the following verified scope:

- Fresh backups/PITR, settings, proxy target, frozen revision and paused
  automation checks passed. Only `performance_schema=on` was added using the
  current settings version; operation `3dc62fba-1eea-4604-8562-4c7600000032`
  completed, settings version changed 863 to 864 and the instance is RUNNABLE.
  Tier, HA, networking, backups and all other settings were preserved.
- Bootstrap `receipt_boot_0908_5a3f8cfd@cloudsqlproxy~%` provisioned inspector
  `receipt_view_0908_0f667c60@cloudsqlproxy~%` with only global PROCESS and SELECT
  on `metadata_locks`, `setup_instruments`, `setup_consumers`, `global_status`
  in performance_schema. Exact grants and role `NONE` were checked. The
  application/operator/root grant hashes were unchanged by provisioning.
  Bootstrap socket/session closure and user deletion were verified before the
  restart; inspector closure/deletion and the original user inventory were
  verified afterward. No password or token was persisted or logged.
- SQL samples at `18:52:59.580Z` and `18:53:04.750Z` confirmed instrumentation=1,
  enabled metadata/global instrumentation, zero lost lock/thread records before
  and after activity reads, zero active transactions and zero pending metadata
  locks. Five other client sessions remained; no SQL text/player rows were
  collected and exclusive writer control was not asserted.
- Seven public checks before and seven after passed: anonymous auth, catalog,
  both boards and all three frozen submission gates. Both leaderboard hashes
  were identical. Exact frozen revision/configuration, generation 128 and
  automation checks passed; no traffic, image, app schema/data, runtime grants,
  IAM, cleanup schedule or score enablement changed. Authenticated login was not
  repeated. Actual outage duration and memory overhead were not measured.

The one-shot execution used `node --use-system-ca` and retained TLS checks;
the non-secret result is outside the repository at
`C:/Users/User/AppData/Local/Temp/mickeyf-maintenance-20260908-1547/result.json`.
The temporary executable helper was removed after verification; no deployment
or credential helper was added to the project.
Independent closeout reads confirmed the flag, original three users and no
active Cloud SQL operation. Independent review found no remaining material
maintenance findings. This closes instrumentation maintenance, not permission
to migrate: the next batch needs a scoped migration principal, approved
write-free window, fresh preservation plan/drain and explicit DDL approval.
No application code changed, so builds and test suites were not rerun for this
operations/documentation checkpoint; `git diff --check` passed.

## Consolidated cutover proposal (awaiting approval)

Read-only preparation on 2026-09-08 used the existing DPAPI-protected operator
credential through the verified loopback proxy. A consistent READ ONLY
transaction captured canonical ordered preservation hashes, then rolled back;
no player rows or credentials were printed/persisted. At `19:00:17.660Z`:

| Preserved data | Rows | SHA-256 |
| --- | ---: | --- |
| Personal bests (5 p4-Vega, 2 Three Bosses) | 7 | `f4a64890694cec7e40b9257ba946ab560c1386e9c6428dab078af232496ad6fc` |
| Existing Three Bosses submissions | 5 | `b5ee68f7af91d417fa6f69cf663da7bc2cd3aa3957483fd4e479bd40558d9334` |

The pinned target is `cms` on `noted-reef-387021:us-central1:cms-mickeyf`,
server UUID `d1e6865c-ecad-11ee-a6b0-42010a400002`. Instrumentation remains on.
The operator's grant hash still matches the maintenance baseline. Its history
read is denied, so this snapshot is explicitly **not an authoritative migration
plan or drain proof**. The non-secret evidence is outside the repository at
`C:/Users/User/AppData/Local/Temp/mickeyf-cutover-plan-20260908-1558/preservation-snapshot.json`;
the one-shot snapshot helper was removed afterward.

Only these immutable migration files are proposed:

- `0004_detach_personal_best_sources.sql`, SHA-256
  `88cc121f6410f6c324cff0d6bb57691062a64a10722c0c35deb826ce4cc0f9a6`:
  drop the best-to-run foreign key, supporting index and source ID column.
- `0005_retain_submission_receipts.sql`, SHA-256
  `f91a3f5aa52f14e43c652282ca9cc1a9e6dc5e9294c8c7c330c8142cbd33becc`:
  rename `game_runs` to `game_submission_receipts`, rename its boolean to
  `improved_personal_best`, and replace the obsolete index/check. Neither file
  deletes personal bests or existing receipt rows.

Recommended single approval scope, not executed during preparation:

1. Save/disconnect TablePlus edits and pause only the VS Code `back` workload;
   preserve `front`, WebGL, docs and the Docker SQL proxy. Temporarily restrict
   the existing Cloud Run service's ingress from captured `all` to `internal`,
   preserving its image, traffic and IAM. Verify both known public run.app
   endpoints are blocked and account for internal callers. Login, signup and
   leaderboard reads will be interrupted; static site/game assets remain up.
   Internal ingress is not universal isolation. [Cloud Run ingress](https://docs.cloud.google.com/run/docs/securing/ingress).
2. Provision short-lived privileged bootstrap/admin access for account
   provisioning and the reviewed grant changes, plus the scoped migration
   identity. Capture exact existing grants, verify full dependency metadata
   and take a fresh backup.
   Drain admitted requests and local writers. Close only positively identified
   application/operator SQL sessions after saved edits are confirmed; never
   kill arbitrary/system sessions. Require zero runtime sessions, active
   transactions and pending locks, plus complete instrumentation. Do not lock
   the runtime account as a shortcut: the existing grant runner rejects it.
3. Generate/review the final guarded plan under full visibility. Apply only the
   two pinned migrations if target, checksums and preservation hashes match;
   drift requires a new decision, not a bypass. Verify final schema/history and
   identical canonical data hashes while the writer barrier remains in place.
4. Revoke only reviewed obsolete `game_runs` grants and any surviving
   `source_game_run_id` column grants, then apply/verify the exact runtime
   manifest. Transfer the operator's captured old-table privileges to the new
   name without broadening other access; never add API DELETE. Table-specific
   grants do not follow a rename. [MySQL rename semantics](https://dev.mysql.com/doc/refman/8.0/en/rename-table.html).
5. Restore captured ingress and the local backend only after schema/grant/read
   verification, then check the same frozen public contracts and board hashes.
   Remove temporary maintenance accounts and verify removal. Keep both score
   gates, backend deployment triggers and receipt cleanup disabled.

Before-DDL failure should restore the captured frozen service after cleanup.
After partial DDL, preserve the barrier and use the existing reviewed recovery
plan; never silently restore an enabled old writer or rewrite migration history.
This batch does not enable scores, deploy another image, activate cleanup or
change Unity. No servers were stopped, accounts created, grants altered or
production routing/schema/data changed during this read-only preparation.

## Approved receipt cutover completed (2026-09-08)

The user approved the complete scoped cutover, including temporary privileged
bootstrap/migration access, the backend barrier, saved operator-session drain,
backup, both pinned migrations, exact grant changes and service restoration.
Execution finished at `19:26:19.570Z` with no pending or recoverable migrations.

- Backup `1788894880118` completed successfully at `19:16:11.521Z`; existing
  backup/PITR settings and instance sizing were preserved. Full privileged
  metadata inspection found no views, routines, events or triggers in `cms`,
  and only the reviewed composite foreign key referencing `game_runs`.
- Temporary `receipt_boot_0908_9827650c@cloudsqlproxy~%` provisioned scoped
  `receipt_mig_0908_9827650c@cloudsqlproxy~%`. Exact table privileges, global
  PROCESS only, no grant options and no assigned/default roles were verified
  for the migrator. Pre-DDL runtime/operator baselines matched reviewed rights.
- Only VS Code's `back` workload was paused. Both public backend origins were
  blocked by the etag-bound ingress change; the backend's admitted-request
  timeout passed before SQL drain. No other regional Cloud Run services/jobs
  were present; Cloud Scheduler was disabled and backend build triggers stayed
  disabled with no active builds. The one remaining sleeping runtime session
  was positively identified and closed. Repeated checks found no reconnects,
  active transactions, pending locks or lost instrumentation records.
- Final ready plan SHA-256
  `37901a35a11562d747d4ed9a2a01cba33709fa9de44a8b1f4e411a505da07fe3`
  matched the approved target, immutable SQL and preservation hashes above.
  Guarded apply verified 0004/0005 at `19:23:31.506Z`; all seven personal bests
  and five receipts retained identical hashes. No best/receipt rows were deleted.
- Grant approval SHA-256
  `f5f804e6e1dfd857402a65cf4eae7f7e05a7489f4a14b38f8b3344e220731615`
  removed only obsolete runtime column grants, applied the exact receipt-era
  manifest and transferred the operator's old-table DML. Runtime verification
  returned `reduced`/compliant, with no API DELETE or inherited roles. Operator
  rights remain SELECT/INSERT/UPDATE/DELETE on users, bests and renamed receipts.
- Public ingress returned to `all` at `19:25:19.552Z`. Generation 130 retains
  the same frozen revision/image, 100% traffic and no tags; IAM is unchanged.
  Seven public checks before and seven after passed, with identical raw
  leaderboard-response hashes. The original local backend command was restarted
  in `back`; both local boards returned 200, Three Bosses ticket submission 403
  and p4-Vega submission 503. Frontend/WebGL/proxy listener PIDs were unchanged.
- Both temporary accounts were removed and the original three-user inventory
  restored after settled operation checks. No passwords, tokens or player rows
  were persisted. An earlier preparation helper stopped on a composite-FK
  counting error before downtime/DDL; its bootstrap account was also removed.
  Temporary executable helpers were deleted; only non-secret evidence remains
  outside the repository in
  `C:/Users/User/AppData/Local/Temp/mickeyf-receipt-cutover-20260908/`.

Evidence: `result-9827650c.json` in that directory, including the final schema,
preservation digests, grant plans, backup and cleanup events. Independent
closeout review passed. Helper syntax checks and `git diff --check` passed;
application/unit/Unity builds were not rerun for this operations-only batch.
Restoring the existing backend dev workload resumed its normal watcher.
Authenticated login and enabled submission/replay were not repeated, cleanup
was not activated, and both score flags/deployment triggers remain disabled.
Those are the remaining rollout gates, not an unfinished migration.

## Approved private enabled acceptance completed (2026-09-08)

The user approved one complete test-and-cleanup batch: a private Cloud Run
service using the already verified image, one disposable website account,
controlled submissions against the production database, and removal of those
temporary resources. The user was told the synthetic bests would briefly appear
on public leaderboards; existing player scores were not used for testing.

Execution ran from `19:48:30.853Z` to `19:49:40.355Z`:

- Production generation 130, frozen revision/image, 100% traffic and IAM matched
  the captured pins. Project IAM had no `allUsers`/`allAuthenticatedUsers`
  bindings and the project had no parent. No production service mutation,
  database schema/grant change, deployment-trigger change or scheduler change
  was performed.
- Private service `mickeyf-receipt-check-b3e497a2` used image digest
  `sha256:9ec1bd83ea73a283ad36961b2dcd3022b9b0a40cbf16bd725398ff562015c3c3`,
  the existing runtime identity/pinned secret references/Cloud SQL mount and
  a maximum of one instance. Only its two submission flags were enabled. IAM
  checks remained on, the service policy had no public members, and an
  unauthenticated request returned 403. A Google ID token in
  `X-Serverless-Authorization` provided service access separately from the
  application's signed session cookie.
- HTTP signup/login created only `receipt_check_20260908_b3e497a2`. Login's
  Secure/HttpOnly/SameSite=None signed cookie verified the matching session;
  the helper generated the website password in memory and did not forge JWTs
  or read the runtime session secret. Existing operator credentials entered
  through a DPAPI-to-stdin handoff, not command arguments or evidence files.
- Eleven genuine server tickets were issued, followed by an actual 13-second
  wait. Ten new runs were accepted. First/worse/better results retained the
  fastest 11,000 ms best, canonical score 909,091 and rank S. Identical retries
  returned the original result, including after the rate limit; a changed
  payload returned 409 and the eleventh new run returned 429 without a receipt.
  The 25 ticket/submission requests remained below the separate 30-request IP
  ceiling, so that ceiling did not substitute for the database-limit check.
- p4-Vega scores 20, 20, 10 and 30 produced improvement results true, false,
  false and true. Database readback showed one best for each game, ten Three
  Bosses receipts and no p4-Vega receipts. Both leaderboard readbacks included
  the expected synthetic result. All **64 HTTP assertions passed**.
- Creation operation `d5fa4807-c86d-4aba-b194-ae4a5e789c6a` was settled before
  teardown. The exact owned service was deleted and absence verified at
  `19:49:32.438Z`. Then a transaction under the application's shared per-user
  lock removed exactly ten owned receipt UUIDs, two bests and the one user,
  with numeric ID/username/email ownership checks and child-before-parent
  deletion. No prefix deletion or auto-increment reset was used. Absence of all
  test rows was verified; these synthetic rows are intentionally discarded.
- The original seven personal bests retained SHA-256
  `f4a64890694cec7e40b9257ba946ab560c1386e9c6428dab078af232496ad6fc`;
  the original five receipts retained SHA-256
  `b5ee68f7af91d417fa6f69cf663da7bc2cd3aa3957483fd4e479bd40558d9334`.
  Public response hashes, production config and IAM were identical afterward.
  Both public backend origins still rejected Three Bosses writes with 403 and
  p4-Vega writes with 503. Local development servers were not stopped.

Non-secret evidence: `result.json` in
`C:/Users/User/AppData/Local/Temp/mickeyf-receipt-acceptance-20260908-b3e497a2/`.
The temporary Node/PowerShell execution helpers were removed after review;
credentials, cookies and run tickets were not persisted. Node syntax and
PowerShell parser checks passed. No dependencies were installed and no
application/unit/Unity builds were rerun for this operations-only batch.

This closes the controlled enabled backend acceptance gate, not normal public
write activation or browser cross-site-cookie/gameplay acceptance. Next is
separately approved normal-traffic score promotion of this verified image;
receipt-cleanup credentials, alerts, manual execution and scheduling remain
separately gated by the cleanup runbook.

## Approved normal score-submission activation (2026-09-08)

The user approved enabling normal production submissions for both games using
the verified image. Execution completed at `20:01:05.143Z`; Cloud Run service
`mickeyf-org` is at generation **132**, with intended and observed traffic both
100% on `mickeyf-org-scores-9ec1bd83-0908`, no tags and no floating LATEST target.

- The image remains
  `sha256:9ec1bd83ea73a283ad36961b2dcd3022b9b0a40cbf16bd725398ff562015c3c3`
  from the reviewed source/build. Only
  `P4_VEGA_SCORE_SUBMISSIONS_ENABLED=true`,
  `THREE_BOSSES_RUN_SUBMISSIONS_ENABLED=true` and the required new revision name
  changed in the template. Secrets, runtime identity, Cloud SQL attachment,
  CPU/memory, scaling, concurrency and timeouts were preserved exactly.
- An etag-bound template-only PATCH created generation 131 while all traffic
  remained on the frozen revision. Operation
  `3127a46d-3b4a-4e43-b94c-c744620cc05c` completed; the enabled revision was Ready
  and its runtime/provenance matched before promotion. A fresh etag-bound
  traffic-only PATCH then completed as
  `7eda635f-b26b-4d3e-888a-870103f6910b`. No image rebuild was needed.
- All **36 live HTTP rollout assertions passed** across both public backend
  origins. Three Bosses now advertises `enabled`; p4-Vega correctly remains
  `legacy-only` in the catalog because it uses `/api/users`, not because it is
  frozen. Signed-out mutations now return the application-level 401
  `UNAUTHORIZED` instead of the disabled/frozen response. Anonymous session
  checks, leaderboard DTO/order checks, both trusted website Origin preflights,
  credential headers and mutation no-store/no-cookie checks passed.
- The board response hashes happened to match before and after promotion;
  legitimate submissions are now allowed to change them. This batch created no
  synthetic scores or test accounts and performed no direct SQL writes. Real
  authenticated persistence proof comes from the preceding private-service
  acceptance, not the unsigned rollout probes. No new Safari/gameplay claim is
  made.
- IAM, ingress and unrelated service configuration are unchanged. Existing
  backend build triggers remained disabled with no active builds at the checked
  boundaries. No scheduler, cleanup credential, database grant/schema or local
  development server was changed. The exact receipt-compatible frozen revision
  `mickeyf-org-freeze-12ec9e8eff4a493cbe8c025423e5110c` remains Ready as the rollback
  target. Do not roll back to the retired pre-receipt writer or re-enable old
  deployment automation without reviewing its receipt compatibility.

Evidence: service-before/staged/after snapshots, the staged enabled revision,
IAM baseline and `result.json` in
`C:/Users/User/AppData/Local/Temp/mickeyf-score-promotion-20260908-e4d8c26a/`.
The zero-traffic revision snapshot is staging history, not the final traffic
state. Independent closeout review passed. The one-shot `promote.mjs` helper was
syntax-checked with `node --check`, then executed with `node --use-system-ca`;
existing guard imports and `git diff --check` passed. The helper was removed
afterward; only non-secret evidence remains. No dependency install, application
build or unit-test rerun was needed for this configuration-only rollout.

Next: the separately approved cleanup runbook, including dedicated credentials,
least-privilege IAM, operator alerts, a reviewed manual execution and then hourly
scheduling. Score activation alone does not enforce receipt expiry.

## Initial receipt-cleanup alert checkpoint (2026-09-08; historical)

The owner approved the notification recipient. Channel
`9138709485205441101` is enabled; its email address is stored in Cloud Monitoring,
not in this repository. Component ERROR/backlog policy `17739991777076766134`
and native execution-failure policy `15588823733398199471` are enabled and use
that channel. The test emitted a positive `result=failed` metric; the log policy
opened incident `0.ocefwkir0c1s` at `23:34:07Z`.

Cloud Run job `mickeyf-submission-receipt-cleanup` in `us-central1` has UID
`332dff70-87d6-40ec-a617-368bb9c5dc0a`. It pins the already-reviewed
`sha256:9ec1bd83ea73a283ad36961b2dcd3022b9b0a40cbf16bd725398ff562015c3c3`
image and runs the dedicated cleanup entrypoint. It has only
`NODE_ENV=production` and `RECEIPT_CLEANUP_ENABLED=false`, no database credentials,
secret references, volumes or mounts, one task, no task retries, and a 180-second
timeout. The new `mickeyf-receipt-cleanup` service account has no direct project
roles or user-managed keys; the job has no public IAM binding. No cleanup SQL
account, secret, scheduler identity or schedule was created.

The one dispatched no-database test, execution
`mickeyf-submission-receipt-cleanup-6jxdx`, completed at `23:33:04.351162Z`
with exit code 1 and the expected structured `configuration-or-shutdown`
failure. The false flag is rejected before the entrypoint creates a database
connection. An initial service-account attachment returned 403; a read-only
check then showed the caller already had `actAs`, and creation succeeded without
adding permissions. No privilege widening was used to resolve that delay.

Security/acceptance disposition:

- Verified: disabled-first execution, exact job identity/image, no DB/secret
  configuration, no direct new-identity project grants, and no public job access.
- Pending: the native-policy incident and actual inbox delivery.
  Creating a channel/policy or seeing the intentional failure is not delivery
  proof. The no-success watchdog must be armed only after a real successful run
  and its positive Monitoring datapoint, before hourly activation.
- Preserved: production generation 132, both submission flags enabled and 100%
  intended/observed traffic on the accepted revision. No application data,
  website runtime roles, traffic, backend triggers or local servers were changed.
- Deferred to the next gate: dedicated least-privilege cleanup SQL credentials,
  pinned secret, reviewed manual deletion with preservation/replay checks, and
  hourly scheduling. Public writes can legitimately change personal bests;
  historical receipt hashes are not a current frozen baseline.

Non-secret operational evidence and independent closeout are outside the repo:
`C:/Users/User/AppData/Local/Temp/mickeyf-cleanup-alerts-20260908-f6b1c8e2/`.
Only this operational documentation changed. `node --check` on the temporary
helper and `git diff --check` passed; no dependencies, builds or application
tests were needed for this cloud-configuration-only batch. The temporary
execution helper was removed after verification; only non-secret evidence
remains outside the repository.

## Approved cleanup credentials and manual acceptance (2026-09-08 local)

The owner confirmed receipt of both intentional alert emails and approved a
disposable website account/score for the before/after retry check. This closes
the preceding delivery gate, including the native-policy incident. The live
manual run completed at `2026-09-09T00:01:24.986939Z`; read-only closeout completed
at `00:03:00.282Z`. Hourly scheduling was not activated.

- `receipt_cleanup@cloudsqlproxy~%` was created through SQL, avoiding automatic
  Cloud SQL administrator roles. A separate connection verified the production
  schema name/server UUID/account and exact `SELECT(user_id, game_run_id,
  submitted_at)` plus `DELETE` on `cms.game_submission_receipts`. Assigned,
  default, active and mandatory roles were empty. All original SQL accounts'
  grants retained their baseline hashes. No existing account gained DELETE.
- The randomly generated password went directly to
  `mickeyf-receipt-cleanup-db-password`, numeric version **1**; no password,
  session cookie or run ticket was written to evidence or command arguments.
  `mickeyf-receipt-cleanup` has Cloud SQL Client at project scope and Secret
  Accessor only on that secret, no user-managed key and no public job binding.
  The temporary provisioning account was physically disconnected and removed;
  its absence and unchanged unrelated project IAM were independently verified.
- The structural preflight found no incoming receipt foreign key or receipt/
  personal-best trigger; personal bests have no source-receipt dependency and
  receipts have the expiry-leading index. Backup/PITR configuration was enabled.
  No schema change was needed. The full pinned-image/secret/socket configuration
  was staged disabled before the manual-only enablement.
- First attempt `mickeyf-submission-receipt-cleanup-8ppht` was safety-canceled:
  the v2 execution response omitted the Cloud SQL volumes/mounts present on its
  verified Job. The same execution's v1 UID, owner, job generation and exact
  `run.googleapis.com/cloudsql-instances` annotation proved the attachment.
  Only that observed representation difference was normalized; all other
  template fields still had to match. Twelve offline guard tests passed,
  including rejection of wrong attachments, identities, images and secrets.
  Fresh SQL hashes proved the canceled attempt left all seven existing bests
  and five receipts unchanged; its disposable fixture was removed.
- The controlled retry, `mickeyf-submission-receipt-cleanup-k2skb` (UID
  `c46be742-d5a1-41e3-bf3a-4c8ffdd98466`), succeeded with one task and no failed,
  canceled or retried task. Its component summary reported **5 deleted receipts**,
  two batches and `backlog=false`. The SQL comparison independently found all
  five expired receipts removed, the young test receipt unchanged and all eight
  then-present bests unchanged (seven existing plus the disposable best).
- Real signed-cookie login, server-issued ticket and authenticated submission
  established the fixture. Exact HTTP retries returned the original result
  both before and after cleanup. Teardown used exact ownership checks, the
  shared user lock and a transaction to remove one test receipt, best and user.
  The final inventory has seven bests, zero receipts and zero expired rows.
  The bests' ordered snapshot hash is unchanged:
  `169d9214df7f0e65f0702c930b7155d24655fcc931fe0d3abe6534ce9b0241e2`.
  This helper's date-string serialization differs from earlier snapshot hashes;
  comparisons use this batch's own identical before/after format.
- After successful cleanup/replay, an auxiliary helper assertion mistakenly
  compared the numeric receipt primary key with the client run UUID. Its
  `finally` still disabled the job and removed the fixture. A separate read-only
  closeout verified the exact successful execution, preservation/replay
  evidence, absent test data, unchanged table DDL and final inventory. No extra
  cleanup was dispatched. Separate post-replay timestamp immutability is not
  claimed; the recent receipt was verified unchanged through cleanup.

Security/activation disposition:

- Verified: delivered failure alerts, exact restricted SQL/secret IAM, removed
  provisioning/test accounts, successful bounded deletion, preserved bests and
  young receipt, before/after authenticated replay and final SQL inventory.
  Independent cloud closeout at `00:06:44Z` also observed a positive native
  `result=succeeded` datapoint for this job in the `00:01–00:02Z` interval. This
  is a job-level aggregate, not an exact per-execution count; the specific
  execution's success is verified from its UID and terminal status separately.
- Preserved: production service generation 132 and its full template hash,
  both enabled score flags, intended/observed 100% traffic on the accepted
  revision, schema, existing SQL grants and disabled backend build triggers.
- Accepted: expired receipts were intentionally deleted; restoring them would
  require a separately reviewed backup restore. Personal bests do not depend
  on those receipts. This operations check adds no new browser/gameplay claim.
- Deferred: no-success watchdog, scheduler identity and hourly scheduling.
  The cleanup job is Ready but **disabled at generation 6**; Scheduler API
  remains disabled. The native success signal is now verified; configure the
  watchdog before hourly activation and observe the first scheduled execution
  after approval.

Evidence: `retry-manual-result.json`, preservation/config snapshots and review
in `C:/Users/User/AppData/Local/Temp/mickeyf-cleanup-activation-20260908-c7d245e1/`.
Temporary execution helpers are removed after verification; only non-secret
operational evidence remains outside the repo. Validation used `node --check`,
the 12 offline helper guard tests and the live operations checks above; no
dependency install, application build, Unity build or unrelated test matrix
was run. This is a scoped retention checkpoint, not final project security
closeout.

## Approved hourly scheduling (2026-09-08 local)

The owner approved retaining short-lived receipts, hourly cleanup and basic
failure alerts. The protection is permanent; individual receipts expire. This
does not reintroduce permanent game history or change p4-Vega's best-only path.

Activation completed at `2026-09-09T00:27:08.024Z`:

- Cleanup Job `mickeyf-submission-receipt-cleanup` is Ready at generation 7 with
  `RECEIPT_CLEANUP_ENABLED=true`. Its previously accepted immutable image,
  numeric secret version, SQL target, task/deadline limits and worker identity
  are unchanged; only the cleanup flag changed from generation 6.
- Scheduler `mickeyf-submission-receipt-cleanup-hourly` uses the checked-in
  UTC-hourly template: authenticated OAuth POST to that Job's `:run`, empty
  request object (no execution overrides), 30-second HTTP deadline and no
  configured retries.
  A successful HTTP call creates an asynchronous execution; terminal Job status
  and component logs are checked separately.
- `mickeyf-receipt-scheduler` has Run Invoker on this Job only, no project role,
  secret/SQL access, delegated service-account binding or user-managed key.
  Its UID is `104319556337535182408`. The Google-managed Scheduler service agent
  has its required `roles/cloudscheduler.serviceAgent` role. All other project
  bindings and the cleanup secret's accessor binding match their baseline.
- Missing-success policy `3453175835959381685` is enabled after the accepted
  native success signal. It watches this exact job's `result=succeeded` sum
  below one for two hours, including missing data, with five-minute alignment.
  It uses the same approved channel as the unchanged failure/log policies
  `15588823733398199471` and `17739991777076766134`. Both earlier failure emails
  were owner-confirmed. No deliberate two-hour outage or separate third-policy
  inbox-delivery test is claimed; evaluation/ingestion can delay detection.

One forced Scheduler request was accepted at `2026-09-09T00:27:32.986Z`.
Initial project provisioning delayed dispatch, consistent with Google's
[first-job initialization guidance](https://docs.cloud.google.com/scheduler/docs/schedule-run-cron-job).
The request was not resent. Execution `mickeyf-submission-receipt-cleanup-v27kx`
(UID `766c2cd7-e866-4256-b7c4-4c876217657c`) was created at `00:31:11.114040Z`
by the exact Scheduler caller and completed at `00:32:57.235029Z`: one successful
task, no failures/cancellations/retries, zero deleted receipts and no backlog.
Its full execution template matches generation 7, with the same independently
correlated v1 Cloud SQL annotation used by the manual acceptance guard.
Scheduler's HTTP delivery and actual cleanup completion both passed.
Independent closeout at `00:34:34Z` also observed the native `result=succeeded`
metric in the `00:33–00:34Z` interval. This aggregate signal supplements, rather
than replaces, the exact execution-UID and terminal-status evidence.

Read-only snapshots before activation and after completion retain nine users,
seven personal bests and zero receipts/expired receipts. Personal-best and
receipt hashes and the users/bests/receipts DDL hashes are identical between
these snapshots. This batch's explicit-column/string serialization is compared
only with its own baseline; it is not compared with earlier hash formats.

The first natural hourly tick passed (2026-09-08 local). Scheduler logged the
`2026-09-09T01:00:19.548160Z` scheduled attempt and HTTP 200 completion at
`01:00:21.032957400Z`. Exact caller `mickeyf-receipt-scheduler` created execution
`mickeyf-submission-receipt-cleanup-zjpfg` at `01:00:19.638409Z`
(UID `6d5b9166-91bb-4269-9871-56f78936d1ca`), distinct from forced run `v27kx`.
The parent Job UID and generation-7 label match; the execution's own generation
is 1. Its full native v1 spec matches both the accepted prior execution and the
current Job template, including the same image/secret pin and matching Cloud SQL,
secret-alias and Gen2 annotations. No v1-to-v2 hash equivalence is claimed.

Execution completed successfully at `01:01:22.324316Z`: one successful task,
zero failed/cancelled/retried tasks. The three returned execution log entries
are INFO; the component completion at `01:01:16.100359Z` reports zero deletions,
one scanned batch, 24-hour retention and no backlog, followed by `exit(0)`.
The enabled Scheduler configuration matches activation (including unchanged
update time); the native Job remains Ready at generation 7. Production UID,
generation/observed generation 132 and intended/observed 100% traffic to
`mickeyf-org-scores-9ec1bd83-0908` match the prior checkpoint. This observation
dispatched no additional run and did not reread SQL, secrets, IAM or the full
production template; it does not claim a new database preservation snapshot.

Historical alert recheck limitation (resolved by the readback below):
Cloud Console freshly showed missing-success policy
`3453175835959381685` enabled, Error severity, a below-one threshold over two
hours and the existing owner-email channel. Its full filter/channel-ID JSON
and failure policies `15588823733398199471` / `17739991777076766134` were not
freshly compared. The installed CLI lacks the required alpha policy command;
no component was installed. Browser reconnection then failed with
`failed to write kernel assets: The system cannot find the path specified`.
The activation snapshots remain the evidence for those unrefreshed fields.
Do not widen permissions, install tooling or rerun cleanup to resolve this
read-only verification limitation. Keep the healthy schedule unchanged; finish
that bounded policy readback when the existing console/tool connection works.

After recording and syncing this outcome, delete only one-time follow-up
`verify-first-hourly-receipt-cleanup` as requested. Preserve this conversation,
JSON evidence and both production cloud jobs; do not create a replacement
follow-up. If removal fails, pause it and report the remaining artifact.
Cloud Scheduler cleanup does not depend on the developer computer.

Scope/security disposition (activation baseline; natural-tick recheck limits
are stated above):

- Verified configuration: exact target/digest/secret pins, separated invoker and
  worker permissions, three enabled scoped alerts, and no unrelated IAM drift.
  The operator snapshot uses only users/bests/receipts; an unnecessary migration
  history metadata probe was removed rather than expanding operator permissions.
- Preserved: production service generation 132, full runtime template, enabled
  submission flags, intended/observed traffic and disabled backend triggers.
  This activation does not modify application code, SQL grants or schema.
- Accepted operations: recurring cleanup has bounded cloud execution cost;
  outages/backlog can extend receipt retention beyond the normal 24–25 hours.
  Already expired receipts require a separately reviewed backup restore, not
  an application rollback. Best scores remain independent and permanent.
- Natural-tick evidence is complete; the limited fresh alert-policy readback
  is now closed by the read-only API comparison below. Forced Scheduler dispatch
  and its exact successful cleanup execution are also verified.
  The completed migration, disposable-account replay test and score promotion
  are not repeated. Final whole-project release/security review is separate.

To intentionally stop cleanup, pause Scheduler, reconcile/cancel in-flight
executions, disable the cleanup flag and disable only the no-success watchdog.
Keep the two failure policies; do not change website traffic or widen SQL roles.

Non-secret activation evidence is outside the repository at
`C:/Users/User/AppData/Local/Temp/mickeyf-cleanup-schedule-20260908-60a2c2ed/`.
It includes `dispatch-result.json`, exact execution/log/IAM/config snapshots and
`before-snapshot.json` / `after-snapshot.json`. Temporary execution helpers are
removed after verification; non-secret JSON evidence is retained outside Git.
Natural-tick evidence is in the `natural-tick-*.json` files in that same folder;
the component-log summary contains selected fields, not a raw full log export.
Activation validation: live Scheduler/Job/alert/IAM checks, read-only SQL preservation
checks, helper syntax checks and `git diff --check`. No dependency install,
application or Unity build, broad test rerun, website deployment or main merge.
Natural-tick validation: native Scheduler/Job/execution/log reads, scoped
production readback, one policy's UI state, saved JSON comparisons and
`git diff --check`; no builds or tests were required for this docs-only checkpoint.

## Final alert-policy readback (2026-09-08 local)

At `2026-09-09T02:12:46.4962511Z`, four read-only Cloud Monitoring API GETs
retrieved policies `17739991777076766134`, `15588823733398199471`,
`3453175835959381685` and channel `9138709485205441101`. The existing Google
Cloud login sufficed; no CLI component, permission or browser repair was needed.
All selected policy configuration fields matched the retained activation
snapshots exactly, including filters, aggregation, thresholds/durations,
missing-data behavior, alert strategies and channel IDs. All policies remain
enabled with Error severity; the enabled email channel matches the approved
recipient. The cumulative ledger records the exact comparison scope.

Non-secret evidence is retained outside Git in
`release-checks-20260907/alerts-readback-20260908.json` under the Codex
visualization folder. No token or recipient address was saved in that record.
No cloud resource, database or local server changed; no cleanup or test alert
was dispatched. This closes the limited configuration readback, not a new
inbox-delivery test or the separate whole-project release/security gates.
Validation: three structural baseline comparisons, channel checks, evidence
JSON parsing and `git diff --check`; no application builds/tests were needed.
