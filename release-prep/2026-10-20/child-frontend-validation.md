# Child-audience frontend validation — 2026-10-20

Prepared locally in the isolated public-release worktree. The child-audience
changes were uncommitted when tested; the surrounding HEAD at handoff was
`7a739d2b7f2db376bb3a15eecb42b633245eb2a5`. No installation, commit, deployment,
cloud mutation, provider sign-in or real parent-form review was performed by this
frontend task.

## Behavior

- Signup requires the server's explicit staged `audience: "children-included"`
  contract and country/coarse-age approval before mounting account fields or
  provider controls. Parent-required choices lead to the existing parent route.
  An older general-audience backend does not silently authorize the new source.
- Login preserves immediate nickname/password authentication for existing
  parent-managed children. Google/Apple controls require the eligibility step.
  Provider login cannot silently continue into signup. Expired or consumed
  approvals require an explicit fresh eligibility step.
- The old HTML/SPA provider preloads and bootstrap asset are removed. Provider
  discovery now returns first-party metadata without loading either external
  SDK. Eligible provider surfaces explicitly warm the SDK. Known child account
  flags suppress linking controls and provider discovery in account/parent pages.
- Strict parent registration sends only parent proof to request a signed form;
  it collects no child nickname or password before reviewed approval. An
  approved form requires a fresh parent proof before the nickname/password form
  mounts, with its exact `formReference` passed to private creation. Existing
  management/deletion/session protections and explicit legacy API contracts are
  retained. No new browser storage or credential logging was introduced.

The browser age choice is an eligibility assertion, not proof of guardianship
or verifiable parental consent. The backend's reviewed form/policy binding is
required; matching backend configuration/schema and actual owner review remain
release gates. Guest content and existing password login remain available when
the strict registration contract is unavailable.

## Changed files owned by this task

- `frontend/index.html`
- `frontend/public/provider-signin-preload.js` (deleted)
- `frontend/vite.config.ts`
- `frontend/ts/App.tsx`
- `frontend/ts/components/RegistrationGate.tsx`
- `frontend/ts/components/RegistrationGate.lifecycle.test.mjs`
- `frontend/ts/components/ParentRegistration.tsx`
- `frontend/ts/components/ParentRegistration.lifecycle.test.mjs`
- `frontend/ts/components/SignedParentForm.tsx`
- `frontend/ts/components/ProviderSignInControls.tsx`
- `frontend/ts/components/ProviderSignInControls.lifecycle.test.mjs`
- `frontend/ts/pages/SignUp.tsx`
- `frontend/ts/pages/Login.tsx`
- `frontend/ts/pages/ManageAccount.tsx`
- `frontend/ts/pages/ParentAccounts.tsx`
- `frontend/ts/pages/ParentAccounts.lifecycle.test.mjs`
- `frontend/ts/pages/accountPageLifetime.test.mjs`
- `frontend/ts/services/authApi.ts`
- `frontend/ts/services/authApi.childAudience.test.mjs` (new)
- `frontend/ts/services/authService.ts`
- `frontend/ts/services/registrationApi.ts`
- `frontend/ts/services/parentRegistrationApi.ts`
- `frontend/ts/services/parentRegistrationApi.test.mjs`
- `frontend/ts/services/providerClient.ts`
- `frontend/ts/services/providerClient.test.mjs`
- `frontend/ts/services/appleWebCredential.test.mjs`
- `frontend/ts/services/publicApiPreviewCompatibility.test.mjs`
- `frontend/ts/config/apiBase.test.mjs`

Shared notice, backend, fonts and browser integration fixtures are owned by the
other release tasks.

## Focused validation

