# Parent form review: owner operation

Preparation checked 2026-10-20 (2026-10-21 UTC). The owner has confirmed that he will review the returned parent forms himself. Hiring another reviewer is not part of this release. Parent-led child registration stays in the candidate source.

This guide does not activate registration, approve a real request, send email, certify guardianship or establish regional compliance. Operational storage/retention, regional policy and age assurance still require qualification before launch. See [policy review](child-policy-review.md), [synthetic rehearsal](synthetic-parent-consent-rehearsal.md) and [production cutover plan](production-cutover-plan.md).

The 21 October [decision package](../2026-10-21/br-us-policy-decision-package.md)
proposes the all-status retention reconciliation procedure, approved-unused attachment
case, consumer-mail terms and Apple relay qualification. Its private register and
security program are drafts. The mailbox's two-step verification and a separate
VeraCrypt container were verified on 31 October; see the later
[privacy review](../2026-10-31/child-privacy-review.md) for their limits.

## Twice-weekly routine at a glance

1. Open the encrypted archive using the desktop shortcut and check the form
   mailbox, including Spam. Review each returned form against its exact pending
   request. Keep incomplete or mismatched forms unapproved; the checks below
   explain what must match.
2. Record each returned form in the private register. Use its actual request
   reference when available; for an unmatched message, use the separate local
   case ID described below, never an invented request reference. Use the
   read-only report and deadline view to check the cases on each pass.
3. Complete due cleanup across all relevant copies, including Gmail Trash,
   downloads, the archive and any backups. Record completion only after the
   copies have actually been addressed. An error or missing report is not proof
   of deletion. Close the mounted archive in VeraCrypt when finished.

This is a guide to the manual process, not evidence that the process is already
qualified or permission to delete any particular message or file. Keep new child
registration closed until the operating procedure and deadlines are verified.

## Start the email conversation

The form now asks every parent to reply to an initial message. This is necessary
for the tested Apple Hide My Email route: the parent can reply through the relay
without revealing the forwarding address. It also avoids separate instructions
for Google and Apple parents. **No email is sent automatically.** Until this
owner-operated process has been rehearsed and adopted, child creation stays closed.

On each review pass, after completing the same private administrative/proxy setup
required below, run `npm --prefix backend run parent-form:review -- pending`.
The command lists up to 50 unexpired pending requests and their verified contacts;
it does not approve a form or send mail. If `nextAfter` is not null, continue with
`npm --prefix backend run parent-form:review -- pending --after=<nextAfter>` until
the final page. A failed command is not an empty queue. Treat the output as
private account data; do not save it to a shared location or post it to chat.
The operator needs read access to `account_uuid`, `provider`, and `subject` in
`account_provider_identities` for the linked-identity check. Verify the existing
operator's actual grants during setup; this command does not change privileges.
If `providerLinked` is false, the contact is withheld: do not send a message or
approve the request. A true value only confirms the original provider identity
is still linked; it cannot prove that the provider's address has not changed.
The queue and inspection report delivery as unknown. Apple can disable relay
forwarding without unlinking the account. By default the notification handler
does not record that change. The optional relay-state candidate must not be
enabled until its separate schema, event handling, cleanup and recovery checks
are qualified. If it is enabled and shows `last-event-disabled`, the contact is
withheld; hold the request. `last-event-enabled` only describes Apple's last
observed event and does not establish current forwarding or delivery.
Handle bounces or uncertainty as a hold and ask the parent to start a new request.

