# Child inactivity: no-response policy candidate

The policy is consumed by `childWarningNonresponse.ts`, backed by `durableChildWarningStore.ts` and the pending `parent_child_warning_history` table. Preparation, one-time dispatch, provider observations, deadline assessment and conditional deletion run under the existing parent/child SQL locks. The workflow is not mounted or scheduled in production. The production guard remains in place.

Warn after three calendar years of online inactivity, then wait one calendar year from verified warning delivery. Late delivery moves the deadline later. Leap-day anniversaries roll forward. The older candidate's additional 30-day grace period is removed from this path: it was an unnecessary assumption beyond the requested twelve months. Child activity or the authenticated parent Keep account action restarts the inactivity timer. The bilingual notice explicitly describes these controls; email replies and anonymous opens/clicks do not reset the timer. No email classifier or mandatory owner review is needed.

`createBrevoChildWarningNonresponse` composes the qualified Brevo adapter with this workflow. Acceptance, absence of a bounce and engagement statistics never establish delivery. Existing parent-confirmed warnings retain their separate policy; neither deletion path is enabled in production.

## Implemented protocol

- SQL stores minimal events, a witness and operation ledger. The existing append-only continuity primitive authenticates the history independently. Use a warning-specific key distinct from the activity key; external objects contain digests, not email addresses or message contents. HMAC binds the actual recipient and independently verified contact revision.
- Dispatch commits a unique claim before contacting Brevo, then reacquires the same locks and rechecks the current binding. Concurrent callers cannot resend that attempt. An uncertain commit/send or a crash after claiming requires reconciliation.
- The committed dispatch is a proven lower bound on acceptance, not an invented provider timestamp. Only the first verified delivery fixes the response clock. Initial empty/request-only reports remain pending. Later failures, inconsistent delivery times or lost delivery evidence produce a persistent hold.
- A real keep action resets activity through the existing writer. Changed activity/contact invalidates the old warning. Restoring older SQL state, head or ledger cannot hide later independently recorded events.
- Assessment uses the locked SQL clock. Before the deadline it returns `waiting`; afterward it returns `candidate` only for unchanged activity/contact and valid, unheld delivery history. There is no blanket reply-review callback. Provider log retention does not need to span the waiting year because the delivery receipt is durably retained.
- `deleteChildAfterNonresponse` rechecks the candidate under those same locks and verifies primary/activity continuity before writing the existing separate conditional intent. It deletes through `deleteOwnedAccountRows` and records the committed outcome only after SQL commit. Lost commits remain explicit reconciliation cases. Replay must match the exact current warning history and verified original intent; a subsequent keep or changed warning holds it. The versioned nonresponse notice cannot pass the legacy 30-day replay policy.

The shared disposable-MySQL suite uses the actual warning store, deletion repository and activity/keep writers. It covers the calendar-year boundary, concurrent dispatch, pending-to-delivered reports, uncertain sends/commits, keep/contact changes, deletion/replay, restore and outage. Contact resolution and cloud transport are synthetic. History is bounded to 64 events and 16 KiB; exhaustion holds for reconciliation. Unchanged observations add no events.

Before this can become a real lifecycle, implement and independently verify:

- Qualify current-contact resolution, delivery/failure processing, Apple relay, schema/grants, restricted runtime and bounded warning discovery. Supply the qualified activity verifier on the same transaction. The accepted direct-delivery and archive-recovery rehearsals do not need repeating for this code change.
- Provision and qualify the existing activity/warning continuity components, keys and restoration procedures. The new table remains outside the general migration manifest and production grant profiles until its activation procedure is reviewed.
- Connect bounded scanning/scheduling and qualify production deletion/recovery operations. The existing maintenance query selects acknowledged warnings and must not be reused unchanged for this path.
- The versioned bilingual notice, regional/privacy review, deletion of other personal-data copies and backup retention, user-facing explanations, monitoring and an operational process. Never remove the hard guard just because the pure policy tests pass.

The Brevo composition can send only when explicitly invoked with a configured durable store and credential. Nothing invokes it in production. Missing or uncertain proof holds; a parent with no established outreach remains pending rather than being silently deleted.
