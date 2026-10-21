# Parent-led child registration: backend preparation

Source preparation only, 2026-10-20. No production schema, runtime flags, cloud resources or publication changed. The BR/US proposal is an unreviewed product-policy draft, not evidence of legal approval.

## Implemented contract

- `REGISTRATION_AUDIENCE=children-included` explicitly selects staged country/coarse-age eligibility. It rejects general-audience signup even when registration is otherwise disabled, and changes the grant digest. Existing policy without this explicit audience retains its legacy behavior.
- New password accounts and provider signup require the matching short-lived country/age policy grant before credential processing. Strict provider login also requires staged eligibility before provider verification. General policy-version-only requests cannot satisfy the child contract. Strict public config includes explicit `creationEnabled`; closing creation preserves staged adult provider-login eligibility, while both preflight and transactional consumption reject any new account. Unknown provider identities cannot continue into signup while closed. Legacy general registration still becomes disabled when creation is paused.
- Strict parent configuration requires explicit `PARENT_SIGNED_FORM_COUNTRIES` covering every configured registration/parent country. Only BR and US are supported by this signed-form extension. Public configuration exposes `audience`, actual `parentRegistrationAvailable`, `credentialsAfterApproval:true` and the explicit signed countries.
- A signed-form request accepts only `{state,idToken}`. Its pending database row stores verified parent contact, country, request reference and policy/notice binding; `user_name` is null. It collects no child nickname or password.
- An operator must review the exact request. After approval, a fresh parent-provider proof is required. Only then may `/children` receive `{grant,formReference,userName,password}`. SQL verifies parent/session/provider/country/policy/consent/approved form before hashing the password. Grant/form consumption and the separate private child account commit together. Child email remains null.
- Existing approval metadata is bound to the current shared signed-form notice digest (`signed-parent-form-2026-10-20.1` at this checkpoint); stale forms cannot authorize a new child. Historical requests remain representable and existing account management/deletion is retained.
- Strict `/providers/account` adds `providerCollectionAllowed`. Managed children cannot link/delete using a provider or initiate any parent provider-verification purpose, including an empty family deletion. Password login/deletion and safe public-score withdrawal remain available.
- Child creation always starts private. Separately signed public permission plus a fresh publication choice is still required when public participation is enabled. BR withdrawal now invalidates signed public proof just as US withdrawal does; recovery replay invalidates restored BR proof too.

## Schema capability and rollout boundary

`backend/migrations/pending/0028_extend_child_signed_parent_forms.sql` is one bounded ALTER: allow a null pending nickname and extend the existing checked signed-form country set to US/BR. Existing non-null historical nicknames remain valid. It is **pending and not registered in the ordinary migration manifest**, and has not been executed outside the disposable test database. No synthetic migration-history row is inserted.

Startup verifies the existing 0026 receipt plus the exact observed signed-form schema, including columns, checks, indexes, foreign keys and runtime-visible grants. Strict child creation requires the complete extension before the service starts or advertises availability. Merely making the nickname nullable fails readiness. With creation closed, the new binary accepts the exact legacy schema and exact extended schema.

Deployment must first arrange a new compatible binary and creation-closed fallback, with explicit operator schema planning/backup, target identity confirmation and independently reviewed apply/rollback steps. The currently serving D0 binary expects the old exact schema and must not be treated as a restart-safe fallback after the extension. The pending SQL file alone is not a production migration plan or authorization.

The creation-closed fallback retains staged login eligibility for eligible existing provider users, password login, signed-in management and cleanup. Its separate creation flags still close password/provider/parent account creation. These source guarantees require fresh runtime/configuration and real-provider acceptance before operational use.

## Policy draft and deployment validation

`parent-registration-policy-draft.json` proposes BR/US staged rules (US below 13 parent-led, BR below 18 parent-led), signed forms for both and private scores. These numbers are proposed configuration, not a legal conclusion. All four new-account creation flags and every new policy/assurance review marker are false. The wrapper and inner unreviewed policy are rejected by the deployment validator. Existing reviewed general-audience configuration is unchanged.

`scripts/provider-release-config.mjs` rejects child/general combinations, unsupported or missing signed-form country coverage and configured registration countries without parent coverage. It permits a separately reviewed child release with public participation fully closed; it never converts old general review flags into child review approval.

## Validation

- Backend TypeScript: `.\node_modules\.bin\tsc.cmd -p tsconfig.json --noEmit` passed from `backend`.
- Focused backend command passed 188 tests: `node --test --test-reporter=spec -r ts-node/register ts/config/registrationPolicy.test.ts ts/config/parentRegistrationPolicy.test.ts ts/config/runtimeConfig.test.ts ts/accounts/parentRegistrationFlow.test.ts ts/routers/registrationRouter.test.ts ts/auth/providerAuthFlow.test.ts ts/routers/providerAuthRouter.test.ts ts/accounts/registrationAuthorization.test.ts ts/accounts/generalRegistrationAuthorization.test.ts ts/security/mainController.security.test.ts` (from `backend`). Includes strict creation-closed adult provider login, blocked password/provider/parent creation, unknown-identity continuation rejection and closed child eligibility before provider verification.
- `node --test --test-reporter=dot scripts/provider-backend-release.test.mjs`: 26 passed, including the frozen renderer, contradictory child/general policy, missing country coverage, private-only scores and rejected unreviewed draft.
- Actual parent SQL/browser suite: **35 passed, 0 failed, 0 skipped**, using pinned MySQL 8.0.31 in a fresh disposable local Docker project on a verified random loopback/non-3306 port. Disposable cleanup confirmed. It exercised real BR and US pending request → owner review → fresh proof → private creation → deletion, no preapproval hash, no child email, one-use proof, exact/partial schema capability, blocked managed-child provider attempts, separately authorized BR publication/withdrawal and restored-proof rejection. The browser lifecycle used actual React, HTTP and SQL with synthetic parent-provider verification.
- The SQL suite was invoked through the existing hardened `run-apple-android-handoff-tests.mjs` isolation runner with its test subprocess adapted to `ts/accounts/parentRegistrationRepository.integration.test.ts` and synthetic migration fixture variables; inherited production/runtime database credentials were excluded. The repository's focused repeat command is `node backend/scripts/run-migration-tests.mjs --parent-registration`.
- `git diff --check` passed. Full repository CI, native builds, physical-device verification and real provider/operator acceptance are separate release checks.

## Remaining gates

Before any public child-audience launch: owner/regional privacy review of intended audience classification, legal basis and age assurance; acceptance of the actual direct notice/form delivery, ownership/guardian checks, review/rejection, retention/cleanup and deletion operations; final versioned policy approval; a concrete reviewed production schema plan and compatible rollback; fresh source/image/runtime/grant receipts; frontend/native and real Google/Apple lifecycle checks; and matching store audience/privacy declarations. Preparation does not authorize activation or establish compliance.
