# Android / Google Play release readiness — 2026-10-20

## Live follow-up: draft created

After this initial read-only assessment, the owner explicitly authorized accepting all three creation declarations and creating the free Ludolume app. The parent task created app ID `4974292717500321843` with package `com.mickeyf.app`, App type, en-US default language and Free pricing. The resulting [app dashboard](https://play.google.com/console/u/0/developers/6318536584887330414/app/4974292717500321843/app-dashboard) confirms a **closed-testing release with at least 12 opted-in testers for at least 14 days** before applying for production; currently **0 testers** are opted in. This requirement is now verified for this actual app, rather than conditional. Initial BR/US store availability is approved but not yet configured. No bundle uploaded, tester added, closed test started or public release made. [Dashboard screenshot](play-draft.jpg).

The assessment below retains the evidence collected before that creation. References to an unsubmitted form or no app describe that earlier snapshot, not the current record.

Read-only assessment of `2fd2b831391288fabe57f910e0eb2420aa5a3a1e` on `feature/auth-family-leaderboards`. No build, workflow dispatch, credential operation, Console save, upload, test-track change or cloud mutation was performed for this assessment. Existing test outputs were inspected; they are not new test executions. Parent-task live Console readback shows Good-Loops is a **Personal** account with **Create your first app** and no existing app records. Owner reports account verification complete; do not repeat it. Account creation date and production access remain unverified.

Owner confirmed **Free on both stores**, with initial store availability limited to **Brazil and the United States**. Root's live Play Create app form is prepared as Ludolume / `com.mickeyf.app` / English (United States) / App / Free, but has not been submitted. The policy-compliance, Play App Signing terms and US export acknowledgments remain unchecked for the owner's review. Apple currently uses Entertainment as primary category and Music as secondary. These form preparations do not establish an app record, production access or publication.

## Recommendation and release gates

Create the Ludolume Play record, establish its production-access requirements, and prepare a signed Android App Bundle plus truthful listing/policy drafts. Use an internal Play install to validate Android behavior before closed/production distribution. iPhone acceptance does not establish Android acceptance.

| Area | Verified current evidence | Remaining work |
| --- | --- | --- |
| Package/version | `frontend/android/app/build.gradle:6–14`: `com.mickeyf.app`, version name `1.0`, version code `1`. | Confirm the first unused Play version code. Increment for each subsequent upload. Preserve the app identity. |
| SDK | `frontend/android/variables.gradle:2–4`: min 24, compile/target 36. | Target 36 meets the current new-app requirement; retain it in the final signed artifact. [Official target API requirements](https://support.google.com/googleplay/android-developer/answer/11926878?hl=en). |
| Distribution signing | `frontend/android/app/build.gradle:21–27` has no signing configuration; `.github/workflows/ios-build.yml:204–277` only tests/assembles without distribution. | Generate/protect a distinct upload key outside the repository, add an explicit release signing path and backup/recovery procedure, enroll in Play App Signing, produce and verify the signed AAB. No Play publishing workflow exists in the reviewed workflow set. A manual initial Console upload is the smallest path. |
| Existing artifact | `frontend/android/app/build/outputs/bundle/release/app-release.aab`: 62,025,682 bytes; modified `2026-10-17T18:26:07Z`; SHA256 `fc46c22ad4ef56980f94da92e25ab921a44848b8f8a3269d4d7f145196b68bad`. ZIP inspection found **zero signature blocks** and **zero `.so` libraries**. | This is an old unsigned artifact with no established binding to today's HEAD; do not upload it as the release candidate. |
| Existing checks | Release JVM XML dated Oct 17: **24 tests, zero failures/errors/skips**. Debug XML dated Oct 20: **30 tests, zero failures/errors**. Oct 17 release lint: **15 warnings, zero errors**. | Run the release checks on the final source and retain the source/hash receipt. Old lint warnings include icon configuration/duplicates, monochrome icon, unused resources, manifest order, dependency suggestions and SDK checks. Review warnings rather than suppressing them wholesale. |
| Google Android | `frontend/android/app/src/main/res/values/provider_identity.xml:3–4`: disabled, empty server audience. `scripts/provider-release-config.mjs:23–26`: empty reviewed Android certificate/OAuth presenter table. | Read the actual Play app-signing certificates, configure corresponding Android OAuth clients for `com.mickeyf.app`, add reviewed public certificate/client pins, configure the server audience/client IDs, then enable and test the Android capability. An upload/debug certificate is insufficient. |
| Apple Android | Same XML `:5–7`: disabled, empty Services ID/redirect. Implemented flow constants are in `LudolumeAppleAuthSession.java:5–9`. | If Apple is part of the promised Android experience, configure the exact existing Services ID/callback and enable only after Auth Tab/browser/server acceptance. Otherwise release metadata must accurately describe Android's available providers. Do not silently drop the feature. |
| Platform behavior | JVM tests cover API restrictions, session persistence, Apple handoff and presentation policy. Only template instrumentation coverage exists. | Test a signed Play-installed build: native login/signup, process restart, remembered/session-only state, logout/rejection, deletion, provider cancellation/background-resume, music file selection, touch/orientation/fullscreen/back navigation and both games. Retain existing accepted iPhone/web evidence. |
| Store assets | `frontend/android/app/src/main/ic_launcher-playstore.png` is **512×512, 32-bit RGBA, 552,647 bytes**. | Visually approve the icon. Prepare actual Android screenshots and a 1024×500 feature graphic; no dedicated final Play listing package was found in the bounded source search. |

Signing hygiene: root `.gitignore:19–23` protects Apple signing extensions but not `.jks`/`.keystore`; `frontend/android/.gitignore:57–59` leaves those examples commented. Add protection before generating any Android key, and still keep keys/passwords in protected storage outside the repository. Do not print, commit or pass password literals on command lines.

Google's current [Play App Signing instructions](https://support.google.com/googleplay/android-developer/answer/9842756?hl=en) describe automatic hybrid signing for new apps and multiple app-signing certificates. Record every certificate relevant to delivered Android versions and register the required API-provider fingerprints/OAuth clients. The existing source supports a bounded list of up to eight reviewed Android presenters; do not invent a single certificate/client mapping or substitute the upload certificate. Read the Console's actual certificate set before changing pins.

The inspected unsigned AAB contains no `.so` libraries. Android's [16 KB guidance](https://developer.android.com/guide/practices/page-sizes) states Java/Kotlin-only apps and dependencies already support 16 KB pages; final artifact inspection and a 16 KB emulator smoke test are still appropriate. Reassess if the final bundle gains native libraries. The current guidance also describes the February 1, 2027 update enforcement date; do not rely on an old deadline copied from previous notes.

## Play record, listing and content drafts

Create the record as **Ludolume**, preserving the reviewed package and prepared English (United States), App and Free selections. Set initial Play country availability to **Brazil and the United States**, as the owner confirmed; keep other store countries unselected. Review the category/tags against the actual product. Do not copy the October 6 staged signup matrix as if it were the current geographic store plan: `scripts/provider-release-general.json` now includes the October 17 general-audience policy. Store availability, registration eligibility and target-audience classification are separate decisions.

Draft English short description (under 80 characters):

> Games, music and interactive visuals in one playful space

Draft full description, subject to validation in the final Android build:

> Explore Ludolume's games and interactive visual experiences. Play p4-Vega and Three Bosses, or experiment with Dancing Circles and Dancing Fractals.
>
> Choose music from your device for local playback and visual analysis. You can explore without an account. An account lets you save eligible game results, with optional public leaderboard participation where available.
>
> Account and sign-in features vary by platform and availability. See the privacy notice for account, leaderboard and deletion choices.

Do not promise offline functionality, all-platform social login, age suitability or unlimited availability without matching build/runtime evidence. These drafts are not saved to Play Console.

Required listing assets: approved 512×512 icon, 1024×500 opaque JPEG/PNG feature graphic, actual screenshots meeting Play's size/aspect rules, descriptions, category/tags and support contact. Play requires at least two screenshots to publish; for game promotion it recommends at least three 16:9 landscape or 9:16 portrait gameplay screenshots. Add alt text. A preview video is optional. [Official preview asset requirements](https://support.google.com/googleplay/android-developer/answer/9866151?hl=en).

Prepare these App content sections before closed/production distribution:

- **Privacy policy:** `https://mickeyf.com/privacy` is the source-owned canonical notice URL (`shared/privacyNotice.json:3`). Verify public reachability and final content against the released build.
- **App access:** reviewers need instructions and usable access to every restricted feature. Guest access alone does not cover account/provider/deletion flows. Prepare an authorized dedicated review account or a complete supported review path; do not invent credentials or require reviewers to contact the owner for every login.
- **Ads:** no ad/analytics SDK was found in the reviewed frontend/native dependency lists and bounded first-party source search. Confirm the final merged manifest/SDK inventory and actual behavior before answering the Console declaration.
- **Target audience and IARC content rating:** complete the actual questionnaire, including game violence, public nicknames/leaderboards and account/parent features. Do not choose adults-only simply to bypass child-related obligations. If children are in the intended audience, [Families requirements](https://support.google.com/googleplay/android-developer/answer/9893335?hl=en) apply. General-audience source flags do not settle classification or compliance.
- **Data safety:** inventory first-party and SDK/server processing, including WebView-controlled behavior. Source candidates include account nickname/IDs/email/provider identity, country/coarse age band, scores, session/security/connection logs and optional public leaderboard information (`shared/privacyNotice.json:23–63`). Determine exact form categories, purposes, optional/required status and sharing exemptions from the actual data flows; this report does not pre-fill them as definitive answers. Music selection/analysis stays on device according to the notice/source; do not declare music uploads without a real transmitting path. Closed, open and production tracks need the form; internal-only testing is exempt. [Official Data safety guidance](https://support.google.com/googleplay/android-developer/answer/10787469).
- **Account deletion:** `/account` and `/parent-accounts` are implemented routes (`frontend/ts/App.tsx:97–98`). Verify actual deletion before claiming it. Prepare a clear public deletion resource usable after uninstall, with a direct browser account-controls link and an explicit email request option. The current privacy section is a possible base but needs clearer initiation instructions before declaring it final. [Official account deletion requirement](https://support.google.com/googleplay/android-developer/answer/13327111?hl=en).

[Google's app review preparation guide](https://support.google.com/googleplay/android-developer/answer/9859455) covers these declarations and restricted-access instructions. Complete any additional Console-generated declarations that apply to the final artifact; do not assume the list is frozen.

### Deletion URL conclusion — source review, not a Google acceptance decision

The existing `https://mickeyf.com/privacy#privacy-deletion` anchor is correctly implemented: `Privacy.tsx:9–11` gives the deletion heading its matching ID. The page identifies Ludolume and has a clickable contact email (`Privacy.tsx:6–8`), but its deletion paragraph only mentions "account controls" in plain text (`shared/privacyNotice.json:41–43`); it has no direct controls link or deletion-specific email instruction. The general privacy-request paragraph is much farther down. Logged-out `/account` asks the user to log in, without public deletion instructions (`ManageAccount.tsx:148–149`).

Recommendation: prepare a small public `/delete-account` instructions page, or equivalently strengthen the existing anchored section. Link directly to browser `/account` and `/parent-accounts`; add a clearly labeled email option that initiates a Ludolume deletion request, explains proportionate ownership verification, warns against sending passwords/sign-in codes, and describes scope plus any actual retained-data exceptions. Do not invent a new retention period or completion SLA. This reuses the current deletion service rather than adding another backend flow.

A dedicated route is our clarity recommendation, **not** a Google requirement. Google permits a prominent privacy-policy section and initiation through customer-service email, a form or another direct deletion path. Therefore the smallest adequate implementation can be the existing anchor plus explicit links/instructions. Validate that public page and browser deletion with the app uninstalled before saving the final Console deletion URL. No code changes were made during this assessment.

## Safest execution sequence

1. Create the app record and inspect the Personal account's production-access gate. If created after **November 13, 2023**, Google currently requires **12 testers opted into a closed test continuously for 14 days**, followed by an application for production access. Verification is a separate milestone. Do not claim that internal testing or an iPhone test satisfies this requirement. [Official testing requirements](https://support.google.com/googleplay/android-developer/answer/14151465).
2. Prepare signing protection/configuration and the upload-key recovery procedure. Produce the first signed internal AAB with a unique version code and exact source/hash receipt. Inspect package, SDK, permissions, assets, absence/presence of native libraries and signature before upload. Let the Console establish the actual Play app-signing certificate set.
3. Configure the matching public certificate/OAuth presenter mappings and chosen Android provider capabilities. Rebuild with a higher unused version code if necessary; do not reuse the first uploaded version code.
4. Install from Play's internal track and complete the focused Android/runtime/provider checks. Check the generated pre-launch report and Android Vitals; fix material failures. A sideloaded upload-key APK cannot prove OAuth behavior of a Play-signed installation.
5. Complete reviewed listing/assets/privacy/Data safety/app-access/IARC/audience/country/pricing forms. If required, start the closed-test clock only after app setup and recruit an authorized tester cohort; no messages or invitations were sent by this assessment.
6. Apply for production access when eligible, resolve review feedback, then submit the final reviewed release and verify its publication. Preserve backend/frontend compatibility and a profile-aware fallback throughout. Google review and any required testing period are external gates, so public availability cannot be promised today.

## Proposed verification commands — not executed here

From the repository root, on the configured JDK 21 / Android SDK 36 toolchain:

```powershell
npm --prefix frontend ci --no-audit
npm --prefix frontend test
$env:VITE_PROD_API_URL = 'https://mickeyf-org-j7yuum4tiq-uc.a.run.app'
$env:VITE_ENABLE_THREE_BOSSES_RELEASE = '1'
npm --prefix frontend run build
Push-Location frontend
try { npx --no-install cap sync android } finally { Pop-Location }
Push-Location frontend/android
try {
    .\gradlew.bat --no-daemon --console=plain :app:testReleaseUnitTest :app:lintRelease :app:bundleRelease
} finally { Pop-Location }
```

`bundleRelease` remains unsigned until the separately reviewed signing configuration is present. Supply protected secrets through that configuration, never inline in this command/report. Verify the resulting AAB using the installed JDK's `jarsigner -verify -verbose -certs <aab>` and an approved Bundletool `validate --bundle=<aab>`; record public signing-certificate fingerprints and `Get-FileHash -Algorithm SHA256 <aab>`. Inspect generated APKs/manifest and run device tests against the Play-delivered certificate lineage. Existing GitHub Android compile-only mode can verify native compilation but does not sign/upload/publish.

Read-only inspection commands used included bounded `rg`/`rg --files` searches; `Get-Content` of the named public source/config files; XML parsing of existing JUnit/lint output; `.NET ZipFile` entry enumeration of the existing AAB; PNG dimension inspection; and `Get-FileHash` of that AAB. No private signing material or secret values were read.
