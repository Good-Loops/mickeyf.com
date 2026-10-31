# Creation-paused provider-login cutover — review only

This plan prepares a website and backend compatibility transition. It does not
authorize deployment, change traffic or configure a store. The policy and
metadata observations are a snapshot from 31 October 2026; verify them again
immediately before a rollout. Do not enable child creation or inactivity
deletion as part of this transition.

## Why the transition has an interruption

The currently published website loads Google resources on its login/signup
pages before an age decision, both through its HTML preload and its application
bundle. The existing provider control also eagerly loads Google. The candidate
frontend removes the preloads and mounts provider sign-in after a country and
age gate. Its password form remains separate.

The active backend currently returns `{ "enabled": false }` from
`/auth/registration/config`. The new frontend needs a `children-included`
policy response even while account creation is paused. The candidate backend
in turn requires a new eligibility grant before a Google/Apple login
(`backend/ts/auth/providerAuthFlow.ts`). The old website and old installed apps
do not create such a grant. Consequently:

* Backend first: old website and old apps cannot complete provider login until
  a compatible client is loaded; the old website also continues to request
  Google resources until replaced.
* Frontend first: the new website cannot start provider login while the old
  backend reports registration disabled. Password login is a separate path.

A server fallback that silently accepts legacy provider logins would bypass the
new eligibility gate. It is not a safe compatibility phase for this objective.
Prepare both artifacts and a coordinated cutover to minimize the interruption,
but do not promise a fixed outage length: an already-open browser tab can keep
old code until reloaded, and installed native apps remain old until updated.
Validate the dedicated reviewer's password login separately throughout.

## Candidate backend configuration with creation closed

The observed serving Cloud Run revision had `REGISTRATION_ENABLED=true`,
`REGISTRATION_POLICY_REVIEWED=true`, `REGISTRATION_GENERAL_AUDIENCE_ENABLED=true`,
`REGISTRATION_CREATION_ENABLED=false`, `PARENT_REGISTRATION_ENABLED=true`,
`PARENT_REGISTRATION_CREATION_ENABLED=false`,
`PARENT_REGISTRATION_POLICY_REVIEWED=true`, `PARENT_SIGNED_FORMS_ENABLED=true`,
`PROVIDER_AUTH_ENABLED=true`, both provider signup switches false,
`ACCOUNT_DELETION_ENABLED=true`, and `APPLE_MAINTENANCE_HTTP_ENABLED=true`.
Inactivity and child-activity switches were absent. These are configuration
observations, not proof of current runtime access or future operation.

To expose the candidate's staged eligibility while retaining the pause, the
reviewed candidate needs the following conditions at the same time:

* Set `REGISTRATION_AUDIENCE=children-included` and set
  `REGISTRATION_GENERAL_AUDIENCE_ENABLED=false`; retain the reviewed enabled
  country policy and its exact policy version.
* Keep `REGISTRATION_CREATION_ENABLED=false`,
  `PARENT_REGISTRATION_CREATION_ENABLED=false`,
  `PROVIDER_GOOGLE_SIGNUP_ENABLED=false`, and
  `PROVIDER_APPLE_SIGNUP_ENABLED=false`. Keep inactivity and child online
  activity disabled; the website build must leave both lifecycle flags off.
* Because parent management is enabled, the candidate requires signed forms
  enabled and `PARENT_REGISTRATION_COUNTRIES` and
  `PARENT_SIGNED_FORM_COUNTRIES` to equal the country-policy set, even while
  child creation is paused. The observed country rules contained US and BR,
  while parent countries contained only US and the signed-form country list
  was absent. Reconcile the lists only with truthful policy review. Updating
  these configuration lists does not itself enable child creation.
* Preserve provider, session, journaled account-deletion, Apple-maintenance,
  privacy-notice and parent-management configuration. Verify the candidate
  actually exposes both desired provider clients and that its maintenance and
  session prerequisites are healthy; do not infer this from flag names alone.

Expected public registration config is `enabled: true`,
`audience: "children-included"`, `creationEnabled: false`, reviewed country
rules, and `parentRegistrationAvailable: false`. Verify the actual response,
including country thresholds, without logging credentials or account data.
The age screen is a self-declaration on the web; native age APIs and their
unavailable outcomes need separate device validation.

## Schema and recovery boundary

Candidate startup always checks the exact registration and parent-management
schemas and migration records (0019–0024), plus its other existing readiness
checks. With signed forms enabled it checks recorded migration 0026 and the
exact signed-form table. While parent creation is false, it accepts the exact
legacy or exact extended signed-form schema; **do not apply pending 0028** just
for this cutover. The separate Android handoff migration 0027 is also outside
this operation. The live schema history, effective runtime grants, account
identity, and exact fallback compatibility have not been freshly verified by
this review. Inspect metadata with the appropriate restricted/admin identities
without reading personal rows. Resolve any readiness failure before cutover;
do not fabricate migration receipts or widen runtime privileges to make it pass.

Capture a verified rollback target for both the serving Cloud Run revision and
the exact current Firebase Hosting version, plus a current recovery point. This
review could read the Cloud Run traffic configuration, but the active CLI
identity received HTTP 403 when reading the Firebase Hosting live channel, so
the actual current Hosting version is unverified. Without that evidence do not
claim rollback is ready. Applying 0028 later changes the schema and can make
older revisions unsafe as fallbacks; that is a separate operation and review.

## Qualification and coordinated transition

1. Establish fresh source, image, Hosting artifact hashes and rollback targets;
   review live schema/grants and the US/BR closed-policy configuration. Build
   the paired candidate with both lifecycle UI switches off. Qualify the
   zero-traffic backend and compatible frontend together in an isolated preview
   that reproduces first-party origin/cookie behavior. Use synthetic data or
   the existing dedicated reviewer as appropriate; do not use real child data.
2. Check that guest play and existing password login work, signup stays closed,
   Google/Apple provider login succeeds only after the permitted age step, and
   rejected/unknown/parent-required eligibility does not load their SDKs.
   Observe network activity on the entry/login/signup pages before the age
   decision. Exercise permitted and unavailable device age outcomes separately.
   A preview that cannot faithfully target the zero-traffic backend is not
   proof of the combined flow.
3. During a coordinated release window promote the verified backend and then
   publish the verified frontend with minimal delay. The interval and stale
   clients have the provider-login limitations above. Recheck the live policy,
   no-preload network behavior, signup pause, reviewer password login, guest
   game, and a separately controlled existing-provider login after the change.
4. If the change fails, use the verified compatible pair for rollback. Switching
   only one side leaves the described incompatibility. The previous website
   rollback also restores its pre-age Google requests; record and address that
   exposure rather than claiming the rollback preserves the new privacy gate.
   Revalidate login, guest play, and the creation pause after rollback.

This plan does not establish completion of the parent-form retention process,
third-party SDK privacy review, the newer no-response inactivity policy, or
store acceptance. Those remain independently qualified work.
