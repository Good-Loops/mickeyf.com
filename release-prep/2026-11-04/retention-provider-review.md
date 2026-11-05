# Retention and provider review — 4 November 2026

Release item **1.3 remains open**. This records verified findings and the concrete
remaining work; proposed deadlines below are not yet operating guarantees or
published promises. Reuse the completed 2.2 and 3.2-3.7 evidence.

## Verified now

| Store / purpose | Evidence and limitation |
| --- | --- |
| Brevo warning delivery | Saved retention UI: all senders, one month, never store previews for new messages. Anonymous engagement reporting and actual bilingual delivery were already qualified. Saved delivery evidence in our own database survives provider-log expiry. |
| Production recovery copies | Eight successful automated backups and four on-demand snapshots: 12 September, 2 October, 6 October and 4 November. Seven-day PITR was verified in 3.4. Count-based backup rotation does not establish a universal eight-day maximum. |
| Independent activity/warning evidence | Private versioned bucket, seven-day soft delete, no expiry rule. Events are signed state/ledger digests, not a copy of every game interaction or an anonymous record. SQL stores account-linked activity and warning state. |
| Conditional deletion evidence | Separate private bucket and key; signed child/parent identifiers, dates, intent and outcome. Existing guard is held. All eight deletion/recovery checks passed on isolated SQL and real private cloud storage; fixture cleanup passed. |
| Parent-form copies | Encrypted archive/recovery and unmatched-message intake/cleanup passed 2.2. Matched approval/rejection/expiry/withdrawal and backup cleanup still need 2.3. |
| Account sessions | Four-hour/remembered 30-day access expiry is enforced. The serving revision cleans expired rows only on later session creation/account deletion. The candidate now adds bounded global cleanup to authenticated maintenance; it is tested but not deployed. Logical expiry is not physical erasure. |

Local evidence is in `C:/Users/User/Ludolume-Release-Evidence-2026-11-01`:
`brevo-retention-observed-2026-11-04.txt`,
`privacy-backup-inventory-2026-11-04.json`,
`deletion-recovery-17d4b341.json`, and the earlier warning/parent-form receipts.
No production backup or retained account evidence was deleted in this review.

The session cleanup passed backend TypeScript checking, 25 focused unit/router
checks and 46 SQL integration checks on disposable MySQL 8.0.31. The SQL cases
cover cross-account expiry, non-UTC connections, live/renewed-session preservation
and draining a 1,001-row backlog over two bounded passes. The harness removed its
container/network. Commands and logs: `session-retention-*-2026-11-04.txt` in the
evidence folder. Existing schema, grants and scheduler are reused.

## Recommended schedule to implement and qualify

Keep the existing three-calendar-year warning and twelve-further-calendar-month
wait. Keep the owner's existing twice-weekly form review; add the following to
that same operating pass instead of creating another review system.

| Record | Proposed rule and required enforcement |
| --- | --- |
| SQL snapshots/exports | Maximum 30 days for operator-restorable copies, including manual snapshots and local exports. Inventory at each pass; remove copies approaching the limit. Preserve a current successful recovery point. Exact old backup removals require a concrete deletion review. |
| Activity/warning witnesses | Keep the current witness and evidence needed by every permitted recovery point or unresolved intent. Remove superseded unreferenced evidence once outside the backup window. After verified account deletion, remove account-linked history within 45 days, including seven-day soft delete; qualify this before promising the deadline. |
| Deletion intents/outcomes | Retain until all backups capable of reviving the account have expired and reconciliation is complete, then remove within the same proposed 45-day account-deletion window. Never expire unresolved intents or the global restore guard by a blanket bucket rule. |
| Forms and register | Preserve the existing 14-day operator-copy deadlines. Explicitly cover approved-but-unused forms: expiry/cancellation starts their 14-day cleanup deadline. Keep only a minimal completion record for the proposed 45-day recovery window, then remove linkable references. Rebuild/rotate encrypted backup copies so deleted attachments are not silently retained. |
| Expired sessions | Candidate cleanup removes at most 1,000 expired rows per pass, preserving live/renewed sessions and reporting backlog/failure through the existing maintenance response. Local checks passed. Deploy and qualify a deadline with the actual schedule; do not claim one from access expiry alone. |
| Uncertain inactivity holds | Investigate on the twice-weekly pass; record the reason and a dated resolution action. Review continued necessity within 30 days. An expired review date does not authorize deletion without reliable activity/delivery evidence. Final treatment of an unresolvable hold still needs an adopted procedure. |

