# Public App Store preparation — 2026-10-20

Scope: public Apple App Store distribution of Ludolume, in addition to the website and Google Play. Owner confirmed free downloads and initial Brazil/United States availability. This document records preparation, not a submitted or published release.

## Live App Store Connect observations

Read from the existing authenticated console on 2026-10-20. No store fields were saved, builds attached, review submissions made, testers added or agreements accepted.

| Area | Observed state | Required action |
| --- | --- | --- |
| Identity | Ludolume; Apple ID `6810735137`; bundle `com.mickeyf.app`; SKU `ludolume-ios`; primary language English (U.S.). | Preserve existing record and signing identity. |
| Latest internal build | Version 1.0 / build **28.1.0**, build ID `894faec2-d8f5-4dc6-b74f-047429e0bf54`, marked Internal / Testing in existing Ludolume Internal group. | Carry forward the owner's successful iPhone report for the exercised scope. Do not represent it as an Android test or unreported provider-revocation/deletion test. |
| Public version | Version 1.0, **Prepare for Submission**, still attached to **10.1.0**. | Upload an App Store eligible build from final reviewed source, then replace the obsolete draft association. The internal-only 28.1.0 export is not the public release candidate. |
| Product page | Description, promotional text, keywords, support URL, marketing URL and copyright appear empty. Subtitle empty. | Review and enter the accompanying listing draft. Keep reviewer credentials outside repository artifacts. |
| Screenshots | Selected iPhone Dynamic Island group shows **0/10 screenshots**, **0/3 previews**. | Capture actual final native UI in required supported device sizes; inspect iPad obligations because the project supports iPad. Optional previews/creative headers are not blockers by themselves. No screenshot assets were fabricated or uploaded. |
| Privacy | Privacy policy URL absent; privacy questionnaire still **Get Started**. | Review actual data inventory, enter reachable canonical policy URL and complete truthful app-level declarations. A general no-data-collected declaration would be inconsistent with server accounts and scores. |
| Classification | Entertainment primary, Music secondary. Age ratings **Set Up Age Ratings**; content rights **Set Up Content Rights Information**. | Retain current category intent unless reviewed otherwise. Complete actual content/audience questionnaires; do not invent a rating or classify adults-only to bypass obligations. |
| Release mode | **Automatically release this version** selected. | Recommend manual release to coordinate all channels. Review this setting before submitting; no setting was changed here. |
| Regional setup | Digital Services Act setup link visible; pricing/availability not inspected. | Set the approved free price and Brazil/US availability. Complete additional account/regional requirements only where applicable; worldwide availability is not authorized by this plan. |

The owner's phone reference remains iPhone 14 Pro / iOS 27.0.1. The general success report is accepted as supplied; the exact installed build was not independently read from the phone.

## Build preparation

The existing protected workflow supports `upload_distribution=app-store-draft`, retaining the `ios-testflight` environment and signing safeguards. This option removes only the internal-only export restriction. Upload, draft association, App Review submission and public release remain separate operations.

Proposed dispatch after the final source is committed, hosted checks pass and the existing protected signing approval is ready:

```powershell
gh workflow run ios-build.yml --repo Good-Loops/mickeyf.com --ref feature/auth-family-leaderboards -f compile_only=false -f resolve_native_locks=false -f upload_testflight=true -f upload_distribution=app-store-draft
```

**Not executed.** Immediately before dispatch, recheck that the branch points to the exact approved commit. Capture the run's actual `headSha`, build number, Apple processing state, signed entitlements and signing-material cleanup result. Branch names are mutable; this command alone is not an immutable source pin. Do not rebuild native dependency locks or expose signing values as part of routine release preparation.

Then attach the processed eligible build to version 1.0, verify encryption compliance on that build, provide working restricted-feature review access, and review the completed version before submission. The previously tested app binary and any later notice/content changes must be distinguished in the release evidence.

## Actual screenshot plan

Capture the final build's Home/Entertainment navigation, one clear scene from each available game, a music-reactive animation with a permitted local audio selection, and optional leaderboard/account views using non-sensitive test content. Use actual native captures or simulator captures from the final candidate; do not label browser fixtures as iPhone runtime evidence. No customer account details, credentials, personal music metadata or real private scores should appear in store assets.

## References

- [Current public version](https://appstoreconnect.apple.com/apps/6810735137/distribution/ios/version/inflight)
- [App privacy](https://appstoreconnect.apple.com/apps/6810735137/distribution/privacy)
- [Choose a build to submit](https://developer.apple.com/help/app-store-connect/manage-builds/choose-a-build-to-submit/)
- [Manage app privacy](https://developer.apple.com/help/app-store-connect/manage-app-information/manage-app-privacy/)
- Repository build contract: [`frontend/ios/BUILDING.md`](../../frontend/ios/BUILDING.md), [workflow](../../.github/workflows/ios-build.yml), [signing helper](../../scripts/ios-testflight.mjs).
