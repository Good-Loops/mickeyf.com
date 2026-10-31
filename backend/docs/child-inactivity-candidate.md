# Child inactivity lifecycle candidate — disabled

This code is a local candidate, not an enabled feature or a deployable release. No warning is sent and no account is deleted by importing it. The parent router is not mounted; the schema is a pending draft and is not in the migration manifest. Do not enable or apply it as-is.

The policy measures authenticated online activity. It prepares a bilingual warning no sooner than 30 days before the third calendar anniversary; it allows a candidate deletion no sooner than the third anniversary and 30 full days after independently confirmed receipt. Missing or uncertain activity, current verified contact, relationship, warning, acknowledgment, or timing holds the process. Later activity or a parent keep action invalidates the old warning. Offline play may not update the timer and is disclosed in the warning.

The candidate supports a locked parent acknowledgment API and a separate retention journal interface, with no production wiring. Gmail Sent, lack of a bounce, and accepted delivery are not proof the parent received a warning. A separately verified reply or authenticated acknowledgment of the exact notice can establish receipt; no-response is held.

Before any real use, complete and independently review all of the following:

- A trusted current verified-contact and activity-health resolver; historical signup address is insufficient. Authenticate contact changes and account for Apple private relay.
- Parent UI to display and acknowledge the exact warning, a keep control connected to the activity writer, and operator discovery and notification workflow. Test the full flow with synthetic accounts.
- A separately durable authenticated retention-intent store and independent authoritative activity/keep history with completeness across database restores. The existing generic account-deletion journal cannot be used because its replay is unconditional. If continuity cannot be proved, deletion and replay must hold. There is no implementation of either retention journal or continuity proof in this candidate.
- Validate the pending tables, deployment sequence, actual restricted grants, production clock, alerting, recovery, and tests of parent/child locks and racing activity in the integrated app. The SQL rehearsal presently uses a privileged disposable database and is not proof of runtime grants.
- Decide how all personal-data copies and backups are handled in deletion and retention, and complete the privacy and regional review before release.

Restore caveat: a restored SQL database alone cannot prove that no later keep action or use occurred after the backup. Never run retention replay on that basis. The interface deliberately requires an independently verified continuity proof; the runtime has no such verifier.
