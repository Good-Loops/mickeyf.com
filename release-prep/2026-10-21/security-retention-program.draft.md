# Ludolume security and retention program — draft

Owner review copy, 21 October 2026. No control is marked completed merely because
it appears here. This is not a deployment configuration or a new published notice.
It accompanies the [decision package](br-us-policy-decision-package.md).

## Coordination and operation

On 5 November 2026, the owner accepted the coordinator role: review the written
safeguards at least annually and after major changes or incidents, handle privacy
incidents, and oversee the existing twice-weekly form and deletion checks. The
owner may ask Codex for assistance; this does not establish autonomous monitoring
or a scheduled service. Acceptance does not complete the controls below or adopt
unqualified retention deadlines. No paid reviewer or subscription is introduced.

Proposed recurring manual work: check the protected mailbox, review pending
requests, reconcile retained forms and complete deletion tasks at least twice
weekly. Record each completed pass and unresolved exceptions privately. This
document creates no scheduled automation and sends no messages.

## Risks, safeguards and proof

| Risk | Existing source / proposed control | Required operational proof |
| --- | --- | --- |
| Forged, replayed or mismatched consent | Exact request/provider/account/contact/policy binding, one-use grants, private child creation and owner-only review fields. | Synthetic reject/expire/replay tests plus actual owner decision procedure; assess guardian evidence by region. |
| Provider collection before eligibility | Native/coarse-age gate, protective unknown/conflict handling, retry restriction and child provider restrictions. | Actual supported-device/network behavior; proportionate web assurance and correction handling. |
| Mailbox or attachment disclosure | Two-step verification is enabled on the form mailbox; Google confirmed the recovery email verified on 9 November. The encrypted archive, synthetic mailbox cleanup and recovery on a second computer were exercised. | Verify access isolation; keep real forms and recovery material out of shared artifacts. |
| Retention after withdrawal/deletion | SQL cascades/expiry cleanup; owner review and synthetic form-copy lifecycle passed in 2.2–2.3. | Qualify production integration, continuing retention and provider recovery-copy limits. |
| Restore revives deleted accounts/permission | Existing independent deletion journal/replay and public-permission invalidation. | Qualified recovery procedure and actual retention/restore evidence; do not expire journal records speculatively. |
| Public nickname/result disclosure | Private new accounts and separately controlled public permission; the live public-score configuration is enabled. | Qualify final-device and supported-client behavior; no blanket all-accounts-private claim. |
| Provider or incident failure | Existing guarded closure/fallback tooling and bounded database operations. | Named incident contact, private factual incident record and applicable notification/escalation assessment. |

Review risks and the program at least annually and after a material incident,
provider/data-flow change or new optional disclosure. Regularly test safeguards
using synthetic data; record dates/results and corrections. Set the initial
review date on actual adoption, not on this draft's preparation date.
[16 CFR 312.8](https://www.ecfr.gov/current/title-16/chapter-I/subchapter-C/part-312/section-312.8).

## Retention schedule requiring final adoption

The table below records the October draft. For current evidence, qualified
form-copy deadlines and remaining decisions, use the [November retention and
provider review](../2026-11-04/retention-provider-review.md).

| Record/purpose | Current evidence | Remaining decision or qualification |
| --- | --- | --- |
| Child account/private results | Necessary for the chosen account service; parent/family deletion implemented. | Define continued necessity, inactive-account handling and a review/deletion timeframe. "Active forever" is not a final schedule. |
| Unused signed-form request | Logical 14-day expiry; bounded maintenance removes expired unused SQL rows. | Qualify maintenance cadence and backlog handling. |
| Rejected/incomplete messages/files | The candidate notice specifies 14 days; synthetic mailbox and known-copy cleanup passed. | Keep the operating pass and provider-copy limitations accurate in the final notice. |
| Approved but unused attachment | The candidate notice specifies removal within 14 days of request expiry or cancellation; the synthetic lifecycle passed. | Qualify production integration and the continuing operating pass. |
| Used consent attachment | The candidate retains it while the child account is active, then specifies removal within 14 days of withdrawal/deletion; the synthetic lifecycle passed. | Qualify production integration, continuing review and provider/recovery-copy limits. |
| Daily-limit withdrawal receipt | The owner chose a minimal permission record for 14 days after the control is switched off; the setting and usage total are removed immediately. Draft cleanup deletes the receipt on the next scheduled pass after 14 days, or the child-account cascade removes it sooner. | Before enabling, apply and verify the reviewed schema and grants, enable and monitor receipt maintenance, and qualify recovery and real-device behavior. Keep `CHILD_DAILY_USAGE_RECEIPT_RETENTION_ENABLED` on even if collection is disabled; disable it only after confirming no receipts remain. A restore can omit newer receipts, and recovery copies can retain data longer. |
| Private retention register | Proposed minimal reference/digest/locators and completion marker. | Decide justified finite completion-marker period; remove unnecessary locators after all-copy deletion. |
| Sessions | Access expiry is 4 hours or remembered 30 days. Bounded global cleanup passed local tests but is not deployed. | Deploy and verify its actual schedule and backlog handling; logical expiry is not physical erasure. |
| Eligibility/provider/parent attempts | Logical 5-minute validity. Some cleanup is on subsequent begin or maintenance. | Inventory each physical purge path and adopt finite cleanup/backlog handling. |
| Anonymous registration restriction | At most 24 hours in tab marker/cookie. | Qualify device behavior; no raw age/account data in marker. |
| Submission retry receipts | Existing cleanup cutoff 24 hours. | Confirm actual configured execution/backlog and recovery-copy handling. |
| Deleted-account Apple token | Existing seven-day authorization cap, early purge headroom. | Qualify actual maintenance; token authorization cap is not a universal backup-erasure deadline. |
| Logs, audit/journal and recovery copies | Source does not establish all operational schedules. Prior cutover snapshot recorded eight scheduled backups and seven-day PITR. | Refresh metadata later; adopt purpose-specific actual schedules and restore suppression. This draft performs no cloud readback. |

Logical expiry prevents use; it does not prove physical deletion. Final public
retention text must state actual purposes, need and deletion timeframes, including
accurate recovery/provider limits. No speculative inactive-account/log/journal
deletion or new TTL has been enabled.
[16 CFR 312.10](https://www.ecfr.gov/current/title-16/chapter-I/subchapter-C/part-312/section-312.10).

## Secure storage

The form mailbox has two-step verification enabled; Google confirmed its recovery
email verified on 9 November 2026. The owner opened the encrypted archive on a second
computer, and synthetic mailbox, attachment and known-copy cleanup passed. These
checks used no real family data. Verify access isolation,
and retain no passwords, recovery codes or real forms in shared artifacts.
Provider-internal recovery copies have separate retention limits.

## Provider and incident record

For each actual Cloud/Firebase, sign-in, email and storage arrangement, retain
private evidence of contracting entity, terms/coverage, roles, written security
assurances, locations/transfers, access controls and deletion/recovery behavior.
Consumer Gmail is not automatically covered by Cloud/Workspace processor terms.
No new terms have been accepted by this draft.

On a suspected exposure, restrict further collection/creation through a reviewed
incident path, protect the relevant records, establish affected data/time/users,
contain access and evaluate applicable notification duties. Do not improvise
production deletion or erase evidence before that assessment. Record corrective
actions and update the program. This draft declares no incident or completed
response exercise.
