# Apple login credential staging — review only

For a children-included policy, an existing Apple account login previously
stored the newly exchanged refresh token before the later session transaction
rechecked eligibility. A concurrent eligibility cancellation could therefore
deny the session after the credential had already been stored.

The bounded change prepares an encrypted token in memory, keeps the one-use
capability outside serializable flow results, and saves it in the existing
account-locked session transaction only after fresh Apple proof and eligibility
checks. The eligibility check runs again before session insertion; a known
failure rolls back both the new token and session. The stage is bound to the
account, Apple subject, client and proof issuance time and is disposed after the
awaited transaction. Existing Apple signup, link, deletion and legacy/general
audience login keep their prior paths. No real credentials are used in tests.

This does not prevent, reverse or clean up an Apple-side token exchange already
started before an eligibility change. It does not automatically revoke an
Apple authorization, undo an uncertain database commit, establish a shared
browser identity, or complete the age-assurance and child-privacy review.
JavaScript strings containing provider responses cannot be reliably erased.
The grant or proof can expire after the last recheck while a commit is delayed.
Creation remains paused until the broader safeguards and rollout are qualified.
