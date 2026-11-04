# Warning runtime and activation

The default remains off. When explicitly enabled, the backend now connects the
existing activity writer, immutable used-form contact, independent warning history,
Brevo delivery lookup, failure callback and conditional deletion journal. It uses
the existing authenticated maintenance endpoint and parent Keep account action.
The older in-app acknowledgment UI and its 30-day policy must remain disabled.

## Delivery processing

Maintenance reads at most 50 candidates per page and 100 pages per invocation.
Each decision is checked again under parent/child locks. A committed dispatch
claim prevents resending after uncertain outcomes. Initial reports remain pending;
the first authenticated delivery receipt starts the twelve-month wait. Waiting
accounts use that saved receipt, so expiration of provider logs does not erase it.
An unfinished scan or held candidate reports maintenance failure/backlog.

`POST /maintenance/child-warnings/brevo` accepts only a private bearer token,
derived as HMAC-SHA256(receiptKey, `brevo-warning-webhook-v1`) in base64url. Configure
the transactional failure events: deferred, soft_bounce, hard_bounce, blocked,
invalid_email, error, spam and unsubscribed (use the corresponding Brevo subscription
names). It ignores engagement events and never treats a webhook as proof of delivery.
Failures bind the exact accepted message and recipient, then persist a hold under
the same locks as deletion. An opaque attempt tag also locates callbacks arriving
before the send transaction commits. No callback content or token is logged.

Brevo supports [bearer authentication](https://developers.brevo.com/docs/secured-webhooks).
Its [retry policy](https://developers.brevo.com/docs/retry-mechanism) discards 5xx
responses but retries 429, so transient persistence failures return 429. Retries
are finite. Monitor callback failures and maintenance status; suspend destructive
maintenance and reconcile retained provider reports after a sustained outage.
These controls do not prove that every possible provider event was received.

## Before activation

1. Apply the guarded four-table schema plan and the new
   `google-apple-parent-signed-warnings` grant profile with child creation closed.
   Existing profiles gain no new permissions. Verify with the restricted principal.
2. Provision the separate continuity and conditional-retention buckets, append-only
   runtime access, independent keys and the existing restore guard. Qualify cloud
   history and deletion recovery with synthetic accounts before admitting families.
3. Supply a restricted production `CHILD_WARNING_BREVO_API_KEY` through managed
   secrets. The short-lived rehearsal key is not a production credential. Retain
   the verified accounts@notify.mickeyf.com sender and accepted anonymous tracking.
4. Configure and test the authenticated failure callback and maintenance schedule;
   verify late failure, uncertain persistence and operational alerts. Complete the
   regional/privacy and copy-retention work before enabling child creation.
5. Enable the reviewed activity/inactivity configuration only after the preceding
   checks pass. Rollback disables the feature and stops maintenance; never drop
   history or rewrite pending deletion intents as rollback.

Apple relay/ambiguous iCloud contacts remain held before sending. They require the
separate registered sender and forwarding qualification. Ordinary contacts must
match the used form, consent and still-linked provider identity. No extra contact
table or free-form email classifier is introduced.
