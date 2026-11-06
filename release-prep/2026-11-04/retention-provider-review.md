# Retention and provider review — 4 November 2026

Release item **1.3 remains open**. This records verified findings and the concrete
remaining work; proposed deadlines below are not yet operating guarantees or
published promises. Reuse the completed 2.2 and 3.2-3.7 evidence.

## Verified now

| Store / purpose | Evidence and limitation |
| --- | --- |
| Brevo warning delivery | Saved retention UI: all senders, one month, never store previews for new messages. Anonymous engagement reporting and actual bilingual delivery were already qualified. Saved delivery evidence in our own database survives provider-log expiry. |
| Production recovery copies | After the owner's specific approval, the 12 September, 2 October and 6 October manual snapshots were removed. The 4 November checkpoint, all eight automatic backups and seven-day PITR were verified preserved. Count-based rotation does not establish a universal eight-day maximum or complete the continuing retention policy. |
| Independent activity/warning evidence | Private versioned bucket, seven-day soft delete, no expiry rule. Events are signed state/ledger digests, not a copy of every game interaction or an anonymous record. SQL stores account-linked activity and warning state. |
| Conditional deletion evidence | Separate private bucket and key; signed child/parent identifiers, dates, intent and outcome. Existing guard is held. All eight deletion/recovery checks passed on isolated SQL and real private cloud storage; fixture cleanup passed. |
| Explicit deletion/score-withdrawal journal | A separate journal retains account IDs, action and request time. Its restore reader rejects any soft-deleted object and fails if its inventory exceeds 10,000 objects. It also needs a qualified finite-retention procedure; the conditional inactivity journal alone does not cover it. Source inspection, not a current object count or proof of an imminent outage. |
| Parent-form copies | Items 2.2 and 2.3 passed: encrypted recovery/mailbox intake, owner queue/review, four matched lifecycle cases and known-copy/temporary-backup cleanup. See [the 2.3 qualification](../2026-11-05/matched-parent-form-qualification.md). Production integration remains 2.4; this does not establish legal sufficiency or complete the continuing retention policy. |
| Account sessions | Four-hour/remembered 30-day access expiry is enforced. The serving revision cleans expired rows only on later session creation/account deletion. The candidate now adds bounded global cleanup to authenticated maintenance; it is tested but not deployed. Logical expiry is not physical erasure. |

Fresh read-only inventory on 5 November: the explicit-deletion bucket has five
versioned objects and no soft-deleted objects; the conditional history bucket
has one versioned object (the previously recorded guard) and no soft-deleted
objects; the continuity bucket has no live/noncurrent versions and 37
soft-deleted event objects. All 37 exact names and generations match the two
previous synthetic qualification cleanup receipts, with none unmatched. Their
latest reported hard-delete time is 12 November 2026 02:02:20 UTC. These counts
are a point-in-time observation and do not remove the need for a future safe
retirement procedure. No journal object was deleted by this inventory.
The oldest available automatic SQL backup started 28 October 20:46 UTC; all
five explicit-deletion objects were created on or after 30 October. Because the
deletion and withdrawal paths record the journal entry before committing the
corresponding SQL effect, that retained backup can predate those effects. Keep
all five; none qualifies for retirement against even this one recovery point.
This does not prove the effects completed or that all other backups/exports have
been inventoried.
The live Cloud SQL `get-latest-recovery-time` response also reported a PITR
window starting 28 October 20:48:22 UTC. The oldest available automatic backup
therefore remains earlier than the observed PITR window at this checkpoint;
this is not a durable floor. The owner reported on 5 November that they know of no production SQL exports
outside Cloud SQL. This is useful operational context, not an exhaustive scan
or proof that no copy exists. A project-wide Cloud SQL metadata listing on
5 November found one current SQL instance and nine listed backups, all for
`cms-mickeyf`; the oldest is the 28 October backup above. This listing does
not exclude external exports or copies in other services. Receipt:
`retention-project-wide-backup-inventory-2026-11-05.json`.

