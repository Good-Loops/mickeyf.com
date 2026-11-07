# Apple relay state for parent-form requests

This is a disabled release candidate. The draft schema is not installed.
An explicit `PARENT_FORM_RELAY_STATE_ENABLED=1` opt-in prepares the recorder
only if signed forms, Apple notifications and authenticated maintenance are
configured. Runtime startup checks the exact schema and read/write access. The
operator flag checks the same schema and read access. Neither check establishes
that notifications were received, the external scheduler is running, or a
restore is safe. Do not enable the flag or child creation on the strength of
these files. Current production behavior remains unchanged.

Apple's signed forwarding events include the provider subject, private email,
event type and event time. The verifier retains the normalized address only for
well-formed signed forwarding events; it never retains the signed token or
notification identifier. The recorder matches both subject and exact recorded
contact to active requests created before the event's second ended. Because
ordering within that second is unknown, those requests are included
conservatively. The separate
table contains only the request reference, last event time and disabled flag;
deleting a request cascades that row. When the candidate is enabled, the
authenticated maintenance handler runs a bounded cleanup pass for used,
rejected and expired requests. Its scheduler must still be independently
verified before activation.

Older events cannot overwrite newer observations. If Apple reports conflicting
events in the same second, the disabled observation wins. A missing row or
missing contact in an event is unknown. A later enabled observation says only
that Apple reported forwarding enabled at that time: it does not prove a
message reached a parent or is enabled now. The operator interface keeps
delivery unknown and withholds the recorded address if the most recent
observation is disabled. A late or missing Apple event, a restore or an outage
can leave the observation stale; this is not a complete delivery monitor.

Before wiring this into production: review and install the schema through a
guarded migration with a compatible rollback, verify exact schema and minimum
runtime/operator grants, independently verify the maintenance schedule,
test signed notifications through the configured Apple endpoint with an
owner-controlled relay, and rehearse retry, timeout, lost/out-of-order events,
the database restore process and form cleanup. Define how parents whose relay
has been disabled can cancel and request another form. A failed or incomplete
notification must not be acknowledged as recorded. Do not treat the contact
status as proof of a parent's identity, consent, inbox delivery or reading.

Apple documentation: https://developer.apple.com/documentation/signinwithapple/processing-changes-for-sign-in-with-apple-accounts
