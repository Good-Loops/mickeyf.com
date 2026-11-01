# Signed iOS privacy inventory — review-only helper

Apple documents generating its privacy report from a signed archive in Xcode's
Organizer. The existing hosted build intentionally destroys its archive, IPA,
and temporary signing material after upload; the already-uploaded build 40.1.0
therefore cannot be retroactively inspected with the local workflow. See
[Apple's privacy-report instructions](https://developer.apple.com/documentation/bundleresources/describing-data-use-in-privacy-manifests).

`scripts/ios-signed-privacy-summary.py` is an **unwired experimental helper**.
It can compare app-bundle manifests inside a future owned archive and the IPA's
extracted application, emitting a bounded summary rather than the signed app,
raw manifests, domains, arbitrary path names, unknown strings, or credentials.
SDK names in that summary are recognized path components, not proof of SDK
identity or runtime collection. Skipped symlinks, unknown top-level keys,
collected-data types or purposes make its known-collection vocabulary check
incomplete. It does not examine unknown fields nested inside manifest entries
or assess accessed-API reasons. An empty or unreadable scan fails closed.

The helper itself does **not** verify a code signature or the claimed bundle
identity. Before any future integration, the signing job must verify archive
and exported code signatures, identity, entitlements and manifest coverage,
invoke it only within the same owned run, and independently review and test how
the bounded output is handled. Scanning must occur after build subprocesses
have stopped modifying the inspected directories; the helper does not protect
against concurrent path swaps. GitHub Actions logs and summaries for this
public repository are public. It must not log credentials, raw signing output,
archive files, or IPA contents. Keep the existing cleanup and protected
environment restrictions. The current production workflow does not call this
helper, and no inspection or upload was performed by preparing it.

A newly built archive—even from the same commit and configuration—has a new
build identity and is not the historical build 40.1.0. This custom summary is
not Apple's Xcode Organizer PDF and cannot establish actual data collection,
third-party sharing, retention, or legal compliance. Review Apple and SDK
guidance, the final runtime configuration and device behavior separately. Never
publish a store declaration based only on this inventory.