For each pending reference, inspect the exact request again immediately before
writing the message with `npm --prefix backend run parent-form:review -- inspect <reference>`.
Confirm it is still pending, unexpired, the contact and policy digest match the
queue, and `provider_linked` is 1. Compare the policy and consent versions and
digest to the current approved release receipt; an old or unknown policy is a
hold, because the parent may no longer be able to use that form. Release
qualification must produce and verify that digest from the exact deployed policy;
the queue does not derive it and an operator must not assume it from the form.
Treat any
mismatch, failure or uncertain state as a hold. This check cannot prove the provider email has not changed since the
request. Then search the registered `mickeyf.plays@gmail.com` mailbox's Sent
folder for that exact reference. If an initial message has already
been sent, check the existing conversation and any returned form; do not send a
duplicate automatically. Otherwise address a new message to the exact verified
contact from the queue. Include only the request reference and the instructions
below, with no child details, account IDs, passwords or attachments. Send it from
the registered mailbox so Apple can relay it. A Sent message is not proof of
delivery or reading; investigate bounces or an absent reply and never approve
without the exact form and human review.

> Subject: Your Ludolume parent form request
>
> You requested a parent form in Ludolume. Please reply to this message with a
> photo or scan of the signed form for request `<reference>`. Do not include
> passwords, identity documents or the child's name. Check that the reference on
> the form matches. If you did not request this, you can ignore this message.

For Brazil, use the Portuguese equivalent:

> Assunto: Sua solicitação de formulário do responsável no Ludolume
>
> Você solicitou um formulário do responsável no Ludolume. Responda a esta
> mensagem com uma foto ou digitalização do formulário assinado para a solicitação
> `<referência>`. Não inclua senhas, documentos de identidade ou o nome da criança.
> Confira se a referência no formulário é a mesma. Se você não fez esta
> solicitação, ignore esta mensagem.

The parent-facing text instructs parents to check Spam and reply, including when
using Apple Hide My Email. An earlier synthetic relay rehearsal received the
initial message and its intact reply but found the initial message in Spam.
This procedure has not yet been demonstrated end to end with the new queue and
real parent-review setup. Handle unanswered or expired requests under the
retention process; do not change a verified contact to force a match.

## What the reviewer checks

1. Open the returned scan or photograph in the private operator environment. The published return address is `mickeyf.plays@gmail.com`. The parent must return it from the exact verified contact recorded for the request; a matching display name or forwarded message alone is insufficient. Do not change the recorded contact to fit a message.
2. Inspect the exact request using the existing review command. Match the reference, parent account, country, verified contact and account consent/policy versions. It must still be pending and unexpired. Match the form's full text, version and notice to the approved release; a form for an older policy cannot authorize a new one. The private form does not print the account-policy SHA; take the exact digest for the CLI from the inspected database record, not from an email or a newly calculated substitute.
3. Check that the private-account choice is affirmative, the parent/guardian declaration is present, and the handwritten signature, name and date are complete and legible. Resolve mismatches without approval. Do not request a child nickname, email, birth date, password or identity document in the form or email. The parent chooses the nickname/password in the app only after approval.
4. Treat public disclosure separately. Keep `public-permission=false` unless the exact form includes the applicable separate public notice/reference and an affirmative signed public choice. An unchecked public choice never prevents a private account. This launch's draft keeps public participation disabled.
5. Approve only after the actual checks are complete. A verified Google/Apple account establishes control of the parent account; it does not prove age or guardianship. Any additional regional assurance required by the final policy must also be satisfied. Do not interpret a store age signal or download permission as this signed consent.

An incomplete message or missing attachment stays unapproved. Do not manufacture a file, signature or review record to reject it. Unused requests expire after 14 days; a parent with an expired request needs a new current request and form. For a returned attachment that is reviewed and rejected, use the reject command with public permission false. Do not repeatedly overwrite or retry a decided request.

## Run the existing command privately

The command is `npm --prefix backend run parent-form:review -- ...` from the repository root. It requires the existing administrative migration configuration through an authenticated local database proxy, including exact database, server UUID and administrative account confirmations. **Do not copy synthetic rehearsal credentials into a real operator environment.** Do not run against production until the reviewed cutover and operator setup are complete.

Inspect takes only the reference:

```powershell
npm --prefix backend run parent-form:review -- inspect <request-reference>
```

After human review, the approved command has these exact options. Replace placeholders only in the private operator environment; the example is not executable consent:

