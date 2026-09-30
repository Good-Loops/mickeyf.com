# Release readiness and cumulative security ledger

Current dispositions refreshed 2026-09-30 against draft PR #341's reviewed source
at `118a2b8b` and the subsequent WebGL package/runtime-gate checkpoint below.
Hosted validation of that follow-up is pending; prior hosted results and CodeQL
source review remain dated evidence. The original reconciliation was 2026-09-08 local
(2026-09-09 UTC), against `015d962e`. This is the current gate summary;
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
| S2 | Fixed controls; current scoped live readback | September 30 readback confirms generation 146, 100% traffic to `mickeyf-org-localhost-dbb80d4f`, no tags, image `1ae9d489…82b1e19` and the dedicated runtime identity. `DB_PASS:1` and `SESSION_SECRET:2` remain Secret Manager references, without literal credential values. This supersedes the older serving-revision summary; prior IAM/grant and browser acceptance remains dated evidence, not newly repeated. |
| S3 | Fixed; source and live control checks | Backend build contexts exclude local environment/dependency/generated files; Docker remains pinned, multistage and non-root. All four existing global backend build/deploy triggers are disabled; none are configured in `us-central1`. Reviewed frozen deployment/traffic guards remain. Do not re-enable triggers or route traffic as part of verification. |
| S4 | Fixed; operational acceptance | Manual cleanup/retry acceptance, hourly activation and exact first natural execution `zjpfg` succeeded. One-off follow-up was deleted. Permanent bests remain independent of receipt deletion. No extra cleanup dispatch is needed. |
| S5 | Fixed; scoped live readback | At 2026-09-09 02:12:46 UTC, read-only Monitoring API requests verified all three enabled ERROR policies, their exact filters/conditions/alert strategies and sole approved channel against the activation snapshots. The email channel is enabled and its recipient matches the owner's choice. The API resolved the readback blocker without installations or permission changes; browser/CLI repair is not claimed. This is configuration evidence, not a new incident or email-delivery test. |
| S6 | Fixed; merged | PR #322 brought the reviewed dependency fixes into main. GitHub's post-merge push report lists only the previously accepted moderate alert #287. At the initial reconciliation, 13 of 14 alerts mapped to branch fixes: eight `fast-uri`, two `qs`, and three `xmldom`. This is distinct from the subsequent CI audit findings in S12. |
| S7 | Fixed on PR branch; deployment pending | Firebase 15.32.0 resolves the earlier Undici/ip-address/stream-json findings. C7 also updates `@grpc/grpc-js` to 1.14.5; the local and PR locked audits are zero. Earlier CSV/Hosting tests carry forward for unchanged paths. No deployment occurred; the historical exception is not renewed. |
| S8 | Blocked on official upstream patch; production-image gate verified | C7 retains official Node 22.23.3 and patched Alpine libcrypto3/libssl3 3.5.9-r0. Node still embeds OpenSSL 3.5.8. After a fresh official-index check, the owner chose to wait for a patched official binary and block deployment. Docker's final runtime stage now rejects embedded versions below 3.5.9 in the reviewed 3.5 series; an actual image build failed with that exact diagnostic. Build/test stages remain usable. This is a verified hold, not a vulnerability fix or risk acceptance. |
| S9 | Fixed; tested CI checkpoint | Authorized non-deploying run `34301221560` passed both jobs on `3ea379fe`: dependency validation/audits, frontend tests/build, WebGL package/tooling checks, backend unit/MySQL integration tests/build, docs watcher tests/docs build and Unity static integrity. All reported test summaries had zero skips. This supersedes failed run `34300667096`; it is not a Unity rebuild or a browser/device test. A PR with required checks/CodeQL on its eventual merge head remains a separate gate. |
| S10 | Historical controls retained; candidate scan dispositions verified | The earlier September 30 readback reported zero open secret-scanning alerts and CodeQL #20/#21 on main `ff9c79be`. PR #341's 32 new JavaScript/TypeScript findings and Python #20 were subsequently reviewed and dismissed as false positives with owner approval; zero open candidate CodeQL alerts remain. #21 remains open on main, with its fix confirmed on the PR. Earlier ruleset/permissions evidence remains dated. Zero secret alerts is not proof that no secret exists. |
| S11 | On-disk mismatch resolved; running-process state unverified | September 30 readback finds installed backend `qs` 6.16.0, matching the lock; the earlier 6.15.3 disk mismatch is superseded. C7 did not refresh or restart the active backend, so cached running modules are not certified. Backend validation used a clean locked build container with no SQL connection. |
| S12 | Fixed; deployment-only dependency patch | `3ea379fe` updates exactly four lock entries: `js-yaml` 4.3.2, `hono` 4.13.7, `morgan` 1.12.0 and Firebase-scoped `csv-parse` 7.0.2. Firebase stays 15.28.1. Fresh locked install, full production dependency-tree validation, CLI version check, eight offline CSV tests and twelve smoke-tool tests pass. Audit now has zero high/critical and only the two previously accepted stream-json/parent moderate entries. No unrelated finding was waived or threshold lowered. |
| S13 | Fixed locally; editor restart not performed | Firebase MCP now runs the local Firebase 15.32.0 CLI from `.github/firebase-deploy`, sharing its reviewed lock and overrides instead of an independent `npx` tree. The installed tooling tree was refreshed; offline selection still exposes exactly the three named read-only tools. No authenticated MCP server or user-data tool was invoked. |
| S14 | Resolved on candidate; main preflight fix awaits merge | CodeQL #21 is absent from the PR's Python analysis after restricting preflight to the literal `/workspace/frozen-pins.json`. Owner-authorized false-positive dismissal of #20 is verified: its traced diagnostic uses static pattern labels, not credential contents, with the existing sentinel regression. #21 was not dismissed and remains open on main. |
| S15 | Fixed in candidate locks; local runtime installs not broadly refreshed | Fresh audit findings prompted exactly six transitive version changes: brace-expansion 5.0.12 in root/frontend/backend, backend fast-uri 3.1.8 and ip-address 10.7.2, Firebase grpc-js 1.14.5. All four final lock audits and dependency graphs pass. Running development installations were not replaced; final backend build used the patched locked tree. |
| S16 | Fixed in candidate; hosted follow-up pending | Fresh guarded Unity build `9b96ad8e…3241a` replaces the stale package. Certification, hashes and 1046-file source provenance match committed Unity source `118a2b8b`; release validation and a release-enabled frontend build pass. Isolated Chrome smoke reaches running with a valid 1141x642 canvas. This resolves the mismatch from run `36761083045`; the updated PR still needs hosted validation. No gameplay/device replay or publication is claimed. |
| S17 | Closed as false positives; remote disposition verified | All 32 new JavaScript/TypeScript alerts (#22–#53; two critical, 30 high) were dismissed with owner approval and the specific reasons below. Readback verifies each reason/comment; the candidate has zero open CodeQL alerts and its CodeQL gate passes. No rules were excluded or thresholds changed. This disposition is tied to the reviewed source and trust boundaries, not a blanket security exception. |
| R1 | Fixed; certified and published | Package `97daf31c…c098` contains the canvas-scroll bridge: certified build `5473694d…4ba7`, source `346491b4`, 1004-file provenance, Unity6000.3.8f1. Guarded build/settings restoration and packaged hash/provenance validation passed; Firebase verified preview startup and live payload delivery. Earlier game/device checks are carried forward. |
| R2 | Fixed; owner phone acceptance | After opening the release-candidate mobile preview for the requested fresh-load/landscape touch check, the owner reported about 10 seconds to load and confirmed Fire/fullscreen-exit buttons behave properly. This closes the combined observation. The timing is owner-observed local Safari delivery, not an instrumented cache-miss measurement or production CDN benchmark; the exact 640x360 geometry remains covered by the earlier layout fixture. No repeat login/submission or exhaustive clip-listening pass is required. |
| R3 | Fixed; accepted owner checks | Keep closed: owner-confirmed published-site login/submission; Android/iPhone normal routes and recorded defeat/retry/menu checks; touch controls; mute persistence; automatic/combined pause; complete outcome-centering audit; accepted fullscreen-button placement and Safari toolbar limitation; recovered desktop FPS incident. Carry acceptance forward unless relevant code/origin/configuration changes or a concrete regression invalidate it. A brief post-publication smoke check is not a new pre-release authentication campaign. |
| R4 | Fixed; published | Latest game release PR #328 / `b6888bc2` published through Firebase run `34481007522` after the compatible backend was serving. Preview/live WebGL payload checks, preview startup, promotion verification and temporary preview deletion passed. Public p4-Vega canvas/help/score delivery passed in fresh signed-out Chromium. This is not a new physical Safari timing or authenticated-persistence test. |
| M1 | Fixed; named scope | Named temporary-artifact cleanup and the 57-script bounded audit are complete. Recycled copies remain recoverable; intentional verification/recovery archives remain. Do not reopen an unlimited package/filesystem audit. |
| M2 | Deferred; explicit follow-ups | Exhaustive per-weapon/per-clip listening and game-feel coverage is optional follow-up absent a specific defect or relevant change; the bounded source review below found no missing weapon/audio reference. Shared-shell device checks (landscape nav/dropdowns with browser bars; Dancing Circles aspect/color) remain distinct from Three Bosses gameplay. Also retain the large-chunk warning, Unity CLI/Pipeline compatibility follow-up and unmeasured DB instrumentation overhead. p4-Vega polish and the incremental Clean Code sweep follow this release phase. |

## C7 security reassessment — 2026-09-30

**Local remediation and aggregate checks are complete; C7 remains open.** The
remaining security blocker is S8's upstream runtime patch, with an owner-chosen
deployment hold enforced for new production images. S16's replacement package
passes local validation and startup; its hosted follow-up is pending.
S14/S17's candidate CodeQL dispositions are verified. The source review does not approve release, renew an exception or
activate providers. Exact commands and carried-forward evidence are in the
[C7 inventory checkpoint](CLEAN_CODE_INVENTORY.md#c7-candidate-and-security-review--2026-09-30).

### Runtime component boundary (S8)

The [official Node index](https://nodejs.org/dist/index.json) and
[22.23.3 release](https://nodejs.org/en/blog/release/v22.23.3) identify the newest
Node 22 patch with embedded OpenSSL 3.5.8. The official Alpine image index is
`sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402`.
C7 uses that exact image and explicitly installs Alpine's available
`libcrypto3=3.5.9-r0` and `libssl3=3.5.9-r0`. The local Linux base build and binary
probe verify both shared-library pins and Node 22.23.3 / embedded OpenSSL 3.5.8.
CI pins and the Firebase tooling engine contract now target 22.23.3 too; the
host's installed Node and active processes were not upgraded.

The [September 29 OpenSSL advisory](https://openssl-library.org/news/secadv/20260929.txt)
and [3.5 release notes](https://openssl-library.org/news/openssl-3.5-notes/index.html)
require a fresh assessment beyond the earlier 3.5.7 exception:

| Relevant 3.5 family | Candidate source assessment; not a non-exploitability claim |
| --- | --- |
| DTLS CVE-2026-84782 (high) | No DTLS endpoint/caller identified in authored backend source. |
| QUIC CVE-2026-35191 / -42772 | No OpenSSL QUIC endpoint/caller identified in authored backend source. |
| Certificate allocation CVE-2026-35189 | Outbound HTTPS exists in provider verification, Apple token work and the deletion journal. Fixed destination URLs reduce attacker control but do not prove an unaffected TLS certificate path. Remains unresolved in Node's embedded component. |
| Generic-curve timing CVE-2026-54872 | Inspected signing uses HMAC or Apple's ES256/P-256; no Brainpool/SM2 signing identified. |

OpenSSL 4.0-only CVE-2026-84783 does not apply to this 3.5 component. Apple token
storage uses AES-256-GCM with update/final, not the earlier CCM example. These
source observations supersede the historical pre-provider statement that the
application had no cipher/HTTPS paths. They do not certify the deployed image,
all transitive/native behavior, or the host's older embedded OpenSSL.

The follow-up official release-index check still found no patched Node 22
binary; newer official Node majors also did not provide OpenSSL 3.5.9. The
owner explicitly chose **keep the official runtime and block deployment until
its patch arrives**, instead of introducing a custom runtime build. No risk
exception was accepted. S8 stays blocked until the official tag/digest can be
updated and its actual embedded component verified.

The Docker `runtime` stage now fails before creating a deployable image unless
`process.versions.openssl` is at least 3.5.9 within the reviewed 3.5 series.
It has no build-argument bypass. The existing development/build stages remain
usable, and a different OpenSSL series requires review. A local
`docker build --target runtime --progress plain --tag mickeyf-c7-runtime-block-check:20260930 .`
failed as intended with `Production image blocked: embedded OpenSSL 3.5.8`;
the wrapper verified that exact cause. The three existing
`node --test scripts/cloudbuild-candidate.test.mjs` checks pass. No broad backend
test rerun was needed for this build-only gate.

No custom Node build, major-version migration, exception renewal, full image
scan or deployment was performed. The gate applies to newly built candidate
images; it does not modify existing images or the running service. The last
serving-image readback remains `1ae9d489…82b1e19`, not this local candidate;
its earlier exception is also due for advisory reassessment. Existing disabled
build/deploy triggers were not changed. Logs are in
`%TEMP%/mickeyf-c7-20260930/openssl-runtime-gate.log`.

### New dependency and scanning evidence (S7, S14, S15)

GitHub's scoped readback found 14 open default-branch dependency alerts (3 high,
8 medium, 3 low), all in the Firebase deployment lock. Their affected versions
are absent from the candidate. The subsequent npm audit additionally surfaced
[brace-expansion](https://github.com/advisories/GHSA-qhr7-859c-m2p7),
[fast-uri](https://github.com/advisories/GHSA-hrr3-gc8f-f4qj),
[ip-address](https://github.com/advisories/GHSA-j6r3-76f7-8jcv) and
[grpc-js](https://github.com/advisories/GHSA-m9gg-hp2v-232j) findings, which justified
refreshing the earlier audit. All four final candidate lock audits now report
zero findings; all four lock graphs validate. This does not close alerts on
main or attest to old running installations.

CodeQL reports #20 (Unity diagnostic logging) and #21 (preflight path) on main
`ff9c79bedb1b3c8ca4e671ed8a9ac00739863f80`. The preflight now uses a constant
file path and rejects alternate arguments before access. The logging finding
is confirmed as a false positive in the retrieved SARIF trace: analysis
`1820860201` starts at the literal `SECRET_PATTERNS` dictionary and follows its
static `label` into the diagnostic, not matched file contents. The expanded
regression verifies that both matched private-key content and four synthetic
settings values stay out of stderr. All seven checker tests pass. No query
suppression was added. After owner-authorized publication, draft
[PR #341](https://github.com/Good-Loops/mickeyf.com/pull/341) now points to
`118a2b8b9acce11a62bb2a797fae73a0d3d8d2ae`. Its CodeQL analyses completed:
Python retains #20 but no longer reports #21; JavaScript/TypeScript reports
32 new findings, reviewed below. The owner subsequently authorized dismissal
conditional on confidence that these were false positives. All 33 reviewed
dismissals (#20 and #22–#53) are verified, and the CodeQL gate now passes.
That approval does not accept S8 risk or authorize merge, deployment or database changes.

### PR #341 CodeQL disposition review (S14, S17)

Reviewed the exact SARIF from JavaScript/TypeScript analysis `1868993490`,
the candidate source, each reported path source and sink, and all 13 related
route locations in the CSRF results. A fresh read of open alerts on
`refs/pull/341/head` confirms #22–#53 plus existing #20, all at `118a2b8b`.
The disposition is **false positive** for these individual findings, with
the reasons below. The owner approved these specific dismissals after review;
all were recorded and verified. This is not acceptance of an exploitable risk
or a claim that the entire application is vulnerability-free.

| Alerts | Evidence and recorded disposition |
| --- | --- |
| #22 — critical request forgery | `appleRuntimeSecrets.ts` receives deployment environment configuration, not a request URL. Both secret versions pass the same anchored grammar: one of the two fixed project identifiers, a bounded alphanumeric/underscore/hyphen secret name and a positive numeric version. Dots, percent encoding, query/fragment delimiters, alternate schemes and hosts cannot pass. The request origin is the literal `https://secretmanager.googleapis.com`; redirects are errors. Responses must match the requested resource and CRC32C. The metadata endpoint is also a constant. **False positive:** the reported flow cannot choose an arbitrary host or traverse the resource path. |
| #23–#42 — 20 iOS path findings | Every SARIF source is `RUNNER_TEMP`, `GITHUB_RUN_ID` or `GITHUB_RUN_ATTEMPT`, supplied by the GitHub runner. `configuration()` requires macOS, GitHub Actions, manual dispatch and the exact approved branch; run identifiers are numeric and the base path absolute. Files use fixed child names, private exclusive writes and an owned per-run directory; cleanup checks direct-child containment, rejects a symlink root and verifies the run ownership marker before recursive removal. Profiles are written to the fixed Xcode profile directory with the numeric run suffix. **False positives within this CI trust boundary:** these are not HTTP, PR-title or dispatch-input paths. This helper must not be reused with untrusted environment/path inputs. |
| #43 — iOS summary path | The sink appends to GitHub's per-step `GITHUB_STEP_SUMMARY` file after the guarded manual upload flow. It does not accept a user-selected output path. **False positive** for the same runner-controlled environment boundary. |
| #44 — critical code injection | `dev-isolated.test.cjs` reads the fixed repository `backend/ts/app.ts`, extracts its bootstrap and evaluates it with synthetic environments and a restricted `require` stub. No request, environment string or external fixture becomes executable source. Anyone changing those bytes already controls executable code in the same checkout/test job. **False positive:** repository test execution, not an application code-injection entry point. The VM is not being treated as a sandbox for hostile code. |
| #45–#50 — missing CSRF middleware | One application cookie-parser mount and five test mounts share results from the same route graph. The actual cookie mutations enforce explicit, exact trusted Origin checks; JSON is additionally required for login, renewal, provider attempts, deletion and score mutations. Cookie-bearing requests cannot use the originless bearer exception. Provider attempts bind to the current cookie, origin, account, state and nonce. See the route review below. **False positives:** the query's recognized token/middleware models do not recognize these origin guards. No decorative token, middleware rename or query suppression was added. |
| #51 — insufficient password hash | The trace starts at `createPasswordlessSession()` and reaches SHA-256 of `session.sessionId` in a SQL test fixture. That ID is generated by `randomBytes(32)` and is the same identifier hashed by the production session repository; it is not a human password. **False positive:** the fixture deliberately locates a session row to exercise expiry. No database fixture was executed for this review. |
| #52 — insufficient password hash | The trace starts at `createPasswordlessFixture()` and reaches `createThreeBossesPayloadFingerprint()`. The hashed data consists of contract/game/rules versions, numeric user ID, run UUID and completion time. It is an idempotency fingerprint, not a password verifier. Actual password login uses bcrypt. **False positive;** changing the hash would unnecessarily change receipt compatibility. |
| #53 — weak cryptography | The flagged MD5 hashes synthetic journal JSON to emulate Google Cloud Storage's `md5Hash` metadata. It is an interoperability/corruption checksum, not password storage, encryption or a signature. The production journal uses authenticated HTTPS and bucket access controls; MD5 does not establish the writer's identity. **False positive in this fixture.** This does not claim MD5 is suitable for adversarial authenticity checks. |
| #20 — existing Python logging finding | Carry forward the prior exact SARIF review and seven passing checker tests: the source is the literal `SECRET_PATTERNS` label dictionary, not matched credential contents. The retained finding is now **dismissed as a false positive with owner approval**; no additional source change or test rerun was justified. |

The iOS trust boundary was also checked live, read-only: `ios-testflight`
requires reviewer `Good-Loops` and its custom deployment branch policy permits
only `improvement/clean-code-sweep`. Self-review is allowed; this is an owner
approval gate, not a two-person control. The workflow has no push/PR trigger,
loads signing secrets only in the explicit upload step and removes them from
child process environments. No workflow, upload or cleanup was dispatched.

CSRF route review:

- Password login and session renewal require a trusted Origin and JSON before
  persistence/cookie changes. Provider begin/complete require the same, reject
  bearer/unsigned/ambiguous cookie transport and enforce server-bound attempts.
- Logout checks the Origin before revoking or clearing cookies. Password deletion
  and both games' score/ticket mutations check authentication and Origin before
  persistence. The originless fallback requires an explicitly presented bearer
  credential and no signed session cookie; browsers cannot forge that bearer.
- Anonymous password signup creates an independent account and does not issue
  a session or act on the browser's current account. Leaderboard reads and auth
  verification do not mutate that account or its cookies. Disabled mutation
  routes return without persistence.
- Apple notifications authenticate Apple's signed payload, not browser cookies.
  Apple maintenance is mounted before cookie parsing and rejects Cookie/Origin
  headers, requiring a pinned workload identity. Both are included in CodeQL's
  related-route list despite these distinct authentication mechanisms.
- The extra `/api/users` route reported in `authRouter.security.test.ts` uses
  the same production controller with fake persistence on a loopback test server.
  The other test mounts use the same guards; they are not production listeners.

These conclusions depend on retaining the exact allowlist and control of its
origins, including the deliberately approved local frontend origin. CORS and
SameSite alone are not the claimed defense, and the native Origin is not app
attestation. New mutations or changes to cookie routing require a fresh review.

Primary references: [CodeQL SSRF guidance](https://codeql.github.com/codeql-query-help/javascript/js-request-forgery/),
the [CSRF query implementation](https://github.com/github/codeql/blob/main/javascript/ql/src/Security/CWE-352/MissingCsrfMiddleware.ql),
[OWASP origin verification](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html#using-standard-headers-to-verify-origin),
[GitHub runner variables](https://docs.github.com/en/actions/reference/workflows-and-actions/variables),
and [Cloud Storage checksums](https://docs.cloud.google.com/storage/docs/data-validation).

Verification in this follow-up was read-only source/SARIF/API inspection plus
`git diff --check` for these documentation changes. No executable code changed,
so the previously recorded 807 backend unit tests, the final 92 dependency-path
tests, seven Python checker tests and focused launcher evidence carry forward;
they were not rerun. Relevant existing cases include `appleRuntimeSecrets.test.ts`
(malformed resource/host/traversal and redirect rejection),
`providerAuthContext.test.ts`, `authRouter.security.test.ts`,
`mainController.security.test.ts` and `threeBossesRouter.security.test.ts`
(Origin/JSON rejection before persistence), and the bootstrap test cited in #44.
SQL integration fixtures, real provider authentication and macOS signing were
not executed. SARIF is retained outside Git in
`%TEMP%/mickeyf-c7-20260930/codeql-javascript-pr341.sarif`.

After confirming unchanged PR head `118a2b8b` and the same 33 findings, used
`gh api --method PATCH repos/Good-Loops/mickeyf.com/code-scanning/alerts/<number>`
with a JSON body for each approved alert: `state=dismissed`,
`dismissed_reason=false positive`, and a specific comment pointing to PR #341's
full review. A final alert-list readback verified all 33 states, reasons and
comments and zero open alerts at `refs/pull/341/head`. `gh pr checks 341`
confirms CodeQL check `110043829795` passes; no scan/test rerun was needed.
Separate readback confirms #21 remains open on main and was not dismissed.
Before/after responses and mutation receipts are outside Git in the same
temporary review directory. These documentation edits remain local until the
next substantive commit, avoiding an unnecessary docs-only CI run.

The runtime/package follow-up below supersedes this checkpoint's S16 blocker.
The draft remains blocked by S8's official upstream runtime patch. No OpenSSL
exception is implied by these false-positive dismissals.

### WebGL replacement and runtime hold follow-up (S8, S16)

The guarded release build used Unity 6000.3.8f1 and completed in 226403 ms.
Package `9b96ad8eb43e6dc10a6c47aa0b27647d38c860baf5fef949fd12a1cc3613241a`
has certified build ID
`a511d086b26e75061eb9ae89ae065f0b53d7c13ad3e92c45fa87533337bcf829`,
source commit `118a2b8b9acce11a62bb2a797fae73a0d3d8d2ae`, and 1046-file
Unity source digest
`fe4c964e1aa3f0d31e6ae76bbe4a18e7fbb9583c3c11072bdd286d8002c38539`.
The generated bytes replace the old candidate package; R1/R4 above still record
the separately published release. No tracked Unity source/settings changed.

An initial guarded attempt rejected old ignored `Assets/_Recovery` scenes.
The task-owned Editor moved the folder and its metadata intact to
`%TEMP%/mickeyf-c7-20260930/unity-recovery-backup` before rebuilding. The files
remain recoverable outside Assets. The completed build reported that absent
`RuntimePipelineConfig` disables development Pipeline in the Player; no runtime
Pipeline configuration was added. The task-owned Editor and preview server were
closed after verification.

Commands and results (Windows paths abbreviated):

- Set `THREE_BOSSES_WEBGL_DIR` to
  `%LOCALAPPDATA%/mickeyf.com/three-bosses-c7-release-20260930`; ran
  `npm run three-bosses:webgl:release:build`,
  `npm run three-bosses:webgl:package` and
  `npm run three-bosses:webgl:release:validate`: passed.
- Set `VITE_ENABLE_THREE_BOSSES_RELEASE=1` and
  `VITE_PROD_API_URL=http://127.0.0.1:4317`; ran
  `npm --prefix frontend run build -- --outDir <temp>/frontend-release-preview`:
  passed. Served that output with
  `npm --prefix frontend run preview -- --host 127.0.0.1 --port 4317 --strictPort --outDir <temp>/frontend-release-preview`.
- `node .github/firebase-deploy/smoke-three-bosses-webgl-preview.mjs --base-url http://127.0.0.1:4317 --chrome-executable "C:/Program Files/Google/Chrome/Application/chrome.exe" --artifacts <temp>/webgl-smoke`:
  passed, running canvas 1141x642. This is isolated Chrome startup, not a new
  gameplay/device or authenticated-submission acceptance run.
- S8's production-image rejection and three deployment-tool checks passed as
  described above. No custom Node binary or OpenSSL exception was introduced.

Build logs and preview output are outside Git under
`%TEMP%/mickeyf-c7-20260930`. The package and gate changes are ready for one hosted
PR validation; no merge, deployment, Cloud SQL change or provider activation is
part of this checkpoint.

### Carried-forward security boundaries

A bounded pattern scan of 484 changed text files since the sweep baseline found
no key/token payload match. Unity's full tracked-content checker also passes;
GitHub reports zero open secret-scanning alerts. These checks do not prove
absence of all secrets. Request error logging and provider/session source
boundaries were re-inspected; unchanged C3 auth, origin, nonce, cookie and
transaction evidence carries forward. Docker/Cloud Build context allowlists,
non-root runtime and frozen deployment approval/traffic guards remain intact.
Live readback confirms numeric secret references and four disabled global build
triggers, with none in `us-central1`. Existing IAM, monitoring, SQL, scheduler,
Unity and device acceptance remains dated evidence; no account or SQL tests were
repeated. Development continues to use Cloud SQL.

## Local Firebase tooling remediation — 2026-09-30

This initial checkpoint is retained as history; C7 above supersedes its audit
and separate-MCP disposition after the new grpc-js finding.

The Dot task "Review Ludolume continuation and security" updated only
`.github/firebase-deploy/package.json`, its lock and the Hosting workflow's
exact CLI-version guard for this repair. Firebase 15.32.0 declares compatible
streaming/CSV ranges itself; the old Firebase-15.28.1-specific CSV override was
removed. The lock resolves `stream-json` 3.7.0 and `stream-chain` 4.2.6 plus
patched transitive dependencies. Static Hosting scope, Node pins, disabled
install lifecycle scripts, audit threshold and deployment timeout are unchanged.

Dot validated an isolated candidate with Node 22.23.2/npm 11.6.2: locked install,
full production dependency-tree check, CLI version/help, **20/20 CSV/preview
tests**, **10/10 Hosting tests**, and audit reduction from **2 high + 5 moderate
package findings to zero**. Process-local `--use-system-ca` used Windows trust
without disabling TLS verification. On continuation, the three current files
matched the recorded tested hashes and the audit/test reports were read;
installation, audit and those tests were not repeated. Evidence remains outside
Git in `C:\Users\User\Documents\Codex\2026-09-30\task\firebase-tooling-review`.

These are local dependency results. They neither certify a deployed revision nor
close C7. The earlier S12 checkpoint below remains historical evidence; it does
not describe today's local Firebase version. Dot also identified upstream
Node/OpenSSL releases as S8 reassessment triggers. S8 still requires its separate
image/advisory review; no production readback, exception renewal, image upgrade
or rollout was performed in this continuation.

The [C4 UI/integrity closeout](CLEAN_CODE_INVENTORY.md#c4-ui-and-source-integrity-closeout--2026-09-30)
records the timer fix and correction of a hidden-file metadata false positive.
C1–C6 are complete at the source-review boundary; C7 remains open. The
[C5 native/provider checkpoint](CLEAN_CODE_INVENTORY.md#c5-native-shell-and-provider-readiness--2026-09-30)
made no application changes and does not enable Google/Apple sign-in. Both
providers remain explicit login/signup requirements for local and released
surfaces, with schema/grants, eligibility/deletion and platform activation open.
The [C6 tooling checkpoint](CLEAN_CODE_INVENTORY.md#c6-tooling-and-documentation-delta--2026-09-30)
corrects development-target documentation and adds existing launcher tests to
PR CI: 11/11 pass locally, with no Docker, SQL, cloud or application changes.
Hosted CI and the final cumulative security closeout have not been rerun.
Those initial September 30 checks preceded commit/push. The owner subsequently
authorized branch publication and a draft PR; hosted candidate checks are pending.

## C3 source availability findings — 2026-09-29

These local source dispositions supplement the dated release evidence above;
they do not change the serving backend or close the overall security review.
The [latest tooling checkpoint](CLEAN_CODE_INVENTORY.md#c3-migration-and-grant-tooling-closeout--2026-09-29)
completes C3 source review, superseding the earlier rows' pending C3 scope below.
The final C7 security/release closeout remains open after the September 30
C4–C6 source/tooling closeouts above.

The push of `005706cf` on 2026-09-29 reported **five default-branch vulnerabilities:
one high and four moderate**. This supersedes the earlier four-moderate notice
for notification tracking only. Alert identities and applicability to this branch
were not queried; reconcile them in C7 before carrying dependency evidence forward.
This notice grants no new exception and is not a fresh dependency audit.

| ID | Status | Evidence and remaining boundary |
| --- | --- | --- |
| C3-A1 | Fixed in source; not deployed | Provider signup/link/credential transaction controls now use ten-second query deadlines, discard uncertain begin/commit connections without another SQL command, and avoid retrying failed rollback. Three before-fix regressions reproduced missing deadline options/cleanup ordering; 104 focused tests, backend typecheck and temporary-output production build passed. MySQL integration fixture updated and typechecked only. See the [checkpoint](CLEAN_CODE_INVENTORY.md#c3-provider-account-transaction-boundaries--2026-09-29). |
| C3-A2 | Fixed in source for reviewed borrowed account/auth connections; not deployed | Deletion transaction controls now have ten-second deadlines and uncertain begin/commit discard directly. A guard at four acquisition boundaries destroys protocol-timeout sessions before helper error sanitization and prevents stalled cleanup SQL. The installed mysql2 client with a scripted loopback peer reproduced the stall and verified socket closure/pool replacement; 218 focused tests, TypeScript and temporary-output production build passed. No live SQL-engine integration, total request/pool-acquisition deadline or blanket direct `pool.query` coverage is claimed. Recovery/audit follow-up is recorded in C3-A3; C3 and final closeout remain open. See the [checkpoint](CLEAN_CODE_INVENTORY.md#c3-deletion-and-stalled-query-cleanup--2026-09-29). |
| C3-A3 | Fixed in source for replay/audit resource disposal; not deployed | Replay's remaining acquisitions and audit now reuse the tested connection guard to close timed-out sockets; audit deadline disposal also closes its socket. Uncertain replay begin/commit no longer attempts rollback. Three targeted cases failed before the fix; 25 affected-file tests, TypeScript and temporary-output production build passed. Existing maintenance watchdogs retained after source review. CLI-wide deadline semantics were not expanded; C3 configuration/tooling and final closeout remain open. See the [checkpoint](CLEAN_CODE_INVENTORY.md#c3-recovery-and-maintenance-resource-ownership--2026-09-29). |
| C3-A4 | Fixed in source for startup readiness disposal; not deployed | Account/session/provider readiness now borrows a guarded connection, closing the underlying socket after query failure or its existing deadline. Three strengthened cleanup cases failed before the fix; all 16 readiness cases have passing results, with one targeted rerun for a stale fixture expectation. TypeScript and temporary-output production build passed. Configuration/policies retained after source review; login/logout type declarations aligned with existing handlers. Migration/grant tooling and final closeout remain open. See the [checkpoint](CLEAN_CODE_INVENTORY.md#c3-configuration-validation-and-contracts--2026-09-29). |
| C3-A5 | Fixed in source for runtime-grant CLI lifetime; not deployed | Target-identity SQL now shares the operation watchdog; late identity responses cannot start grant work after timeout. Timeout forces socket closure even if driver teardown fails, and shutdown is capped at two seconds. Three scenarios reproduced the gaps before the fix; all 22 affected-file tests, TypeScript and temporary-output production build passed. Migration/configuration/grant-policy review is complete with no SQL or grant changes. Fixtures mocked database/cloud operations; no live execution or total CLI deadline claim. Apply timeouts retain indeterminate-outcome reporting. See the [checkpoint](CLEAN_CODE_INVENTORY.md#c3-migration-and-grant-tooling-closeout--2026-09-29). |

## Local Cloud SQL startup mismatch — 2026-09-29

**Fixed local startup; approved Cloud SQL schema/grant repair complete.** Initial
inspection found migration records only through 0008 and no session-table
grants; this branch requires 0011/0012. Following the approved read-only preflight,
the owner authorized migrations 0009–0012 and the additive session grant.
All four completed, all 12 recorded checksums match, and a fresh runtime connection
passes session readiness. Other runtime grants are unchanged. The temporary
maintenance user was deleted, confirmed absent and a fresh login denied.
The existing VS Code backend restarted and returned HTTP 200 from
`/api/leaderboards`. See the [review](backend/CLOUD_SQL_SESSION_MIGRATION_REVIEW.md)
for exact scope, commands and rollback boundaries. Migrations 0013–0018 remain
pending; provider flags, credentials and deployed revisions are unchanged.
Backup metadata and serving-source compatibility were checked; no restore,
rebuild, broad suite or login/logout/renewal smoke test was run. C7 remains open.

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

## Embedded OpenSSL: historical September 9 review

The C7 reassessment above supersedes the release-version and reachability
statements in this historical exact-image review. Its approval remains bounded.

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
