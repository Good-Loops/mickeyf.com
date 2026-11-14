# Child inactivity lifecycle candidate — disabled

This document describes the older parent-acknowledged 30-day candidate. The current
release uses [automatic warning/nonresponse handling](child-warning-production-wiring.md)
with a twelve-month wait; the new deployment does not invoke this older deletion path.

This code is a local candidate, not an enabled feature or a deployable release. No warning is sent and no account is deleted by importing it. The parent router is not mounted; the schema is a pending draft and is not in the migration manifest. Do not enable or apply it as-is.

The owner later chose to allow deletion after 12 additional months of parent
nonresponse. That product decision supersedes the earlier indefinite hold, but
is **not implemented or enabled** in this candidate. The precise start of the
additional period, delivery failures, exceptions, retention, and recovery still
need a reviewed specification and tests. Until an updated, qualified process is
implemented, the candidate's behavior remains to hold without confirmation.

The warning service can now be explicitly injected into the auth router after
`prepareChildInactivityRuntime` verifies its table and restricted grants. Its
authenticated `/pending` route reports only whether a parent has an unacknowledged
warning; the default-off web/native banner links to the parent account page.
The runtime requires separate target and receipt keys and an independently
supplied activity-health verifier. No startup wiring provides these dependencies
yet. This in-app reminder reaches only parents who sign in; it is not email or
proof of delivery to an absent parent, whose account remains pending.

The policy measures authenticated online activity. It prepares a bilingual warning no sooner than 30 days before the third calendar anniversary; it allows a candidate deletion no sooner than the third anniversary and 30 full days after parent confirmation. Missing or uncertain activity, target identity, relationship, warning, acknowledgment, or timing holds the process. Later activity or a parent keep action invalidates the old warning. Offline play may not update the timer and is disclosed in the warning.

The candidate supports a locked parent acknowledgment API and a separate retention journal interface, with no production wiring. The in-app target is a domain-separated HMAC of the exact parent/child relationship, not a verified email, and the parent must have a live session to see and explicitly acknowledge the warning. Email and in-app confirmations have separate channel types and cannot substitute for each other. Gmail Sent, lack of a bounce, and accepted delivery are not proof the parent received a warning; no-response is held. A parent who never signs in receives no proactive warning and their account remains pending.

Before any real use, complete and independently review all of the following:

- An independently reliable activity-health resolver; the in-app target resolver requires it but does not implement it. If email outreach is later introduced, separately verify current contact and handle Apple private relay; the historical signup address is insufficient.
- A candidate parent warning component displays and acknowledges the exact bilingual server notice only when `VITE_ENABLE_CHILD_INACTIVITY_WARNING=1`. It expects `/auth/child-inactivity/warning` and `/auth/child-inactivity/acknowledge`; these are allowlisted in native source but the backend router is not mounted. Do not enable the flag until the backend, native builds, privacy policy and full synthetic flow are qualified. Operator discovery and notification remain unimplemented.
- A separately durable authenticated retention-intent store and independent authoritative activity/keep history with completeness across database restores. The existing generic account-deletion journal cannot be used because its replay is unconditional. If continuity cannot be proved, deletion and replay must hold. There is no implementation of either retention journal or continuity proof in this candidate.
- Validate the pending tables, deployment sequence, actual restricted grants, production clock, alerting, recovery, and tests of parent/child locks and racing activity in the integrated app. The SQL rehearsal presently uses a privileged disposable database and is not proof of runtime grants.
- Decide how all personal-data copies and backups are handled in deletion and retention, and complete the privacy and regional review before release.

Restore caveat: a restored SQL database alone cannot prove that no later keep action or use occurred after the backup. Never run retention replay on that basis. The interface deliberately requires an independently verified continuity proof; the runtime has no such verifier.
