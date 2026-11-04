# Child activity continuity: SQL rehearsal

This rehearsal joins the existing append-only witness prototype to real MySQL
transactions. It uses the application's activity writer, authenticated activity
and parent-keep services, session checks and shared account locks. The witness
provider is a fault-injecting in-memory transport; it is independent of SQL but
does not qualify cloud storage or production deployment.

Run from the repository root:

```text
node backend/scripts/run-child-continuity-sql-rehearsal.mjs
```

The runner reuses the pinned MySQL 8.0.31 disposable-container harness, accepts
no target arguments, strips inherited application credentials, checks the fresh
local container and empty database, and removes its container and volume after
success or failure. No production migration, feature flag, cloud resource or
runtime composition is changed. `synthetic_continuity` exists only in the test.

## What is exercised

- A new synthetic relationship and activity row commit with matching external
  evidence; later child activity and parent keep advance the witness.
- SQL rollback after an external write and a lost external response leave the
  witness ahead of SQL. Later verification and activity must hold.
- A lost commit command before SQL executes discards the connection and holds.
  Delayed provider writes that complete after client timeout compete with the
  next keep for the same create-only event: either the keep commits its own
  matching evidence or its SQL transaction rolls back and holds.
- Loss of the SQL commit response permits a retry only with the same operation
  token, matching request, complete ledger and fresh witness verification. A
  successful retry does not add another activity or external record.
- Restoring older activity, witness and ledger rows cannot hide a later keep.
  Partial activity or ledger restores also fail verification.
- Concurrent activity and parent keep use the same named child lock through
  commit. The test waits for the competing lock attempt before releasing the
  first external write.
- An invalid parent session cannot append evidence. Provider unavailability
  leaves SQL unchanged.

The test-only composition reads and verifies the old state, makes a tentative
transactional SQL update, records its resulting state externally, then re-reads
and verifies the SQL state and ledger before the existing caller can commit.
No operation outside that SQL transaction may have an irreversible side effect.
This ordering differs from preparing an intended state before SQL mutation;
both require external confirmation before commit and the same lock throughout.
It does not establish that every existing application writer participates.

## Remaining release work

The carried-over primitives are unchanged from the preserved
`fix/child-continuity-witness` prototype at `2f58b24d`. Their HMAC-protected head
and bounded append-only lookup reject mismatched, incomplete or uncertain
evidence. The bounded lookup does not inspect events before SQL's current
sequence: independent protection against event removal and storage rollback is
still essential. Event growth, finite retention and backup expiry, key rotation,
costs and latency require qualification before deployment.

The canonical fixture state covers relationship, country, consent version,
policy digest and activity only. Warning preparation/delivery/failure, provider
and contact changes, consent changes, score/login writers, deletion and restore
administration are not integrated. There is no approved production witness
schema, runtime identity, clock-skew check, writer fencing or reconciliation
workflow. Client operation-token persistence and complete request coverage also
remain unimplemented. This receipt is not authority to delete an account, enable
inactivity handling, or mark release step 3 complete.
