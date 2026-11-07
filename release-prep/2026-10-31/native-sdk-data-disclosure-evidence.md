# Native SDK data-disclosure evidence — 31 October 2026

This read-only source review compares candidate `be57f89d` with the Google
Sign-In iOS SDK and Android runtime dependencies locked in its source. It does
not establish the behavior of a final signed IPA, a Play-delivered Android app,
or a production backend, and it is not a completed store declaration.

## Directly supported first-party data

* Existing password and provider accounts can store a username, email address,
  account identifier, and, for password accounts, a password hash
  (`backend/ts/accounts/passwordAccountRepository.ts`,
  `backend/ts/accounts/providerAccountRepository.ts`). The candidate uses these
  for account functionality. This supports reviewing Apple's Email Address and
  User ID as linked to the account, with App Functionality as a purpose. For
  Google Play, email and user IDs are within Personal info; its Name definition
  also includes a nickname. See [Apple's categories](https://developer.apple.com/app-store/app-privacy-details/)
  and [Google's definitions](https://support.google.com/googleplay/android-developer/answer/10787469).
* A signed-in player's p4-Vega best score is associated with the account ID and
  recorded on the server (`frontend/ts/games/p4-Vega/p4RunResult.ts`,
  `backend/ts/leaderboards/p4VegaScoreRepository.ts`). The guest result code
  does not submit that score. Apple's Gameplay Content and Google's App activity
  / Other actions, which includes gameplay, are reasonable classifications to
  assess for these stored results; the category mapping is an inference from
  vendor definitions, not a completed questionnaire.
* When its configuration permits the eligibility flow, the candidate sends a
  selected country and coarse age band during registration or provider-login
  eligibility (`frontend/ts/components/RegistrationGate.tsx`,
  `frontend/ts/services/registrationApi.ts`). Google lists age-related data in
  Personal info / Other info; Apple has Other Data Types. Determine the actual
  deployed flags, retention, and exact categorization before declaring. These
  values are not a date of birth or a precise device location.
* The signed parent form is returned by email outside the app, according to the
  candidate notice, not through an in-app photo/file upload. That fact alone
  does not establish that the in-app Photos, Files, or Messages categories apply.
  This does not eliminate the separate privacy and retention obligations for
  the returned forms.

## SDK and platform evidence

* GitHub Actions [run 41240915795](https://github.com/Good-Loops/mickeyf.com/actions/runs/41240915795)
  compiled candidate `f119a57c` for the iOS simulator and inventoried nine
  bundled privacy manifests without skipped symlinks. It confirms that the
  `GoogleSignIn.framework/GoogleSignIn.bundle/PrivacyInfo.xcprivacy` manifest
  below is present in that simulator build, including its declared data types
  and purposes. This is not a signed distribution archive or a runtime capture.

* Google Sign-In is enabled by the checked-in iOS `Info.plist` and the locked
  version is 10.0.0. Its [source privacy manifest](https://github.com/google/GoogleSignIn-iOS/blob/10.0.0/GoogleSignIn/Sources/Resources/PrivacyInfo.xcprivacy)
  declares linked Name, Email Address, Phone Number, Other Data Types, Coarse
  Location, User ID, Device ID, and Other Usage Data. Purposes include App
  Functionality; Analytics is listed for Other Data Types, User ID, Device ID,
  and Other Usage Data. Each listed tracking flag is false. The locked
  [CocoaPods spec](https://raw.githubusercontent.com/CocoaPods/Specs/master/Specs/d/4/0/GoogleSignIn/10.0.0/GoogleSignIn.podspec.json)
  includes the SDK's Resources directory. Check the final IPA and determine
  applicability of SDK features; the vendor manifest alone does not prove that
  every listed item is collected in this app's particular flow.
* [Google's iOS disclosure guidance](https://developers.google.com/identity/sign-in/ios/app-privacy)
  separately says the SDK may collect a user identifier for OAuth grants and an
  IP address for fraud prevention, possibly estimating general location. This
  guidance is narrower than the manifest and should not be used to dismiss its
  other entries without clarification.
* [Google Play Age Signals](https://developer.android.com/google/play/age-signals/overview#data-safety)
  says its client library collects no usage data; the Play Store's own processes
  handle data under its terms. This does not establish behavior of other SDKs.
* The checked-in Android source has no direct advertising-ID permission; an
  earlier candidate's merged release manifest also lacked it, but that finding
  is not proof that no SDK processes other device identifiers. The debug staging
  APK examined here is not the final Play package. See
  `android-release-manifest-audit.md` and `guest-native-privacy-audit.md`.

## Before final declarations

Inspect the final iOS archive's bundled manifests and generate its privacy report
as [Apple describes](https://developer.apple.com/documentation/bundleresources/describing-data-use-in-privacy-manifests).
Inspect the Play-delivered Android artifact and observe network destinations and
data for signed-out guests, unknown-age users, existing account login and the
parent/child flows that will actually be enabled. Separately establish provider
roles, use and retention, including access logs. These gaps prevent a confident
blanket answer on all collection, sharing, analytics, tracking, deletion and
encryption-in-transit fields. Do not treat source flags, a missing permission,
or the lack of an advertising SDK as proof of every negative answer.
