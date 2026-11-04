# Retention history and recovery: implementation boundary

Status: the source now includes a separate GCS conditional-intent store and a
pinned-primary/restore-guard verifier, but neither is provisioned, wired or
qualified in production. The default-off activity adapter now records independent per-activity history;
see `child-continuity-sql-rehearsal.md` for source integration and test coverage.
It is not qualified for deployment or warning/deletion continuity. The
inactivity deletion candidate remains disabled. A parent who has not confirmed
the warning remains pending.

The proposed product signal is successfully recorded, authenticated online
activity; offline use or a failed activity report is not observable. The parent
notice must state this limitation before enabling the feature. The verifier
does not claim to detect those missed events.

## Concrete conditional journal and restore guard

`createGcsRetentionJournal` uses a pinned bucket separate from the unconditional
deletion journal. It creates an authenticated, conditional record with a
create-only precondition and does not blindly retry an uncertain write. Its
reconciliation reader validates object generations and HMACs, refuses
soft-deleted records or changing inventories, and must be treated as private.
It does not grant permission to replay deletion. The HMAC key must be independent,
durably recoverable and inaccessible to browser clients.
Per-child checks use a keyed, opaque prefix so that assessing one child does not
list or download the entire journal. Global inventory remains available for
administrative recovery.

`createPinnedPrimaryHealth` checks the exact database and writable server UUID,
an authenticated active restore guard with a bounded expiry and unchanged object
generation, and the absence of an earlier conditional intent for that child.
It fails closed on provider or database errors. A matching old intent requires
reconciliation: the exact authenticated parent can record an append-only kept
resolution only after later activity is visible on the locked SQL relationship.
The verifier clears that intent only while SQL still confirms that activity.
A deleted resolution never clears a restored live account automatically.
For a normal successful inactivity deletion, the service records a signed
deleted outcome only after the SQL transaction confirms commit. If that
outcome write is unconfirmed, the conditional intent remains for manual
reconciliation; it is never blindly retried.
`reconcileDeletedRetentionIntent` can record a deleted outcome only after an
administrator's exact SQL user/database/server pins and the held restore guard
are checked against an absent account on the drained original primary. It uses
a short global MySQL read lock while recording the outcome; this blocks writes
to all databases on that server and needs the administrative `RELOAD`
privilege. The target is checked before acquiring the lock, and an uncertain
lock/transport state discards the SQL connection. This lock is a short additional
fence, not a replacement for stopping writers before and after the operation.
`reconcileRestoredDeletedIntent` applies that signed outcome only to a separately
pinned, isolated restore, under parent/child locks, when restored activity is no
newer than the intent. Both operations need a qualified administrative caller;
their confirmation strings are deliberate review friction, not proof that
traffic was actually drained. No unresolved intent is automatic replay authority.
GCS and SQL tests use a
synthetic transport and disposable database, respectively; no GCS bucket or
guard has been created.

**Administrative restoration is a critical assumption.** Before any restore,
an authorized operator must change the signed guard to `hold` using its current
generation, stop and drain all old writers and maintenance jobs, reconcile the
complete conditional-intent inventory against the primary and restored target,
and only then requalify the target and create a new active guard/epoch. The
health verifier checks the guard but cannot detect a restore that bypasses this
procedure and preserves the same server UUID. A guard change is not itself a
writer fence. Keep cutover and deletion disabled whenever that process or the
outcome of a conditional intent is uncertain.

## Why the existing journal is insufficient

The explicit-account-deletion journal records an unconditional deletion
intent. It cannot represent an inactivity decision that is cancelled when a
child signs in or a parent chooses to keep the account. Writing such an intent
and then losing a SQL commit could cause the existing recovery replay to delete
an account despite a subsequent keep action. The separate `RetentionJournal`
interface intentionally does not write into that journal.

An independent intent by itself is also insufficient. A restored database may
predate a successful activity or keep action. Reading only the restored activity
timestamp would mistake old state for the latest state. Even an intact external
event list does not prove completeness if an activity request could reach the
database without first being recorded, or if tracking failed before reaching
the server.

## Proposed durable protocol to qualify

1. **Separate history and identities.** Use an independently administered,
   private, access-controlled store for retention records, separate from the
   explicit deletion journal and from SQL backups. Pin the exact resource and
   environment. Do not put email addresses, signed forms, passwords, game
   events, or warning contents in the history. Define access, retention,
   erasure, restoration, costs, and key ownership before provisioning.
2. **Record before a successful activity or keep commit.** Every tracked
   child-creation, interactive activity, score, login, and keep path must share
   the same child serialization boundary, and write an authenticated,
   create-only activity event before its SQL transaction can commit. If the
   event write is unconfirmed, do not claim that tracking succeeded. An event
   persisted while SQL later rolls back conservatively invalidates an older
   warning; it must not be discarded merely because the SQL write is absent.
   Events need unique operation identifiers and an ordering or watermark
   protocol that can be compared across primary and restored environments.
3. **Record conditional retention intent separately.** The intent must bind the
   exact parent, child, activity watermark, warning version, acknowledgment and
   deadlines. A lost acknowledgment is ambiguous: reconcile the exact
   operation before retrying. Never replay it through the unconditional
   account-deletion journal.
4. **Require coverage, not just a latest event.** Establish an independently
   durable account-tracking start, writer-epoch and coverage evidence from
   that start through the decision and recovery cutover. A missing heartbeat,
   detected outage, unrecorded writer, failed reporting, unexpected history
   change, or unknown clock makes coverage unknown and holds deletion. A
   storage event list alone cannot prove requests that failed before the server
   recorded them; the product must define and verify how such gaps are detected
   before it can call the coverage complete. Offline-only play is not measured.
5. **Fence restores and recheck.** A restored database cannot safely race a
   still-running primary. Before replay, isolate the restored target, fence and
   drain *all* old writers using an independent durable epoch, and establish a
   stable authenticated history snapshot covering all activity and keep events
   through that fence. With the parent then child locks held, compare the
   snapshot, intent, relationship, warning, contact, SQL activity, deadlines,
   and current epoch. Any later activity/keep, incomplete coverage, uncertain
   writer fence, changed snapshot, or unconfirmed parent warning holds replay.
   Repeat the check immediately before cutover. SQL locks on an isolated target
   alone do not fence writers against the primary.
6. **Prove failure handling.** Exercise lost write acknowledgments, rollback
   after event creation, activity before/during deletion, parent keep after a
   failed commit, tracking outage and recovery, stale restored databases,
   concurrent primary writers, changed epoch, and unavailable history. Each
   test must show a hold unless all required evidence is complete; do not
   merely mock the final continuity verifier as `true`.

Cloud Storage is a possible component, not an already provisioned solution.
Google documents strong read-after-write and object-listing consistency and
atomic individual object operations, plus generation preconditions for
conditional writes. These properties do not create a cross-system transaction,
prove that every client request was observed, or fence another database. See
[Cloud Storage consistency](https://docs.cloud.google.com/storage/docs/consistency)
and [request preconditions](https://docs.cloud.google.com/storage/docs/request-preconditions).

## Current unresolved work

No independent per-activity history, provider-level writer fence, automated
restore integration, or provisioned GCS journal exists. The prepared pinned
administrative command is described in `retention-reconciliation-command.md`
and requires a reviewed cutover and drained writers. The new
primary verifier depends on the administrative restore protocol above; it does
not prove that offline or failed client activity was seen. The activity writer
presently updates SQL only. Runtime composition, warning notification,
schema/grants, restricted-runtime tests and end-to-end device validation are
separate prerequisites.
