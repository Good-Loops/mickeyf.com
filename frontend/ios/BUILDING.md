# Ludolume iOS cloud builds

## First stage: unsigned simulator compilation

`.github/workflows/ios-build.yml` is manual-only. It uses a standard GitHub-hosted
macOS 26 runner with Xcode 26.6, the existing CocoaPods project, and locked npm
dependencies. It builds the web assets, synchronizes Capacitor, then compiles the
shared `App` scheme with signing disabled. It does not deploy the website, change
the backend, contact Apple to publish, or use Apple credentials.

The workflow was activated on the repository's default branch (`main`) by
approved PR #330 on 2026-09-10. That PR contained only the workflow and signing
ignore rules. Merging the full development branch also carries its website/auth
changes and can trigger website deployment; that remains separate approval.

The workflow and future run titles use **Ludolume iOS build**. The name-only
PR #331 merged to `main` as `292c5a64`, and GitHub's API confirms the workflow
name. This did not merge the full development branch or deploy its changes.
Select **Run workflow** and choose the reviewed branch. The stable filename
also allows the equivalent command:

```sh
gh workflow run ios-build.yml --repo Good-Loops/mickeyf.com --ref <reviewed-branch>
```

The result is an unsigned simulator `.app` in a ZIP, retained for one day.
Xcode diagnostics are retained for one day on failure. This is **not an IPA**,
cannot be installed on a physical iPhone, and is not a TestFlight build.
Successful compilation is not proof of working WKWebView authentication,
microphone/audio permissions, packaged Unity assets, or native gameplay.