Local evidence is in `C:/Users/User/Ludolume-Release-Evidence-2026-11-01`:
`brevo-retention-observed-2026-11-04.txt`,
`privacy-backup-inventory-2026-11-04.json`,
`deletion-recovery-17d4b341.json`, and the earlier warning/parent-form receipts.
The later approved backup cleanup receipt is `approved-backup-cleanup-verified.json`.
No retained account evidence was removed by that three-snapshot cleanup.

The 5 November notice/form candidate now explicitly covers the qualified 14-day
cleanup of approved-but-unused forms after request expiry/cancellation. Both
languages distinguish our mailbox/file/recovery copies from provider-internal
backups; no immediate provider-wide erasure is promised. Notice version is
`privacy-2026-11-05.1`, form version `signed-parent-form-2026-11-05.1`.
Twenty-nine notice/form/parent-flow rendering checks and the backend form-digest
binding check passed. This clarification does not adopt the proposed 30/45-day
schedule below or complete item 1.3. Final deployment must use the matching new
notice/form versions; older approvals must not be relabeled as the new version.

The owner also approved built-in Portuguese parent controls. The candidate now
offers English/Português on the existing parent page, including Keep, withdrawal,
family deletion, leaderboard choices and inactivity guidance. Localized typed
confirmations map to the unchanged API operations; switching language clears the
entered confirmation and family acknowledgment. Existing provider/session/target
checks remain. Server-supplied consent is preserved, with a Portuguese public
consent translation shown only for the matching known text/version. This closes
the identified source-language gap, not the signed-device or production checks.

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

### Recovery-journal cleanup constraint — 5 November source review

The explicit account-deletion/score-withdrawal journal is separate from the
conditional inactivity journal. Both readers reject soft-deleted intents: the
former across its whole bucket, the latter across the requested intent prefix.
The inactivity guard activation reads that whole conditional prefix. Each reader
also rejects an inventory above 10,000 objects; the cap is a protection, not a
measured production count. Retaining everything indefinitely is therefore not a
complete operating plan, but simply deleting an old intent can block a restore
while the soft-deleted object remains. Restoring that object alone does not
remove the obstacle: Cloud Storage creates a new live generation and retains the
original soft-deleted generation until its retention period expires. The current
reader would still reject it. A versioned object's deletion may first
leave a readable noncurrent version rather than removing it. The current child
continuity reader starts at the SQL sequence; an earlier witness can still be
needed by a permitted older restore. See `gcsDeletionJournal.ts`,
`gcsRetentionJournal.ts` and `childContinuityAppendOnly.ts`.

A smaller first implementation can retain continuity witnesses for active
accounts and target cleanup at verified deleted accounts once every supported
recovery point is newer than the confirmed deletion. That avoids needing to
calculate a minimum live sequence across every backup. It does not remove the
journal soft-delete/recovery problem, establish a deletion deadline, or settle
how long evidence for a long-lived active account remains necessary; storage
growth and the disclosure still need review. Score-withdrawal intents for
accounts that still exist would also stay until a separate safe retirement
method is qualified. Keep unresolved or ambiguous records, and do not infer
confirmed effects from request timestamps.

Possible recovery simplification to evaluate: restore each soft-deleted intent
to a live generation and replay it, rather than ignoring an intent. The reader
currently rejects the original soft-deleted generation even after restoration,
so this would require a narrowly verified change to both journal readers.
Provider MD5 metadata alone is not a strong proof against adversarial content
replacement; matching names or hashes is not sufficient authorization. A
candidate is an operator-only recovery process that itself calls the Google
restore API for the exact deleted generation with ifGenerationMatch=0, records
the returned live generation in the same run, then reads and replays it while
writers remain fenced. Unknown soft-deletes, collisions and lost restore
acknowledgements must still hold recovery. The restore API and conditional
precondition are documented at https://docs.cloud.google.com/storage/docs/json_api/v1/objects/restore.
This remains unimplemented until both journal readers, partial failures and a
synthetic database recovery are qualified.

Before any cleanup is qualified, establish an enforceable oldest permitted
recovery point across automatic/manual backups, PITR and operator exports;
preserve unresolved intents and every witness needed by those recovery points.
Design a bounded, authenticated retirement/reconciliation procedure for both
journals, including versioned and soft-deleted generations, writer fencing,
failure/retry, partial completion and restore after retirement. It must not
weaken detection of an unexpected deletion or allow an old backup to resurrect
an account or public scores. Test it with synthetic records and a restored
database before adopting a deadline or changing production. A grace period or a
signed retirement marker is only a design option until these properties are
implemented and proven; neither is authority to delete existing objects.

