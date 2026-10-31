# Child privacy release review — 31 October 2026

This is an engineering review of the candidate at `1b977236`, not a finding
that a jurisdiction's requirements have been met, an authorization to publish
the candidate notice, or a change to production. Review the deployed build,
configuration, and owner-operated process again before release.

Later work on 31 October prepared Portuguese translations for all notice
sections and the Brazilian form and country-selected registration controls;
bound both language versions to the form policy digest; and corrected the
expired-request wording. Some account-management screens remain English. These
source changes do not resolve the operational and regional qualification gaps
below and are not a published notice.

## Newly published Brazilian guidance

On 28 October, Brazil's ANPD published the final general guide to the scope and
general obligations of the ECA Digital. This supersedes the 21 October decision
package's statement that the general guide had not yet been found in final form;
it is distinct from the separate age-assurance guidance. The guide explains
preventive, protective, informational, and security duties, and emphasizes
context and proportionality. Its summary lists privacy settings, age assurance,
parental supervision, moderation, and compulsive-use safeguards as relevant
examples; it does not establish that every listed mechanism must be implemented
identically in every product. Assess Ludolume's actual content, risks, audience,
supervision and intervention capabilities against the complete guidance.

Sources: [ANPD announcement, 28 October 2026](https://www.gov.br/anpd/pt-br/assuntos/noticias/anpd-publica-guia-que-esclarece-quem-deve-cumprir-e-quais-sao-as-responsabilidades-das-plataformas-na-protecao-de-criancas-e-adolescentes),
[published guide](https://www.gov.br/anpd/pt-br/centrais-de-conteudo/materiais-educativos-e-publicacoes/guia-fornecedores-de-produtos-ou-servicos-de-tecnologia-da-informacao.pdf/@@display-file/file),
and [ANPD age-assurance portal](https://www.gov.br/anpd/pt-br/assuntos/eca-digital/).

## Notice and process gaps

1. **Logical expiry is not a guaranteed physical deletion deadline.** The
   current signed-form text and public child section in `shared/privacyNotice.json`
   say that unused requests expire after 14 days and expired records are removed
   during maintenance. They do not promise SQL removal within 14 days. The database
   rejects expired requests immediately, but physical cleanup occurs through
   bounded maintenance (`backend/ts/accounts/signedParentFormReview.ts`) or an
   opportunistic cleanup on a later request
   (`backend/ts/accounts/parentRegistrationRepository.ts`). Establish actual
   cadence, backlog monitoring and deletion timeframes, and describe them
   accurately. Mail attachments are outside database cleanup.
2. **Form retention must match actual operations.** The candidate promises that
   rejected or incomplete messages and approved forms after withdrawal/deletion
   are deleted within 14 days. The owner previously agreed to manual review
   and twice-weekly cleanup; qualification still needs to cover every relevant
   mailbox, trash, local copy, approved-but-unused form, and provider/recovery
   copy. The retention report is a read-only lookup, not an automatic deletion
   mechanism. The existing register and report require a request reference;
   messages without a usable reference need a separate private tracking and
   deadline process, which has not been rehearsed. The candidate also does not
   describe an approved form whose request expires before an account is created.
   Do not interpret failed lookups as successful absence checks.
3. **The retention notice needs actual defined periods.** The candidate mentions
   separate schedules for security records and recovery copies without stating
   them, and does not set an inactivity rule for child data. For covered child
   data, 16 CFR 312.10 requires a written policy in the notice with purposes,
   the business need for retention and deletion timeframes; indefinite retention
   is not allowed. Do not invent dates to fill this gap. Determine the actual
   cloud, mailbox, database, backup, audit, and local-file behavior and adopt
   enforceable schedules first.
4. **Brazilian parent-facing information remains English-only in the app.**
   `frontend/ts/pages/Privacy.tsx`, `frontend/ts/components/SignedParentForm.tsx`
   and the relevant parent-registration controls present English content. The
   existing Portuguese parent instructions are explicitly a review draft and do
   not translate the full direct notice or signed form. Produce and review
   Portuguese content for the complete versioned experience, make it available
   to the parent at each applicable step, and retain the exact consent/version
   binding. A translated, unbound summary alone is not the permission granted.
5. **Provider roles need evidence.** Google states that the consumer versions
   of Gmail and Drive are not processor services and do not have a Google data
   processing agreement. Do not attribute Google Cloud or Workspace processing
   terms to the Gmail mailbox. Document the actual service role, relevant terms,
   written security assurances, and the applicable Brazilian transfer analysis.
   [Google privacy help](https://support.google.com/policies/answer/9581826?hl=en).
6. **Contact publication history needs reconciliation.**
   `frontend/PRIVACY_NOTICE.md` says the postal address and telephone were not
   authorized when that document was written, while the later current notice and
   `frontend/ts/pages/Privacy.test.mjs` include them and call them owner-approved.
   Determine which record is authoritative before copying or changing those
   details; do not publish new personal information from this review alone.

The applicable U.S. rule recognizes a parent-signed form returned by electronic
scan, subject to its reasonable-efforts standard; this does not on its own prove
the Ludolume operation or Brazilian requirements are satisfied. See
[16 CFR 312.5](https://www.ecfr.gov/current/title-16/chapter-I/subchapter-C/part-312/section-312.5),
[312.8](https://www.ecfr.gov/current/title-16/chapter-I/subchapter-C/part-312/section-312.8),
and [312.10](https://www.ecfr.gov/current/title-16/chapter-I/subchapter-C/part-312/section-312.10).

## Completion evidence still needed

Read-only cloud configuration observed 31 October: the `cms-mickeyf` Cloud SQL
instance has automated backups enabled, retains eight automated backups by count,
and has seven-day point-in-time recovery. The `_Default` and `_Required` logging
buckets have configured retention of 30 and 400 days, respectively. These are
configuration facts, not proof that a particular category of child information
is logged, proof of its actual lifetime in every copy, or a universal erasure
deadline. Determine actual data and restore behavior before publishing schedules.

On 31 October the Google security page for `mickeyf.plays@gmail.com` showed
two-step verification enabled since 12 April 2024. On 31 October the `ParentForms`
directory and its subdirectories were not marked EFS-encrypted. An attempt to
set encryption reported access denied on the existing contents; a separate
readback showed the root directory remained unencrypted even after an apparent
success. The known contents were setup materials and synthetic data. Keep real
forms out until directory inheritance, existing copies and a separately tested
recovery backup are verified. After the owner reported applying encryption,
readback still showed the directory unencrypted, and a newly created synthetic
file did not inherit encryption; the synthetic file was removed. Explorer
continued to show the encryption checkbox selected, according to the owner. A
separate empty synthetic directory could not be encrypted by this process, and
a synthetic file created in `Incoming` was not encrypted; both were removed.
The source of the discrepancy is unknown. The owner previously deferred a
restore test on another Windows device.

As an alternative, the owner authorized installation of the signed VeraCrypt
1.26.29 package. A new 1 GiB file container was created with a password entered
privately by the owner. A synthetic file was written while mounted, the volume
was dismounted and reopened with the owner's password, and the same synthetic
content was read and removed. Empty intake/review folders and a header-only
register were created inside the container; it was then dismounted. A snapshot
of the dismounted container was copied to the owner's selected D: drive, a
different physical SATA disk, and SHA-256 readback matched the original. This
does not establish that the disk is removable or offline, and the backup does
not update automatically. A restore on a separate device remains untested.
Existing EFS files and the prior EFS recovery backup were not migrated or
removed. Do not receive real forms until the complete intake, all-copy deletion
and recovery operation is qualified.

Record the exact tested build and reviewed notice/form/consent versions; qualify
the parent review and all-copy deletion process with synthetic records; validate
the restore and deletion-replay procedures and real device age-signal behavior;
and complete the child-data retention, service-provider, Portuguese-language and
Brazilian safeguards assessments. The existing project rehearsal and relay
evidence are useful partial evidence, not a substitute for the full lifecycle.
Keep account creation closed until the actual prerequisites are met.

## Owner decision: proposed inactivity policy

On 31 October 2026, the owner selected a proposal to delete future
parent-managed child accounts after three years of inactivity, with a warning
to the parent before deletion. This is a product decision, not an enabled
deletion job or a statement of the current notice. Existing accounts such as
Good-Loops are outside its scope. Before implementation, define and verify a
reliable activity signal, warning and grace period, delivery failure handling,
parent choices, deletion and recovery replay, and an enforceable schedule. Do
not infer inactivity from missing session rows, or delete accounts merely
because this proposal exists.

The current source does not retain a reliable per-child last-activity time or
provide warning-email delivery, bounce handling, or a current-contact workflow.
Sessions may be removed on logout or cleanup, and game scores are not a complete
record of use. A possible implementation starts a prospective clock for newly
created managed accounts, records minimal successful interactive activity, warns
the parent at a currently verified contact and provides a keep-account action.
A 30-day warning period is a proposal, not an owner decision. The process must
stop for missing activity/contact or unconfirmed delivery, and must use a tested
child-only deletion and recovery path. The existing withdrawal flow requires
fresh parent proof and is not itself an automated inactivity-deletion job.

## Follow-up implementation decision

The owner confirmed that a parent-managed child account stays pending when the
parent does not respond to the warning. A sent message or lack of a bounce is
not confirmation. The candidate measures authenticated online activity and
discloses that offline play may not update the timer; it must hold when the
reliability of activity tracking is unknown. A warning is considered no sooner
than 30 days before the third calendar anniversary, and deletion is considered
no sooner than both that anniversary and 30 days after the parent's confirmed
receipt. Later activity or a keep action invalidates the warning.

The code and isolated tests prepared after the initial review are disabled and
do not by themselves complete the process. Current-contact verification,
reliable tracking health across outages and restores, independently durable
retention history, operator notification, and an end-to-end privacy and device
review remain necessary. See `backend/docs/child-inactivity-candidate.md`.
