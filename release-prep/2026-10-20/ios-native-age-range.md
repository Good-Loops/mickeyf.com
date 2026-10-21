# iOS native age-range bridge — source preparation, 2026-10-20

Prepared against worktree base `6c3cab1d7e28f57dae0fb559eee7397e07f47514`. This receipt covers the iOS bridge and capability checks. It does not establish device behavior, regional age-assurance completeness, guardian consent, or release approval.

## Implemented source

- `frontend/ios/App/App/LudolumeAgePlugin.swift` registers the single promise method `LudolumeAge.requestAgeRange({})`. An explicit empty-options call is required; plugin loading does not request age information.
- iOS/iPadOS 26.0+ uses `AgeRangeService.shared.requestAgeRange(ageGates: 13, 16, 18, in: controller)`. The existing minimum deployment target remains **15.0**. Older systems return `unsupported`; there is no `canImport` branch that could conceal a missing SDK/framework during compilation.
- The request runs on the main actor, permits one active request, and requires a foreground scene and an unobstructed bridge controller. No presenter, a concurrent request, malformed options, an unknown response, or an error returns `unavailable`. Declined sharing returns `not-shared`.
- The exact result contains only `status`, `minimumAge`, and `maximumAge`. Non-shared results carry two JSON nulls. `verification-required` remains part of the shared cross-platform contract but is not inferred from an unrecognized Apple error.
- Shared responses retain regional overrides instead of requiring the requested 13/16/18 values. Per Apple's property discussion, a present upper bound is an **exclusive age gate**; it becomes the inclusive `maximumAge = upperBound - 1`. A missing lower bound remains null when there is a valid upper bound; a missing upper bound remains null when there is a valid lower bound. Both missing, inverted bounds, or normalized ages outside integer **0–150** return `unavailable` before arithmetic can overflow.
- The bridge reads only the two bounds. It does not retain or forward the declaration method, parental-control details, account identifiers, or a birth date; it adds no app logging, persistence, analytics, or network client.
- `App.entitlements` now requests Boolean `com.apple.developer.declared-age-range = true`; existing Sign in with Apple remains. The plugin is in the App target's Sources and is registered once by the existing bridge controller.
- `scripts/ios-testflight.mjs` requires Boolean true in the supplied distribution profile before archive/keychain installation, then in the embedded profile and exported app's signed entitlements before upload. False, absent, string, number, array, and object grants are rejected. Existing app/team/certificate/profile binding and upload controls are retained.
- `scripts/ios-age-linkage.mjs` checks actual `otool -l` output for every architecture: DeclaredAgeRange must appear exactly once as `LC_LOAD_WEAK_DYLIB` from the system framework path, and `LC_BUILD_VERSION.minos` must remain 15.0. Strong/missing/duplicate linkage, malformed inspection metadata, or a changed minimum OS stops the check. The unsigned workflow invokes it only for `compile_only=true`; the signed helper invokes the same check on the exported device executable before upload. It emits only a small linkage summary, creates no artifact/cache, and reads no credentials.

## API evidence checked on 2026-10-20

Apple's live DocC JSON was read to verify declarations and platform availability, because the HTML API pages expose a JavaScript shell to the text reader.

