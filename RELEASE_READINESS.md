# Release readiness and cumulative security ledger

Reconciled 2026-09-08 local (2026-09-09 UTC), against source checkpoint
`015d962e3b056b6c0aa1ad306a4ca4b94a398b79`. This is the current gate summary;
dated entries in [PROJECT_PLAN.md](PROJECT_PLAN.md) and
[RECEIPT_RETENTION.md](backend/RECEIPT_RETENTION.md) remain supporting history.
Update this ledger instead of treating superseded historical blockers as new work.

**Published with public mobile gameplay enabled on 2026-09-09 local.**
Owner-approved PR #322 merged as `c94c5de5` after the required checks and CodeQL
passed. Firebase run `34305326963` succeeded through preview startup, live
promotion, runtime verification and temporary-preview deletion. The continuing
polish branch is preserved and synchronized; backend deployment, flags, grants
and database state were not changed. Earlier evidence below remains dated
history; the publication closeout records the final delivery checks.

## Current dispositions

| ID | Status | Evidence and remaining boundary |
| --- | --- | --- |
| S1 | Fixed; dated production acceptance | Receipt migration, exact SQL runtime/operator grants, preservation checks, temporary-account removal, 64 enabled HTTP acceptance assertions and 36 promotion assertions are complete. Do not repeat migrations or synthetic-account acceptance. These are not browser-cookie tests. |
| S2 | Fixed; scoped live readback | On 2026-09-10, final Cloud Run generation138 serves 100% traffic to `mickeyf-org-ios-origin-a1f3ea43-0910`, image `90a9bca6…646d1`, with no tags. Runtime/configuration are unchanged; `mickeyf-org-p4-1000-6c5a8859-0910` remains intact for rollback. All six live preflights and the unauthenticated session probe passed. Earlier scoped IAM/grant findings are carried forward, not re-enumerated by this CORS-only rollout. |
| S3 | Fixed; source and live control checks | Backend build contexts exclude local environment/dependency/generated files; Docker remains pinned, multistage and non-root. All four existing global backend build/deploy triggers are disabled; none are configured in `us-central1`. Reviewed frozen deployment/traffic guards remain. Do not re-enable triggers or route traffic as part of verification. |
| S4 | Fixed; operational acceptance | Manual cleanup/retry acceptance, hourly activation and exact first natural execution `zjpfg` succeeded. One-off follow-up was deleted. Permanent bests remain independent of receipt deletion. No extra cleanup dispatch is needed. |
| S5 | Fixed; scoped live readback | At 2026-09-09 02:12:46 UTC, read-only Monitoring API requests verified all three enabled ERROR policies, their exact filters/conditions/alert strategies and sole approved channel against the activation snapshots. The email channel is enabled and its recipient matches the owner's choice. The API resolved the readback blocker without installations or permission changes; browser/CLI repair is not claimed. This is configuration evidence, not a new incident or email-delivery test. |
| S6 | Fixed; merged | PR #322 brought the reviewed dependency fixes into main. GitHub's post-merge push report lists only the previously accepted moderate alert #287. At the initial reconciliation, 13 of 14 alerts mapped to branch fixes: eight `fast-uri`, two `qs`, and three `xmldom`. This is distinct from the subsequent CI audit findings in S12. |
| S7 | Accepted; bounded and expiring | Deployment-only `stream-json` 1.9.1, GHSA-528h-pc64-c93x, remains under the owner's static-Hosting-only exception through 2026-10-07 or earlier reassessment triggers. Firebase 15.28.1, locked install, high audit gate and eight-minute deployment timeout remain. No import/framework pipeline expansion or major override is accepted. |
| S8 | Accepted; bounded and expiring | On 2026-09-10 the owner renewed the exception through 2026-10-07 for the now-deployed CORS-only image `90a9bca6…646d1`, limited to the matching unchanged-runtime/base/dependency replacement and existing earlier-reassessment triggers. Exact build/rollout evidence and historical receipt/p4-image approvals are below. This is risk acceptance, not an OpenSSL fix or blanket approval for subsequent images. Clean OS/NPM/SECRET scans do not certify the embedded component. |
| S9 | Fixed; tested CI checkpoint | Authorized non-deploying run `34301221560` passed both jobs on `3ea379fe`: dependency validation/audits, frontend tests/build, WebGL package/tooling checks, backend unit/MySQL integration tests/build, docs watcher tests/docs build and Unity static integrity. All reported test summaries had zero skips. This supersedes failed run `34300667096`; it is not a Unity rebuild or a browser/device test. A PR with required checks/CodeQL on its eventual merge head remains a separate gate. |
| S10 | Fixed controls; limited scan coverage | Main ruleset requires PR/thread resolution, strict Web/Unity checks and CodeQL errors/high-or-higher protection, with no bypass actors. Zero open code/secret-scanning alerts were observed; main CodeQL evidence covers `2bffc0db`, not this branch. Push protection is enabled; non-provider patterns and validity checks are disabled. Zero alerts is not proof that no secret exists. |
| S11 | Deferred; local maintenance | Active backend install still has `qs` 6.15.3 versus locked 6.16.0. Isolated locked tests already passed. Refresh only during a deliberate development-stack stop; do not use the stale install as release evidence or modify running dependencies silently. |
| S12 | Fixed; deployment-only dependency patch | `3ea379fe` updates exactly four lock entries: `js-yaml` 4.3.2, `hono` 4.13.7, `morgan` 1.12.0 and Firebase-scoped `csv-parse` 7.0.2. Firebase stays 15.28.1. Fresh locked install, full production dependency-tree validation, CLI version check, eight offline CSV tests and twelve smoke-tool tests pass. Audit now has zero high/critical and only the two previously accepted stream-json/parent moderate entries. No unrelated finding was waived or threshold lowered. |
| R1 | Fixed; certified and published | Package `97daf31c…c098` contains the canvas-scroll bridge: certified build `5473694d…4ba7`, source `346491b4`, 1004-file provenance, Unity6000.3.8f1. Guarded build/settings restoration and packaged hash/provenance validation passed; Firebase verified preview startup and live payload delivery. Earlier game/device checks are carried forward. |
| R2 | Fixed; owner phone acceptance | After opening the release-candidate mobile preview for the requested fresh-load/landscape touch check, the owner reported about 10 seconds to load and confirmed Fire/fullscreen-exit buttons behave properly. This closes the combined observation. The timing is owner-observed local Safari delivery, not an instrumented cache-miss measurement or production CDN benchmark; the exact 640x360 geometry remains covered by the earlier layout fixture. No repeat login/submission or exhaustive clip-listening pass is required. |
| R3 | Fixed; accepted owner checks | Keep closed: owner-confirmed published-site login/submission; Android/iPhone normal routes and recorded defeat/retry/menu checks; touch controls; mute persistence; automatic/combined pause; complete outcome-centering audit; accepted fullscreen-button placement and Safari toolbar limitation; recovered desktop FPS incident. Carry acceptance forward unless relevant code/origin/configuration changes or a concrete regression invalidate it. A brief post-publication smoke check is not a new pre-release authentication campaign. |
| R4 | Fixed; published | Latest game release PR #328 / `b6888bc2` published through Firebase run `34481007522` after the compatible backend was serving. Preview/live WebGL payload checks, preview startup, promotion verification and temporary preview deletion passed. Public p4-Vega canvas/help/score delivery passed in fresh signed-out Chromium. This is not a new physical Safari timing or authenticated-persistence test. |
| M1 | Fixed; named scope | Named temporary-artifact cleanup and the 57-script bounded audit are complete. Recycled copies remain recoverable; intentional verification/recovery archives remain. Do not reopen an unlimited package/filesystem audit. |
| M2 | Deferred; explicit follow-ups | Exhaustive per-weapon/per-clip listening and game-feel coverage is optional follow-up absent a specific defect or relevant change; the bounded source review below found no missing weapon/audio reference. Shared-shell device checks (landscape nav/dropdowns with browser bars; Dancing Circles aspect/color) remain distinct from Three Bosses gameplay. Also retain the large-chunk warning, Unity CLI/Pipeline compatibility follow-up and unmeasured DB instrumentation overhead. p4-Vega polish and the incremental Clean Code sweep follow this release phase. |

