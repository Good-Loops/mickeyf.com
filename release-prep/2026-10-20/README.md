# Ludolume public release plan — 2026-10-20

## Approved outcome

Release the **website, public Apple App Store app and public Google Play app**. The owner confirmed **free downloads on both stores**, initially available in **Brazil and the United States**. TestFlight/internal Play delivery are intermediate validation stages, not the final outcome. Store review and any required Play testing mean the three channels need not become public on the same day.

The owner reports the app now works on their iPhone. Carry that acceptance forward for the exercised app behavior. Do not turn a general success report into unreported provider revocation, deletion, Android or regional-policy acceptance. The default physical reference is iPhone 14 Pro / iOS 27.0.1.

Preparation started from `2fd2b831391288fabe57f910e0eb2420aa5a3a1e` on `feature/auth-family-leaderboards`, [draft PR #342](https://github.com/Good-Loops/mickeyf.com/pull/342). Hosted checks and CodeQL pass for that committed source. **Local changes prepared in this closeout are not covered by those earlier hosted results.** They require deliberate integration and fresh hosted checks before release.

## Child-audience release hold (latest owner decision)

The owner confirmed that Ludolume intentionally includes children under 13 and selected **finish parent-led child registration before public launch**. This supersedes the earlier website-first readiness recommendation. Guest games and animations remain available. Do not publish the new frontend, submit store review or enable the new parent path until its backend, schema, consent operations and end-to-end validation are qualified together.

The currently live backend still uses general registration without age/country screening and has new parent-account creation disabled. Holding this candidate does **not** disable that existing live signup. No production database, account-creation flag or traffic change has been made during this work.

The mixed-audience implementation must screen country/coarse age before new account credentials or sign-in SDKs, route parent-required users to verified parent consent, and request child nickname/password only after signed-form approval. An old general-audience backend must fail closed for this frontend. Brazil and US signed-form support requires a reviewed source/schema/config cutover; historical US-only schema and current D0 rollback are insufficient for the new nullable pending-form data.

[Child registration readiness](child-registration-readiness.md) records technical evidence, pending operations and the guarded deployment order. Existing owner iPhone acceptance predates this account-flow change; validate the new flow explicitly.

## Current channel status

| Channel | Current evidence | Remaining public-release work |
| --- | --- | --- |
| Website/backend | Live Hosting version `65e2e66f73a81522` serves frontend `454f8170`. Cloud Run generation 156 is healthy and serves the active D0 backend at 100% traffic, no tags. General signup and Google/Apple web/iOS configuration are already active. | Review the locally prepared verifier/notice changes, assemble a fresh exact-source backend/image/scan/rollback plan where needed, then publish the matching frontend after backend compatibility is established. Do not repeat the obsolete September session cutover. |
| Apple App Store | Existing record `6810735137`; latest internal 1.0 (28.1.0) Testing. Public draft still Prepare for Submission and selects old 10.1.0. | App Store eligible build, current draft association, listing/screenshots, privacy/content/age declarations, reviewer access and approved regional/free/manual-release settings; then review submission and eventual public release. |
| Google Play | **Draft app created with explicit owner authorization**, app ID `4974292717500321843`, `com.mickeyf.app`, en-US, App, Free. Dashboard confirms production access requires a closed test: **12 opted-in testers for at least 14 days**, currently 0 testers. | Upload-key/signing preparation, signed AAB, actual Play certificate/OAuth bindings, Android acceptance, listing/privacy/rating/access forms, required closed testing, production-access application and review. No build uploaded or test release published. |

Detailed evidence: [website](website-readiness.md), [iOS](ios-readiness.md), [Android](android-readiness.md), [verifier validation](verifier-validation.md). Listing copy is in [store-listings.json](store-listings.json). The English Apple version text/contact and manual release setting are saved in its public draft; other listing/setup work remains pending.

## Disposition ledger

| Item | Disposition | Boundary |
| --- | --- | --- |
| Tested iPhone mobile fixes | Accepted owner evidence | Preserve acceptance; exact installed build was not independently read from the device. Latest delivered internal build is 28.1.0. |
| RETIRED/latestReady deployment checks | Fixed locally; focused tests pass | Zero-traffic reconciliation permits only the exact captured serving pointer or new revision; settled traffic must point to the approved target. Regenerate saved plans. Cloud behavior was not exercised through a new deployment. |
| Android key-file ignore rules | Fixed locally | `.jks`/`.keystore` are ignored; actual keys still belong outside the repository in protected storage. No key generated or credential read. |
| Privacy and signed-form notices | Updated in candidate source | `privacy-2026-10-20.2` and `signed-parent-form-2026-10-20.1` describe the new gated BR/US parent path and post-approval child credentials. The notice digest changes; fresh policy/consent binding and operational review are required. Not published or a legal-sufficiency finding. |
| External deletion request instructions | Prepared in source | Public privacy deletion section provides browser/account and email request paths. Operational ownership-verification/deletion handling must be accepted before entering the URL in Play Console. |
| Existing finite Clean Code sweep/gameplay acceptance | Complete / retained | No new broad audit, gameplay rewrite or dependency sweep is part of closeout. |
| Worldwide availability / additional features | Deferred | Launch scope is BR/US. No additional countries or features are silently enabled. |
| Android distribution signing and providers | Pending required setup | Current old AAB is unsigned. Native Google/Apple opt-ins remain disabled until reviewed real configuration and device acceptance exist. |
| Store privacy/audience/content declarations | Pending review | Inventory data actually collected by app/SDK/server. Do not choose no-data, adults-only or a content rating to bypass requirements. General signup flags do not establish minor/audience legal classification. |
| Public binary/store asset qualification | Pending | Fresh eligible iOS and signed Android artifacts, actual screenshots and Play feature graphic must match final source and marketed behavior. |
| Google Play creation declarations | Completed with explicit action-time owner authorization | Policy/export declarations and Play App Signing terms accepted solely for creating the free draft app. App dashboard verified. No public release, paid subscription or new tester was created. |
| Public deployment/submission/publication | Not performed | This preparation does not merge, deploy, change traffic, submit review, publish stores, add testers or change repository visibility. |

## Execution order

1. Review the local changes and preserve the original 22 dirty documentation/generated files when selecting a commit. Run fresh hosted checks on the final exact source. Do not use `git add .` to absorb unrelated work.
2. **Play record creation completed.** The actual app dashboard confirms **12 opted-in closed testers for at least 14 days**, followed by a production-access application. It currently has 0 opted-in testers; the testing clock has not started. Complete app setup and a closed-testing release before starting that period. Account verification and internal testing do not replace this requirement. [Google's current requirements](https://support.google.com/googleplay/android-developer/answer/14151465).
3. Prepare a signed Android internal candidate and safe upload-key backup/recovery. Read the actual Play app-signing certificate set; configure matching OAuth clients and bounded server presenter pins before enabling Android providers. Rebuild with a new unused version code when configuration changes. Validate a Play-installed Android candidate; retain existing iPhone evidence.
4. Assemble/review any required provider-aware backend candidate, scanned image and compatible rollback using fresh current metadata/pins. Keep the six disabled Cloud Build triggers disabled. A provider rollback preserves private profiles, deletion and Apple maintenance; it is not an old legacy binary. Fresh traffic plans expire quickly and must be regenerated after verifier changes.
5. Establish backend readiness **before main merge**, because main merge triggers Firebase frontend publication. Use the guarded Hosting preview/live verification path and a short route/config/privacy/asset smoke check. Changes here must not silently broaden signup audience, countries, grants or Android provider flags.
6. Upload an App Store eligible iOS build through the existing protected `app-store-draft` workflow, capture its source/signing/cleanup evidence and replace the old draft build. Finalize the two store listings with [the prepared copy](store-listings.json), actual assets, truthful forms and working reviewer access. The Apple draft now selects manual release; it remains Prepare for Submission with old build 10.1.0. Reviewer username/password remain owner-pending.
7. Submit each ready store candidate for review, satisfy Play's actual testing/production gate, then publish under the approved channel-specific release plan. A publicly available website is not an App Store or Play release. Do not promise simultaneous approval or a fixed approval date.

## Created Google Play draft

Created in the existing Good-Loops personal account after explicit owner authorization to accept all three declarations and create the draft:

- Name **Ludolume**; package **com.mickeyf.app**; default language **English (United States)**.
- Type **App**, consistent with existing Apple Entertainment/Music categories; pricing **Free**, explicitly confirmed by owner.
- Initial distribution after record creation: **BR and US only**. The creation form itself does not set countries.
- The owner authorized accepting Developer Program Policies, Play App Signing Terms of Service and US export declarations. These were accepted before the single Create app action, and the resulting app dashboard was independently read back.
- Automatic protection is offered by the Console; its enabled default was not changed. Assess the delivered Play artifact and its sign-in behavior rather than assuming a locally installed unsigned artifact is equivalent.

App ID: `4974292717500321843`. [Open the created draft](https://play.google.com/console/u/0/developers/6318536584887330414/app/4974292717500321843/app-dashboard). [Dashboard evidence](play-draft.jpg) confirms the created app; [production-gate evidence](play-production-gate.jpg) records the closed-testing requirement. No signing key, OAuth credential, paid subscription, tester assignment or app release was created.

## Validation and limits

The verifier receipt records **221 passing tests**, zero failures/skips, and preserved negative drift/readiness tests. Independent review also passed all six targeted new integration/negative cases. Focused privacy rendering/consent tests passed **17/17**, and frontend TypeScript passed. The release-enabled production build passed to an isolated temporary output directory; Vite retained its existing mixed static/dynamic import warnings. Both listing localizations passed field-length checks, and all report-relative links resolved.

Unsigned native screenshot run [39520334734](https://github.com/Good-Loops/mickeyf.com/actions/runs/39520334734) was dispatched at `877b520d45518a6fca953d0ac02a0fe77f5131e2`; result and visual acceptance remain pending. No signed public candidate was uploaded or device-tested in this pass. Current hosted CI applies only to its reported source. Existing Android outputs and previous iPhone/CI observations retain their dates and scopes.

Safe final local review commands:

```powershell
git diff --check
git diff -- scripts/render-frozen-backend-deploy.preflight.py scripts/frozen-backend-traffic.mjs scripts/session-backend-rollback.mjs scripts/session-backend-traffic.mjs shared/privacyNotice.json frontend/ts/pages/Privacy.tsx .gitignore
gh pr checks 342 --repo Good-Loops/mickeyf.com
```

**Owner decision: keep the repository public for this release.** Live GitHub metadata confirms public visibility, zero forks and owner `Good-Loops` of type `User` (a personal account). Private Code Security's organization-plan and add-on costs are outside the current budget. Retain the existing public security checks; do not create an organization, transfer the repository, change visibility or purchase a GitHub subscription. Revisit only after monetization provides a budget. Ads/monetization are future work, not additions to this launch.
