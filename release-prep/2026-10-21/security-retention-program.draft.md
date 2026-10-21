# Ludolume security and retention program — draft

Owner review copy, 21 October 2026. No control is marked completed merely because
it appears here. This is not a deployment configuration or a new published notice.
It accompanies the [decision package](br-us-policy-decision-package.md).

## Coordination and operation

Proposed coordinator: the existing owner/operator, subject to explicit acceptance
of this role. The owner has accepted form review; that alone does not establish
security-program coordination, storage readiness or a schedule. No employee,
paid reviewer, service subscription or mailbox invitation is introduced.

Proposed recurring manual work: check the protected mailbox, review pending
requests, reconcile retained forms and complete deletion tasks at least twice
weekly. Record each completed pass and unresolved exceptions privately. This
document creates no scheduled automation and sends no messages.

## Risks, safeguards and proof

| Risk | Existing source / proposed control | Required operational proof |
| --- | --- | --- |
| Forged, replayed or mismatched consent | Exact request/provider/account/contact/policy binding, one-use grants, private child creation and owner-only review fields. | Synthetic reject/expire/replay tests plus actual owner decision procedure; assess guardian evidence by region. |
| Provider collection before eligibility | Native/coarse-age gate, protective unknown/conflict handling, retry restriction and child provider restrictions. | Actual supported-device/network behavior; proportionate web assurance and correction handling. |
| Mailbox or attachment disclosure | Proposed two-step verification, restricted encrypted storage, no real data in Git/CI/shared screenshots, minimal duplicate copies. | Owner confirmation and synthetic access/recovery demonstration; no recovery keys or passwords in chat. |
| Retention after withdrawal/deletion | SQL cascades/expiry cleanup; read-only all-status report and proposed private reference register. | Demonstrate the actual owner pass, missing/deleted/expired/failed-lookup cases and message/file/trash cleanup. |
| Restore revives deleted accounts/permission | Existing independent deletion journal/replay and public-permission invalidation. | Qualified recovery procedure and actual retention/restore evidence; do not expire journal records speculatively. |
| Public nickname/result disclosure | Private new accounts and separately controlled public permission; draft public participation closed. | Review legacy visibility and exact hosted behavior; no blanket all-accounts-private claim. |
| Provider or incident failure | Existing guarded closure/fallback tooling and bounded database operations. | Named incident contact, private factual incident record and applicable notification/escalation assessment. |

Review risks and the program at least annually and after a material incident,
provider/data-flow change or new optional disclosure. Regularly test safeguards
using synthetic data; record dates/results and corrections. Set the initial
review date on actual adoption, not on this draft's preparation date.
[16 CFR 312.8](https://www.ecfr.gov/current/title-16/chapter-I/subchapter-C/part-312/section-312.8).

## Retention schedule requiring final adoption

| Record/purpose | Current evidence | Remaining decision or qualification |
| --- | --- | --- |
| Child account/private results | Necessary for the chosen account service; parent/family deletion implemented. | Define continued necessity, inactive-account handling and a review/deletion timeframe. "Active forever" is not a final schedule. |
| Unused signed-form request | Logical 14-day expiry; bounded maintenance removes expired unused SQL rows. | Qualify maintenance cadence and backlog handling. |
| Rejected/incomplete messages/files | Candidate notice promises deletion within 14 days. | Demonstrate all operator-controlled copies, including trash; decide precise start event for incomplete messages. |
| Approved but unused attachment | Request eventually expires/cancels; no explicit attachment deadline in current notice. | Proposed first reconciliation pass after expiry/cancellation; final wording/version and owner acceptance pending. |
| Used consent attachment | Candidate says retain while child account active; delete within 14 days of withdrawal/deletion. | Qualify the all-status report/register operation; justify necessity and provider/recovery-copy limits. |
| Private retention register | Proposed minimal reference/digest/locators and completion marker. | Decide justified finite completion-marker period; remove unnecessary locators after all-copy deletion. |
| Sessions | Access expiry 4 hours or remembered 30 days. Expired SQL rows are not universally deleted at expiry. | Decide physical cleanup schedule; current per-account/session creation/logout/deletion is not a global deadline. |
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

## Secure-storage setup to verify privately

Verify two-step protection and recovery access on the actual form mailbox. Choose
an existing encrypted, owner-restricted storage location outside the repository,
build artifacts and unreviewed sync/sharing. Verify device encryption/recovery
privately before storing real forms; do not send recovery material here. Test with
a synthetic attachment, remove it from mailbox/trash/downloaded/synced copies and
record what recovery copies remain under provider terms. Confirm that another
device user cannot casually open the archive. This draft has inspected or changed
none of those settings.

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
