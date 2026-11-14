# Ludolume security and retention program — current operating review

Updated 9 November 2026; retained at its original draft path for continuity. The
owner adopted the operating schedule on 9 November. Adoption does not complete
production or device qualification. This is not a deployment configuration or
a published notice.
It accompanies the [decision package](br-us-policy-decision-package.md).

## Coordination and operation

On 5 November 2026, the owner accepted the coordinator role: review the written
safeguards at least annually and after major changes or incidents, handle privacy
incidents, and oversee the existing twice-weekly form and deletion checks. The
owner may ask Codex for assistance; this does not establish autonomous monitoring
or a scheduled service. The separate 9 November schedule decision adopts the
purpose-specific periods below; it does not authorize unidentified deletions or
certify unfinished controls. No paid reviewer or subscription is introduced.

Adopted recurring manual work: check the protected mailbox and pending requests,
reconcile forms, review held warnings, inventory operator-restorable backups and
complete qualified deletion tasks at least twice weekly. Record completed passes,
original hold dates, due dates, concrete actions and exceptions privately.
By 30 days from a recorded warning hold, decide continued necessity and an action;
missing dates require prompt review, not a fresh 30-day allowance. Repair the
verified contact/evidence, use authenticated parent Keep/delete, or obtain an
account-specific owner decision through the qualified journaled deletion path.
An unresolved exception must name the remaining data, purpose and next decision
date. Failed email or an expired review date never authorizes automatic deletion.
This document creates no scheduled automation and sends no messages.

## Risks, safeguards and proof

| Risk | Existing source / proposed control | Required operational proof |
| --- | --- | --- |
| Forged, replayed or mismatched consent | Exact request/provider/account/contact/policy binding, one-use grants, private child creation and owner-only review fields. | Synthetic reject/expire/replay tests plus actual owner decision procedure; assess guardian evidence by region. |
| Provider collection before eligibility | Native/coarse-age gate, protective unknown/conflict handling, retry restriction and child provider restrictions. | Actual supported-device/network behavior; proportionate web assurance and correction handling. |
| Mailbox or attachment disclosure | Two-step verification is enabled on the form mailbox; Google confirmed the recovery email verified on 9 November. The encrypted archive, synthetic mailbox cleanup and recovery on a second computer were exercised. | Verify access isolation; keep real forms and recovery material out of shared artifacts. |
| Retention after withdrawal/deletion | SQL cascades/expiry cleanup; owner review and synthetic form-copy lifecycle passed in 2.2–2.3. | Qualify production integration, continuing retention and provider recovery-copy limits. |
| Restore revives deleted accounts/permission | Independent deletion journal/replay, authentication reset and public-permission invalidation passed the isolated restored-target qualification. | Fresh production recovery coverage and known-copy checks before an actual restore or retirement; do not expire needed journal records speculatively. |
| Public nickname/result disclosure | Private new accounts and separately controlled public permission; the live public-score configuration is enabled. | Qualify final-device and supported-client behavior; no blanket all-accounts-private claim. |
| Provider or incident failure | Existing guarded closure/fallback tooling and bounded database operations. | Named incident contact, private factual incident record and applicable notification/escalation assessment. |