```text
npm --prefix backend run parent-form:review -- approve <request-reference> --contact=<exact-verified-parent-contact> --form-file=<private-returned-file-path> --parent-account=<exact-parent-account-uuid> --policy-digest=<exact-64-hex-request-digest> --public-permission=false --reviewer=owner-michel --signed-parent-reviewed=true
```

Use `reject` instead of `approve` for a completed negative review of an actual returned file, keeping `--public-permission=false`. Quote argument values as required by the shell. Never put database passwords, provider tokens, signed attachments or parent-specific command transcripts in Git, shared logs or this document. The command's inspect output contains parent contact information and belongs in the private operator environment.

The CLI checks `MIGRATION_DB_HOST=127.0.0.1`, the configured database and the actual `@@server_uuid` / `CURRENT_USER()` against `SIGNED_FORM_CONFIRM_DATABASE`, `SIGNED_FORM_CONFIRM_SERVER_UUID` and `MIGRATION_CONFIRM_ACCOUNT`. It verifies schema readiness, requires the exact pending parent/contact/digest, checks expiry in the transaction, and hashes the returned file locally. It never prints the attachment or uploads it. A successful review records the decision, reviewer, time, hash and separate public permission; **it does not create the child account**. The parent must return to the app and supply fresh provider proof before creating the private child account.

If the command fails or its delivery is uncertain, inspect the same reference before considering a retry. Do not assume failure means the transaction did not commit. Inspection reports status but does not by itself prove the full recorded review evidence; use an authorized private administrative check when that evidence needs confirmation. Never bypass the command with an improvised production UPDATE.

## Storage, expiry and deletion

Before enabling the service, establish restricted mailbox access and private attachment storage, and confirm that the owner can carry out the published schedule. Keep signed forms outside the repository and build artifacts. Do not create an unapproved shared inbox or invite another person as part of this guide.

The current candidate notice promises:

- unused requests expire after 14 days; expired database rows are removed during maintenance;
- incomplete or rejected form messages are deleted within 14 days;
- approved forms remain private while the managed child account is active, then are deleted within 14 days of account-consent withdrawal or child-account deletion.

Database cleanup removes expired unused request rows; it **does not delete Gmail messages or downloaded attachments**. The owner must track the separate mailbox/file deadlines, including trash and other retained copies, and ensure that actual storage and recovery handling match the published notice. A parent may withdraw public display alone while keeping the private account, or withdraw account permission/delete the child. Verify the requester using the established account controls or approved support process; never ask them to email passwords or sign-in codes.

