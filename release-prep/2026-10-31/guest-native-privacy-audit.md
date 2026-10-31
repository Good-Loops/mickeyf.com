# Guest and native privacy audit — 31 October 2026

Read-only source review of release candidate `1b977236` (the later local commits
add operator documentation and an offline ledger helper, not runtime changes).
No live account, child data, production mutation, packet capture, or native
device test was used. This is not a complete SDK data-safety declaration or a
finding of compliance. The website currently serving users may be a different
revision; these candidate findings are not a live-site measurement.

## Findings

1. **Guests make first-party requests before parent consent.** The globally
   mounted `AuthProvider` attempts session restoration at startup
   (`frontend/ts/main.tsx`, `frontend/ts/context/AuthContext.tsx`,
   `frontend/ts/services/authApi.ts`). Web and Android attempt an empty-body
   `/auth/renew` request. On iOS when the Apple capability is enabled,
   `nativeAppleSession.check()` first requests `/auth/providers/apple-credential`;
   a signed-out result can short-circuit the renewal. Actual calls depend on
   platform, capability and state. A request exposes its IP address and ordinary
   transport metadata to the involved network services, and request rate limits
   use an IP-derived key (`backend/ts/security/requestRateLimits.ts`). The
   anonymous renewal controller returns a signed-out result without creating an
   account or issuing an account session cookie. The candidate notice mentions
   IP and request information for hosting/security. Determine actual access-log
   fields, destinations, retention and provider uses before claiming that the
   pre-consent processing qualifies for any particular exception.
2. **Guest results and device storage.** The p4-Vega result code does not submit
   a score when its authentication flag is false
   (`frontend/ts/games/p4-Vega/p4RunResult.ts`). The Three Bosses wrapper
   initializes its submission bridge disabled before its gate completes
   (`frontend/ts/games/three-bosses/unityWebGl.ts`); qualify the final build and
   game transitions on a real device rather than generalizing this source check
   to every possible traffic path. P4-Vega can store a joystick preference in
   local storage; the bundled Unity framework also initializes an IndexedDB
   filesystem. Device storage is not by itself evidence of a transmitted
   identifier or an account.
3. **Unity WebGL enumerates media devices locally.** The packaged framework
   referenced by `frontend/public/unity/three-bosses/build-manifest.json`
   calls `navigator.mediaDevices.enumerateDevices()` at startup when available
   and listens for `devicechange` (the minified framework's line 9). It filters
   `videoinput` and may inspect exposed device/group identifiers locally. The
   presence of webcam support and enumeration does **not** establish that a
   camera or microphone is activated or that those identifiers are transmitted;
   no such transmission was verified here. Three Bosses itself is behind a
   release feature flag. Verify actual final-build behavior and consider whether
   unused enumeration can be removed without breaking the game.
4. **Native age signal is not parental consent.**
   `frontend/ts/components/RegistrationGate.tsx` invokes
   `frontend/ts/services/registrationAge.ts` when the user continues the
   eligibility flow, rather than on guest gameplay startup. The native bridges
   request Apple Declared Age Range or Google Play Age Signals; the frontend
   derives a protective coarse band before the server registration request.
   Confirm denied, unavailable, conflicting, and parent-required outcomes on
   actual supported devices and inspect the bytes crossing the app/backend
   boundary. [Google's Play Age Signals documentation](https://developer.android.com/google/play/age-signals/overview#data-safety)
   says its client library collects no usage data and that Play Store processes
   operate under their own terms; this is not proof of the behavior of every
   other SDK in the app. The account form remains a separate permission step.
5. **SDK configuration is evidence, not runtime proof.** The Unity source
   settings disable Unity Analytics, Ads, crash reporting and diagnostics
   (`Unity/three-bosses/ProjectSettings/UnityConnectSettings.asset`). The native
   source dependencies include Google sign-in and age-signal components
   (`frontend/android/app/build.gradle`, `frontend/ios/App/Podfile.lock`), and
   the direct Android manifest declares internet access but not AAID. A source
   manifest is not the final merged manifest, and a declared dependency does not
   establish whether or when it transmits data. Obtain actual final signed-build
   manifest/dependency evidence and device network observations for guest,
   unknown-age, parent and child paths. Google Play's
   [Families data-practices requirements](https://support.google.com/googleplay/android-developer/answer/11043825)
   prohibit transmitting AAID and specified device/network identifiers from
   children or users of unknown age; SDK traffic to any recipient counts.

## Review consequence

Under the FTC's [COPPA FAQ](https://www.ftc.gov/business-guidance/resources/complying-coppa-frequently-asked-questions),
IP addresses can be persistent identifiers, and an internal-operations
exception has conditions on what is collected and how it is used. Do not call
all guest traffic consent-free solely because it is unauthenticated, or assume
the exception applies to unexamined provider/SDK uses. Inventory and document
the actual first-party and third-party flows, purpose, retention, recipients and
applicable exceptions before completing store declarations or activating the
child-inclusive release. Verify release package and live-web contents separately.
