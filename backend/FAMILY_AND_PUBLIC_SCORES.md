# Family deletion and public score participation

This source adds confirmed family deletion and a separate choice to publish game scores under the account's chosen nickname. It does not activate providers, registration, public participation, credentials, SQL or production traffic. Provider identity plus guardian attestation is not claimed to satisfy a jurisdiction's parental verification requirements.

## Decisions and preserved behavior

Family deletion lists the parent and every current child, requires the explicit family confirmation and fresh provider proof linked to that parent, and binds the approval to the exact sorted child account UUIDs. A changed family, omitted child, duplicate or foreign account rejects the request. On one SQL connection, parent and child locks protect revalidation and deletion. Each child's independent deletion intent is acknowledged before the parent's intent. A journal failure leaves SQL untouched; an uncertain acknowledgement or commit is never presented as confirmed deletion. Recorded intent cannot be cancelled by navigating away. The browser serializes the final cookie-changing request with login/logout and clears authentication only on confirmed success. Existing single-account parent deletion remains restricted while children exist.

New registrations have private scores regardless of age. Public participation is a separate displayed notice and choice, followed by fresh linked provider proof. The configured regional route may permit an independent minor or require the account's parent; there is no blanket under-18 ban and no universal parent requirement. Parent-managed children cannot grant themselves publication. Country, age band, profile policy, family ownership, displayed consent text and publication policy must still match at approval. Chosen nicknames remain unchanged.

The public choice covers existing and future best scores, as the UI states. Leaderboards still return only nickname and game results; filtering occurs before limits. Existing unclassified and already-public legacy profiles retain their earlier visibility until a separate withdrawal overrides it. Public reads are not cached, but already-rendered pages on other devices do not receive a live removal event.

Withdrawal is independently available with an authenticated account even if new publication is paused. It records a minimal withdrawal intent, makes the score permission private and cancels pending/approved publication attempts. It preserves the account and private progress. Family deletion instead removes each account and its scores. The deletion audit counts only actual deletion intents, not accounts intentionally retained after score withdrawal.

## Closed activation contract

`PUBLIC_SCORE_PARTICIPATION_ENABLED`, `PUBLIC_SCORE_POLICY_REVIEWED` and `PUBLIC_SCORE_ASSURANCE_REVIEWED` are separate explicit gates. Enabling them requires the existing reviewed registration policy, provider authentication and journaled account deletion. No jurisdiction is enabled by default.

`PUBLIC_SCORE_POLICY_VERSION`, `PUBLIC_SCORE_CONSENT_VERSION`, `PUBLIC_SCORE_CONSENT_TEXT`, `PUBLIC_SCORE_PRIVACY_NOTICE_URL` and `PUBLIC_SCORE_COUNTRY_RULES` supply the reviewed decision. The country rules map configured registration countries to the exact fields `selfAgeBands` (a subset of minor/adult) and `parentManaged` (boolean). A parent-managed route additionally requires the reviewed parent registration policy. The public HTTPS notice and complete displayed text are part of the digest. These are variable names and shape documentation, not approved deployment values.

Legal applicability and adequate assurance for public disclosure remain unresolved until separately reviewed. Provider login and a checkbox do not establish adult age or guardianship. No new verification or email vendor is introduced. Keep issuance closed in every unreviewed region.

## Schema, transitions and restoration

Immutable migrations 0024 and 0025 extend purpose-bound parent attempts with family/profile digests and add per-account score permissions. The explicit `family-management-apply` command selects only these two effects after normal target/history/confirmation checks. Startup requires the extended schema even with issuance closed. The `google-apple-parent` runtime grant profile gains only the needed columns; it does not grant profile edits or DDL. Do not repeat old migrations or use the current Cloud-SQL-backed local launcher as a disposable test database.

Policy/profile comparisons fail closed when values differ, but they are not a durable history of configuration changes. Reusing a former policy digest or reverting a profile can match an old permission or an unexpired grant. Before an operator changes a profile, consent policy, relevant country rule, ownership or rollback configuration, freeze and drain **all** account and publication writers, invalidate the affected permissions to private and cancel every outstanding publication attempt, then use a new, never-reused policy generation and verify private visibility before resuming. This applies to rollback and restoration as well as forward rollout. There is no runtime profile-edit API. An operator transition without this reviewed invalidation procedure is unsupported; source tests alone do not authorize it.

Restore reconciliation reads both deletion and withdrawal intents. Family deletion is ordered child before parent. Withdrawal replay makes a restored account private and cancels restored pending/approved publication attempts without deleting the account. The conservative replay can also remove a later opt-in: require a fresh choice after reconciliation. Keep every writer, including publication approval and withdrawal, stopped until the full journal is reconciled and final state verified. Per-account locks and a stable journal digest cannot detect new publication after that account's replay finishes. The freeze acknowledgement remains an operator attestation, not an automatic traffic drain.

Rollback must preserve the permission-aware leaderboard query, parent management, journal formats and attempt tombstones. A historical image ignoring these tables can expose private scores. Do not drop permission rows or restore an old binary/configuration merely to resume traffic.

## Validation boundary

Regression checks cover ordinary and uncertain family deletion, exact ownership, queue/session races, independent minor rules, stale profile/text approvals, private withdrawal and restored grants. Disposable MySQL/browser tests use actual HTTP and SQL with synthetic provider verification. They do not prove live Google/Apple login, legal sufficiency, signed device acceptance or production migration readiness. The original private privacy-policy draft remains outside this repository and is not published by these changes.
