# Android release manifest audit — 31 October 2026

This is a local, unsigned manifest-level review of candidate commit
`bcadaeec05ec0b9698091ed3a15db54e4506a94e`; it is not a signed package,
Play-distributed artifact, device network capture, or compliance declaration.
No account, store listing or production resource was modified.

## Reproduction and result

In a detached worktree at that commit, using the locally installed Eclipse
Temurin JDK 21.0.12.1, installed Android SDK, and existing Gradle cache:

```powershell
$env:JAVA_HOME = 'C:\Users\User\AppData\Local\Programs\EclipseAdoptium\jdk-21.0.12.1'
$env:ANDROID_HOME = Join-Path $env:LOCALAPPDATA 'Android\Sdk'
cd frontend\android
.\gradlew.bat --no-daemon --offline :app:processReleaseManifest
```

The manifest merge completed successfully. For this isolated check the
`@capacitor/android` package was copied from the candidate checkout and its
version `8.5.1` was checked against the candidate lockfile. The generated
`capacitor-cordova-android-plugins` directory was copied from the earlier local
unsigned Android worktree; the tracked Android sources did not change between
that worktree's `339422f8` commit and the tested candidate. No Capacitor sync,
signing, APK/AAB upload or device test was performed. This is therefore not a
substitute for examining the actual final build.

The resulting `app/build/intermediates/merged_manifests/release/`
`processReleaseManifest/AndroidManifest.xml` had SHA-256
`59a838b2ccda251b2af0d60371e0d38cc22a2dc226e2ffe68f2ea4b995f07e2f`.
It declares `INTERNET`, `USE_BIOMETRIC`, `USE_FINGERPRINT`, and the app's own
signature-protected dynamic receiver permission. It does not declare Android
advertising ID, location, camera, microphone, or phone-state permissions.
The manifest targets Android API 36. Absence of a permission is not evidence
that every SDK avoids all restricted data or network transmissions.

## Backup caveat

The merged manifest sets `android:allowBackup="true"` and has no explicit
`fullBackupContent` or `dataExtractionRules` attribute. The native Android
session store independently uses Android Keystore and `getNoBackupFilesDir()`
(`frontend/android/app/src/main/java/com/mickeyf/app/LudolumeSessionStore.java`).
That design is not proof about all WebView or other application data.
Google's [Android Auto Backup documentation](https://developer.android.com/identity/data/autobackup)
describes the eligible file categories and notes that device-to-device transfer
behavior can differ by manufacturer even when cloud backup is disabled.
Inspect actual backup contents and restore behavior before describing retention
or changing backup settings.

Before a child-inclusive Play release, inspect the final Play-delivered package
and observe device network behavior for guest, unknown-age, parent and child
paths. Google's [Families data practices](https://support.google.com/googleplay/android-developer/answer/11043825)
restrict transmission of specific identifiers from children and users of
unknown age; a manifest-only check cannot establish that those rules are met.
