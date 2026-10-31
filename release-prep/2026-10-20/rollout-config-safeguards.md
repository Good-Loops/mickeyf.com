# Strict-child rollout configuration safeguards

Source-only follow-up to the first three tooling findings in
[production-cutover-plan.md](production-cutover-plan.md), based on
`6c3cab1d7e28f57dae0fb559eee7397e07f47514`. No launch configuration, draft review
flag, schema, secret, native project or production resource was changed.

## Explicit closed preparation

`phase: "prepare-child"` requires the complete reviewed
`REGISTRATION_AUDIENCE=children-included` policy and supported signed-form country
coverage. It requires all four creation flags to be false:

- `REGISTRATION_CREATION_ENABLED`
- `PROVIDER_GOOGLE_SIGNUP_ENABLED`
- `PROVIDER_APPLE_SIGNUP_ENABLED`
- `PARENT_REGISTRATION_CREATION_ENABLED`

Existing eligible provider login, password login, family management/deletion,
signed-form policy, private-profile handling and Apple credential lifecycle,
notifications and maintenance stay configured. Registration/parent policy review
flags must be true; the unreviewed draft still fails. Public participation may be
explicitly closed with all three corresponding participation/review flags false,
as in the existing strict active validator. No public disclosure is enabled by
this source change. Old `prepare`, staged active and general active contracts
retain their existing validation; general activation still requires its separate
reviewed general policy and parent creation closed.

The backend's existing closed-mode readiness accepts either exact legacy or exact
extended signed-form schema. This work changes no backend readiness, schema or
grant definitions and does not execute0028.

## Strict activation and schema evidence

Strict active pins add required `childSchemaReceipt` to the existing
`{closed, activeConfiguration}` structure. The closed deployment must use
`prepare-child`, and its complete environment must equal the active policy with
only the four creation flags closed. Country, consent, notice, public policy,
provider and review differences cannot be smuggled into activation.

The receipt has exactly these fields:

| Field | Required binding |
| --- | --- |
| `schemaVersion` / `operation` | `1` / `verify-child-signed-form-schema` |
| `verifiedAt` | Canonical ISO timestamp, at most five minutes old or five seconds in the future when a plan is created |
| `sourceCommit` | Exact candidate source commit |
| `sqlSha256` | SHA256 of the current pending0028 raw bytes |
| `target` | Exactly project `noted-reef-387021`, instance `cms-mickeyf`, database `cms`, source-pinned expected server UUID |
| `capability` | `nullable-parent-request-us-br` |
| `runtimeGrantProfile` | `google-apple-parent-signed` |
| `schemaSha256` / `grantsSha256` | Exact reviewed metadata digests; shape alone is not live verification |

Every full plan and confirmation hash binds the entire receipt, including its
timestamp. The reader-boundary pin hash excludes **only** `verifiedAt`: a
300-second drain requires fresh verification afterward. Refreshing identical
evidence is allowed; changing any target/source/SQL/schema/grant/capability field
invalidates the boundary. The refreshed receipt must be carried in the reviewed
pins before planning the fallback; preparation receipts then bind those pins
through candidate and traffic planning. Expired inputs require fresh planning;
do not edit a prepared receipt or reuse its old confirmation.

Strict template/activation writes separately require a fresh live metadata
verification result with every material field matching the reviewed receipt.
Both the apply functions and the direct Cloud Run adapter enforce this. The
adapter accepts the bounded SQL metadata dependency as
`createProviderActivationCloudProvider(token, fetcher, { verifyChildSchema })`.
The default now runs the real read-only SQL verifier through an isolated process,
with explicit private migration configuration and a clean matching source
checkout. Missing configuration, a failed query or changed metadata blocks the
write. See [child-schema-operation.md](child-schema-operation.md) for the concrete
operation and verification contract. A receipt-shaped JSON file or arbitrary
digest cannot substitute for that verifier.

Incident `close-active` keeps the existing exact runtime/fallback/traffic/etag and
fresh plan guards, but does not require a fresh activation schema receipt or a
working live verifier. It can still close new creation when activation evidence
expires or metadata access fails. It does not mutate schema or restore D0.

## Exact generated smoke

The frozen provider smoke checks the reviewed provider list and each provider's
signup capability. Closed preparation exposes existing Google/Apple login
clients without signup flags. Strict registration includes the exact audience,
creation boolean, country rules, policy version and actual configured parent
availability. Active parent availability must be true; closed availability must
be false. A missing Apple capability, unexpected Android client, wrong audience,
country/flag drift, unsafe cache headers or Set-Cookie fails the smoke. JSON
comparison also rejects numeric substitutes for booleans. These are anonymous
metadata probes, not provider/consent acceptance.

## Files and validation

- `scripts/provider-release-config.mjs`
- `scripts/provider-backend-activation.mjs`
- `scripts/render-frozen-backend-deploy.mjs`
- `scripts/provider-backend-release.test.mjs`
- `scripts/provider-backend-activation.test.mjs`
- `scripts/test-support/provider-release-fixture.mjs`
- This receipt and the source-follow-up note in `production-cutover-plan.md`.

```powershell
node --test scripts/render-frozen-backend-deploy.test.mjs scripts/render-session-backend-deploy.test.mjs scripts/frozen-backend-traffic.test.mjs scripts/session-backend-rollback.test.mjs scripts/session-backend-traffic.test.mjs scripts/provider-backend-release.test.mjs scripts/provider-backend-activation.test.mjs
```

**233 passed, 0 failed, 0 skipped**, including **63** provider release/activation
cases. Scoped diff check passed. The final complete script log is
`$env:TEMP\ludolume-child-rollout-full-script-suites.log`.

Coverage includes strict open/closed environment matrices; preserved general
validators; rejected drafts/mixed policies/missing countries; absent/wrong/stale/
future schema receipts; timestamp-only refresh after reader drain; full receipt
hashing; missing or changed live schema/grant verification; exact child HTTP
contracts; foreign/retired revision guards; stale plans and incident closure.
The HTTP adapter integration also exercises strict activation with a synthetic
metadata verifier, verifies both apply and adapter rechecks on all three writes,
and confirms closure does not depend on that activation verifier.
Independent read-only review by the backend release task found no concrete
authority bypass in the closed flag matrix, exact policy match, receipt binding,
freshness, live rechecks, reader timestamp refresh or incident closure exemption.
All positive child review/schema evidence and verifier implementations are
synthetic fixtures that release entry points never import.

Remaining gates: real policy/operational review, target-bound0028 plan/apply and
metadata verification implementation, current source/image/runtime receipts,
compatible deployed closed candidate/fallback, actual providers/native candidates
and separately authorized publication. No install, commit, cloud/SQL call,
deployment, image build, flag/traffic change or publication occurred in this task.
