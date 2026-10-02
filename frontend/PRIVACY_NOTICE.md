# Approved privacy notice and separate consent

The owner-approved notice is versioned in `shared/privacyNotice.json` and rendered
at `/privacy` without authentication. The footer links to that local page when no
`VITE_PRIVACY_NOTICE_URL` override is configured. A valid explicit HTTPS override
retains the existing external-link behavior. A nonempty invalid override still
fails Vite startup/build. Legal name/email are approved; postal address and
telephone details are not authorized for publication.

The page presents account permission and optional public-leaderboard permission
separately. Reading it grants neither. Actual account controls continue to display
the backend's exact versioned consent text; there is no client-side substitution
that could differ from the policy bound to an approval record.

`node scripts/privacy-notice-consent.mjs` prints an offline fragment containing
the two approved consent texts, their separate versions and their notice URLs.
Use that fragment when assembling the separately reviewed runtime configuration.
It sets no enable/review flags, age boundaries, country rules or assurance method.
It does not deploy or access credentials. Neither consent is preselected; account
creation does not grant leaderboard participation, which retains its own opt-in
and withdrawal.

`PARENT_PRIVACY_NOTICE_URL` is required with an enabled parent-management policy.
The backend validates and returns it with the consent text. Parent consent and
child-credential collection retain this link. The canonical URL participates in
the policy digest, so changing it invalidates pending proofs and approved grants.
The begin request also echoes the displayed URL; a stale page cannot approve a
different newly configured destination even if the policy version was not changed.
The frontend also validates the server value and refuses malformed configuration.
Closed parent-policy defaults remain closed and need no notice setting.

`PUBLIC_SCORE_PRIVACY_NOTICE_URL` remains a separate required field of an enabled
public-score policy, returned with its own consent text and bound to that policy.

Explicit external notice settings accept an absolute HTTPS URL (maximum 2,048 characters) with no
credentials, query parameters, nonstandard port, whitespace or control characters.
Document section fragments are supported. Links use ordinary keyboard-accessible
anchors, announce a new tab, isolate the opener and suppress the referrer. The
new tab preserves the existing form; native external-browser behavior still needs
device acceptance. No API allowlist or native navigation policy was broadened.

Use the same reviewed notice destination for the runtime settings at a separately
authorized release. Verify its public reachability, redirects, content and target
ownership; syntax validation does not establish these. Archive the approved notice
and consent versions. Changing content at the same URL requires a reviewed version
change: a URL digest is not a content archive or live page monitor. Both switches
for management/creation, regional policy reviews and all rollout gates are unchanged.

## Publication boundary

This commit prepares the approved wording; it does not publish the frontend.
Main merge triggers Hosting publication, so compatible backend readiness and
release sequencing must be resolved first. Verify actual deletion, Apple revocation
cleanup, legacy score visibility and provider signup/login before publishing the
corresponding claims. The page qualifies feature availability and offers the contact
email when a control is unavailable; this does not replace those release checks.

No global legal-compliance claim, worldwide country/age mapping, US under-13 consent
workflow or publication of private contact details is approved by notice adoption.
Existing support/recovery/inactivity retention designs need operational verification
before exact durations enter the notice. Keep the private draft and review appendix
outside the public repository. Record the actual release date with the publication
receipt; the content version does not invent an effective publication date.