The proposed 45-day window provides room for a 30-day backup boundary, the
existing manual cadence and seven-day soft delete. It is a design target, not a
measured result. Cloud/provider physical deletion is distinct from loss of our
ability to restore a copy. No blanket object TTL was added: runtime verification
currently rejects lifecycle rules, and deleting a live witness could disable
continuity checks. Implement narrowly scoped operator cleanup and test its safety
against a permitted restore before updating the notice.

## Provider roles and assurances

- **Cloud/Firebase:** the Cloud CDPA supplies documented security commitments
  and Brazilian transfer clauses for covered contracts. Verify the applicable
  account/entity and covered Firebase services. Its deletion instruction can
  take up to 180 days after data becomes unrecoverable by the customer; that is
  separate from our proposed backup window. [Cloud CDPA, sections 6-7 and Brazil appendix](https://cloud.google.com/terms/data-processing-addendum).
- **Brevo:** the public terms dated 1 October 2025 incorporate a DPA. It describes
  processing on customer instructions, confidentiality/security measures,
  subcontractors and customer-controlled retention. France/Belgium hosting and
  other international support/subprocessor locations are listed; do not claim
  that all processing stays in France. Transactional logs contain parent contact
  and message metadata even with anonymous engagement reports. [Terms, DPA and security appendix](https://www.brevo.com/legal/termsofuse/).
- **Consumer Gmail:** its own Terms and Privacy Policy apply; it is not covered
  by a Google processor DPA. Our form deliberately excludes child names,
  credentials and birth dates, but parent contact, signature and linkable request
  references still require protection and transfer analysis. Public Google
  retention guidance describes longer system/backup deletion, including backup
  storage up to six months, with stated exceptions/delays. Do not promise that
  deleting mailbox copies erases every Google copy within 14 days.
  [Service role](https://support.google.com/policies/answer/9581826?hl=en),
  [retention](https://policies.google.com/technologies/retention?hl=en).

Brazil's ANPD identifies the EU as adequate under Resolution 32/2026. This can
inform the direct France transfer assessment, but does not automatically settle
every onward transfer or each provider's contract. Record the actual route and
mechanism. [ANPD transfer guidance](https://www.gov.br/anpd/pt-br/assuntos/assuntos-internacionais/transferencia-internacional-de-dados).

## Close 1.3 only after

Adopt and enforce the schedule; qualify copy cleanup through 2.3; resolve provider
coverage/transfers and persistent holds; record the operator's security-program
responsibility; and bind accurate English/Portuguese retention text to the notice
and form versions. Finish the product-specific Brazil safeguards assessment using
the published October ANPD guide. The remaining signed-device evidence belongs
to 1.2/5.3 and must not be inferred from this review.

These are existing requirements under 1.3, not additional plan substeps.
[COPPA retention](https://www.ecfr.gov/current/title-16/chapter-I/subchapter-C/part-312/section-312.10),
[security/provider assurances](https://www.ecfr.gov/current/title-16/chapter-I/subchapter-C/part-312/section-312.8),
[ANPD general guide](https://www.gov.br/anpd/pt-br/centrais-de-conteudo/materiais-educativos-e-publicacoes/guia-fornecedores-de-produtos-ou-servicos-de-tecnologia-da-informacao.pdf/@@display-file/file).