```powershell
node --experimental-strip-types --test frontend/ts/services/authApi.childAudience.test.mjs frontend/ts/services/authApi.generalRegistration.test.mjs frontend/ts/services/registrationApi.test.mjs frontend/ts/services/parentRegistrationApi.test.mjs frontend/ts/services/providerClient.test.mjs frontend/ts/components/RegistrationGate.lifecycle.test.mjs frontend/ts/components/ParentRegistration.lifecycle.test.mjs frontend/ts/pages/ParentAccounts.lifecycle.test.mjs frontend/ts/pages/accountPageLifetime.test.mjs frontend/ts/components/ProviderSignInControls.test.mjs frontend/ts/components/ProviderSignInControls.lifecycle.test.mjs frontend/ts/components/SignedParentForm.test.mjs
.\frontend\node_modules\.bin\tsc.cmd -p frontend/tsconfig.json --noEmit
```

**154 passed, 0 failed, 0 skipped**; TypeScript passed. Scoped `git diff --check`
also passed. The tests exercise strict-versus-legacy contracts, missing/expired/
cancelled/private grants, direct API collection barriers, metadata-only discovery,
the signed-form approval-to-credential lifecycle, parent-route entry, existing
password login, account/session cancellation and explicit eligibility retry.

These are controlled transport/component tests. Full browser/SQL integration,
actual provider and device behavior, external parent-form handling and publication
remain separate evidence.

## Compatibility regression follow-up

The first complete frontend run found eight stale assertions: six modern-mode
transport scenarios still expected credential submission without eligibility,
one Apple test expected SDK loading during discovery, and one CSP test expected
remote Google Fonts. These assertions now verify the strict source contract:
modern modes refuse missing approval and older general-audience configuration,
accept one reviewed country/coarse-age grant for one creation attempt, and leave
provider controls unmounted before eligibility. Explicit legacy previews retain
their existing transport/UI expectations. Apple discovery remains metadata-only;
the test explicitly preloads the SDK from the eligible surface. The CSP test
expects locally hosted fonts.

```powershell
node --experimental-strip-types --test frontend/ts/services/publicApiPreviewCompatibility.test.mjs frontend/ts/services/appleWebCredential.test.mjs frontend/ts/config/apiBase.test.mjs
```

**26 passed, 0 failed, 0 skipped**. The scoped `git diff --check` passed.

Complete frontend verification then passed:

```powershell
npm.cmd --prefix frontend test
```

**TypeScript passed; 751 passed, 0 failed, 0 skipped.** Output was retained at
`$env:TEMP\ludolume-child-frontend-full-after-compatibility.log`. No implementation
change was required for this follow-up; only the three test files above and this
receipt were updated.

## Creation-paused fallback continuity

The final strict contract includes required `creationEnabled: boolean` independently
of staged eligibility. When false, signup shows the paused message and mounts no
eligibility form, account fields or provider controls. Existing password login is
unchanged. Provider login still requires explicit country/coarse-age approval and
the server's private short-lived grant, so existing passwordless adult accounts
can sign in while new creation is closed. The auth API captures the creation flag
with that in-memory approval and rejects password/provider signup before transport
or provider credential acquisition when false. Backend enforcement remains
authoritative if availability changes after approval; no error contract changed.

This final follow-up changed `registrationApi.ts`, `authApi.ts`,
`RegistrationGate.tsx`, their child-audience/lifecycle tests and the strict fixture
in `publicApiPreviewCompatibility.test.mjs`.

```powershell
node --experimental-strip-types --test frontend/ts/services/authApi.childAudience.test.mjs frontend/ts/services/authApi.generalRegistration.test.mjs frontend/ts/services/registrationApi.test.mjs frontend/ts/components/RegistrationGate.lifecycle.test.mjs frontend/ts/services/publicApiPreviewCompatibility.test.mjs
npm.cmd --prefix frontend test
```

**Focused: 41 passed. Complete: TypeScript passed; 755 passed, 0 failed, 0
skipped.** Scoped `git diff --check` passed. Final complete-suite output is at
`$env:TEMP\ludolume-child-frontend-final-paused-creation.log`. Four new cases
exercise paused signup without mounted collection surfaces, provider-login
eligibility while creation is paused, direct signup collection barriers, and both
prepared and one-shot existing provider login. Missing/nonboolean creation flags
fail closed. No installation, commit or external write was performed by this task.