First cloud compile verified on 2026-09-10:
[run 34494943864](https://github.com/Good-Loops/mickeyf.com/actions/runs/34494943864),
development commit `aa83270262ce579826eab79bc85ee55f85139da9`. TypeScript and all
202 frontend tests, Vite build, Capacitor/CocoaPods synchronization, unsigned
Xcode simulator compilation, packaging and artifact upload passed. The uploaded
ZIP was 57,907,439 bytes and expires after one day. Windows still cannot run this
Xcode build locally, and no simulator/device runtime test is claimed.

The first compile predates the owner-approved bundle ID correction to
`com.mickeyf.app`. The correction was checked across Capacitor, both parsed
Xcode build configurations, Android's namespace/application ID, Java activity
path/package, XML resources and instrumented-test expectation. No fresh native
compile or device test was run just for this identifier change.

Non-failing upstream/tooling warnings were retained rather than patched inside
dependencies: Capacitor's Swift closure capture, the runner's Metal-toolchain
search path, optional App Intents metadata, CocoaPods script dependency analysis,
and the artifact action's Node runtime/deprecation notices. The build completed;
these are not evidence of native runtime correctness or a clean warning-free build.

Native artwork sources, generation prompts and export instructions are in
`../resources/README.md`. The iOS icon is opaque and the launch screen uses one
shared celestial image; its navy background avoids a white reveal. This is the
OS launch screen, not an added timed loading overlay.

## Signed TestFlight builds

The same manual workflow now has an `upload_testflight` boolean, defaulting to
`false`. The default remains the unsigned simulator job. Selecting `true` uses
the signed job only on `improvement/clean-code-sweep` and requires approval of
the `ios-testflight` environment. No push or pull-request event uploads a build.
The helper `scripts/ios-testflight.mjs` is dedicated to this job: it checks the
app/team/profile/certificate, assigns a unique build number, archives an iPhone
app, exports a signed IPA and uploads through Apple's tool. The explicit
`upload_distribution` choice defaults to `internal-only`. The owner-approved
`app-store-draft` choice removes only the internal-only export restriction so
the processed build can be attached to the draft App Store version. Uploading,
attaching a draft build, submitting for review and releasing are separate actions;
the workflow performs only the upload. Both choices retain the same protected
environment, app identity checks and signing safeguards.
It removes temporary signing material and signed outputs; neither is uploaded
as a public Actions artifact.

Signed build/upload verified on 2026-09-10:
[run 34505852569](https://github.com/Good-Loops/mickeyf.com/actions/runs/34505852569)
passed at exact commit `cd59d311e8b866f77477f8867a6334544a89a066`, including signed
archive/export, IPA metadata, deep signature and leaf-certificate verification,
Apple upload and credential/artifact cleanup. App Store Connect GET (HTTP 200)
confirms Ludolume version **1.0**, build **4.1.0**, ID
`2999535d-e87d-47e1-91cf-ce2bb4bbd4ea`: processing `VALID`, audience
`INTERNAL_ONLY`, not expired. The initial `MISSING_EXPORT_COMPLIANCE` state
cleared after the owner personally submitted Apple's encryption declaration
on 2026-09-10; the live App Store Connect UI now confirms **Ready to Test**.
The **Ludolume Internal** group (`c610a469-a86a-4e0f-9a8b-c83809230442`) initially showed
**1 Tester · 1 Build**, with the existing Account Holder as sole tester and only
build `4.1.0` assigned. Automatic distribution is disabled; future builds require
manual assignment. The owner installed TestFlight version 1.0/build `4.1.0`
on the iPhone. Other tested functionality was reported working, but p4-Vega showed
“The game could not load. Please refresh to try again.” After the CORS rollout
below, the owner confirmed password login worked, but fully closing and reopening
the app lost the session. Those initial failures are tracked in the current
native-device checkpoint below; build `6.1.0` subsequently passed persistence.
No roles or public testing were enabled.
The workflow did not answer the compliance questionnaire or make a public store
submission or website/backend release.

App Store Connect's placeholder icon was traced on 2026-09-10 to the draft
version having no eligible build selected. Builds `4.1.0` through `9.1.0` already
contained the correct cosmic-controller icon but were Internal Only, making
them unavailable for draft association. The opaque RGB 1024x1024 AppIcon asset
and target/resource configuration were valid and remain unchanged. The owner
approved a store-eligible upload and draft association, explicitly without App
Review submission or release. The workflow now exposes that eligibility as an
opt-in choice; internal-only remains the default.

The approved `app-store-draft` upload succeeded in
[run 34542319206](https://github.com/Good-Loops/mickeyf.com/actions/runs/34542319206)
at exact commit `39fcfd7452d867adff5957e2d64df263b9fd201d` (build `10.1.0`).
All 226 frontend tests and four signing-helper tests passed, including signed
upload and signing-material/output cleanup. Apple reports build
`75f00fc4-375c-4068-996b-09b4695f7872` as `VALID` and `APP_STORE_ELIGIBLE`.
After the owner signed back in, draft version `1.0` was associated with this
build and saved; the API confirms it remains `PREPARE_FOR_SUBMISSION`.
Returning to the Apps listing now displays the correct controller icon, verified
visually in Chrome. The owner's iPhone App Store Connect cache was not checked.
No App Review submission, release, or external tester assignment was performed.
The owner saved build `10.1.0`'s export-compliance declaration on 2026-09-10.
The API confirms `usesNonExemptEncryption: false`, `READY_FOR_BETA_TESTING`
internally and `READY_FOR_BETA_SUBMISSION` externally. The draft still references
this build and remains `PREPARE_FOR_SUBMISSION`; no tester assignment or review
submission was added as part of the compliance verification.
See Apple's [build selection](https://developer.apple.com/help/app-store-connect/manage-builds/choose-a-build-to-submit)
and [distribution methods](https://developer.apple.com/documentation/xcode/distributing-your-app-for-beta-testing-and-releases).

TestFlight's English (U.S.) beta description, feedback email, marketing URL and
review notes were saved and read back on 2026-09-10. Existing review contacts
were preserved. The owner confirmed there is no published privacy policy, so
that URL remains blank rather than pointing to an unrelated page. A dedicated
ordinary reviewer account was created and its browser login verified. TestFlight
now has sign-in required enabled and its dedicated credentials saved and read
back. The verification session was logged out; no scores or personal-account
data were added. Its password is also backed up with Windows DPAPI outside the
repository, restricted to the current Windows user and SYSTEM. Credentials
belong only in Apple's review fields and encrypted operator storage, never in
source control or public release notes.

The first protected run, `34504646121`, stopped at uploader preflight before
dependencies, signing credentials or uploads were used: `altool --help` did not
list `--bundle-id`. The helper now uses the already-verified IPA metadata instead
of duplicate bundle/version command-line overrides, and Apple's documented
`./private_keys/AuthKey_<key-id>.p8` lookup inside its owned temporary directory.
Preflight checks the flags from the actual upload command, not a separate list.
This was not a certificate rejection or an Apple upload failure.

Run `34505161671` passed archive/export and signature checks but stopped while
extracting the signing certificate: the optional `codesign --extract-certificates`
prefix was passed separately, making it another input path. The helper now uses
`--extract-certificates=<prefix>` and retains the leaf-certificate comparison.
Cleanup passed; that failed run attempted no upload. The successful run above
verified the correction and subsequent Apple upload.

The GitHub `ios-testflight` environment was created and read back on 2026-09-10:

- Only the branch `improvement/clean-code-sweep` is allowed (no tag rule).
- `Good-Loops` is a required reviewer. Self-review remains available because the
  owner also starts manual runs; otherwise a sole operator could not approve them.
  The owner should review the exact source commit in GitHub before approving a
  signing run. This is a release checkpoint, not two-person separation of duties.
- The Developer-role team API key is stored as `ASC_PRIVATE_KEY_P8`, with its
  non-secret identifiers in environment variables. The protected signed/upload
  path passed in run `34505852569`; configuring credentials alone does not start
  a build or publish.
- When rolling the active branch, explicitly update its exact branch policy;
  do not replace it with a broad wildcard to work around a blocked run.

Keep signing credentials in this environment, not repository-wide secrets:

| Secret | Purpose/status |
| --- | --- |
| `IOS_DISTRIBUTION_P12_BASE64` | Configured: encrypted distribution identity, including Apple G3 intermediate |
| `IOS_DISTRIBUTION_P12_PASSWORD` | Configured: randomly generated identity password |
| `IOS_PROVISION_PROFILE_BASE64` | Configured: active App Store profile for this app ID and certificate |
| `ASC_PRIVATE_KEY_P8` | Configured: App Store Connect API authentication key |

Distribution credentials created with owner approval on 2026-09-10:

- Certificate `Q4FS72TU6B`, Apple Distribution, team `AX4Z7T24C9`, expires
  2027-09-10. Its public key matches the encrypted local RSA private key and
  its signature verifies against Apple's G3 intermediate.
- Profile `Z392C733U4`, **Ludolume App Store 2026-09-10**, UUID
  `e312aedc-9b44-4464-8ce9-0e0f0fb39c0a`, expires 2027-09-10. Its CMS signature,
  exact application identifier, non-development entitlements and matching
  distribution certificate were checked before storage.
- Chrome blocked certificate downloads both manually and through browser
  automation. Apple's official certificate/profile GET endpoints returned
  HTTP 200 using the existing Developer-role API key; no roles or browser
  security settings were changed to retrieve them.
- The three signing secret names were read back from `ios-testflight` after
  storage. Values are not readable through GitHub; macOS import and signing were
  subsequently verified by the successful protected run.
- The local backup is under `%LOCALAPPDATA%/Ludolume/Apple/Distribution-20260910`,
  restricted to this Windows user and SYSTEM. Both the RSA key and P12 are
  encrypted; the password is DPAPI-protected for the same user and computer.
  Do not commit this folder or treat it as portable recovery storage.

Team ID, API key ID, issuer ID and the numeric App Store Connect app ID are
non-secret identifiers to confirm from Apple. Generate the temporary runner
keychain password per job; never expose keys through logs or public artifacts.
Apple Developer registration was verified on 2026-09-10: explicit bundle ID
`com.mickeyf.app`, description `Ludolume`, team `AX4Z7T24C9`. No optional
capabilities were enabled. After the original listing name was rejected, Apple
accepted the owner-selected name Ludolume and created its App Store Connect record:

- Apple app ID: `6810735137`.
- Platform/language: iOS, English (U.S.).
- SKU: `ludolume-ios`.
- Categories: Entertainment (primary), Music (secondary), saved and verified
  after reloading App Information on 2026-09-10.
- Store status: Prepare for Submission; the internal TestFlight upload is not
  a public store review submission or release.

The on-device display name is Ludolume. Apple Developer's Identifiers list
confirmed the renamed description; App Store Connect's bundle selector still
showed the previous description after refresh. The underlying identifier is
unchanged. Google Play registration remains separate.

The owner's confirmed sequence is Apple distribution signing and a signed
TestFlight build for the iPhone, Google/Apple sign-in, then the Clean Code sweep.
Keep the pending iPhone acceptance milestone in scope; public store publication
still requires separate release approval.

API access verified 2026-09-10 after the owner accepted Apple's API-use agreement:

- Created the team key `Ludolume GitHub TestFlight` with the Developer role,
  not Admin. Team keys apply to all apps in the Apple account; their name does
  not restrict access to Ludolume alone.
- Stored `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_APP_ID`, `IOS_TEAM_ID`,
  `IOS_BUNDLE_ID` and `IOS_BUNDLE_RESOURCE_ID` as variables in `ios-testflight`.
  The bundle resource ID (`BFW2RJD725`) is distinct from the app ID (`6810735137`).
- Scoped, 120-second JWT GET requests returned HTTP 200 for the exact app and
  filtered bundle record. Both names were already Ludolume and the bundle was
  `com.mickeyf.app`. Node required `--use-system-ca` on this Windows host;
  certificate verification was not disabled.
- An idempotent attempt to refresh the bundle description through PATCH returned
  HTTP 403 with this Developer key. No permission escalation was performed.
  Do not create an Admin CI key or recreate the app to fix the stale UI label.
- A Windows-DPAPI-encrypted local backup is under
  `%LOCALAPPDATA%/Ludolume/Apple/ASC-<key-id>.dpapi.xml`, restricted to the current
  Windows user and SYSTEM. Its decryption round trip was verified before the
  plaintext download was removed. This backup requires the same Windows user
  and computer; it is not a portable recovery file. Rotate the Apple key and
  replace the GitHub secret if access is lost or compromise is suspected.

Those initial API checks proved authentication and record reads. The successful
protected run now verifies runner key consumption, signed compilation and
TestFlight upload. The owner installed the app and confirms password login after
the CORS rollout. The owner also confirms session persistence on build `6.1.0`;
native p4-Vega remains unresolved on that build, and signup has not been rechecked.
Do not expose the P8 or minted JWTs in logs, source, artifacts or chat.

For subsequent signed uploads and device acceptance:

1. Use the existing Ludolume App Store Connect record (`6810735137`) and
   registered `com.mickeyf.app` bundle ID; do not create a duplicate record or
   change the identifier to refresh its displayed description.
2. Preserve the configured GitHub environment's approved release branch and
   manual review. Keep Apple credentials out of repository-wide build jobs and
   untrusted pull-request code.
3. Confirm the configured Apple Distribution identity (`.p12` plus password)
   and matching App Store provisioning profile are current. Reuse App Store Connect
   API key/issuer/key ID through protected secret storage. Never commit or paste
   private signing keys into chat. The ignore rules are only a safety net.
4. Review the exact source commit and approve the protected manual signing job.
   It uses unique build numbers and temporary-keychain cleanup. Uploading to
   TestFlight does not authorize public App Store submission or release.
5. Build `4.1.0`'s compliance, tester setup and iPhone installation are complete.
   Future declarations still require the owner's answers when Apple requests
   them. Login/persistence on `6.1.0` and p4-Vega loading on `7.1.0` are
   owner-confirmed, as are the three combined `8.1.0` layout corrections.
   Accept the subsequent native fullscreen/frame follow-up and confirm signup
   before accepting those paths. Installation does not prove
   gameplay or full authentication readiness.
   Preserve the PWA and Android tracks.

First native-device acceptance limits identified on 2026-09-10:

- The live production CORS policy now allows exactly `capacitor://localhost`.
  Its initial login preflight lacked `Access-Control-Allow-Origin`; the approved
  backend-only correction adds that exact iOS origin (not HTTP localhost,
  wildcard origins, or Android) and retains authentication checks. The owner
  approved its CORS-only deployment and renewed the temporary Node/OpenSSL
  exception through 2026-10-07 only for the matching unchanged-runtime/base/
  dependency replacement, with earlier-review conditions unchanged. Source
  `a1f3ea4331ea28f7477a7addfd21d34ecd13d39e` is deployed at generation138,
  revision `mickeyf-org-ios-origin-a1f3ea43-0910`, serving 100% with no tags and
  unchanged runtime/configuration. All six live preflights and the unauthenticated
  session probe passed; the prior p4 revision remains intact for rollback.
  See `RELEASE_READINESS.md` for exact build/rollout evidence and exception scope.
  The owner confirmed login after this rollout; persistence initially failed.
  The separate native correction below passed the owner's close/reopen check.
  Signup has not been rechecked; CORS permission alone is not session acceptance.
- Check Three Bosses' packaged asset URLs in WKWebView on the device; a custom
  scheme behaves differently from a normal website origin. Desktop URL parsing
  alone is not proof of a device failure or success.
- The follow-up session correction is owner-confirmed on TestFlight `1.0 (6.1.0)`:
  `LudolumeApiPlugin.swift` uses Foundation's persistent cookie storage for the
  exact production API origin/routes. Auth, p4-Vega scores and Three Bosses API
  calls share that transport on iOS; website/Android fetch remains unchanged.
  It rejects redirects, limits request/response sizes, and never returns cookies
  or response headers to JavaScript. Login now verifies its session before
  reporting success. Native POST ordering and local-first logout prevent an
  older login or an offline logout from silently restoring a session.
  Cookie/JWT expiry remains four hours; this is not indefinite remembered login.
  The native host is intentionally pinned and checked against both build jobs;
  changing API hosts requires reviewing that allowlist too. All 33 focused
  transport checks and frontend TypeScript passed. Unsigned iOS workflow
  [34512879625](https://github.com/Good-Loops/mickeyf.com/actions/runs/34512879625)
  passed the complete frontend tests/build and Swift simulator compilation on
  source `5b12b15aa7cc9a70d14dcc81f1c2ce6786b52aec`, without signing credentials.
  The owner-approved signed workflow
  [34513464675](https://github.com/Good-Loops/mickeyf.com/actions/runs/34513464675)
  uploaded version `1.0`, build `6.1.0`, from source
  `e5b22722f123a1222e993941843de28282846ee1`; signing and cleanup passed.
  Apple processed it as `VALID` / `INTERNAL_ONLY`. The owner saved the export
  answers on 2026-09-10; Apple's API confirms `usesNonExemptEncryption: false`.
  The build was added to the existing Ludolume Internal group, with readback
  confirming `IN_BETA_TESTING`. Previous builds and tester access were preserved;
  no public release was performed. The temporary release helper was removed.
  The owner reports the requested login -> full close/reopen -> logout -> full
  close/reopen check passed. Offline logout and four-hour expiry were not
  separately device-tested. The owner reports p4-Vega still fails on this build.

  Focused local commands from the repository root:
  ```sh
  node --experimental-strip-types --test frontend/ts/services/authApi.test.mjs frontend/ts/services/nativeApiFetch.test.mjs frontend/ts/services/leaderboardApi.test.mjs
  frontend/node_modules/.bin/tsc --noEmit -p frontend/tsconfig.json
  ```
- p4-Vega asset correction (2026-09-10): reproduced Pixi `8.20.1` converting
  `/assets/p4.png` under `capacitor://localhost/games/p4-Vega` into
  `capacitor://assets/p4.png`, losing the host and packaged `assets/` directory.
  All five sprite loads now use `new URL(source, document.baseURI).href` before
  Pixi resolves them. Its real resolver/loader passes five focused tests covering
  custom/HTTP(S) schemes, relative/absolute paths and inlined images; frontend
  TypeScript and the production build passed (existing large-chunk warning).
  Worker/renderer settings, gameplay and native authentication are unchanged.
  Owner-approved workflow
  [34526331701](https://github.com/Good-Loops/mickeyf.com/actions/runs/34526331701)
  uploaded version `1.0`, build `7.1.0`, from source
  `320997ce4cdfaf8ce1ebd4dffc7b058cbf7c24a5`. All 218 cloud tests, web build,
  native signing/upload and credential/output cleanup passed. Apple confirms
  build `11ad9ad6-5708-4b2b-b40b-0f797f61411e` is `VALID` / `INTERNAL_ONLY`,
  not expired, initially `MISSING_EXPORT_COMPLIANCE`. The owner saved the
  questionnaire; Apple confirms `usesNonExemptEncryption: false`. The build was
  added to the existing Ludolume Internal group, with readback confirming
  `IN_BETA_TESTING`; previous builds/testers were preserved. The temporary release
  helper was removed. The owner confirms p4-Vega now loads/plays on the iPhone
  in `7.1.0`. The follow-up portrait screenshot identified misplaced HUD controls
  and unwanted outer-page scrolling, addressed in the next local correction.
- Native portrait layout correction (2026-09-10): embedded p4-Vega score/pause
  offsets are now local canvas padding, not the device safe-area inset applied
  a second time. Fullscreen retains notch-safe offsets in all three modes.
  Bootstrap marks actual Capacitor apps before the first React frame; only that
  native shell uses a fixed viewport with non-scrolling outer document. Long
  content remains accessible in the main scroll area. Ordinary browsers keep
  their page scrolling and the Safari toolbar workaround is skipped in native.
  Thirty focused shell/fullscreen/Safari tests, TypeScript and the production
  build passed (existing chunk warning). Synthetic 393×852 iPhone safe-area
  checks confirm an 852px document, no outer scroll under wheel/scroll requests,
  and 8.5px HUD offsets; the Home quote is fully visible. Simulated 844×390
  landscape keeps the outer document fixed while longer p4/form content scrolls
  only inside main. CSS fullscreen fallback fills the viewport without clipping
  in both orientations and restores the fixed shell on exit. These are browser
  simulations, not WKWebView/device acceptance. No native configuration or
  authentication changes. The owner-approved combined build below includes it.
- Small-screen Home polish is required before public app release. The welcome
  uses 30–38px text and quotes use 14–16px wrapped normal-flow text, with a
  separate author and reserved space instead of random clipped positioning.
  All 61 quotes fit at 320×568 and 844×390 in local browser geometry checks;
  representative portrait, landscape and desktop screenshots were reviewed.
  TypeScript and the production build passed (existing chunk-size warning).
  This later change is not included in build `7.1.0`; the combined build below
  includes it. The owner confirms the small-screen quote correction in `8.1.0`.
- Combined layout upload (2026-09-10): owner-approved workflow
  [34531224341](https://github.com/Good-Loops/mickeyf.com/actions/runs/34531224341)
  uploaded version `1.0`, build `8.1.0`, from source
  `57665ff116284c15de9247637f660b08e1e5c0bb`. All 221 cloud tests, web build,
  signing/upload and credential/output cleanup passed. Apple confirms build
  `711a17df-82cf-456d-b402-72b8fd0401d3` is `VALID` / `INTERNAL_ONLY`, not expired,
  initially with `MISSING_EXPORT_COMPLIANCE`. The owner saved the questionnaire;
  Apple confirms `usesNonExemptEncryption: false`. Existing Ludolume Internal
  group assignment was verified, with readback `IN_BETA_TESTING`; previous builds
  and testers were preserved. The temporary release helper was removed. The
  owner accepts the three corrections; subsequent fullscreen/frame/inner-scroll
  defects were reported below. No public website/App Store release was performed.
- Native fullscreen/frame follow-up (2026-09-10): owner screenshots confirm
  WebKit's system close overlay and whole-web-view inset changes after native
  fullscreen exit. Installed iOS now uses existing CSS fullscreen instead of
  WebKit's separate presentation window; browser and Android native fullscreen
  selection are unchanged. This avoids the native presenter, not a promise to
  hide iOS status/home-indicator UI. Fullscreen clears the inline card's border,
  padding, shadow, blur and corner rounding; proportional 16:9 letterboxing remains.
  Native p4-Vega has a finite, responsive game layout with no main scroll area;
  portrait shares a row between settings and joystick, landscape uses columns.
  Its framed canvas keeps a 16:9 content box and explicit rounded clipping.
  Dropdowns/help retain their own overflow access. Ordinary web layouts and
  long native forms retain scrolling. A reproduced overlapping-fullscreen race
  could overwrite the original `inert` snapshot and disable navigation after
  exit; fallback isolation is now idempotent and tested. Forty focused tests,
  TypeScript and production build pass (existing chunk warning). Local touch
  simulation confirms Games navigation before/after fullscreen, unchanged
  portrait bounds on exit, round-corner styling and zero native fullscreen calls.
  Owner-approved follow-up upload
  [34539835666](https://github.com/Good-Loops/mickeyf.com/actions/runs/34539835666)
  completed from source `bd107c547c50da90e335d276332da1262962c2ad`, version `1.0`,
  build `9.1.0` (ID `575c1208-6849-41da-bc7f-923279477245`). All 226 cloud tests,
  web build, signing/upload and credential/output cleanup passed. Apple readback
  was initially `VALID` / `INTERNAL_ONLY` / `MISSING_EXPORT_COMPLIANCE`. The owner
  saved the questionnaire; Apple confirms `usesNonExemptEncryption: false`.
  Assignment to the existing Ludolume Internal group was added and verified,
  with readback `IN_BETA_TESTING`. The temporary API helper was removed; only the
  focused device check remains for these fixes.
  No public release, backend deployment or permission changes were performed.
- Check user-selected audio playback and interruption/resume. No first-party
  microphone capture was found; do not add a microphone permission without a use.
- If Apple reports Missing Compliance, the owner must confirm the encryption
  answers before the build becomes available to testers. No exemption declaration
  has been inferred or inserted into Info.plist by this workflow.

Standard runner compute is free for public repositories. Private repositories
use their plan's included allowance, then paid usage; storage has separate
allowances. The manual trigger, 30/35-minute simulator/signing timeouts, no dependency cache, and
one-day artifact retention limit incidental usage. They are not an account-wide
spending cap. Never buy larger runners or change billing limits implicitly.

References checked 2026-09-10:
[Capacitor requirements](https://capacitorjs.com/docs/getting-started/environment-setup),
[GitHub manual workflows](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow),
[GitHub Apple signing](https://docs.github.com/en/actions/how-tos/deploy/deploy-to-third-party-platforms/sign-xcode-applications),
[Apple API keys](https://developer.apple.com/help/app-store-connect/get-started/app-store-connect-api/),
[Apple API tokens](https://developer.apple.com/documentation/appstoreconnectapi/generating-tokens-for-api-requests),
[Windows encrypted credential exports](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.utility/import-clixml),
[runner pricing](https://docs.github.com/en/billing/reference/actions-runner-pricing).
