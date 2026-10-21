# iOS public build and native screenshot preparation — 2026-10-20

Supplement to `ios-readiness.md`. Owner direction is website publication first, then Apple public-submission preparation. Downloads are Free; initial store availability is Brazil and the United States. Existing categories remain Entertainment / Music. No App Store Connect writes, credential reads, signing dispatch, screenshot dispatch or review submission were performed by this preparation.

## Current evidence and the next eligible build

- Read-only GitHub run [39464042930](https://github.com/Good-Loops/mickeyf.com/actions/runs/39464042930), workflow run number 28 / attempt 1, succeeded at exact source `2fd2b831391288fabe57f910e0eb2420aa5a3a1e`. Its successful job is explicitly **Sign and upload (internal-only)**. This confirms the upload mode of build 28.1.0; it cannot be repurposed as the public App Store binary. Carry forward the owner's accepted iPhone behavior for the exercised scope.
- The existing workflow and signing helper already support `upload_distribution=app-store-draft`. This sets only `testFlightInternalTestingOnly=false` in export options (`scripts/ios-testflight.mjs:27–38`). The App Store distribution profile, exact app/team identity, Apple sign-in entitlement, deep signature verification and signing-material cleanup remain required.
- **Live protected-environment restriction:** read-only API inspection of `ios-testflight` shows custom branch policies and exactly one allowed branch, `feature/auth-family-leaderboards`. The helper/workflow also recognize `main`, but the actual environment does not currently allow it. Use the approved feature branch at the exact final source, or obtain a separately reviewed environment-policy change. No policy was changed here. The environment retains required reviewers with `prevent_self_review=false`.
- Unsigned compile-only run [39461774802](https://github.com/Good-Loops/mickeyf.com/actions/runs/39461774802), number 27, passed iOS simulator and Android compilation at the same `2fd2b831` source. It produced no artifacts and did not launch either app. It is compilation evidence, not native screenshot or iPad acceptance evidence.

After website publication and final source qualification, the protected signed dispatch is:

```powershell
gh workflow run ios-build.yml --repo Good-Loops/mickeyf.com --ref feature/auth-family-leaderboards -f compile_only=false -f resolve_native_locks=false -f upload_testflight=true -f upload_distribution=app-store-draft -f capture_store_screenshots=false
```

**Not executed.** First verify that the branch points to the exact reviewed source. Record the actual run `headSha`, resulting build number, Apple processing/eligibility, signed entitlement verification, encryption declaration and cleanup result. Workflow run numbers also advance for unsigned jobs, so do not predict the next build number. Upload does not attach a build, submit it for review or release it. Apple documents the distinction between [App Store Connect and internal-only distribution](https://developer.apple.com/tutorials/develop-in-swift/test-your-beta-app).

The prior signed job took approximately 22 minutes; the prior unsigned native compilation took about three minutes. Screenshot simulator boot/OCR adds runtime that remains unmeasured until the first capture run.

## Supported devices and assets

The Xcode project's Debug and Release configurations both have `TARGETED_DEVICE_FAMILY = "1,2"` (`frontend/ios/App/App.xcodeproj/project.pbxproj:385,405`). The minimum iOS version is 15.0. `Info.plist:69–82` supports iPhone portrait/landscape and all four iPad orientations. Therefore public assets must cover iPad as well as iPhone; do not remove a supported family merely to avoid screenshots.

Apple currently permits one to ten JPEG/PNG screenshots per group, without transparency. The capture helper targets an installed iPhone type with accepted 6.9-inch-group portrait dimensions (1320×2868, 1290×2796 or 1260×2736) and an installed 13-inch iPad type (2064×2752 or 2048×2732). It checks the actual captured pixel dimensions; it does not resize browser fixtures. Smaller groups may use Apple's scaling where the UI is equivalent. [Official screenshot specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications/).

The existing iOS AppIcon was inspected: `AppIcon-512@2x.png` is 1024×1024, RGB, fully opaque. Its universal iOS asset catalog entry is present. No native artwork or project change is needed solely for these technical checks.

## Implemented optional unsigned capture path

`capture_store_screenshots` is a new default-off input. With `upload_testflight=false` and `compile_only=false`, the existing unsigned simulator job:

1. Builds the actual Release simulator app with `CODE_SIGNING_ALLOWED=NO` and the existing pinned dependencies.
2. Discovers the installed CoreSimulator runtime/device inventory, selects compatible reviewed iPhone/iPad display types using their actual inventory identifiers, and creates two uniquely named owned simulators.
3. Boots each device, installs the compiled app, verifies its container, launches the exact bundle and captures real simulator frames with `simctl io screenshot`.
4. Uses a host-side Apple Vision OCR helper to recognize the rendered Home welcome text and navigation twice, at least three seconds apart. This rejects splash-only captures. OCR returns only readiness flags and geometry; recognized text is not logged or archived.
5. Exports the accepted actual frames as opaque JPEGs, rechecks Home readiness and dimensions, writes a source/device/runtime/hash manifest, and deletes only the exact owned simulator UUIDs after inventory/name/type/runtime verification.

The artifact is `ludolume-store-home-<run-id>-<attempt>` and contains only `iphone-home.jpg`, `ipad-home.jpg` and `manifest.json`, retained for three days. Screenshot mode suppresses the ordinary unsigned app ZIP and Xcode diagnostics artifacts. Probe PNGs and host OCR binaries stay in the ephemeral runner work directory and are not uploaded. No signing environment or signing job is used or modified.

The capture helper changes no app runtime code, routes, native dependencies or lockfiles. These initial assets show **guest Home only**. They do not establish gameplay, provider login, account deletion, physical-iPad behavior or signed-IPA equivalence. The manifest explicitly leaves visual review pending. Root should download and inspect both full-resolution images before uploading them to Apple; reject loading screens, clipping, broken quotes, wrong fonts or unsupported screenshots.

Proposed capture dispatch after integration and checks:

```powershell
gh workflow run ios-build.yml --repo Good-Loops/mickeyf.com --ref feature/auth-family-leaderboards -f compile_only=false -f resolve_native_locks=false -f upload_testflight=false -f capture_store_screenshots=true
```

**Not executed.** Keep capture and public signed upload on the same final reviewed commit. The unsigned job can also run on `main` because it does not use the protected signing environment. App Store Connect may accept these two initial Home assets, but richer screenshots of actual games/animations remain desirable before the public page is finalized; they are not fabricated by this job.

## Metadata preparation and owner facts

Reuse the prepared `store-listings.json`: en-US/pt-BR text, canonical privacy URL `https://mickeyf.com/privacy`, support URL `https://mickeyf.com/connect`, marketing URL `https://mickeyf.com/` and support email. `/connect` has a real mailto feedback flow (`frontend/ts/pages/Connect.tsx:7–8,38–50`). The Portuguese listing accurately says the app UI is English. Current in-app gallery labels are p4-Vega and Three Bosses.

Before final App Store submission, fill or verify copyright ownership, App Review contact details and a working authorized reviewer access path for restricted features. Keep review credentials out of the repository. Reuse previously supplied owner/contact facts instead of asking again. Content-rights answers must agree with actual provenance/licensing; age/privacy/export answers must describe the final shipped build. This preparation does not invent those attestations or reopen the broader audience policy. Free pricing and Brazil/US scope are already decided. Review manual release mode to coordinate the eventual launch.

## Validation boundary

Local Windows checks passed:

```powershell
node --check scripts/ios-store-screenshots.mjs
node --test scripts/ios-store-screenshots.test.mjs scripts/ios-testflight.test.mjs
git diff --check -- .github/workflows/ios-build.yml scripts/ios-testflight.test.mjs
```

At this checkpoint, **17 tests passed, zero failed/skipped**. They cover mode/input restrictions, contained paths, installed runtime/device selection, accepted geometry, exact simulator cleanup ownership, app launch identity and workflow artifact/signing boundaries. The Swift Vision helper and CoreSimulator commands cannot run on this Windows host. Their compilation/runtime behavior and actual screenshots remain pending the first authorized macOS run; no captures or public-ready binary are claimed yet.

## Execution update

The owner subsequently confirmed under-13 intended users and selected completion of parent-led registration before public launch. [Child registration readiness](child-registration-readiness.md) supersedes the earlier website-first execution order. English Apple version/contact metadata and manual release are saved; reviewer credentials remain owner-pending. No public submission or signed public candidate upload occurred.

Unsigned native run [39520334734](https://github.com/Good-Loops/mickeyf.com/actions/runs/39520334734) at `877b520d` compiled the simulator app and Swift readiness helper, but the initial simulator boot exceeded its 180-second budget. No screenshots were archived. CodeQL's environment-path findings in the helper were corrected by using only the exact reviewed hosted-Mac temporary layout and parsed numeric run identities; the fresh `c1815498` CodeQL aggregate and all five analyses passed. A bounded 360-second cold-boot retry [39521113272](https://github.com/Good-Loops/mickeyf.com/actions/runs/39521113272) at `7a739d2b` was dispatched unsigned. It compiled the unsigned simulator app, but capture stalled and was cancelled without archived screenshots. Do not claim screenshot readiness; a working native capture environment or genuine device assets remains required. These runs precede the child-flow changes and cannot qualify a final public binary.
