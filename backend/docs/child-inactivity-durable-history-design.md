# Retention history and recovery: implementation boundary

Status: **design only; no durable activity journal or continuity verifier is
implemented**. The inactivity deletion candidate must remain disabled. A parent
who has not confirmed the warning remains pending.

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

No independently durable activity or intent writer, writer fence, coverage
monitor, history lifecycle, or restore verifier exists in this candidate. The
existing `verifyActivityContinuity` dependency is only a fail-closed contract,
not evidence of any of them. The activity writer presently updates SQL only;
using it as proof across outages or restores would be unsafe. The contact,
warning-notification workflow, schema/grants, restricted runtime tests and
end-to-end device validation are also separate prerequisites.
