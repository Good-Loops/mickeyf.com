# Signed iOS privacy inventory — review-only helper

Apple documents generating its privacy report from a signed archive in Xcode's
Organizer. The existing hosted build intentionally destroys its archive, IPA,
and temporary signing material after upload; the already-uploaded build 40.1.0
therefore cannot be retroactively inspected with the local workflow. See
[Apple's privacy-report instructions](https://developer.apple.com/documentation/bundleresources/describing-data-use-in-privacy-manifests).

`scripts/ios-signed-privacy-summary.py` and the default-off
`audit_signed_privacy` workflow path are an **isolated experimental proposal**.
It can compare app-bundle manifests inside a future owned archive and the IPA's
extracted application, emitting a bounded summary rather than the signed app,
raw manifests, domains, arbitrary path names, unknown strings, or credentials.
SDK names in that summary are recognized path components, not proof of SDK
identity or runtime collection. Skipped symlinks, unknown top-level keys,
collected-data types or purposes make its known-collection vocabulary check
incomplete. It does not examine unknown fields nested inside manifest entries
or assess accessed-API reasons. An empty or unreadable scan fails closed.

The helper itself does **not** verify a code signature or the claimed bundle
identity. The proposed protected job invokes it only after archive and export
signature, identity and entitlement verification within the same owned run.
It does not load the App Store Connect API private key or run the Apple upload
command. A fixed disabled-child-lifecycle setting, reviewed signing branch,
manual opt-in and exclusive signing concurrency are required. It emits a
bounded summary and the IPA digest, then uses the existing cleanup routine;
it does not upload signed files, raw manifests or signing material. GitHub
Actions logs and summaries for this public repository are public.
If the hosted job is forcibly canceled or reaches its hard timeout, neither
`finally` nor the cleanup step is guaranteed to run; this depends on disposal
of GitHub's ephemeral hosted runner. Signing jobs are not configured to cancel
an active job when another is queued, but pending runs in the same concurrency
group can still be replaced.

The job and helper still require **independent security review and a real
macOS qualification** before use. Scanning must occur after build subprocesses
have stopped modifying the inspected directories; the helper does not protect
against concurrent path swaps. No proposed workflow was dispatched, no real
archive inspected, and no Apple upload was performed. The production branch is
unchanged.

A newly built archive—even from the same commit and configuration—has a new
build identity and is not the historical build 40.1.0. This custom summary is
not Apple's Xcode Organizer PDF and cannot establish actual data collection,
third-party sharing, retention, or legal compliance. Review Apple and SDK
guidance, the final runtime configuration and device behavior separately. Never
publish a store declaration based only on this inventory.