Review risks and the program at least annually and after a material incident,
provider/data-flow change or new optional disclosure. Regularly test safeguards
using synthetic data; record dates/results and corrections. The next annual
review is due no later than 9 November 2027, with earlier review after a relevant
change or incident.
[16 CFR 312.8](https://www.ecfr.gov/current/title-16/chapter-I/subchapter-C/part-312/section-312.8).

## Adopted retention schedule and qualification boundary

The owner decision and current operating addendum in the local release-evidence
folder govern this schedule. The [November provider review](../2026-11-04/retention-provider-review.md)
separates current findings from historical drafts. Times below do not establish
unverified production execution or erase provider-internal copies.

| Record/purpose | Adopted period or deletion trigger | Existing mechanism and remaining rollout proof |
| --- | --- | --- |
| Account/private results and current activity/warning proof | While necessary for account service, warnings and safe recovery; reassess through account/inactivity and hold reviews. Delete when the account/purpose ends, then apply the recovery periods below. | Existing account cascade and journaled deletion. Current warning state is bounded; old fields are not all needed for callbacks, but complete-state proof and retained intents bind the record. No blanket 45-day per-field expiry or general compaction engine is adopted. |
| Unused signed-form request | Logical 14-day expiry, then expired-unused-row maintenance. | Existing bounded cleanup; verify actual cadence/backlog with production registration in 2.4. |
| Rejected/incomplete messages/files | Remove controlled copies within 14 days. | Verified mailbox/archive/known-copy procedure in 2.2–2.3; continue the twice-weekly pass. |
| Approved but unused attachment | Remove within 14 days after request expiry/cancellation. | Verified synthetic lifecycle; production integration remains 2.4. |
| Used consent attachment | While the managed account is active, then remove within 14 days of account-permission withdrawal/account deletion. | Verified synthetic lifecycle; include Trash and encrypted recovery copies. Separate request/review metadata follows its account/expiry process. |
| Daily-limit withdrawal receipt | Remove limit/use total immediately when switched off; keep minimal permission receipt 14 days, then remove on the next scheduled pass or sooner with account deletion. Restore resets the setting/total. | Before enabling, verify schema/grants, actual receipt maintenance and device behavior in 2.4/3.8 and 1.2. Keep `CHILD_DAILY_USAGE_RECEIPT_RETENTION_ENABLED` on until no receipts remain even if collection is off. A restore can omit newer receipts. |
| Operator-restorable database backups/exports | Maximum 30 days, reviewed twice weekly; preserve current usable recovery. | Inventory known cloud/local/external copies and separately review exact destructive actions. Provider-internal periods are separate. |
| Deleted-account recovery history and minimal completion register | Remove within the 45-day target after confirmed deletion, including seven-day storage soft deletion. Remove unnecessary file locators promptly. | Qualified checkpoint/effect/floor verification and exact-object retirement; all permitted recovery points must be newer and intents resolved. A specific unresolved recovery exception requires a restricted purpose, reason, action and dated review. |
| Superseded external activity/warning snapshots | Remove within the 45-day target after replacement/resolution, including seven-day soft deletion, once outside permitted recovery needs. | Bounded active-witness retirement is qualified at `de8fa7d9`; preserve the current witness and unresolved proof. Live operation must satisfy its signed selection, identity and writer/copy conditions. |
| Sessions | Access expires after 4 hours or remembered 30 days; expired rows are removed by bounded maintenance. | Candidate global cleanup and backlog handling passed local/SQL checks. Verify actual scheduled execution in 2.4/3.8; access expiry is not physical erasure. |
| Eligibility/provider/parent attempts | Five-minute logical validity followed by existing bounded cleanup. | Existing physical-purge/backlog paths; qualify production cadence in 2.4. |
| Anonymous registration restriction | At most 24 hours in tab marker/cookie. | No raw age/account data in the marker; remaining device behavior belongs to 1.2. |
| Submission retry receipts | Existing 24-hour cleanup cutoff. | Restored-target receipt job qualified; verify normal production schedule/backlog in 3.8. |
| Deleted-account Apple token | Existing seven-day authorization cap and earlier purge headroom. | Verify ordinary maintenance in 2.4/3.8; the authorization cap is not a provider-backup erasure deadline. |
| Provider logs | Brevo is configured for one-month transactional logs and no previews of new messages; other provider categories retain their reviewed separate periods. | Anonymous engagement is separate from message-linked delivery/recovery evidence. Provider findings and limits are recorded in the current review. |

The owner-approved isolated restored-target rehearsal passed using fictional data:
restored SQL/authentication reset, real journal reconciliation, packaged audit and
receipt jobs, running backend and isolated traffic switch. Its audit GET adapter
and synthetic credentials do not establish production bucket/IAM or provider-send
behavior; reuse the separate verified evidence rather than claiming those tests
were repeated. No production cutover or child/inactivity activation occurred.

Initial production checkpoint 1 is already prepared. Its older recovery points
must age past the verified checkpoint before the first actual guard advancement
or retirement; confirm the fresh recovery floor and known-copy inventory then.
Do not repeat preparation to restart aging. This execution prerequisite does not
require keeping a reviewed and qualified retention procedure open for calendar
waiting alone. Actual production configuration/schedule/backlog verification is
2.4/3.8; final supported-device behavior is 1.2/5.3. The combined rehearsal receipt
confirms all 15 temporary runtime resources/live buckets and both test databases
removed; storage soft deletion still lasts seven days. Final notice/form checks
are recorded separately before closing 1.3.
No public 30/45-day commitment is established merely by this source document.
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
The current provider-processing record documents standard online terms, actual
roles and the narrow essential-service transfer assessment. It does not extend
Cloud processor terms to consumer Gmail or optional provider-independent uses.
No new terms have been accepted by this document.

On a suspected exposure, restrict further collection/creation through a reviewed
incident path, protect the relevant records, establish affected data/time/users,
contain access and evaluate applicable notification duties. Do not improvise
production deletion or erase evidence before that assessment. Record corrective
actions and update the program. This document declares no incident or completed
response exercise.
