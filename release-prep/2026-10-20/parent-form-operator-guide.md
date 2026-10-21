# Parent form review: owner operation

Preparation checked 2026-10-20 (2026-10-21 UTC). The owner has confirmed that he will review the returned parent forms himself. Hiring another reviewer is not part of this release. Parent-led child registration stays in the candidate source.

This guide does not activate registration, approve a real request, send email, certify guardianship or establish regional compliance. Operational storage/retention, regional policy and age assurance still require qualification before launch. See [policy review](child-policy-review.md), [synthetic rehearsal](synthetic-parent-consent-rehearsal.md) and [production cutover plan](production-cutover-plan.md).

The 21 October [decision package](../2026-10-21/br-us-policy-decision-package.md)
proposes the all-status retention reconciliation procedure, approved-unused attachment
case, consumer-mail terms and Apple relay qualification. Its private register and
security program are drafts; no mailbox/storage control is presumed completed.

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

- unused requests expire after 14 days and are removed;
- incomplete or rejected form messages are deleted within 14 days;
- approved forms remain private while the managed child account is active, then are deleted within 14 days of account-consent withdrawal or child-account deletion.

Database cleanup removes expired unused request rows; it **does not delete Gmail messages or downloaded attachments**. The owner must track the separate mailbox/file deadlines, including trash and other retained copies, and ensure that actual storage and recovery handling match the published notice. A parent may withdraw public display alone while keeping the private account, or withdraw account permission/delete the child. Verify the requester using the established account controls or approved support process; never ask them to email passwords or sign-in codes.

The owner accepting the reviewer role resolves staffing. It does not automatically approve these storage/retention arrangements, the BR/US age-assurance design or production activation. No paid review service, response-time guarantee or new external account has been introduced.
