# Android release API origin check

The version 3 internal-test bundle omitted `VITE_PROD_API_URL`. It built and
signed successfully, but the native app could not load account registration.
Version 4 was rebuilt with the production origin and published for internal
testing; device acceptance remains separate.

`verifyReleaseApiOrigin` checks the synced Android web bundle before release
packaging. A missing or ambiguous main JavaScript bundle, or a missing approved
production API origin, fails the release build. This is intentionally strict:
if the frontend bundler changes the emitted configuration format, update and
retest the check before producing a release. Staging builds are unaffected.

In an isolated checkout with Capacitor assets synced, the verification task
passed with the version 4 assets. Replacing the packaged origin with an absent
value made `:app:bundleRelease` fail with the expected error; the original
generated asset was restored afterward. A `:app:preReleaseBuild --dry-run`
also showed the check is a release prerequisite.
