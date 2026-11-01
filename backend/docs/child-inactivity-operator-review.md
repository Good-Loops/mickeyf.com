# Private inactivity review — candidate only

This read-only scan is **not ready for real use** until the pending activity schema, permissions, parent warning interface, current-contact verification, tracking-health checks and notice are qualified. The SQL rehearsal uses synthetic data. A scan result is not proof of inactivity, a warning, permission to contact someone, or permission to delete an account. Missing activity is flagged for investigation and never treated as old activity. Offline play might not appear in online activity records.

After those prerequisites are reviewed and installed, the operator can use the same private, authenticated local database proxy and explicit target, account and clean-source confirmations used by the signed-form review (`childSchemaCommandSettings`). Run from the checked-out reviewed source, in a private terminal:

```powershell
'{"afterChildId":null}' | npm --prefix backend run --silent child-inactivity:review
```

The result contains private parent/child identifiers and last observed online activity, but no email addresses or names. Keep it out of shared logs. `nextAfterChildId` is a cursor: when non-null, run another scan with that value in `afterChildId`; a null cursor ends the scan. Database changes while paging can affect coverage, so this is a review aid, not an exhaustive lifecycle audit. The scan checks the exact configured database identity before and after the page; any error withholds the entire page. It uses a read-only transaction and returns at most 100 records at a time.

For each candidate, later workflow must independently verify the exact current parent relationship, activity history and current contact before preparing any actual warning. The returned bilingual notice is an **unsendable draft** of the exact versioned warning; it has no recipient, and this command does not send, prepare, acknowledge, record or delete anything. A missing row, rejected lookup or unsent draft is not a successful notice. In the current disabled candidate, if the parent does not confirm the warning, the account remains pending; this scan cannot establish confirmation. The owner later chose to allow deletion after 12 additional months of nonresponse, but that decision is not implemented or enabled. Its timing, failure handling, retention and recovery must be specified and tested before use. Existing backups and mail copies still require the separate verified retention procedure.
