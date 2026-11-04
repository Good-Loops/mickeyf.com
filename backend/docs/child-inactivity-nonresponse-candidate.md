# Child inactivity: no-response policy candidate

The policy is now consumed by `childWarningNonresponse.ts`, backed by `durableChildWarningStore.ts` and the pending `parent_child_warning_history` table. Preparation, one-time dispatch, provider observations, parent responses and nonresponse assessment run under the existing parent/child SQL locks. The workflow is not mounted, scheduled or connected to deletion. The production guard remains in place.

The owner's decision permits a later deletion if a parent does not respond. The precise start of the extra 12 months was not specified, so this candidate uses the more conservative interpretation: add one calendar year after the later of the child's third inactivity anniversary and the end of the 30-day warning period following provider-reported delivery. If a warning is delivered late, the latter deadline controls. Leap-day anniversaries roll forward. Provider-reported delivery does not prove inbox placement, reading, or parental acknowledgment; the decision explicitly permits nonresponse after the wait.

`createBrevoChildWarningNonresponse` composes the qualified Brevo adapter with this workflow. Acceptance, absence of a bounce and engagement statistics never establish delivery. Existing parent-confirmed warnings retain their separate policy; neither deletion path is enabled.

## Implemented protocol

- SQL stores minimal events, a witness and operation ledger. The existing append-only continuity primitive authenticates the history independently. Use a warning-specific key distinct from the activity key; external objects contain digests, not email addresses or message contents. HMAC binds the actual recipient and independently verified contact revision.
- Dispatch commits a unique claim before contacting Brevo, then reacquires the same locks and rechecks the current binding. Concurrent callers cannot resend that attempt. An uncertain commit/send or a crash after claiming requires reconciliation.
- The committed dispatch is a proven lower bound on acceptance, not an invented provider timestamp. Only the first verified delivery fixes the response clock. Initial empty/request-only reports remain pending. Later failures, inconsistent delivery times or lost delivery evidence produce a persistent hold.
- A current parent session can record a response. A real keep action resets activity through the existing writer. Changed activity/contact invalidates the old warning. Restoring older SQL state, head or ledger cannot hide later independently recorded events.
- Assessment uses the locked SQL clock. Before the deadline it returns `waiting`; afterward it also requires a qualified exact-history verifier covering replies, forwarding and later failures. The default verifier returns false. A one-month provider log alone cannot establish twelve months of nonresponse. `candidate` means ready for reviewed deletion integration, never permission to delete.

The shared disposable-MySQL suite uses the actual warning store and activity/keep writers. It covers the calendar-year boundary, concurrent dispatch, pending-to-delivered reports, uncertain sends/commits, authenticated responses, changed contact, restore and outage. Contact/coverage proofs and object transport are synthetic. History is bounded to 64 events and 16 KiB; exhaustion holds for reconciliation. Unchanged observations add no events.

Before this can become a real lifecycle, implement and independently verify:

- Qualify the current-contact continuity resolver, response/failure review, Apple relay, schema/grants, restricted runtime and bounded warning discovery. Supply the qualified activity verifier on the same transaction. The accepted direct-delivery and archive-recovery rehearsals do not need repeating for this code change.
- Provision and qualify the existing activity/warning continuity components, keys and restoration procedures. The new table remains outside the general migration manifest and production grant profiles until its activation procedure is reviewed.
- A durable no-response deletion intent distinct from a confirmed-warning intent, locked SQL deadline rechecks, replay and reconciliation behavior, bounded scanning and cleanup, and synthetic race and recovery tests. The existing warning schema and maintenance query require an acknowledgment and do not implement this path.
- The versioned bilingual notice, regional/privacy review, deletion of other personal-data copies and backup retention, user-facing explanations, monitoring and an operational process. Never remove the hard guard just because the pure policy tests pass.

The Brevo composition can send only when explicitly invoked with a configured durable store and credential. Nothing invokes it in production. Missing or uncertain proof holds; a parent with no established outreach remains pending rather than being silently deleted.
