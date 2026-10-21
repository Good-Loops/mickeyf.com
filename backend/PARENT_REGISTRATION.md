# Provider-only parent registration

This implementation uses an existing live parent account and fresh Google/Apple proof linked to that exact account. Provider identity and a signed verified email are contact evidence. They do not establish adult age or legal guardianship. Adult/guardian declarations and versioned consent are separate, and a country-specific review of this assurance model is required before activation. No country defaults, identification documents, KWS, email vendor or child email are introduced.

## Activation and pause

`PARENT_REGISTRATION_ENABLED` must explicitly enable the management capability. It additionally requires `PARENT_REGISTRATION_POLICY_REVIEWED`, the existing reviewed registration policy, provider authentication and journaled account deletion. Configuration must supply `PARENT_REGISTRATION_POLICY_VERSION`, `PARENT_CONSENT_VERSION`, `PARENT_CONSENT_TEXT`, `PARENT_PRIVACY_NOTICE_URL`, and `PARENT_REGISTRATION_COUNTRIES`. Countries must be a reviewed subset of the existing registration policy. No real configuration values are provided here.

The public HTTPS notice URL is validated and bound to the approval digest; changing it invalidates old proofs/grants. The frontend retains a clickable notice during consent and child-detail collection. The separate `VITE_PRIVACY_NOTICE_URL` supplies the app footer without enabling parent registration. See [notice linkage](../frontend/PRIVACY_NOTICE.md) for configuration, versioning and publication boundaries. Worldwide audience and the approved provider-plus-guardian-attestation product route remain unchanged; no jurisdiction is declared reviewed by adding this link.

`PARENT_REGISTRATION_CREATION_ENABLED` is a separate explicit switch and defaults closed. Pause new child creation with this switch while retaining the reviewed management policy so existing parents can list children and withdraw consent. Removing all management configuration would disable that recovery path; it is not the normal pause procedure.

The runtime verifies the new schema even when creation is disabled. Configuration requires the existing `APPLE_MAINTENANCE_HTTP_ENABLED` capability, with its authenticated identity and target validation. The independently authorized maintenance job must be operating before activation: its handler now also removes expired parent attempts in bounded batches. Backlogs report failure for operational follow-up. No provider/runtime configuration is changed by this source implementation.

## SQL and least privilege

New immutable migrations are 0021 (nullable contact for a separate parent-managed account), 0022 (purpose-bound attempts/grants), and 0023 (current parent-child consent). The separate `parent-registration-apply` command selects only these effects and retains the existing migration target/account confirmation gates. Previously applied migrations are never repeated. Inspect the complete history and checksums before selecting new effects.

The explicit runtime grant profile is `google-apple-parent`. Existing `google` and `google-apple` profiles remain unchanged. The parent profile adds only the reviewed attempt/consent columns and read access to the existing coarse age band. It grants no consent reassignment, consent deletion, schema operations, password changes or account-identity updates. Child deletion cascades the relationship. Parent deletion is restricted by its foreign key and checked under the parent account lock before persisting any parent-deletion intent.

Creation consumes its grant in the same transaction as the distinct user, private minor profile and consent row. It does not change the parent's browser session. The child uses a nickname and password, and never shares the parent's identity/email. Existing self-signup still requires an email. This release does not provide child password/email recovery; the parent can withdraw consent and permanently delete the account, then create a fresh account if needed. Deleted progress is not restored.

Withdrawal requires a separate fresh proof, exact owned child and explicit permanent-deletion confirmation. Parent and child account locks serialize it with account mutation and score submission. The independent deletion journal must acknowledge the child's identity before deletion; a lost acknowledgement/commit is not reported as success. Retrying or cancelling does not rescind a recorded deletion intent.

## Retention and rollback

Attempts/grants expire at the original five-minute deadline. They contain hashes/binding/purpose, short-lived provider subject evidence, and policy references; never provider tokens, email, DOB, ID documents or plaintext passwords. Cancellation tombstones prevent late verification from reviving an attempt. Maintenance removes expired attempts. The active consent row contains parent/child UUIDs, country, policy digest/version reference and consent timestamp, and is removed with child deletion. Existing independent deletion-journal retention remains unchanged.

Rollback is a reviewed compatibility decision after child creation: old code may assume non-null email and lacks parent management. Prefer pausing creation while preserving the compatible management runtime and schema. Do not drop consent/attempt tables, force parent cascades, rewrite child email, revoke needed management grants, or restore pre-deletion data to make an old binary run. Any data restoration still requires the existing deletion-journal replay procedure.

## Local verification boundary

Tests use a pinned disposable MySQL 8.0.31 instance and synthetic credentials. The browser flow uses a new headless Chrome profile, real HTTP/session/persistence paths and a synthetic provider-verifier seam; it does not exercise live Google/Apple accounts or establish jurisdictional legal sufficiency. Production migrations, grants, provider configuration, traffic and deployments require their separately reviewed rollout and action-time authorization.

The isolated development bootstrap recognizes the reviewed schema through 0025 and its explicit parent grant profile. It strips inherited registration/parent/public-participation policy and keeps those capabilities closed. Its normal retained development database was not changed by this review; automated persistence tests use a separate disposable database.

The subsequent [family deletion and public participation contract](FAMILY_AND_PUBLIC_SCORES.md) documents migrations 0024/0025, exact-family confirmation, separate score permission, privacy-preserving withdrawal and the required operator transition/recovery boundary. Child creation alone never grants public participation.
