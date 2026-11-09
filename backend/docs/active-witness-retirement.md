# Superseded active-account witnesses

This is an operator capability, not an adopted retention deadline or a scheduled
cleanup. It removes only earlier external activity/warning witness objects. It
does not change accounts, results, consent, current SQL history, replay ledgers,
or the current external witness. The ordinary runtime reader remains strict.

Use the existing recovery retirement procedure and private credential launcher.
The source must first be committed, independently reviewed, and pinned by
`RETIREMENT_SOURCE_COMMIT`; the CLI rejects a dirty or mismatched checkout. The
production target, operator identity, buckets and keys remain the existing ones.
Keep output in the private evidence directory: object identities are linkable
operating records even though they contain no email addresses.

From `backend`, the executable is:

```text
node node_modules/ts-node/dist/bin.js ts/accounts/runRetirementOperator.ts OPERATION
```

Supply one private JSON object on stdin, using the existing environment/secret
loading procedure. In addition to existing fields, every witness command must
include `"kind":"witness"` and the same managed child's `"accountId"`.

| Operation | Additional input | Result/use |
| --- | --- | --- |
| `preview` | `offset:0` | `accountId`, up to 100 `candidates` and `more`; no mutation. |
| `prepare` | Existing `lineage`; reviewed `selected` array from preview | Signed **non-authorizing** checkpoint; preserve it unchanged. |
| `advance` | Same selection/lineage plus exact `prepared` document | `waiting`, or `advanced` with the signed `permit`. |
| `retire` | Exact `permit` and one `selected` identity from it | `{status:"retired",generation}` after provider soft-delete readback and current-head verification. |
| `inspect` | Same permit and one selected identity | `"live"` or `"soft-deleted"`; read-only reconciliation, never a retry. |

`resume` is not supported for witnesses. Preview objects contain only
`name`, `generation`, and `contentSha256`; do not add storage metadata to the
signed selection. The maximum is 100 objects for one account per checkpoint.
Finish the current batch before preparing another; a different guard advance
invalidates an unrelated batch. Refresh preview after inventory changes.

Keep the original primary and every writer/restore path fenced for each command,
including witness inspection. The exact existing writer and external-copy
confirmations are required. Between preparation and advancement, follow the
existing procedure to restore service while retained backups age. A `waiting`
result does not justify repeating preparation or deleting recovery points. Only
advance the same preparation after all permitted recovery copies are newer than
its checkpoint. No command creates a replacement backup or new cloud resource.

Every phase authenticates the current SQL state/ledger against its current
external witness. Missing/duplicate/later objects, unknown key coverage, an
uncertain initial warning write, or any retained child intent (including a
parent's explicit deletion entry) holds cleanup. Only lower sequences qualify.
A lost response remains unconfirmed: keep the fence and inspect the exact signed
identity. Do not automatically retry or expand the selection. Provider
soft-delete recovery and physical expiry retain the bucket's existing policy.

## Existing desktop wrapper

`invoke-recovery-retirement-7312.ps1` is unchanged and cannot run this new kind.
It is pinned to the preserved older checkout/source. After review and commit,
make a separately named version of that same wrapper, without changing its
credential/proxy workflow: pin this checkout and the reviewed commit, allow
`witness`, require one `AccountId` and pass it in every JSON body, bind it to the
saved preview, accept `live`/`soft-deleted` inspection results, and require writer
fencing plus copy confirmation for witness inspection. Keep `offset=0` and the
existing 100-object maximum. Use new output filenames so the existing prepared
checkpoint and running recovery rehearsal remain untouched. Do not relax source
pins to make an uncommitted operator run.

## Remaining SQL history

The current warning JSON can still contain superseded attempts. This capability
does **not** establish finite retention for all active-account history. Current
attempt IDs, message IDs, dispatch/acceptance/delivery/hold events, and
activity/contact/notice bindings support callback matching, idempotency and the
nonresponse decision. Retained conditional intents bind a digest of the entire
history, so they also block any future SQL compaction. The JSON schema and
existing witnessed before/after-state writer could support a separate bounded
compaction once policy and event/recovery dependencies are reviewed; none is
implemented here.
