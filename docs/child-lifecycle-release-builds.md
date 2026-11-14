# Child lifecycle release builds

Child activity reporting and parent inactivity warnings are **off by default**. Both
must be included together. Their presence in a build does not enable the backend,
establish parental consent, or qualify the service for public use.

Before an opt-in production build, qualify the backend, its configuration, privacy
documentation, warning and deletion process, and operational readiness. Deploy and
verify the compatible backend first; only then distribute clients that use it.

The iOS build, Firebase Hosting deployment and website verification workflows have
the same `child_lifecycle` dispatch choice:

* `follow-repository` (default) reads repository variable
  `LUDOLUME_CHILD_LIFECYCLE_RELEASE`. An unset value or any value other than `1`
  keeps both features off. Automatic workflow runs also use this setting.
* `on` includes both features for that run.
* `off` disables both for that run, even if the repository variable is `1`.

After a production cutover is qualified, setting the repository variable to `1`
keeps subsequent automatic builds consistent. Before then, leave it unset. For a
rollback, choose `off` for manual builds and clear the repository variable before
future automatic builds. Existing deployed artifacts do not change automatically.

For an explicitly qualified Android build, install the locked frontend dependencies
and run from the repository root:

```text
node scripts/build-child-release.mjs --qualified-android
```

This only builds the frontend assets with both features enabled and the production
API origin. It does not sync Capacitor, sign, upload, deploy, or verify the app on a
device. Perform those steps separately using the existing release procedure. The
script rejects conflicting environment settings. It is not a readiness check.
