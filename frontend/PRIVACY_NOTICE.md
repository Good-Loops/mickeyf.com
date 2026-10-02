# Privacy notice linkage (prepared locally; no notice published)

`VITE_PRIVACY_NOTICE_URL` is an optional public build setting for the app footer,
including login, signup and account-management routes. Leave it unset until the
owner-reviewed notice is published. An unset value adds no link; a nonempty
invalid value fails Vite startup/build. No fallback route or legal text is invented.

`PARENT_PRIVACY_NOTICE_URL` is required with an enabled parent-management policy.
The backend validates and returns it with the consent text. Parent consent and
child-credential collection retain this link. The canonical URL participates in
the policy digest, so changing it invalidates pending proofs and approved grants.
The begin request also echoes the displayed URL; a stale page cannot approve a
different newly configured destination even if the policy version was not changed.
The frontend also validates the server value and refuses malformed configuration.
Closed parent-policy defaults remain closed and need no notice setting.

Both settings accept an absolute HTTPS URL (maximum 2,048 characters) with no
credentials, query parameters, nonstandard port, whitespace or control characters.
Document section fragments are supported. Links use ordinary keyboard-accessible
anchors, announce a new tab, isolate the opener and suppress the referrer. The
new tab preserves the existing form; native external-browser behavior still needs
device acceptance. No API allowlist or native navigation policy was broadened.

Use the same reviewed notice destination for both settings at a separately
authorized release. Verify its public reachability, redirects, content and target
ownership; syntax validation does not establish these. Archive the approved notice
and consent versions. Changing content at the same URL requires a reviewed version
change: a URL digest is not a content archive or live page monitor. Both switches
for management/creation, regional policy reviews and all rollout gates are unchanged.

No production value, notice text, publication, legal adequacy assertion or country
exclusion is part of this source change. Worldwide audience and the approved
provider-plus-guardian-attestation product approach are preserved.