The initial caller-supplied-date preview was removed after it was superseded by
`observedRetirementPreview.ts`. That read-only candidate verifies exact signed
observations and inventories project Cloud SQL backups and PITR; it retains
unobserved effects and those inside that floor. It does not cover external
copies or authorize deletion. Recovery-floor enforcement, complete trusted
inventories, retirement evidence, writer fencing, failure recovery and a
restored-database qualification remain necessary before real cleanup.

Provider semantics: [Cloud Storage soft delete](https://docs.cloud.google.com/storage/docs/soft-delete),
[object versioning](https://docs.cloud.google.com/storage/docs/object-versioning),
and [Cloud SQL backup retention](https://docs.cloud.google.com/sql/docs/mysql/backup-recovery/backup-options).
No bucket setting, production object, backup or deletion journal was changed by
this source review.

## Provider roles and assurances

- **Cloud/Firebase:** the Cloud CDPA supplies documented security commitments
  and Brazilian transfer clauses for covered contracts. Verify the applicable
  account/entity and covered Firebase services. Its deletion instruction can
  take up to 180 days after data becomes unrecoverable by the customer; that is
  separate from our proposed backup window. [Cloud CDPA, sections 6-7 and Brazil appendix](https://cloud.google.com/terms/data-processing-addendum).
- **Firebase product coverage:** Google's current [Firebase terms](https://firebase.google.com/terms)
  distinguish Firebase Hosting (Google APIs Terms plus Firebase Data Processing
  and Security Terms) from Firebase Authentication (Google Cloud Platform
  Terms); a separately signed offline agreement can change the applicable
  terms. A read-only Hosting API inspection on 5 November found the project's
  default site and both `mickeyf.com` and `www.mickeyf.com` marked active for
  hosting and ownership, with a release dated 4 November. This confirms domain
  association, not that all requests use that path or that Firebase
  Authentication is used. Confirm the account's applicable agreement
  before recording either as covered. Google's [Firebase privacy information](https://firebase.google.com/support/privacy/)
  describes Hosting as a global service; it separately describes Authentication
  as US-only. These are service-level facts, not proof of this project's actual
  data transfers or of a Brazilian transfer mechanism.
  Project Settings > Data privacy was inspected read-only on 5 November; it
  showed service-data information and no assigned privacy representative, but
  did not establish the project's contracting entity. The signed-in account
  opened the existing project without a Firebase terms-acceptance prompt.
  Google's [Firebase FAQ](https://firebase.google.com/support/faq) says that
  absence of such a prompt when opening an existing project indicates that
  account has already accepted the Firebase Terms. This is account-level
  evidence, not an acceptance timestamp or confirmation of the contracting
  entity. The owner reported standard online signup rather than a separate
  offline contract. This supports applying the published online service terms;
  it is not a complete conclusion about the role or transfer mechanism for every
  data category. The
  [Google APIs Terms](https://developers.google.com/terms/) identify Google LLC
  as the default contracting Google entity unless product-specific terms state
  otherwise; do not conflate this with the separate Cloud billing entity.
  The absence of a representative is not itself a determination that one is required.
  The Firebase data-processing terms discuss non-European laws generally but
  their published transfer section is framed around European transfers. The
  Cloud addendum's Brazil clauses cannot simply be assumed to cover Hosting,
  which is listed under separate terms. A focused, unsent clarification draft is
  in `firebase-hosting-brazil-transfer-question-2026-11-05.txt` in the local
  evidence folder. Firebase routes [privacy inquiries](https://firebase.google.com/support/privacy/dpo)
  through its support channel, but its [no-cost support scope](https://firebase.google.com/support/scope)
  excludes interpretation of terms; a support response is therefore not assured. The draft asks Google to identify
  applicable published materials. No support request has been sent.
  ANPD's transfer regulation distinguishes international collection from a
  transfer between an exporter and importer (articles 5-6); collection may
  still be subject to the LGPD. This distinction is relevant to examining
  browser-to-Hosting requests, but does not establish the roles, actual routes
  or classification of this project's processing. Do not assume it resolves
  the Hosting transfer question. [ANPD Resolution 19/2024](https://www.gov.br/anpd/pt-br/acesso-a-informacao/institucional/atos-normativos/regulamentacoes_anpd/resolucao-cd-anpd-no-19-de-23-de-agosto-de-2024).
- **Hosting request paths and logs:** the candidate source uses same-origin
  `/auth` and `/api` requests for the hosted website, and `firebase.json`
  rewrites those paths to Cloud Run. Native API calls use the configured Cloud
  Run origin, with the Android Apple callback separately routed through the
  Hosting URL. The callback uses a POST body and its return proof is in a URL
  fragment; neither fact proves that every intermediary's logs omit sensitive
  data. This is source/configuration evidence, not a capture of every deployed
  route. Google's [Hosting configuration](https://firebase.google.com/docs/hosting/full-config)
  describes Cloud Run rewrites. Google states that Hosting uses and retains
  incoming IP addresses for a few months; it also describes Hosting as globally
  processed. If Hosting request logging is linked to Cloud Logging, documented
  fields include the complete request URL, referrer, IP and user agent, with
  Cloud Logging retention configurable; do not put credentials or personal
  data in URLs. See [Firebase privacy](https://firebase.google.com/support/privacy/)
  and [Hosting request logs](https://firebase.google.com/docs/hosting/web-request-logs-and-metrics).
  A project-level read-only Logging inventory on 6 November listed the default
  and required sinks only, with global `_Default` and `_Required` bucket
  retention of 30 and 400 days respectively. Its 13 listed log names contained
  no Hosting `webrequests` name. This does not establish that Hosting export
  is disabled, exclude organization/folder-level routing or non-global buckets,
  reveal Google's internal retention, or settle the Brazilian transfer question.
  No individual request log was read; confirm the actual Hosting linkage and any
  remaining routing before treating this as a complete logging inventory.
- **Brevo:** the public terms dated 1 October 2025 incorporate a DPA. It describes
  processing on customer instructions, confidentiality/security measures,
  subcontractors and customer-controlled retention. France/Belgium hosting and
  other international support/subprocessor locations are listed; do not claim
  that all processing stays in France. Transactional logs contain parent contact
  and message metadata even with anonymous engagement reports. Brevo's current
  [help page](https://help.brevo.com/hc/en-us/articles/15403782599570-Where-can-I-find-the-Data-Processing-Agreement-DPA)
  confirms that the DPA appears in its Terms of Service. This does not by itself
  establish the account's contracting entity or resolve every onward transfer.
  [Terms, DPA and security appendix](https://www.brevo.com/legal/termsofuse/).
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

The product-specific October ANPD guide assessment is recorded in
[brazil-child-safeguards-assessment.md](brazil-child-safeguards-assessment.md).
It identifies the actual evidence and open risks; it is not a legal sign-off
or proof of final-device and production behavior.

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

## Recovery-safe cleanup prototype, 5 November

**Current status:** The later checkpoint design supersedes the proposed
separate observation receipts described in the historical notes below. It
rechecks the selected deletion effects in the checkpoint transaction, signs a
post-commit database time, and waits until the oldest inventoried Cloud SQL
recovery point is newer before retiring the selected objects. The app's local
grant profile allows checkpoint reads only; deployment and the audit account's
grant remain open. A disposable real Cloud Storage test passed guard advancement
and exact-generation conditional-journal retirement; its SQL recovery timing
and witness operations were simulated. The candidate checks both project-wide
Cloud SQL backup APIs for matching inventories and refuses provider warnings;
the current read-only listings matched nine backups. This does not cover copies
outside that project or establish that no exports exist. Production recovery and cleanup are not
yet qualified. No production data or settings were changed.

The owner chose to keep recovery available. A local prototype places a lineage
and monotonic checkpoint inside SQL and retains the minimum accepted checkpoint
in the independently authenticated recovery guard. The local activation and
account-health checks reject missing or older SQL state when a checkpoint is
present. An isolated MySQL test simulated old and post-checkpoint restored
states; it did not perform a Cloud SQL restore. Signed exact-generation
retirement claims and a read-only Cloud SQL inventory are separate building
blocks, not authorization to delete. The provider inventory was refined to read
the recovery window twice; that refinement is unit-tested, not separately live
qualified. The Cloud SQL inventory does not establish all external copies.

Both journal readers have an optional administrative recovery verifier; focused
synthetic tests cover signed versus unknown soft-deleted generations, changed
inventories, older restored SQL and the period after soft-delete expiry. The
ordinary reader remains strict. Both explicit and conditional recovery commands
now have local guard/checkpoint integration, including a check before
conditional replay; full end-to-end recovery qualification remains outstanding.
The explicit command requires independent guard bucket/key configuration and,
for a guarded checkpoint, a public verification key file; plans bind the guard generation.
The draft command reads `RETENTION_JOURNAL_BUCKET`, `RETENTION_CONFIRM_BUCKET`
and the existing `CHILD_INACTIVITY_KEYS`; checkpoint-aware recovery also needs
`RETIREMENT_PUBLIC_KEY_FILE`. Both commands reject a verification key whose
SHA-256 differs from the authenticated guard. These settings have not been
provisioned for production recovery and contain no authorization to cut over.
In particular, an old replay command cannot be used after
cleanup: it would not enforce the durable floor after a soft-deleted marker
expires. The prototype guard now pins the SHA-256 fingerprint of the Ed25519
public key; the verifier rejects a different key. Before any cleanup, all
recovery paths must enforce that guard, and its key and checkpoint must be
provisioned through a qualified administrative procedure.
The account-health check protects the child-retention path; it does not by
itself stop unrelated application traffic or prevent an operator from serving
an older restored database. The recovery/cutover procedure must keep traffic
fenced until both journals and the guarded target have been reconciled.
The separate read-only `runDeletionAudit` now has local checkpoint-aware reader
integration on its pinned SQL connection. Its read-only service account still
needs appropriately scoped guard-bucket access, the guard key, public key and
SQL checkpoint grant before that candidate can be deployed and qualified. Its
`RETENTION_GUARD_READ_KEY` must contain only the existing guard/journal HMAC
key, not the other values in the runtime's key bundle. Its output remains an
audit, not a recovery/cutover qualification.
The guard must also remain independent of database and bucket recovery. A valid
older signed guard generation is not evidence of the latest floor; an operator
must not roll it back along with a restored database. Guard rollback detection
and the procedure for recovering the guard itself still need qualification.

Guard advancement must be tied to verified effects and confirmed recovery
coverage, and metadata signing, cleanup and restore replay must be connected
and tested together. The schema and production grants
remain drafts. No production configuration or records were changed. Google
contact is deferred; the provider coverage question remains open.

The explicit journal records a request, not a confirmed completion time.
Absence of an account today does not prove when deletion finished. Any cleanup
candidate therefore needs a trustworthy, dated observation of its completed
effects before comparing that observation with the backup-retention boundary;
the request timestamp cannot substitute for it. Retained Apple revocation
tokens also require their own completed cleanup or a separately justified hold.
The existing preview's caller-supplied timestamps do not supply this proof.
Source review also found that a parent-registration attempt can carry a child
UUID without a child foreign key, and the short-lived Apple/Android handoff can
carry an account UUID through its provider-attempt relationship. Account-row
absence alone therefore does not prove that every account-linked transient row
has gone; the final effect check must account for these records and their
actual schema/expiry rather than assume all references cascade.
The local `verifyDeletedAccountEffects.ts` is a conservative SQL observation:
it requires the account, Apple token and parent-attempt references to be absent,
and checks handoff references when their migration is present. Unit checks and
the disposable MySQL rehearsal passed. It is not connected to a cleanup
command; the caller still has to authenticate journal identities, verify the
foreign-key schema, fence writers, retain a dated observation and check the
complete backup boundary before this could authorize retirement.
The local observation candidate now binds a database-generated timestamp and
pseudonymous account digest to an exact journal generation and content hash;
its private GCS receipt writer is create-only. Focused tests cover tampering,
remaining tokens and a lost write acknowledgement followed by a read. This has
not been connected to an operator command or run on real accounts, and neither
the receipt nor a signed retirement claim independently authorizes cleanup.
