# Matched parent-form operation: release item 2.3

Verified 5 November 2026. Item 2.3 is complete; production integration is 2.4,
privacy/legal sufficiency is 1.3, and activation remains gated by the release plan.

## Owner operation

The owner understood comparing the returned form with its pending request and
asked where that request appears. The installed **Ludolume - Solicitações
pendentes** desktop viewer now provides that missing view. The owner confirmed
seeing its two explicitly fictional examples. This is acceptance of the explained
procedure and visible queue, not a quiz result or approval of actual consent.

**Atualizar fila real** uses the existing private operator connection, pins the
database identity and reads within a read-only transaction. One live lookup
returned zero pending requests, then closed its connection and temporary proxy.
The viewer cannot approve, reject, send mail or create accounts. Actual decisions
use the existing review command after the owner's examination of the signed form.

## Four synthetic cases

The existing isolated MySQL rehearsal and actual operator CLI were exercised with
the four explicitly synthetic files staged in the encrypted archive. Each decision
was bound to the SHA256 of its actual file. No production account or provider was
created, no real consent was asserted, and no additional email was sent.

| Case | Verified behavior |
| --- | --- |
| US matching form | Approval, private child creation, used state, withdrawal, independent child absence and preservation of the parent. |
| BR mismatched reference | Rejection under the explained procedure, exact returned-file hash retained, later approval refused. |
| BR approved but unused | Controlled expiry, expired-unused observation, approval refused, SQL cleanup and retained file-cleanup deadline after the request disappears. |
| US pending | Controlled expiry, approval refused, SQL cleanup and retained file-cleanup deadline. |

The form-copy deadline is 14 days after the relevant terminal event. Boundary
behavior uses controlled synthetic times; cleanup of the fictional material was
performed immediately after rehearsal, without pretending 14 days elapsed.

Eight form copies, the training HTML/register and one freshly created encrypted
external snapshot were removed and absence verified. The external snapshot had
been copied from the normally dismounted original and verified byte-for-byte.
The real retention register and original archive were preserved; P: was normally
dismounted after cleanup. Existing older backups were not touched. Known accessible
copy removal is not a claim of forensic erasure or provider-backup deletion.

Completed item 2.2 supplies the real mailbox intake/cleanup and second-computer
recovery evidence. This rehearsal reuses it rather than repeating transport tests.
Provider identity/deletion-journal dependencies in the isolated lifecycle harness
are synthetic; item 2.4 must qualify the actual production registration path.

## Evidence and source checks

Local receipts in `C:/Users/User/Ludolume-Release-Evidence-2026-11-01`:

- `matched-form-operator-result.json`: four passing cases, source/harness hashes,
  SQL observations, file records and verified isolated-database cleanup.
- `matched-form-owner-decision.json`: procedure clarification and owner readback.
- `parent-requests-live-readback.txt`: read-only live query, zero pending requests.
- `matched-form-encrypted-backup.json` and `matched-form-copy-cleanup.json`:
  encrypted snapshot hash, exact deleted paths, timestamps and normal dismount.

Source validation: `npm run test:parent-form-retention-summary` passed seven tests;
Windows PowerShell AST parsing and `git diff --check` passed. These cover identity
pinning, read-only transaction/pagination and failures that cannot masquerade as an
empty queue or expose driver errors. The four CLI/SQL cases use runtime source
8673d6cb; the new viewer is an operator tool, not a backend runtime change.
