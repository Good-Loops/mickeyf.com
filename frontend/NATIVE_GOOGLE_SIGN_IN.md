# Native Google sign-in preparation

The native Google source is prepared for iOS and Android. It is disabled in both app configurations. This document does not approve provider setup, signup policy, credential creation, deployments or release.

## Identity contract

The server advertises fixed `google-ios` and `google-android` clients only when their explicit identifiers are configured. Their public `clientId` is the server's web audience. The server verifies the ID token signature, issuer, expiry, nonce, exact web audience and exact native `azp` presenter. Web, iOS and Android identifiers must be distinct. A caller cannot select a different audience or presenter.

| Setting | Meaning |
| --- | --- |
| `PROVIDER_AUTH_ENABLED` | Existing exact-true provider gate |
| `GOOGLE_WEB_CLIENT_ID` | Existing server audience, also used by the browser client |
| `GOOGLE_IOS_CLIENT_ID` | Exact iOS OAuth client/presenter for the app bundle |
| `GOOGLE_ANDROID_CLIENT_ID` | Exact Android OAuth client/presenter for its package and signing certificate |
| `PROVIDER_GOOGLE_SIGNUP_ENABLED` | Existing exact-true signup gate, shared by the three explicitly configured Google clients |
| `ACCOUNT_DELETION_ENABLED` | Existing global deletion gate; the deletion journal and schema must also be ready |

Client identifiers are public configuration, not client secrets. Neither native application embeds a Google client secret. No Google access/refresh token or profile object crosses the JavaScript bridge. Google authentication is not proof of age, jurisdiction, guardianship or parental authorization.

Existing account login, explicit linking, signup continuations and deletion retain their existing server authorization rules. New-account policy must be completed before enabling signup. Do not turn the signup flag on merely because provider authentication succeeds.

## iOS

The Podfile pins GoogleSignIn 10.0.0 (minimum iOS 15). Its AppAuth dependency owns OAuth state and S256 PKCE. Each explicit sign-in supplies the server nonce and requests no additional scopes beyond Google's SDK basic identity scopes. SDK credentials are signed out after extracting the ID token; no cached Google session is restored.

Before activation, verify or reuse the project's real iOS and web OAuth clients. Set `GIDClientID` and `GIDServerClientID` in Info.plist, register the reversed iOS client ID under `CFBundleURLTypes` / `CFBundleURLSchemes`, then review enabling `LudolumeGoogleSignInEnabled`. Missing IDs, matching native/server IDs or a missing callback scheme keep the capability unavailable. These settings currently remain empty/off.

AppDelegate and SceneDelegate offer Google callbacks to the SDK, preserving unhandled Capacitor links. Google has no public programmatic cancellation API: cancellation discards credentials and holds the native operation lock until the SDK finishes. Apple and Google cannot open overlapping native sheets. A user may need to dismiss Google's sheet before retrying after a cancelled application request.

Use the manual `ios-build.yml` compile-only mode on the existing GitHub-hosted macOS runner to resolve CocoaPods, review the dependency lockfile, and compile the unsigned simulator app. Its Android job also verifies an unsigned release build. This mode uses no signing environment, caches or artifact uploads; TestFlight remains separately gated. Windows source checks do not compile Swift or prove URL callback, Keychain or device behavior. The existing TestFlight build predates this work.

## Android

The app pins Credential Manager and its Play Services adapter to 1.6.0, Google ID to 1.2.1 and OkHttp to 5.4.0. The 5.5.0 Android artifact requires compile SDK 37; 5.4.0 retains this project's API 36 / AGP 8.13 toolchain. The 5.5.0 hostname-canonicalization fix concerns malformed IP hosts, which the exact DNS-host allowlist rejects. The transport also retains its whole-call timeout, bounded responses, no redirects and no automatic retries. This compatibility pin requires ongoing advisory review; it is not a security exception or release acceptance. The explicit Google button uses `GetSignInWithGoogleOption` with the server nonce. It does not use automatic sign-in, request extra authorization scopes or embed a client secret. Cancellation targets its own `CancellationSignal`; late callbacks cannot complete a later operation.

