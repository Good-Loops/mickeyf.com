# Native age eligibility and retry protection

Source preparation, 2026-10-20 local. No production activation or public upload is performed by this change. Parent-led child registration stays in scope, with the owner handling real form reviews.

## Implemented behavior

`registrationAge.ts` requests the platform age range after a user continues through account eligibility. Web retains its neutral country/coarse-age screen. Android requests Play access before querying a shared range; iOS uses Declared Age Range on supported systems. Guest content does not start this request. A user already selecting the parent path goes directly to that protective path without needing a native prompt.

The bridges return only status and inclusive range bounds. They do not expose an installation identifier, birth date, identity document or provider token. The parser rejects extra fields, malformed/empty ranges and contradictory status/bounds. Raw bounds are not persisted or sent to the backend. Only the resulting coarse eligibility choice and country travel through the existing preflight contract.

Use the youngest possible age in a shared range and the more protective of it and the user's selection. A missing lower bound is treated conservatively as zero. An adult range cannot override a selected parent/minor path. Native refusal, verification-required, unsupported systems and API errors do not authorize self-service signup or provider collection. Parents can use their own device/account; guest content and existing nickname/password login remain available. Provider-only login on an unsupported/declining native device is unavailable at this gate; this does not establish universal provider-login continuity on every OS.

A parent-required result retains only a 24-hour expiry marker in tab session storage, without country or range. It survives route changes/reloads and ordinary adult/country retries. The frontend also sends the restrictive observation to the existing preflight endpoint, which issues a signed anonymous canonical cookie for at most 24 hours. It cannot authenticate an account. Begin/cancel preserve its original expiry; signup/provider eligibility fails before account or credential work. Anonymous logout also preserves it. Expiry or successful real account login can replace that anonymous cookie. Explicit legacy consumers retain their old general contract.

The parent route offers guest access, the parent's own device/account and a privacy-contact correction path. No reset button encourages selecting an older age. Browser/device storage can still be cleared, and a forged client request is not cryptographic age evidence. This addresses normal back/navigation/reload/cancel/logout retries; it does not prove identity, guardianship or regional legal sufficiency. The website's wider assurance policy and native regulatory features remain qualification items.

The candidate notice is `privacy-2026-10-20.3`; the form is `signed-parent-form-2026-10-20.2`. It describes platform sharing, restricted fallback, temporary markers and correction contact. The notice-version change invalidates old form bindings. Draft review markers stay false; this change approves no real form or policy.

## Validation

- Frontend TypeScript/full suite: **764 passed, 0 failed, 1 Mac-only Swift check skipped** on Windows. The final parser type/threshold tightening is also checked by focused tests and the subsequent exact-source hosted run.
- Backend full unit suite before the final logout fix: **984 passed, 0 failed**. The affected logout/context HTTP suite passed **35/35** after that fix.
- Actual disposable React/HTTP/MySQL parent suite after the new notice/context source: **35/35**, cleanup confirmed. No production database used.
- Targeted real-browser signup/parent suites: **11/11**, including US/BR restriction persistence through reload/navigation, no credentials/provider requests, and retained password login.
- Android release Java compile and **37 JVM tests** passed. See [Android receipt](native-age-validation.md).
- iOS source/signing gates: [iOS receipt](ios-native-age-range.md). Windows checks cannot replace unsigned SDK compilation or real-device proof.
- Rollout guard suites: **233/233**. See [rollout safeguards](rollout-config-safeguards.md). The real schema verifier is intentionally unwired, so strict production writes fail closed.
- Frontend/backend production builds passed. No signing/upload. Independent review found and resolved anonymous logout clearing the restriction; no remaining concrete blocker was found in the bounded source delta.

Commands run from `frontend`: `npm test`, `npm run build`, and focused `node --experimental-strip-types --test` runs for the changed services/components. Build environment: `VITE_PROD_API_URL=https://mickeyf-org-j7yuum4tiq-uc.a.run.app`, `VITE_ENABLE_THREE_BOSSES_RELEASE=1`.

Commands run from `backend`: `npm run test:unit -- --test-reporter=dot`, `npm run prod`, and `node --test --test-reporter=dot -r ts-node/register ts/routers/authRouter.security.test.ts ts/auth/providerAuthContext.test.ts` after the logout fix. The three initial affected suites were also run with `ts/auth/providerAuthContext.test.ts ts/accounts/registrationAuthorization.test.ts ts/routers/registrationRouter.test.ts`.

From root: `node backend/scripts/run-migration-tests.mjs --parent-registration`. From `.github/firebase-deploy`: `node --test --test-concurrency=1 --test-reporter=dot registration-browser.test.mjs parent-registration-browser.test.mjs`. An initial concurrent cold-browser run timed out while full backend/database suites were starting; the sequential rerun passed. No assertion was weakened or timeout raised. Native/rollout commands are in their linked receipts.

## Remaining qualification

Run final-source unsigned Xcode compilation and verify weak linkage/minimum OS, then actual prompts/range boundaries, refusal/errors, resume and account paths on supported devices. Signing needs Declared Age Range in the real profile; local entitlement text is not proof. Play acceptance needs the actual Play-delivered signed app. Complete regional/operational review, the exact 0028 operation and live schema verifier, then qualify a compatible creation-closed backend/fallback before publication. Existing general signup remains live while this candidate is held.