- [UIKit request signature and regional overrides](https://developer.apple.com/documentation/declaredagerange/agerangeservice/requestagerange(agegates:_:_:in:)-2go8c): three optional/required integer gates and a `UIViewController`, async/throwing; introduced in iOS/iPadOS 26.0. The three requested gates meet Apple's minimum two-year spacing.
- [Response sharing case](https://developer.apple.com/documentation/declaredagerange/agerangeservice/response/sharing(range:)) and [declined-sharing case](https://developer.apple.com/documentation/declaredagerange/agerangeservice/response/declinedsharing): both introduced in 26.0.
- [Lower-bound discussion](https://developer.apple.com/documentation/declaredagerange/agerangeservice/agerange/lowerbound) defines a present lower gate as met or exceeded and a missing lower gate as below the first threshold. [Upper-bound discussion](https://developer.apple.com/documentation/declaredagerange/agerangeservice/agerange/upperbound) defines a present upper gate as exceeding declared age. The upper property's short abstract calls it a maximum, and the broader guide contains an inconsistent `<18` example; this implementation follows the explicit property discussion. Native sandbox boundary qualification is still required, rather than treating the arithmetic as device-verified.
- [Entitlement documentation](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.declared-age-range) specifies a Boolean entitlement and the Declared Age Range target capability.
- [Apple age-assurance Q&A](https://developer.apple.com/support/age-assurance/) distinguishes the base 26.0 API from regional features available with 26.2+ and significant-update features in 26.4+. This bridge obtains a minimal age range; it does not implement all of those additional features.

## Back-deployment linkage evidence

An unconditional Swift import is not, by itself, proof of safe launch on iOS 15–25. [Xcode's build-phase documentation](https://developer.apple.com/documentation/xcode/customizing-the-build-phases-of-a-target) documents automatic linking of Apple frameworks for Swift. The [Swift compiler's availability/linkage implementation](https://github.com/swiftlang/swift/blob/fe8ce0ea73f442f28a6f33a71e37fe9108bfe4c1/lib/AST/Decl.cpp#L1719-L1815) derives linkage availability from annotations and compares it with the deployment target to determine weak imports. [Apple's linker implementation](https://github.com/apple-oss-distributions/ld64/blob/f60a74eaa2c99585de1dc0f2820e7a9f8aaf522c/src/ld/HeaderAndLoadCommands.hpp#L1517-L1535) emits an optional framework load command when all imports are weak or weak linkage is explicitly forced.

Together these support the expected automatic weak linkage for the API introduced in 26.0 when building for minimum 15.0. They do not prove the output of the pinned Xcode/SDK. The actual Mach-O check above is decisive for that build; no `-weak_framework` override was added without evidence that automatic linkage fails. If it fails, inspect the SDK declarations and linker command, then add the narrow explicit weak-framework setting and rerun. Even successful load-command inspection does not replace an actual older-OS launch test or prove every other dependency back-deploys.

## Local verification

From `frontend/`:

```powershell
node --experimental-strip-types --test ts/services/iosAgePlugin.test.mjs ts/services/nativeApiFetch.test.mjs ts/services/nativePresentation.test.mjs
```

**26 passed, 0 failed, 1 explicitly skipped** on Windows. The skipped test runs the actual extracted Swift normalization helper through `xcrun swift` on macOS, checking requested and regional boundaries, nulls, non-shared results, invalid bounds, and integer extremes. It does not emulate the Apple service. The passing Windows checks cover Xcode/plist registration, unchanged deployment targets, foreground/single-request guards, and the minimal source contract.

From the repository root:

```powershell
node --test scripts/ios-testflight.test.mjs
node --test scripts/ios-age-linkage.test.mjs scripts/ios-testflight.test.mjs scripts/ios-store-screenshots.test.mjs
git diff --check
```

**12 signing-tool tests passed, 0 failed; the combined linkage/signing/screenshot suite passed 24/24; diff check passed.** The signing tests use synthetic entitlement/profile objects and issue no signing commands or credential reads. Linkage fixtures exercise multiple architectures, strong/re-exported/missing/duplicate framework references, changed/missing OS minima, and malformed metadata. These parser tests are not an inspection of a built app.

## Remaining concrete qualification

1. Root must dispatch the existing `ios-build.yml` workflow at the eventual reviewed commit with `compile_only=true`, `upload_testflight=false`, `capture_store_screenshots=false`, and locked native dependencies. Its pinned Xcode 26.6 job runs the real Swift normalization test, an unsigned simulator build with `CODE_SIGNING_ALLOWED=NO`, then the actual Mach-O weak-link/minimum-OS check. No local macOS compiler was available and no dispatch occurred in this subtask.
2. Before a signed candidate, the owner must verify the App ID and replacement distribution profile authorize the new Declared Age Range entitlement. Adding the local entitlement does not update the Developer portal or a stored profile. No portal, profile, credential, or protected-environment value was read or changed here. The new validator will deliberately stop an incompatible signing attempt.
3. Use Apple's [age-assurance sandbox scenarios](https://developer.apple.com/documentation/storekit/testing-age-assurance-in-sandbox) on a real supported iPhone/iPad build to qualify below-13, 13–15, 16–17, adult, regional overrides, declined/unavailable, cancellation, and repeated requests. Verify that native age conflicts cannot reopen self-service through Back/reload/navigation or unlock third-party authentication. Those cross-layer controls are owned by the separate registration change and require their own tests.
4. An OS range is an input to protection decisions; it is not a signed guardian form, proof of guardianship, or evidence that the overall parent-registration/review process is complete. Keep unresolved significant-update/withdrawal and regional operational obligations explicit in the broader policy/readiness record.
