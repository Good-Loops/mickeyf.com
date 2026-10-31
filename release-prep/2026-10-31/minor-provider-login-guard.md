# Temporary provider-login guard — review only

The child-audience provider login path now rejects an eligibility grant whose
age band is `minor` before creating a provider challenge, and rechecks it before
provider completion. Provider session creation rechecks the grant under a SQL
row lock in the session transaction, after provider verification and before
session insertion. A cancelled, expired, missing or minor grant cannot issue a
session. The UI explains that provider sign-in is temporarily
unavailable after a minor result and offers password login or guest play. Adult
provider login, existing password login, guest play and signup authorization are
separate paths. This change does not write or alter any account or score.
The current tab remembers a minor provider restriction for 24 hours across
component remounts, without storing an exact age, to block adult reselection.

This is **not** a durable, cross-tab age restriction. The anonymous eligibility
grant is bound to an individual signed cookie. A different anonymous binding may
still assert an adult band. The tab-local restriction is not synchronized across
tabs or devices. A cancellation that loses the race for the grant-row lock waits
for the session transaction to commit and cannot retroactively revoke that
session, even if it arrived before the commit completed.
The server does not independently attest the age signal from the native client.
Do not claim this guard proves that all minors or all concurrent sessions have
been identified. Account creation remains paused; release requires separately
reviewing neutral age-screening, applicable regional requirements, pre-age SDK
traffic, and a durable way to protect existing minor accounts' score visibility.

Native age-signal unavailable/refused cases still fail closed. On iOS before 26,
the bridge returns unsupported, so provider login is unavailable in the native
app; Android's unavailable/non-Play-install paths can also be unsupported. An
adult may still use an existing username/password account or guest play.
The candidate frontend also requires its reviewed paired backend; the currently
serving backend does not provide this eligibility contract. Deployment, device
acceptance, and the coordinated backend/frontend cutover remain separate.
