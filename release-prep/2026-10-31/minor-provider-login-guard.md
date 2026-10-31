# Temporary provider-login guard — review only

The child-audience provider login path now rejects an eligibility grant whose
age band is `minor` before creating a provider challenge, and rechecks it before
provider completion. The UI explains that provider sign-in is temporarily
unavailable after a minor result and offers password login or guest play. Adult
provider login, existing password login, guest play and signup authorization are
separate paths. This change does not write or alter any account or score.

This is **not** a durable, cross-tab age restriction. The anonymous eligibility
grant is bound to an individual signed cookie. A different anonymous binding may
still assert an adult band; a request that already passed its grant check may
continue if the grant is revoked while provider verification is in flight.
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
