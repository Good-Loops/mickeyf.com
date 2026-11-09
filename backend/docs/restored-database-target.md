# Restored database target

The ordinary deployment remains pinned to `cms-mickeyf`. For a separately
reviewed recovery deployment, put the same `LUDOLUME_RESTORED_DATABASE_TARGET`
JSON value on the backend and each configured database job:

```json
{"formatVersion":1,"connectionName":"noted-reef-387021:us-central1:cms-recovery-example","serverUuid":"11111111-2222-4333-8444-555555555555"}
```

These are fictional values. Replace both with the actual isolated restored
instance and its independently inspected SQL UUID. The parser requires the
existing project and region, a different instance and UUID, and production
mode. It does not enable child creation, inactivity deletion or a maintenance
job. With the contract absent, existing configuration behavior remains intact.

Each consumer still requires its own existing connection, database, account and
UUID settings. The contract rejects a mix of old and restored settings. It
covers the backend connection, HTTP maintenance, deletion audit, receipt cleanup
and Apple revocation. Before opening its HTTP listener, a recovery-configured
backend also checks the actual database, runtime account and server UUID.

This is configuration, not a recovery approval. A dedicated recovery deployment
plan must bind this contract to the Cloud SQL volume attachment, credential
secret references and tested image. The ordinary frozen deployment verifier is
intentionally unchanged and will reject a different target.

Keep public traffic and scheduled jobs stopped until both journals are
reconciled, the checkpoint and guard are verified, restored daily limits are
reset, credentials/grants and session invalidation are handled, and actual
backend and job checks pass. Updating this variable alone does none of that.
Use explicit current secret-version references for restored-target credentials;
do not assume a clone preserves passwords or change the original credentials.
An older backup can revive sessions that were subsequently logged out and old
native handoff/provider attempts. Before serving, the reviewed restore procedure
must invalidate those restored authentication records while preserving accounts
and game results. This configuration change does not perform that cleanup.
After the guard is activated for the restored UUID, an old-primary revision is
not a valid rollback. Keep the maintenance fallback available if a cutover
outcome is uncertain.