Gmail normally keeps messages in Trash for 30 days. Moving a message to Trash
alone does not satisfy a 14-day deletion promise; qualify the actual removal of
the specific message and copies. Do not empty unrelated mail or assume Google
provider recovery copies have been physically erased. See
[Gmail deletion guidance](https://support.google.com/mail/answer/7401?hl=en).
In the form mailbox, Gmail's `in:anywhere` search also includes Spam and Trash;
search using the message's known details and inspect matching messages and any
replies before acting. It cannot prove the absence of unindexed attachments or
messages in another account. For each message confirmed due for cleanup, move
that specific message to Trash, then select it there and choose **Delete forever**.
Do not select an entire conversation or empty all Trash unless every affected
message is due. Recheck the specific messages, not just the search results.
[Gmail search operators](https://support.google.com/mail/answer/7190?hl=en).
An encrypted container backup is a snapshot: deleting a file from the current
container does not remove it from older snapshots. No automated backup rotation
or physical-erasure deadline is established here. Test an all-copy plan before
making the 14-day notice a public promise.

Before a due cleanup, identify every archive snapshot that could contain the
form. Remove the due form from the current mounted archive, then make and verify
a fresh encrypted backup that preserves the forms still needed: dismount the
archive before copying its container, then verify that the new copy opens and
contains the remaining forms. Address the
older affected snapshots within the adopted deadline; a fresh backup does not
change those files. Do not remove the only recoverable backup of forms that must
still be kept. This is a proposed manual sequence, not evidence that a backup
restore, snapshot inventory or deletion has been tested.

## Prepare a reconciliation list from the private register

The private register can supply the request references for the existing guarded
read-only report, so the owner need not type each reference into a separate JSON
file. After completing the separately reviewed target/proxy setup, from a clean
checkout run the following in a private PowerShell 7 (`pwsh`) window. This path
is for the newly created VeraCrypt archive when mounted as `P:`; use the actual
protected register location if it is mounted under another letter:

```powershell
pwsh -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ./scripts/parent-form-ledger-input.ps1 -LedgerPath 'P:\Records\retention-register.csv' |
    npm --prefix backend run --silent parent-form:retention |
    node ./scripts/parent-form-retention-summary.mjs
```

The helper reads the existing register format and sends **only** references from
rows whose `deleted_at` is empty to the report. Set `deleted_at` only after all
applicable copies have actually been deleted. Invalid CSV, duplicate references,
invalid or future deletion dates, an empty set or more than 100 outstanding rows
produce an error rather than a partial list. Split larger registers into deliberate,
independently checked batches. A successful zero-row lookup, a failed lookup, and
no outstanding rows are different outcomes; no report is evidence of deletion.
This helper does not connect to any database, approve or delete anything, inspect
attachments, or validate that a human review was completed. It does not simplify
or bypass the target, schema, source, account and proxy checks in the report.
Both register and report contain sensitive metadata; keep them private.

To see the deadlines already entered in the register, run this local-only view
in the same private window:

```powershell
pwsh -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ./scripts/parent-form-ledger-input.ps1 -LedgerPath 'P:\Records\retention-register.csv' -DeadlineReport
```

It lists outstanding references ordered by entered deadline, flags dates due
now or within four days, and flags blank deadlines for a status check. Four
days covers the longer gap in a typical twice-weekly routine; it is a reminder
threshold, not a deletion deadline or automatic reminder. An active account
may have no deletion deadline yet. The view does not calculate the correct
deadline from the request's status or verify that an entered date is correct.
Check the guarded report and current facts before acting. A header-only register
means only that this register contains no rows; it does not prove that the
mailbox, unreferenced messages, downloads or backups have no copies. The view
does not delete anything or inspect those copies.

The optional summary displays only request references, their observed states and
short actions; it omits database target details. It rejects invalid, duplicate,
future or older-than-one-hour reports without printing a partial list. The report
does not include review dates or determine deletion deadlines: consult the
private register. A `not-found` result needs investigation and does not prove
that copies or backup contents were deleted. The summary makes no database or
file changes and does not replace the full guarded target/source checks.

For a message with no usable request reference, create a local case ID with:

```powershell
pwsh -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ./scripts/parent-form-ledger-input.ps1 -NewUnmatchedReference
```

Put the resulting `unmatched:...` ID in the register's `request_reference`
column, the actual receipt time in `received_at` as UTC (for example,
`2026-10-30T14:30:00Z`), and enough private information in `message_locator`
to locate the specific email. Choose a conservative earlier receipt time if
the exact time cannot be established; do not treat the time the record is made
as the receipt time. Keep locators inside the encrypted register. Leave
`deleted_at` blank until all copies have actually been addressed. The process-only
execution-policy option above does not change the Windows policy for other
sessions; use the reviewed script from this checkout.

The deadline view labels this as an unmatched message and calculates a
conservative 14-day deadline from receipt. An earlier entered `purge_due_at`
is accepted; a later one is rejected. These local IDs never go to the database
report and never establish that a request or consent exists. If only unmatched
messages are outstanding, use the deadline view; the database-report pipeline
will return an error because there are no actual references to reconcile. If a
valid matching request is later verified, follow the regular review process and
update the register without leaving duplicate active entries. This is a tracking
aid: it does not search Gmail or prove that all messages and copies are recorded.

The owner accepting the reviewer role resolves staffing. It does not automatically approve these storage/retention arrangements, the BR/US age-assurance design or production activation. No paid review service, response-time guarantee or new external account has been introduced.