## Local Three Bosses UI checkpoint — 2026-09-22

The UI Toolkit menu/pause/outcome changes remain on the active development
branch, not the published package. The final source correction is `148e38e0`;
its combined `ScreenUI` run passed 14/14 and the local WebGL build succeeded.
Local preview delivery fixes `0bc613e1` and `b0ff1efd` address truncated downloads
under forced-close and slow-consumer conditions; full throttled payload hashes
and 28 asset-server tests passed. These are development-server changes only.

The owner now confirms successful Safari loading and accepts the phone layout.
Reported temporary lag stopped without performance changes; no sustained-FPS
measurement or performance improvement is claimed. Do not repeat this layout
check or the previously accepted login/submission/gameplay checks without a
relevant regression. Production packaging/publication remains separately scoped.

## Exact dependency interpretation

The initial GitHub snapshot reported 14 default-branch alerts: nine high, five medium.
Alert #288 was added on September 8 for precisely xmldom 0.9.11; this branch
already has the patched 0.9.12. The opt-in serializer semantics are unchanged;
the patch is not a claim that arbitrary untrusted DOM serialization is safe.
[Primary advisory](https://github.com/advisories/GHSA-jxjr-3g7g-3944).

The sole remaining GitHub alert from that snapshot in the reviewed locks was #287,
[stream-json GHSA-528h-pc64-c93x](https://github.com/advisories/GHSA-528h-pc64-c93x).
The earlier npm audit's two moderate package entries (library plus parent) are
not two separate GitHub advisory alerts. Reassess on compatible upstream
remediation or changes involving imports, framework builds, untrusted JSON,
CLI/configuration/workflow scope, and no later than the exception's expiry.
The inspected Hosting scope/configuration has not changed since acceptance.

`stream-json` is Firebase CLI tooling for incremental JSON processing. Its
installed callers handle Auth-user JSON imports, Realtime Database imports and
Next.js framework dependency parsing. This project publishes static
`frontend/dist` files; those processing paths are outside the reviewed Hosting
workflow. The library is absent from the root/frontend/backend lockfiles but
remains a declared Firebase CLI dependency, so deleting its installed files is
not a supported remediation. [Library documentation](https://github.com/uhop/stream-json).

### Authorized CI checkpoint: 2026-09-09 01:49 UTC

[Run 34300667096](https://github.com/Good-Loops/mickeyf.com/actions/runs/34300667096)
checked `cd347db91edfc62541e793c824e0251407cc648d` using `pr-ci.yml`.
The failure was `npm --prefix .github/firebase-deploy audit --audit-level=high --omit=dev`,
not a production deployment or an application test failure. Unity static checks
passed; all web validation after the audit was skipped, including MySQL integration,
packaged WebGL validation, frontend/backend builds and documentation tests/builds.

The locked `js-yaml` 4.3.1 falls in the high-severity advisory's affected range;
4.3.2 is the patched v4 release. The advisory was added to GitHub's database on
September 8, so the preceding default-branch alert comparison did not establish
the latest audit result. [Primary advisory](https://github.com/advisories/GHSA-2883-xcg3-v3hh).
The additional moderate entries require their own review; the previously accepted
stream-json risk is not a blanket waiver. No dependency changes, audit-threshold
changes, forced fixes, local installs or production actions were made in this run.

### Scoped remediation: `3ea379fe`

The isolated `.github/firebase-deploy` install was refreshed using Node 22.23.2
and npm 11.6.2 with `npm ci --ignore-scripts --no-audit --no-fund`. No separate
temporary install copy was created; frontend/backend installs and servers were
not changed. YAML, Hono and Morgan patches stay within their parent ranges.
CSV's exact override is scoped to `firebase-tools@15.28.1`, not every consumer.
Firebase 15.29.0 still requests CSV v5; no patched v5/v6 release was available.
[CSV advisory](https://github.com/adaltas/node-csv/security/advisories/GHSA-8cw4-87c7-c6xx),
[Firebase caller](https://github.com/firebase/firebase-tools/blob/v15.28.1/src/commands/auth-import.ts#L63),
[CSV changelog](https://github.com/adaltas/node-csv/blob/master/packages/csv-parse/CHANGELOG.md).

The permanent `csv-parse-compat.test.mjs` resolves CSV from Firebase's actual
caller without executing `auth:import`. It covers default array-record streams,
UTF-8/chunk boundaries, LF/CRLF, quoting, empty fields, malformed-input errors
and duplicate-`__proto__` safety. Seven compatibility cases passed with old
CSV 5.6.0 while the security regression failed; all eight pass with 7.0.2.
Both PR CI and Hosting dependency validation now run these tests. They do not
authorize or claim a live auth import. Static Hosting scope, CLI pin, audit
threshold, timeout and existing stream-json disposition are unchanged.

Local commands passed: `node --test .github/firebase-deploy/csv-parse-compat.test.mjs`,
`npm --prefix .github/firebase-deploy run test:three-bosses-webgl-smoke`,
`npm --prefix .github/firebase-deploy ls --omit=dev --json`,
`npm --prefix .github/firebase-deploy audit --audit-level=high --omit=dev --json`,
and the Firebase CLI version check. Both edited workflows parse as YAML and
`git diff --check` passes. Existing upstream deprecation warnings for `json-ptr`,
`node-domexception` and `glob` remain separate maintenance notes; they are not
new findings in the passing audit or justification for a broad dependency update.

[CI run 34301221560](https://github.com/Good-Loops/mickeyf.com/actions/runs/34301221560)
completed successfully at 2026-09-09 01:59:52 UTC on
`3ea379fe1db4e3818e61b55ad828585d9e6f7f08`. Both `Web audit, test, and build` and
`Unity source integrity` passed. The frontend large-chunk warning remains;
the docs-watcher test uses Node's experimental MockTimers API. Neither warning
was suppressed or turned into additional unrelated work. Documentation-only
recording after this run does not claim a new tested SHA or require repeating
unchanged application checks merely to update this ledger.

## Embedded OpenSSL: no automatic carry-forward

The most recent historical exception covered image
`sha256:3bba5ca29a474c6b75d92f48f93a9efc6cfa3fe32d3a4ddb7b82f2a610baaa48`.
Current receipt image is
`sha256:9ec1bd83ea73a283ad36961b2dcd3022b9b0a40cbf16bd725398ff562015c3c3`.
Its Dockerfile/base pin is unchanged, but backend dependencies and code changed.
The refreshed component/reachability evidence for this exact image follows.
Do not interpret approval of migration/promotion or of this review as an
unrecorded security waiver.

The official release index still lists Node **22.23.2**, dated **2026-07-28**,
with embedded OpenSSL **3.5.7** as the latest published Node 22 release.
A normal Node 22 patch bump therefore does not yet provide OpenSSL 3.5.8.
[Node distribution index](https://nodejs.org/dist/index.json).
Alpine's separately patched shared libraries are not Node's embedded copy.
OpenSSL 3.5.8 security fixes remain relevant to this component review;
[official release notes](https://www.openssl-library.org/news/openssl-3.5-notes/index.html).
The old note calling Node PR #65542 open is historical; its closure alone does
not prove a new Node 22 release exists. Do not introduce an unreviewed custom
Node build or silently transfer the old exception.

### Exact receipt-image review: 2026-09-09 UTC

Read-only Cloud Run inspection reconfirmed generation/observed generation 132,
100% intended/observed traffic to the receipt revision and container HTTP port
8080. Global Cloud Build `12ec9e8e-ff4a-493c-be8c-025423e5110c` reports SUCCESS,
resolved Git revision `d1d5dbf6fcc1bedd596827a540779f437fe3501f` and the exact
receipt digest above. No revision, traffic, flag, grant or data was changed.

Both OCI manifest and configuration bodies were fetched through the existing
authenticated read-only registry access and independently SHA256-verified.
The current and prior images are Linux/amd64, declare Node 22.23.2, run as
`node`, and share the first four compressed layer digests byte-for-byte. Their
Node installation layer is
`sha256:efbef6f9e333972a10ca323e700496a64e7ddcc3a6725e6afbbae52e690f4a4a`
(the earlier roadmap abbreviated this digest incorrectly). Both exact sources
have Dockerfile blob `2b3c60894c2a73e701230482f3b722a72e017725`; later layers
differ. This establishes base-component identity, not a new deployed-binary
execution or a complete native-addon inventory.

Comparing prior source `e91d3b1177932614c22fbed059a42a05fcb10793` to the resolved
receipt source found no new runtime package among 103 non-dev lock records;
the only production version delta is `qs` 6.15.3 to 6.16.0. `fast-uri` changes
are dev-only. New run tickets use HMAC-SHA256/HS256; the API remains an Express
HTTP listener, and API/cleanup production database connections use a Cloud SQL
socket rather than application-configured TLS. JWT key normalization can call
`createPublicKey`, but key material is server-owned, not supplied by requests.
No caller for QUIC, DTLS, RPK, CMS, CMP or cipher/decipher APIs was identified
in the reviewed application paths. Those capabilities must not be described
as absent from the bundled OpenSSL binary.

| Reviewed family | Application prerequisite and current boundary |
| --- | --- |
| QUIC: CVE-2026-18798, -14456, -63075 | OpenSSL QUIC endpoints/connection processing; not identified in the HTTP API or cleanup path. |
| DTLS: CVE-2026-54874 | DTLS handshake records; no DTLS listener/caller identified. |
| RPK: CVE-2026-14457 | Explicit raw-public-key configuration without the corresponding certificate; no such configuration identified. |
| CMS: CVE-2026-63072 | CMS message decryption/key unwrapping; no CMS processing identified. |
| CMP: CVE-2026-63076, -63073, -63074 | CMP message protection/response/server-context handling; no CMP endpoint or message processing identified. |
| AEAD: CVE-2026-75803 | Affected direct one-shot `EVP_Cipher()` finalization. Reviewed Node wrappers use Update/Final; application uses HMAC/hash rather than cipher calls. |

Prerequisites: official [August 25 advisory](https://openssl-library.org/news/secadv/20260825.txt)
and [August 13 advisory](https://openssl-library.org/news/secadv/20260813.txt).
Pinned Node [cipher wrapper](https://github.com/nodejs/node/blob/v22.23.2/deps/ncrypto/ncrypto.cc)
and [HMAC implementation](https://github.com/nodejs/node/blob/v22.23.2/src/crypto/crypto_hmac.cc)
support the API distinction; it is not an upstream guarantee of non-exploitability.

CCM remains a separate caveat: Node supports it and requires exactly one
`update()` call. A synthetic probe on local Windows Node 22.23.2/OpenSSL 3.5.7
accepted an arbitrary CCM tag when Update was omitted and rejected it when an
empty Update was supplied. This is not a deployed-Linux-image test or proof of
CVE-2026-75803 exposure; no application cipher/decipher caller was identified.
Do not assume an OpenSSL-only patch fixes Node's skipped-finalization path.
[Node CCM contract](https://nodejs.org/download/release/v22.23.2/docs/api/crypto.html#ccm-mode).

**Owner-approved bounded exception:** on **2026-09-08 local (2026-09-09 UTC)**,
the owner explicitly approved retaining only receipt image
`sha256:9ec1bd83ea73a283ad36961b2dcd3022b9b0a40cbf16bd725398ff562015c3c3`
under an exception through **2026-10-07**, with earlier reassessment when
a patched supported Node release is available, this image/relevant code/runtime
dependencies/configuration change, or a relevant advisory/incident appears.
Introducing native addons, FFI, custom providers or affected cipher/protocol
features also invalidates the present scope. The conclusion is limited to
"no affected call chain identified in the examined application," not "OpenSSL
is fixed/unused". This is a new, exact-image risk acceptance, not a transfer of
an earlier exception. It does not authorize a replacement image, new deployment,
traffic changes or publication. Reassessment is required by expiry or an earlier
trigger; no unchanged source/component review is needed before then.

Non-secret OCI hashes, metadata and scope limitations are retained outside Git
in `release-checks-20260907/receipt-openssl-review-20260908.json`. No image layers
were pulled or executed; no production requests, secret payload reads, rebuild,
scan, deployment or complete image-wide native inventory were performed.

## Receipt-cleanup alert readback: 2026-09-09 02:12:46 UTC

Four read-only Monitoring API GETs used the existing Google Cloud login:
three exact policies and their single notification channel. No alpha CLI
component, browser repair, new permission or credential installation was needed.
[Policy GET](https://docs.cloud.google.com/monitoring/api/ref_v3/rest/v3/projects.alertPolicies/get)
and [channel GET](https://docs.cloud.google.com/monitoring/api/ref_v3/rest/v3/projects.notificationChannels/get).

All three policies are enabled, Error severity, OR combiner, and scoped to
project `noted-reef-387021`, region `us-central1`, resource `cloud_run_job` and
job `mickeyf-submission-receipt-cleanup`. Each uses only channel
`9138709485205441101`; the enabled email channel matches the approved recipient.

| Policy | Verified condition | Strategy |
| --- | --- | --- |
| `17739991777076766134` | Exact cleanup-component logs with severity >= ERROR, backlog=true or status=failed | Notification limit 300s; auto-close 1800s |
| `15588823733398199471` | Completed-execution metric, result=failed, five-minute summed series/reduction > 0; no retest delay; trigger count 1 | Auto-close 1800s |
| `3453175835959381685` | Completed-execution metric, result=succeeded, five-minute summed series/reduction < 1 for 7200s; missing data active; trigger count 1 | Auto-close 86400s |

An exact structural comparison of the selected configuration fields passed
for all three policies against `alerts-before.json` and `watchdog-enabled.json`
in the retained activation evidence. Object key order was ignored; arrays were
preserved. Documentation and creation/mutation metadata were not compared.
The absent failure threshold is its default zero; omitted validity/channel
verification fields are not interpreted as a fresh delivery guarantee.

Non-secret readback/comparison evidence is retained outside Git in
`release-checks-20260907/alerts-readback-20260908.json`. The recipient is recorded
only as a match boolean. No token was saved or printed. No incident was induced,
cleanup dispatched, resource modified, secret payload read or database queried.
Prior owner-confirmed failure emails remain the delivery evidence; no deliberate
two-hour outage or separate watchdog inbox test is claimed. S5 is closed; do not
repeat this check absent a relevant change or failure.

## Bounded Three Bosses preparation: 2026-09-08 local

The owner challenged repeated login/submission verification and approved focused
preparation without circular testing. Preserve the published-site confirmation
and existing backend receipt/retry acceptance. No authentication, session-cookie
or submission-bridge code changed in this preparation; no test score was created.

The short-16:9 concern was concrete: at 640x360 with zero insets and 10px rem,
Fire's padded hit rectangle intersected the 34px fullscreen exit by 27x6px,
even though the visible Fire artwork did not overlap. A host-only CSS rule now
reserves a symmetric exit-width/safe-inset gutter below 429px landscape height.
Both canvas dimensions use the same available width, preserving 16:9. The exit
button retains its size and screen-corner position; no Unity asset changed.

An isolated Chromium fixture using the real compiled before/after styles
reproduced that overlap, then measured a 560x315 canvas at (40,22.5) with no
intersection. At the previously accepted 852x393 size, canvas and exit bounds
were identical before/after. This intentionally trades a little game area for
separate controls on short 16:9 screens, not on already wider letterboxed phones.
The inspected screenshot is a labelled layout fixture, not a gameplay screenshot
or proof of native Safari touch behavior. All five focused style tests pass,
including the added regression which failed before the correction. No full
frontend/backend/Unity suite or build was rerun. The in-app browser connection
was unavailable; no tool repair, dependency install or server restart was made.
Evidence: `release-checks-20260907/three-bosses-short-landscape-20260908.json`
and its labelled PNG, outside Git.

One bounded source/asset pass found ten weapon definitions in the crate pool,
their projectile implementations, and the 21 expected nonempty audio files:
ten fire, nine impact, and Phase Anchor loop/end. Lightning's separate impact
clip is intentionally absent in its fire-only implementation. Controller and
Phase Anchor playback references resolve; no concrete missing reference was
identified. This does not certify that every clip was heard or subjective game
feel was reviewed. Keep the accepted Android full run/mute checks closed and
defer exhaustive listening rather than imposing another release prerequisite.

### Owner iPhone spot-check: 2026-09-08 local

The existing VS Code Front terminal was restarted with a process-only
`THREE_BOSSES_WEBGL_DIR` override pointing to the retained certified candidate
`webgl-candidate-8eaa6615`, and Vite exposed on the LAN. All four candidate
asset hashes matched the tracked release manifest; the proxied manifest
reported certified build `3477618b…aecca`, and the mobile-preview page
returned HTTP 200. Backend and Docs were left running; no source edits,
dependency installation, new preview helper or Unity rebuild was needed.

For the requested fresh Safari load and landscape Fire/fullscreen-exit check,
the owner reported: "About 10 seconds to load. The buttons behave properly."
This is accepted physical-device feedback, not automated touch evidence or
proof of a completely cold cache. It covers the candidate's local delivery
and current host layout, not production CDN timing/headers. R2 is closed;
public mobile remains disabled until separately approved. Existing gameplay,
authentication and score-submission acceptance remains closed.

## Publication closeout: 2026-09-09 local

[PR #322](https://github.com/Good-Loops/mickeyf.com/pull/322) passed web/Unity
checks in run `34305108785`, all four CodeQL language checks in `34305104505`,
and the documentation build. The release-only mobile gate passed 29 focused
availability/visibility tests and TypeScript before submission. No required
check or review-thread protection was bypassed. A short-lived release branch
allowed GitHub's automatic merged-branch cleanup without deleting the continuing
`feature/three-bosses-polish` branch, which was fast-forwarded and pushed to the
merged result. The local release branch was also removed after merge.

[Firebase run 34305326963](https://github.com/Good-Loops/mickeyf.com/actions/runs/34305326963)
successfully published main commit `c94c5de586af893e6257e32f6908b85cc0c2e4e0`.
Its preview startup, immutable package/header verification, enabled-submission
readback, live promotion and live runtime verification all passed. The temporary
Hosting preview was deleted; rollback was unnecessary. Existing Cloud Build
backend triggers were reconfirmed disabled before merge (four global, none
regional), preventing a separate backend deployment from this release.

The public manifest returned package
`2e660337df60df782451a5d00f85a0591d9a1ba595510da0d61ac382517a7fe7`.
A negotiated Wasm HEAD returned HTTP 200, `Content-Encoding: gzip`,
`Content-Type: application/wasm`, immutable caching and a compressed length of
13,874,087 bytes. The existing startup checker, with an iPhone-emulated context
in system Chromium, reached `running` at the public game URL without a preview
parameter. This covers the production mobile gate, not physical Safari behavior
or a new load-time benchmark. No new login, score, migration or cleanup run was
performed. Backend runtime/database state and the accepted S7/S8 exceptions
remain unchanged; local dependency refresh S11 and optional M2 follow-ups remain
explicitly deferred, not described as fixed.

## Next execution order and authority

Updated 2026-09-10: p4-Vega's approved feature batch is published through
PR #328 / `b6888bc2`; the exact release results are below. The owner reported good gameplay
on iPhone. Bottom-corner fullscreen joystick placement and fullscreen HUD
selection protection are recorded in Phase 15 of `PROJECT_PLAN.md`. The owner
accepted the rare intermittent Safari edge bands: **accepted, not fixed**. This
is not a reason to repeat the Safari investigation or earlier accepted tests.

The following release sequence is complete; it is not a fresh checklist to rerun.

1. Device closeout and release approval received 2026-09-10: the owner reported
   "Done. All good. Approved. Proceed." Carry forward completed keyboard/browser,
   iPhone and the remaining focused device/scrolling acceptance; do not restart a
   login/submission or exhaustive game checklist.
2. Released the backend-only 0–1000 policy first, keeping
   previous scores, ten-point increments, schema, authorization and runtime flags
   unchanged. A backend main push or zero-traffic candidate is not proof of
   production promotion: verify the exact serving revision before publishing the
   1000-point frontend. Do not merge the full feature branch first, because the
   Firebase workflow publishes relevant frontend changes from main automatically.
   Backend trigger state must be checked at release time; the older disabled
   trigger snapshot is not a fresh live-state claim.
3. After device closeout and the backend prerequisite, published the approved
   frontend batch through the existing release flow. Keep accepted Three Bosses
   gameplay/authentication checks closed absent a relevant regression.
4. Retain the dated S7/S8 reassessment boundaries and deferred maintenance list.
   No backend pipeline reactivation, dependency refresh, further deployment or
   unrelated cloud mutation is implied by this closeout. Phase16's bounded
   first-party inventory, leaderboard detail-loader extraction and shared
   Three Bosses request-policy extraction are recorded in
   `CLEAN_CODE_INVENTORY.md`. Frontend test discovery now uses a matching glob
   without removing coverage. Stale project-guidance cleanup is also complete;
   auth transport is now consistently service-owned with corrected session
   response typing, and stale startup checks cannot overwrite newer auth actions.
   The owner-requested signup auto-login and shared SweetAlert2 glass theme are
   also implemented: creation succeeds before login, and failed automatic login
   routes to manual login without repeating registration. TypeScript/all 200
   frontend tests, Vite build and mocked browser flow/responsive checks passed;
   physical iPhone dialog behavior remains unverified. No backend/cookie-policy
   changes or real account writes. These changes have not been deployed; continue
   bounded subsystem cleanup, not another production authentication audit.
   Subsequent game record alerts use the same theme: server-confirmed personal
   bests only, Three Bosses run-ID deduplication and fullscreen-aware placement.
   All 202 frontend tests and build passed; mocked browser notifications and
   lifecycle checks passed, not real account/score writes or device testing.
   Backend/Unity assets remain unchanged. Native-store/social-provider work is
   separately planned in Phase 17. The owner subsequently approved GitHub Actions
   for iOS: approved workflow-only PR #330 activated manual builds on `main`
   without publishing the pending website/authentication changes. Cloud run
   `34494943864` passed against development commit `aa832702`: all 202 frontend
   tests, Vite build, Capacitor/CocoaPods sync, unsigned Xcode simulator build
   and artifact upload. New celestial native artwork includes a real-alpha
   Android adaptive layer; exports and asset references were checked. Physical
   native appearance, Android compilation and native authentication remain
   unverified. No provider login, store upload or additional public website
   release was activated by that unsigned build.
   On 2026-09-10 the owner selected `com.mickeyf.app`; Capacitor, Android and
   iOS configurations were aligned and the explicit bundle ID was registered
   with Apple. Focused identifier/XML/Xcode-project checks passed, not a fresh
   native compile. After the original listing name was rejected, Apple accepted
   the owner-selected Ludolume: app `6810735137`, SKU `ludolume-ios`, status
   Prepare for Submission. The Developer identifier description is Ludolume;
   `com.mickeyf.app` remains unchanged. Registration did not itself upload or
   publish a binary; the subsequent signed checkpoint is recorded below.
   App Information categories Entertainment (primary) and Music (secondary)
   were saved and verified after reload on 2026-09-10. Fresh app/bundle API
   reads still return Ludolume; the previous description persists only in the
   observed App Store Connect selector. That cosmetic inconsistency does not
   change the registered identifier or authorize broader CI-key permissions.
   Distribution signing is now configured with owner approval (2026-09-10):
   certificate `Q4FS72TU6B` expires 2027-09-10; active `IOS_APP_STORE` profile
   `Z392C733U4` (UUID `e312aedc-9b44-4464-8ce9-0e0f0fb39c0a`) matches exactly
   `AX4Z7T24C9.com.mickeyf.app`. Existing Developer-key GETs retrieved both
   (HTTP 200) after browser downloads failed, without permission escalation.
   RSA-key/leaf matching, Apple WWDR G3 leaf signature, profile CMS signature,
   profile certificate and helper guards passed. The encrypted P12/password
   backup has restricted local access; `ios-testflight` stores the API key and
   three signing secrets, retaining its exact active-branch restriction and
   `Good-Loops` reviewer. Protected run
   [`34505852569`](https://github.com/Good-Loops/mickeyf.com/actions/runs/34505852569)
   passed on exact commit `cd59d311e8b866f77477f8867a6334544a89a066`, including
   signed archive/export, IPA metadata and leaf-certificate verification,
   TestFlight upload and credential/artifact cleanup. App Store Connect GET
   (HTTP 200) confirms Ludolume 1.0 build `4.1.0`
   (`2999535d-e87d-47e1-91cf-ce2bb4bbd4ea`): processing `VALID`, audience
   `INTERNAL_ONLY`, not expired. The owner personally submitted Apple's
   encryption declaration on 2026-09-10; the live App Store Connect UI now shows
   **Ready to Test**, replacing the initial `MISSING_EXPORT_COMPLIANCE` state.
   **Ludolume Internal** initially contained only build `4.1.0` and the existing Account
   Holder as its sole tester, with automatic distribution disabled. The owner
   installed TestFlight version 1.0/build `4.1.0` on the iPhone. Other tested
   functionality is reported working, but p4-Vega shows “The game could not
   load. Please refresh to try again.”; the cause was initially unknown. After the
   CORS rollout below, the owner confirms password login works, but fully closing
   and reopening the app initially lost the session. The owner subsequently
   confirmed login/logout and close/reopen persistence on build `6.1.0`.
   Signup, offline logout and expiry have not been separately device-verified.
   Native p4-Vega still fails on that build. Its demonstrated Pixi asset URL bug
   is corrected in uploaded build `7.1.0` (source `320997ce`), Apple-processed as
   `VALID` / `INTERNAL_ONLY`. Export answers are saved and the existing internal
   group has access (`IN_BETA_TESTING`); the owner confirms p4-Vega loads/plays.
   The follow-up native portrait HUD, outer-page scrolling and small-screen Home
   typography/quote fixes are uploaded in combined build `8.1.0` (source
   `57665ff1`); all 221 cloud tests, build, signing/upload and cleanup passed.
   Apple reports `VALID` / `INTERNAL_ONLY`; owner export answers are saved and
   existing internal group access is verified (`IN_BETA_TESTING`). The owner
   accepts those three fixes. Subsequent p4 frame/main-scroll, native fullscreen
   exit and navigation fixes are uploaded in `9.1.0` from `bd107c54`; forty focused
   tests, TypeScript/build and all 226 cloud tests pass, including signed upload
   and cleanup. Owner export answers are saved; existing internal-group access
   is verified (`IN_BETA_TESTING`). Native device acceptance remains.
   No roles, public
   testing, public store submission or website release were enabled.
   The exact `capacitor://localhost` backend allowance is now live;
   14 focused configuration/authorization tests and backend TypeScript passed.
   The owner approved this CORS-only deployment and renewed S8 only for a matching
   unchanged-runtime/base/dependency replacement through **2026-10-07**. The same
   earlier-review triggers remain: a patched supported Node release, relevant
   image/code/runtime dependency/configuration changes, native/FFI/provider/
   cipher/protocol expansion, or a relevant advisory/incident. This is temporary
   risk acceptance, not remediation or blanket approval for later images.
   Cloud Build `c25d3432-10dc-4f23-b795-87cfde6b9300` built source
   `a1f3ea4331ea28f7477a7addfd21d34ecd13d39e` as
   `sha256:90a9bca6bbd44f5b7d05c944a6443e3692538089a9e1aafdca8983c80b7646d1`.
   PR #332 merged as `ff9c79bedb1b3c8ca4e671ed8a9ac00739863f80`. Stage job
   `67dfa5dc-f380-404f-bf4c-bb872977e5e9`, promotion
   `8c7dba8f-7b8b-4fb8-92b1-a11cc54d277f` and tag cleanup
   `502741da-8d94-4375-afdd-c800e22d3264` all succeeded. Final generation138
   serves 100% on `mickeyf-org-ios-origin-a1f3ea43-0910` with no tags; runtime/
   configuration and rollback revision `mickeyf-org-p4-1000-6c5a8859-0910` are
   intact. All six live preflights and the unauthenticated session probe passed.
   The temporary branch/worktree were removed, leaving only `main` and the
   active branch. Native persistence is now owner-confirmed on build `6.1.0`;
   p4-Vega's portrait layout/scrolling corrections and signup still need device confirmation.
   See `frontend/ios/BUILDING.md` for the current narrow checkpoint.

Accepted operational limits remain: expired receipt IDs lose historical retry
recognition; failures/backlog can extend retention; expired receipts require a
separately reviewed backup restore; traffic etags/trigger checks are not a
distributed IAM lock. Use a controlled maintenance window for later mutations.

## p4-Vega release checkpoint: 2026-09-10

Backend-only PR #327 passed the required Web/Unity CI checks and CodeQL, then
merged as `7cfe7b5c7bd24e3362c7e2c089cde81999339d99`. Cloud Build
`397a07e2-d007-4306-be6c-9f60112a809e` built that exact resolved Git source using
the existing build service account and VERIFIED provenance. The resulting image
is `sha256:6c5a8859328daa79423b23ae8e248191f73e62db2a563e9e907cd5a92a366331`.
This is a built artifact, not a deployed candidate or traffic promotion. Live
service readback still showed generation 132 and 100% intended/observed traffic
to `mickeyf-org-scores-9ec1bd83-0908`; triggers and runtime settings were unchanged.

Artifact Registry reports automatic analysis `FINISHED_SUCCESS`, including OS,
NPM and SECRET, with no vulnerability metadata returned by the exact-image
`--show-package-vulnerability` read. This coverage does not certify the embedded
OpenSSL component; S8 still requires its separate disposition.

The scoped image review independently verified both OCI manifest/configuration
hashes and confirmed identical first four base layers, Dockerfile blob, Node
22.23.2 declaration, Linux/amd64 target and non-root user versus the live image.
The 103 runtime lock entries contain no added/removed package; version changes
are the previously merged express-rate-limit, ip-address, lru.min and mysql2
updates. Application-source changes versus the live source are the score-policy
extension and receipt-migration inspection safeguards, plus tests/documentation.
No new application cipher/protocol call was introduced by that diff. This is a
scoped source/component comparison, not execution of the image or a complete
native/transitive reachability audit.

The [official Node release index](https://nodejs.org/dist/index.json), checked
2026-09-10, still lists Node 22.23.2 with embedded OpenSSL 3.5.7 as the newest
Node 22 release. The owner explicitly approved the exact replacement-image S8
exception on 2026-09-10, replying "Yes" to the decision naming image
`6c5a8859…6331` and backend-first publication. This covers only
`sha256:6c5a8859328daa79423b23ae8e248191f73e62db2a563e9e907cd5a92a366331`
and the reviewed scope above, through **2026-10-07**, with the same earlier
reassessment triggers (patched supported Node release, relevant image/code/runtime
dependency/configuration changes, native/FFI/provider/cipher/protocol expansion,
or relevant advisory/incident). It is explicit risk acceptance, not remediation,
an assertion of no vulnerabilities, or blanket approval for subsequent images.

The guarded Unity release builder produced certified build `5473694d…4ba7` from
`346491b4`, with 1004-source-file provenance and restored project settings. The
packager replaced the stale checked-in release with `97daf31c…c098`, including
the previously accepted canvas-scroll bridge. Command
`node scripts/package-three-bosses-webgl-release.mjs --validate-packaged` passed;
this package is not yet published. The prior package remains recoverable in Git,
and the local WebGL server's separate output was not replaced.

Non-secret image/component evidence and temporary rollout preparation remain
outside Git in `C:/Users/User/.codex/tmp/p4-vega-rollout-20260910`. No real-account
login/score write, schema mutation, secret-value read, trigger activation or
production traffic change was performed in this release-preparation checkpoint.

## Completed deployment: 2026-09-10

- Stage job `89f1e424-ab53-46cd-a1f6-2c7ec6b1af3c` succeeded at generation133,
  with the candidate Ready and old production traffic unchanged.
- Promotion job `256b9571-c6a7-4183-9651-c8900fcf594d` applied the traffic-only
  change to generation134. Its final comparison failed because Cloud Run combined
  the untagged100% allocation and zero-percent tag in `trafficStatuses`. Independent
  readback verified equivalent revision allocations/tag mappings, exact image,
  complete service/runtime configuration and unchanged rollback revision. The
  promotion was not blindly repeated; this was a verification representation
  mismatch, not a failed traffic change.
- Job `5311d0af-2c9d-4356-8b08-51ea0b1674cd` removed only the temporary candidate
  tag and succeeded. Generation/observed generation135 is Ready with 100% intended
  and observed traffic on `mickeyf-org-p4-1000-6c5a8859-0910`; no candidate tag
  remains. Existing backend triggers stayed disabled. Secrets, runtime identity,
  enabled flags, Cloud SQL attachment, resource settings, grants and schema were
  not changed. Old revision `mickeyf-org-scores-9ec1bd83-0908` remains available;
  after frontend publication, restore the prior frontend before using it because
  its score policy rejects1000.
- Read-only staged/live catalog and p4 leaderboard requests passed the current
  DTO, CORS, no-store and no-cookie checks. No real/disposable account, login,
  score, database migration or cleanup dispatch was used for this release.
- PR #328 merged at `b6888bc2ebd58040b32398a7c2982daf2acfe746` after required
  CI/CodeQL passed. [Firebase run34481007522](https://github.com/Good-Loops/mickeyf.com/actions/runs/34481007522)
  succeeded: build, isolated preview, WebGL bytes/headers, preview startup,
  promotion/live WebGL verification and preview-channel deletion. One fresh public
  Chromium check at13:13:58UTC loaded p4-Vega's canvas, current How to Play card
  with1000-point completion and plain score counter, with zero page errors.
  Existing owner device acceptance remains the physical-device evidence.

Temporary executable transport/deployment/check helpers are removed at release
closeout; non-secret build/state/probe evidence remains outside Git. The obsolete
packaged WebGL release was replaced and is recoverable from Git. No open-ended
temporary-file sweep or repeat package-script audit was performed.

## Verification record

The initial reconciliation used read-only Git/GitHub state, manifest/source/history
comparisons, selected Cloud Run/trigger/secret-IAM/project-role reads and official
upstream metadata. Secret payloads were not read; only configuration metadata and secret
references were inspected. No fresh SQL query,
image build/scan, full transitive-IAM audit, npm audit, application test or
physical-device session is claimed for that initial checkpoint. The later CI
run's exact audit/static-check coverage and skipped steps are recorded above.
`git diff --check` covers the documentation
changes. Non-secret snapshots are retained outside Git in the existing Codex
`release-checks-20260907/release-gates-20260908.json` evidence file.
