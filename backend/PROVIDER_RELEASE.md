# Provider release and compatible rollback

The session-only tooling deliberately rejects provider-enabled releases because
its historical rollback image does not preserve private profiles and Apple
credential maintenance. `render-provider-backend-deploy.mjs` and
`provider-backend-release.mjs` provide a separate, explicitly approved path.
They do not create credentials, change SQL, enable a provider portal setting or
establish real Google/Apple acceptance.

## Reviewed configuration

The renderer accepts the existing nine session source/build/image/secret pins
plus `providerRelease: { phase, environment }`. It accepts only the public
environment contract in `scripts/provider-release-config.mjs`: exact existing
provider identifiers, Apple secret references at numeric version 1, original
deletion journal/identity epoch, and the existing maintenance caller/DB identity.
Private key material, unknown variables and invented Android client IDs are
rejected. Changing a fixed identity/version requires a separate reviewed change.

`prepare` enables journaled deletion, signed notifications and protected cleanup,
with provider authentication and all new-registration/public-consent switches
closed. `active` requires the complete explicit country/policy/notice/consent
bundle and reviewed activation flags. The tool checks format and dependencies;
it cannot determine legal sufficiency, operator authorization or parental status.
Fixture `ZZ` country rules and synthetic consent are tests, never rollout defaults.

`previousProviderRelease`, when present, is the exact previously approved bundle
for a preparation-to-activation transition. Both previous and requested settings
are hashed into the provider-specific deployment approval. Omission requires the
known legacy configuration, rather than silently replacing an active policy.
All ordinary source/provenance, two-hour source-build freshness, successful scan,
severity, automation-exclusion and zero-traffic checks remain.

Public policy text is materialized from a hash-verified, chunked data bundle into
a JSON environment file. Commas, quotes, dollar signs and newlines do not become
shell arguments or Cloud Build substitutions. Post-deployment checks verify the
exact runtime environment plus public provider/registration configuration. An
Apple runtime-secret loading failure therefore cannot pass as an active Apple
release. These anonymous checks do not exercise real provider authentication.

```text
node scripts/render-provider-backend-deploy.mjs <reviewed-provider-pins.json>
node scripts/render-provider-backend-deploy.mjs --steps-sha256 <reviewed-provider-pins.json> <deployment-build-id> <deployment-trigger-id>
```

Both commands are offline. Source-less deployment still uses an explicitly
approved Cloud Build receipt under the existing deployment identity. Do not use
a session/frozen approval string or dispatch with placeholder identifiers.

## Compatible fallback

The provider fallback copies the exact reviewed candidate image and runtime,
uses a separately approved newer signing-secret version, and changes only these
creation switches to `false`:

- `REGISTRATION_CREATION_ENABLED`
- `PROVIDER_GOOGLE_SIGNUP_ENABLED`
- `PROVIDER_APPLE_SIGNUP_ENABLED`
- `PARENT_REGISTRATION_CREATION_ENABLED`

Existing login/proof, parent management, deletion, private-profile filtering,
public permission withdrawal, notifications and cleanup remain available.
`REGISTRATION_ENABLED` and its policy remain configured for those operations.
The creation-only switch prevents new grants and consumption of outstanding
password/provider signup grants; cancellation and cleanup still work. Omitting
it preserves previous behavior; malformed explicit values refuse startup.

This fallback is an activation/creation pause with fresh sign-in, not an older
binary that can undo arbitrary defects in the new code. Such a defect requires
a separately tested, profile-aware repair image. Never fall back to an image
that ignores privacy profiles or parent/Apple lifecycle obligations.

The traffic pin document has the existing `candidate.deployment`,
`candidate.receipt`, `baseline` and `rollback.sessionSecretVersion` fields.
A provider-aware baseline additionally records `baseline.providerRelease`,
which must equal the candidate's `previousProviderRelease`.

```text
node --use-system-ca scripts/provider-backend-release.mjs baseline --output <new-baseline.json>
node --use-system-ca scripts/provider-backend-release.mjs baseline --previous-configuration <serving-provider-config.json> --output <new-baseline.json>
node --use-system-ca scripts/provider-backend-release.mjs plan-rollback --pins <reviewed-traffic-pins.json> --output <new-plan.json>
node --use-system-ca scripts/provider-backend-release.mjs apply-rollback --plan <reviewed-plan.json> --confirm-plan <sha256> --confirm-provider-rollback-creation
node --use-system-ca scripts/provider-backend-release.mjs plan-traffic --operation promote --pins <reviewed-traffic-pins.json> --output <new-plan.json>
node --use-system-ca scripts/provider-backend-release.mjs apply-traffic --plan <reviewed-plan.json> --confirm-plan <sha256> --confirm-provider-promotion
```

For a later fallback, generate a **fresh** `plan-traffic --operation rollback`
plan and use `--confirm-provider-rollback`. Plans expire after five minutes;
application rechecks configuration, exact receipts, etag, readiness and paused
automation. Only one template or traffic mutation is attempted. An ambiguous
response requires readback, never an automatic retry. Session-only commands
cannot apply provider plans (schema version 2).

## Operational sequence and limits

Resolve reviewed policy/notice and actual maintenance/notification acceptance
before enabling issuance. Preparation at zero traffic is still reachable by its
tagged URL. Existing hourly cleanup dispatch and Apple notification registration
remain separate exact configuration actions; this tooling does not create jobs,
change IAM, register notification URLs or claim those actions succeeded.

Each traffic cutover keeps the existing newer-secret requirement. If preparation
is first promoted to production and activation is a second cutover, that second
candidate and fallback need their own approved newer secret versions. Two approved
versions cover one cutover pair; do not silently create extra versions or reuse
an old fallback secret. Likewise each deterministic source-build revision may
be deployed once; inspect an existing revision instead of redeploying it.

Main merge triggers Firebase frontend publication. Coordinate backend readiness
before that merge; keep the disabled legacy backend triggers disabled. Verify
real Google/Apple login **and signup**, account/parent deletion and applicable
native-device behavior separately. Source tests and public config checks do not
establish those acceptance results or authorize policy activation.

## Focused verification

`npm run test:frozen-backend` includes the provider configuration, rendering,
transport, transition, fallback and CLI regressions alongside legacy guards.
Backend registration policy/authorization/router tests verify that pausing
creation preserves management policy and cancellation while refusing new or
outstanding grants. No production DB migration is needed for this switch.