Verify or reuse a real Android OAuth client bound to `com.mickeyf.app` and the exact signing certificate. Configure its ID on the server. Set the public web audience in `res/values/provider_identity.xml` as `google_server_client_id`, then review enabling `ludolume_google_sign_in_enabled`. Both are currently empty/off. Debug, upload and Play signing certificates are distinct; never assume one client proves another build's presenter.

`LudolumeApi` owns native API requests for Android as well as iOS. Android allows only the production HTTPS host and explicit API routes, uses normal certificate/hostname verification, follows no redirects, performs no automatic transport retries, and limits requests to 32 KiB and responses to 1 MiB. Requests are serialized across plugin instances so late responses cannot reorder login/logout cookies.

Only a host-only, Secure, HttpOnly `session` cookie at `/` is retained. The cookie stays out of JavaScript and the WebView cookie store. Persistent cookies are encrypted with an Android Keystore AES-GCM key in the application's no-backup directory; session-only cookies remain in process memory. Storage failures return an error without a plaintext fallback. Confirmed logout/deletion clears the native session and requests Credential Manager state reset. Provider reset failure cannot undo server logout. Existing WebView cookies are not imported; a previously signed-in Android build may require a fresh login.

The first local attempt stopped before compilation because Java was missing. The owner subsequently approved JDK 21, the required Android SDK packages and the Android SDK agreement. The compile-only checks are `:app:testReleaseUnitTest`, `:app:lintRelease` and `:app:assembleRelease`; they do not configure distribution signing. Native dependency resolution and compilation are still pending at this source checkpoint. The JVM tests cover URL/route/header restrictions, byte limits and cookie scope. A successful native build will not establish device or provider acceptance.

## Acceptance before activation

Use synthetic adult test accounts first. Confirm each actual build produces the expected audience, native presenter and nonce; missing/different claims must fail closed. Do not weaken validation to accommodate an unverified client setup.

Exercise existing-account login, unknown-account signup continuation, duplicate username/email handling, explicit linking, challenge expiry/replay, cancellation/retry, offline/timeout, app background/resume, process restart, remembered versus session-only persistence, session renewal, failed and successful logout, and deletion with a fresh provider identity. Check that a late response cannot reauthenticate after logout and that credentials never appear in bridge logs or browser storage. Inspect the native UI and callback behavior on both supported platforms. The supplied Google button PNGs preserve the approved artwork and platform proportions.

The worldwide, under-18 signup policy is a separate reviewed launch requirement. A proposed implementation boundary is a server-issued, single-use, versioned registration authorization bound to the registration context and consumed atomically when creating an account. Required jurisdiction/age-band and guardian steps must precede provider challenges where policy requires them. Do not infer eligibility from a Google/Apple token, retain unnecessary raw birth dates or ID images, or silently change existing leaderboard visibility. This source patch adds no age/guardian schema or policy claims.

Browser Apple remains a separate source gap. Apple's supported web setup requires a Services ID associated with an enabled primary App ID, verified domain/return URL and a reviewed callback flow. Its availability and credentials must be checked before implementation/activation.

## Primary references and artwork

- [Google iOS integration](https://developers.google.com/identity/sign-in/ios/start-integrating)
- [GoogleSignIn 10.0.0 nonce API](https://github.com/google/GoogleSignIn-iOS/blob/10.0.0/GoogleSignIn/Sources/Public/GoogleSignIn/GIDSignIn.h)
- [AppAuth 3.0.0 nonce/state/PKCE initialization](https://github.com/openid/AppAuth-iOS/blob/3.0.0/Sources/AppAuthCore/OIDAuthorizationRequest.m)
- [Android Credential Manager Google flow](https://developer.android.com/identity/sign-in/credential-manager-siwg-implementation)
- [Android Keystore](https://developer.android.com/privacy-and-security/keystore)
- [OkHttp changelog](https://github.com/square/okhttp/blob/master/CHANGELOG.md)
- [Google approved branding](https://developers.google.com/identity/branding-guidelines): unmodified light, pill, text-present PNGs at 2x from the iOS and Android/Web folders in the linked `signin-assets.zip`; served locally as `public/images/google-sign-in-ios.png` and `google-sign-in-android.png`.
- [Apple web setup](https://developer.apple.com/help/account/capabilities/configure-sign-in-with-apple-for-the-web/)
