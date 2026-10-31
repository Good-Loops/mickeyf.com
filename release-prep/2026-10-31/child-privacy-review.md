# Child privacy release review — 31 October 2026

This is an engineering review of the candidate at `1b977236`, not a finding
that a jurisdiction's requirements have been met, an authorization to publish
the candidate notice, or a change to production. Review the deployed build,
configuration, and owner-operated process again before release.

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
   signed-form text and public child section in `shared/privacyNotice.json`
   say that unused requests expire and are removed after 14 days. The database
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
   mechanism. Do not interpret failed lookups as successful absence checks.
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
