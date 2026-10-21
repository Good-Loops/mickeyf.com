# Mixed-audience parent registration readiness — 2026-10-20

Owner decision: intentionally include children under 13; finish parent-led child registration before public launch. Free store downloads and BR/US availability remain approved. This is a technical readiness record, not a legal compliance certification.

The owner subsequently confirmed that he will personally review returned parent forms. No registration-removal change was made. The [operator guide](parent-form-operator-guide.md) records the review steps; [the rehearsal](synthetic-parent-consent-rehearsal.md), [regional policy review](child-policy-review.md) and [cutover plan](production-cutover-plan.md) distinguish demonstrated behavior from the remaining release gates. Review staffing alone does not approve the regional policy or activate registration.

## Live baseline and hold

The existing live site/backend still expose general signup without country/age screening, while new parent-led registration is disabled and its configured countries are US only. No live creation flags, traffic, database or notice have been changed. The candidate public launch is on hold. Guest games/animations remain available.

## Required behavior

- New account and provider entry determine eligible country/coarse age before collecting account credentials or loading Google/Apple controls. No birth date or identity document is requested by this screen. The new frontend must refuse the old general-audience contract.
- Parent-required users receive the parent-led path. A parent authenticates with their own account and receives a direct signed-form notice tied to the exact policy, contact, country and request reference.
- The pending form collects no child nickname, email or password. An operator verifies the returned signed form and exact parent/request. Only after approval can the parent supply a child nickname/password and create the private account. The authorization is single-use and scoped.
- Optional public leaderboard disclosure needs a separate signed choice. Withdrawing public participation preserves the private account. Account withdrawal/deletion remains available.
- Existing login, parent management, withdrawal, deletion and Apple maintenance must remain operational if new registration is paused.

## Publication gates

1. Qualify source and meaningful frontend/backend/migration tests, including direct entry points, rejected/pending/expired/replayed forms, BR/US countries, legacy management and creation-pause behavior.
2. Independently review the country policy and age assurance for the intended audience. A self-selected coarse age range and parent provider sign-in do not themselves prove age, parenthood or legal compliance.
3. Accept the actual signed-form operation: verified mailbox, designated operator, exact signature/sender/request checks, restricted storage, rejection/expiry, published retention/deletion handling and a complete synthetic rehearsal. No real child data is needed for this rehearsal.
4. Prepare an exact-source backend candidate plus a compatible creation-closed fallback, scanned image and fresh guarded deployment/rollback plans. Keep disabled Cloud Build triggers disabled. Review the pending schema operation separately; do not apply a new nullable/BR schema while relying on the old D0 fallback.
5. Qualify schema and policy in the intended environment; verify every exposed child country supports the signed path. Enable only a reviewed policy/configuration after operational proof. Do not label draft flags as reviewed or infer approval from this document.
6. Validate the complete account path with hosted backend/frontend and actual native candidates. Then publish matching website/notice, finish truthful store privacy/audience forms, attach eligible binaries and submit stores for review. Apple reviewer access still requires the owner to enter credentials directly when available. Play closed testing remains a separate production-access requirement.

## Policy references checked 2026-10-20

- [FTC six-step COPPA plan](https://www.ftc.gov/business-guidance/resources/childrens-online-privacy-protection-rule-six-step-compliance-plan-your-business): mixed-audience screening, direct parent notice, verifiable consent before covered child collection, separate disclosure choice and ongoing parent/retention rights.
- [Google Play Families policies](https://support.google.com/googleplay/android-developer/answer/9893335?hl=en): intended child audience, SDK/API and data handling must match declarations; provider sign-in is not a substitute for these checks.
- [ANPD age-assurance guidance and timeline](https://www.gov.br/anpd/pt-br/assuntos/noticias/anpd-publica-orientacoes-preliminares-e-cronograma-para-afericao-de-idade-no-ambiente-digital): Brazil child/adolescent obligations and privacy-preserving age-assurance review. This engineering work does not establish that self-declared age meets those obligations.

## Validation

The parent-account flow is implemented in the candidate worktree; overall age assurance and production tooling are not complete. See the linked policy and cutover reports for the native store-age integration, age-screen retry and strict creation-closed rollout gaps. Full frontend qualification passed TypeScript and **755/755 tests**. Backend focused qualification passed **188/188**, deployment validation **26/26**, and the final real parent HTTP/React/MySQL suite **35/35** with disposable cleanup confirmed. The broader migration suite passed **159/159** before the final provider-login continuity change; the affected parent suite was then repeated successfully. Full browser and final combined backend results are recorded below when available. Independent review found and resolved the managed-child parent-provider entry bypass, and found no remaining P0/P1 in the final continuity delta. Those checks do not cover the newly identified age-assurance and rollout-planner gaps.

Strict config includes `creationEnabled`: closing new accounts still permits staged eligibility for existing adult provider sign-in; Signup mounts no collection fields, and both authorization and transactional account creation reject the closed state. Parent-created children retain nickname/password login. This is source/test evidence, not live acceptance.

Fonts are served locally using 28 unmodified official WOFF2 files with licenses/provenance. Fresh guest browser tests confirmed no Google Fonts request attempts. A two-pixel landscape row-gap correction keeps the real-font p4-Vega notice near its scene without changing target sizes or centering. All 15 game layout cases passed.

Commands and detailed changed-file inventories are in [frontend validation](child-frontend-validation.md) and [backend validation](parent-registration-backend.md). The pending schema migration and draft policy are deliberately not an approved production operation. The original 36 captured working-tree files in the primary checkout remained byte-for-byte unchanged during isolated implementation, including all 22 unrelated dirty documentation/generated files.

## Consolidated local qualification

The final source passed **755 frontend tests**, **981 backend unit tests**, **75 browser cases**, and the TypeScript checks. The broad disposable migration suite passed **159 tests**; after the login-continuity change, the affected real parent HTTP/React/MySQL suite was repeated with **35/35 passing** and cleanup confirmed. Provider release validation passed **26/26**. Frontend/backend production builds passed during this implementation; hosted qualification of the pushed source remains separate.

Exact commands from the repository root:

```powershell
npm --prefix frontend test
npm --prefix backend test
npm --prefix backend run test:unit
npm --prefix backend run test:migrations
npm --prefix .github/firebase-deploy run test:auth-browser
node --test scripts/provider-backend-release.test.mjs
node --test scripts/ios-store-screenshots.test.mjs scripts/ios-testflight.test.mjs
$env:VITE_PROD_API_URL='https://mickeyf-org-j7yuum4tiq-uc.a.run.app'
$env:VITE_ENABLE_THREE_BOSSES_RELEASE='1'
npm --prefix frontend run build
npm --prefix backend run prod
git diff --check
```

An existing Apple-revocation deadline test assumed its synthetic provider request would start within 15ms, which failed under concurrent load. Its scoped mocked clock now waits for that request before advancing exactly to the same deadline; all no-late-write/no-retry assertions remain. The full backend suite then passed. A full browser run exposed stale paused-message wording in one fixture; the corrected exact message and complete 75-case rerun passed.

The main local checkout was fast-forwarded to the new source. All **22** original dirty file paths and their exact uncommitted added/removed content were verified unchanged. Twenty-one complete files remained byte-identical; the release ledger additionally received the new committed hold sections. A recoverable stash and external patch/manifest backup remain available. Original edits were excluded from all release commits. Official font/license hashes also passed after a fresh checkout; upstream CRLF license bytes are explicitly preserved.

Public launch is still held by the operational/regional/schema/native gates above. Keeping this code in a draft PR does not close the currently live general signup.
