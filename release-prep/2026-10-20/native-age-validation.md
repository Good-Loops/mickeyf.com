# Native age-signal validation

## Android

The Android bridge registers `LudolumeAge.requestAgeRange({})` and returns exactly `status`, `minimumAge`, and `maximumAge`. Status is one of `shared`, `not-shared`, `verification-required`, `unsupported`, or `unavailable`. Only a valid nonempty shared range has age bounds. Other outcomes contain explicit JSON null bounds.

### Verified API and range semantics

- Google Maven metadata, the actual POM/AAR and Java bytecode confirm `com.google.android.play:age-signals:0.0.4` exists. It supports `requestAgeSignalsAccess(AgeSignalsAccessRequest)` followed by `checkAgeSignals(AgeSignalsRequest)`, matching Google's [current integration guide](https://developer.android.com/google/play/age-signals/request-age-signals) and [release notes](https://developer.android.com/google/play/age-signals/release-notes). The generic Java reference pages still describe older 0.0.3 fields; no removed `userStatus` API or reflection is used.
- The bridge requests access on the current Activity, allowing Play to present its sharing prompt. It reads age bounds only after an explicit `SHARED` response. A declined/missing/verification-required result cannot initiate a range read. No age prompt runs during plugin registration/startup.
- Google documents both bounds as **inclusive**, including default bands 0–12, 13–15, 16–17 and 18+; the highest band's maximum is null. Android therefore passes bounds through without subtracting one. Documented 0..18 bounds are validated, inverted/out-of-range/incomplete ranges are rejected, and two null bounds yield `not-shared`. See [response semantics](https://developer.android.com/google/play/age-signals/understand-age-signals-responses).
- Missing Play/API capability maps to `unsupported`; transient/system failures, unknown statuses, malformed results and cancellation map to protective `unavailable`. One in-flight request is permitted, with cancellation at Activity destruction or a two-minute local deadline; late callbacks cannot publish a result or begin another range read.
- The bridge reads no install ID, provider identifier, token, significant-change metadata or assurance tier. It performs no age logging, analytics or persistent storage. The range is a platform signal and does not establish verified identity or parental consent; Play can supply a self-declared age source. Actual device/Play eligibility and response behavior remain unverified locally.

### Changes and validation

Owned changes: `LudolumeAgePlugin.java`, `LudolumeAgeRequest.java`, `LudolumeAgeRequestTest.java`, MainActivity registration, app Gradle dependency and its generated dependency lock. Required transitive changes are `core-common:2.0.4`, `play-services-basement:18.5.0 → 18.9.0`, and task-library compile scope. No provider signup configuration, keys, signing or upload changes were made.

Android-only Capacitor scaffolding was regenerated using existing dependencies/assets:

```powershell
.\node_modules\.bin\cap.cmd sync android
```

From `frontend/android`, the unsigned compile and JVM command was:

```powershell
$env:JAVA_HOME = 'C:\Users\User\AppData\Local\Programs\EclipseAdoptium\jdk-21.0.12.1'
$env:ANDROID_HOME = 'C:\Users\User\AppData\Local\Android\Sdk'
.\gradlew.bat :app:testReleaseUnitTest :app:compileReleaseJavaWithJavac --write-locks --no-daemon --console=plain '-Djavax.net.ssl.trustStoreType=Windows-ROOT' '-Djavax.net.ssl.trustStore=NONE'
```

**Passed: 37 JVM tests, zero failures/errors, including 7 new age-request tests; release Java compilation passed.** Tests cover access-before-range ordering, all nonshared states, inclusive/open-ended bounds, malformed/null ranges, unsupported/transient errors, repeated callbacks, cancellation and late results. `git diff --check -- frontend/android` passed. The Windows trust store resolved the installed JDK's local certificate-chain issue while retaining TLS verification. Existing flatDir/SDK XML version warnings remain.

No APK/AAB assembly, signing, installation, emulator/device interaction, live Play consent prompt, Play-delivered build validation or upload occurred. Real Play-installed device acceptance remains required before claiming runtime readiness.
