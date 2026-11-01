# Child inactivity: no-response policy candidate

This is isolated policy code and synthetic tests. It is not connected to the server, the warning interface, the SQL maintenance scan, the deletion journal, or any account deletion. The existing deployment guard remains in place. It must not be treated as an implemented or enabled retention process.

The owner's decision permits a later deletion if a parent does not respond. The precise start of the extra 12 months was not specified, so this candidate uses the more conservative interpretation: add one calendar year after the later of the child's third inactivity anniversary and the end of the 30-day warning period following provider acceptance. If a warning is sent late, the latter deadline controls. Leap-day anniversaries roll forward. An accepted send does not prove delivery to an inbox, reading, or parental acknowledgment; the decision explicitly permits nonresponse after the wait.

The candidate never treats creating or displaying an in-app draft, an unknown recipient, a rejected send, absence of a bounce, or a malformed receipt as a successful email send. It requires a caller-supplied verifier for the provider acceptance, exact current verified recipient, warning version and parent/child relationship. No such verifier or production email transport exists here. The caller must distinguish a truly unacknowledged warning from a missing, stale or corrupt acknowledgment. Existing parent-confirmed warnings remain governed by the separate reviewed acknowledgment policy.

Before this can become a real lifecycle, implement and independently verify:

- A proactive warning service and a separately durable, authenticated acceptance record tied to the current verified recipient, exact notice, relationship, activity instant and a unique attempt. Define handling for forwarding, bounces, later delivery failure, changed addresses and provider outages; provider acceptance is not a read receipt.
- An independently durable, complete activity and keep-action history that survives or detects database restores. The present deployment deliberately throws before enabling inactivity operations because this guarantee is unavailable.
- A durable no-response deletion intent distinct from a confirmed-warning intent, locked SQL deadline rechecks, replay and reconciliation behavior, bounded scanning and cleanup, and synthetic race and recovery tests. The existing warning schema and maintenance query require an acknowledgment and do not implement this path.
- The versioned bilingual notice, regional/privacy review, deletion of other personal-data copies and backup retention, user-facing explanations, monitoring and an operational process. Never remove the hard guard just because the pure policy tests pass.

The baseline proposed here cannot send, delete or extend a production record. Missing or uncertain proof holds; if no outreach can be established, a parent who never signs in remains pending rather than being silently deleted. The result `candidate` is a request for further verified review, not deletion authorization.
