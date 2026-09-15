# Clean Code inventory and teaching plan

## Baseline and scope

Recorded 2026-09-10 against `3af15ecbf18d0b277578f2488943648acbc70085`
(`main` after the p4-Vega release closeout). The baseline has **1,586 tracked
files**. This document is a new file beyond that baseline.

This is an ownership and subsystem inventory, with targeted source inspection
to choose the first refactor. It is **not** a claim that every implementation
has received a line-by-line review. No application code, dependency, database,
Unity asset, deployed service or running development process changed in this
pass. Completed release, device and package-script audits stay closed.

Reference: Robert C. Martin, *Clean Code: A Handbook of Agile Software
Craftsmanship*, the owner's local `C:\Users\User\Desktop\Pastas\Books\CleanCode.pdf`.
Consulted printed pages 35 (focused functions), 120 (dependency boundaries),
124 (readable tests) and 138 (responsibilities), corresponding to PDF pages
66, 151, 155 and 169. The book remains outside the repository. Its examples
are guidance, not rules requiring tiny functions, classes, wrappers or rewrites
where those would add more complexity than they remove.

## Tracked-file classification

The source of truth is Git's index, not a recursive scan of the working folder:

```powershell
git ls-files -z
git ls-files | Group-Object { ($_ -split '/')[0] } |
    Sort-Object Count -Descending
```

Every baseline path was assigned once using the boundaries below. Generated,
upstream, native and asset paths take precedence over general source/test/file
extension rules. The remaining 63 non-Unity tooling/configuration paths were
listed and inspected as a set; they are not an unclassified catch-all.
Counts total 1,586. Ignored dependencies, caches, local credentials, build
directories and out-of-repository evidence archives are outside this inventory.

| Class | Files | Boundary and treatment |
| --- | ---: | --- |
| First-party implementation | 313 | 208 frontend TypeScript/shaders/Sass and backend TypeScript files, plus 105 Unity runtime/editor C# and WebGL `.jslib` files. Review behavior-preserving changes by subsystem. |
| First-party tests | 76 | 67 `.test.ts` / `.test.mjs` files across frontend, backend and tooling; 9 Unity C# test files. Counts are files, not passing tests or coverage. |
| First-party tooling/configuration | 93 | 63 root/build/deploy/dev/editor/web configuration and tool files; 30 Unity project/package/assembly configuration files. Includes TypeDoc source CSS and the web manifest. Existing package-script audit is carried forward. |
| First-party documentation/references | 18 | Root and subsystem Markdown, agent instructions, design guidance, `docs-src/index.md`, and `resources/colors.txt`. Excludes upstream skill/license text and the captured tree below. |
| Protected schema migration history | 5 | `backend/migrations/0001` through `0005`. Do not rewrite or delete applied history. Executable migration/recovery code is included in first-party implementation, not assumed disposable. |
| Project-controlled native scaffolds/assets | 65 | Remaining `frontend/android/**` and `frontend/ios/**`, including Java/Swift entry points, example tests, resources and project files. Classify template remnants before changing them; preserve the Capacitor direction. |
| Project-controlled media/serialized content | 334 | 33 web artwork/audio/sprite-data files and 301 Unity scenes, prefabs, animation/material/data/settings/media files. Not conventional source refactoring targets; preserve references, attribution and embedded C2PA Content Credentials (provenance, not secrets). |
| Required Unity project metadata | 478 | Project `.meta` files outside the third-party group. These carry GUID/import settings and are not disposable generated junk. |
| Generated TypeDoc | 96 | `docs/**`. Change the source/configuration and regenerate when relevant; do not hand-refactor the generated site. |
| Generated Unity release | 5 | Four content-addressed files in `frontend/public/unity/three-bosses/releases/**` plus `build-manifest.json`. Preserve exact release bytes and provenance; use the release pipeline for changes. |
| Generated dependency locks | 5 | Four npm lockfiles and Unity `Packages/packages-lock.json`. Update through the appropriate dependency workflow, not a stylistic rewrite. |
| Generated Capacitor wiring | 2 | Android `app/capacitor.build.gradle` and `capacitor.settings.gradle`, explicitly marked generated. |
| Upstream tools/fonts/resources/notices | 95 | 11 Unity CLI skill files; 80 TextMesh Pro/Oxanium files including their metadata; `UNITY_COMPANION_LICENSE.md`; 3 Gradle wrapper files. Preserve attribution and update through upstream workflows. |
| Captured legacy directory listing | 1 | Baseline path `resources/project-structure.txt` contained stale paths and captured generated/dependency output. Retired after reference review on 2026-09-10; this historical baseline count remains unchanged. |

Ownership evidence for Unity content comes from
`unity/three-bosses/ASSET_PROVENANCE.md` and
`unity/three-bosses/THIRD_PARTY_NOTICES.md`; it is not a new legal review. Generated artwork is
still project content, unlike generated executable/build output. Native
scaffolding is not automatically third-party code to discard simply because
it started from a template.

### Subsystem review queue

All areas are inventoried; only the named candidate below has been selected
for implementation. Later entries remain review scopes, not a commitment to
refactor everything in them.

| Area | Review boundary | Current decision |
| --- | --- | --- |
| Leaderboard UI/data loading | `frontend/ts/pages/leaderboards`, hub page, transport/service boundary and route tests | First slice completed 2026-09-10: isolated the detail-state loader and its direct Node tests, described below. |
| Shared shell/forms/services/styles | `App`, `Header`, components, context, hooks, layout, auth pages/services and `frontend/sass` | Auth transport and initial session-check lifecycle completed 2026-09-10. Owner-requested signup auto-login and shared glass alerts are recorded below; other shell/style areas remain review scopes. |
| Games | `frontend/ts/games`, game pages, help/results and bridge modules | Inspect responsibilities and lifecycles, preserving newly accepted gameplay, 1000-point policy, faster diagonal movement and touch/scroll boundaries. No generic release retest. |
| Animations/audio/math | `frontend/ts/animations`, music controls, shared utilities and public facades | Review ownership of renderer/audio/timing cleanup and pure calculations; retain artistic behavior. |
| Backend | `backend/ts` configuration, controllers, routers, middleware, repositories, security, migrations and public contracts | Second slice completed 2026-09-10: consolidated the duplicated Three Bosses mutation preconditions. Ordering, DTOs, gates, credentials and persistence remain unchanged. Other backend areas are still review scopes. |
| Unity | Custom `Assets/Scripts`, `Editor`, `Plugins/WebGL` and `Tests` | Review source responsibilities separately from serialized content. Any later scene/asset mutation uses the established Unity workflow and preserves GUIDs. |
| Native platforms | Android/iOS entry points, resources and configuration | Inventory complete; substantive review stays aligned with the native/PWA phase and available platform checks. |
| Tooling/configuration/docs | Root, `.github`, `.githooks`, `.vscode`, `scripts`, `docs-src`, `design`, `resources`, subsystem docs | Stale project-guidance slice completed 2026-09-10: corrected backend paths and retired the unused directory listing. Other tooling areas remain review scopes; preserve deployment boundaries and do not repeat the completed package audit. |

## First slice: isolate the leaderboard detail-state loader

### Before the refactor and the cost of its placement

At pre-refactor commit `86cd0cf4`,
`frontend/ts/pages/leaderboards/GameLeaderboard.tsx:13-90` defined the detail
state and loading decisions alongside the React page. The function already
accepts injected readers, which is a good foundation. However, its default
readers come from `leaderboardService`, which imports environment configuration
and constructs the configured API client.

Before-code, abbreviated only to show the dependency boundary:

```ts
// GameLeaderboard.tsx
export async function loadGameLeaderboardState(
    gameId: string | undefined,
    signal?: AbortSignal,
    readers: LeaderboardDetailReaders = {
        readCatalog: getLeaderboardCatalog,
        readGame: getGameLeaderboard,
    }
): Promise<SettledDetailState> {
    // Existing catalog selection, result validation and error decisions.
}
```

At that same commit, `leaderboardRoutes.test.mjs:16-38` starts Vite in middleware mode and loads
the `.tsx` module even for the injected-reader logic case at line 320. Vite
is appropriate for its JSX/view tests; it should not be required just to test
how a catalog/read result becomes `success`, `not-found` or `error`.

### Implemented change — 2026-09-10

The existing state/types/loader now live in adjacent
`frontend/ts/pages/leaderboards/leaderboardDetailState.ts`. It imports DTO types
and `LeaderboardRequestError` directly from `../../services/leaderboardApi.ts`,
not the environment-configured `leaderboardService`.

Actual new signature (the unchanged decision body is omitted here):

```ts
// leaderboardDetailState.ts
export async function loadGameLeaderboardState(
    gameId: string | undefined,
    signal: AbortSignal | undefined,
    readers: LeaderboardDetailReaders
): Promise<SettledDetailState> {
    // Same loading decisions; no React or environment-configured client.
}
```

The page supplies its already-existing real services explicitly:

```ts
const nextState = await loadGameLeaderboardState(
    gameId,
    abortController.signal,
    { readCatalog: getLeaderboardCatalog, readGame: getGameLeaderboard }
);
```

This is **dependency injection** in its simplest form: pass the collaborators
a function needs as arguments. No container, service hierarchy or generic
fetch framework is needed. The page owns the effect, retry, cancellation and
rendering; the loader owns the catalog/result-to-state decisions; the transport
owns HTTP and payload validation.

The benefit is not moving lines into a shorter file. It is making the
dependency boundary real and making the loader independently testable. The
loader is still asynchronous and performs I/O through its supplied readers;
it is not a mathematically pure function. The trade-off is one extra module
and explicit arguments at the call site, justified by independent logic tests.

### Preserved behavior and verification boundaries

- Keep catalog-first loading, no game read for missing/unknown routes, and the
  same AbortSignal passed to both reads.
- Preserve the rules-version mismatch error, `UNKNOWN_GAME` recovery links,
  selected-game context on ordinary errors and cancellation propagation.
- Keep the React effect's abort guard/cleanup, dependency array, retry callback,
  rendered markup, focus behavior, labels and table formatting unchanged.
- Use the same `LeaderboardRequestError` module identity within each test
  runtime; mixing a Node-loaded class with a Vite-loaded class can break
  `instanceof` even when their source is identical.
- Move the relevant existing loader assertions into direct Node tests; add
  focused signal/cancellation cases if missing. Retain Vite SSR view/hub tests.
  The full route suite still uses Vite: no claim that the entire suite becomes
  Vite-free or substantially faster.
- When implementing, run the complete relevant frontend checks once:
  `npm --prefix frontend test` and `npm --prefix frontend run build`, plus a
  bounded browser check of unchanged leaderboard rendering. No real accounts,
  score writes, database migration, Unity rebuild or device campaign is needed.

Finish that slice with a reviewed diff and commit/sync before choosing another
subsystem. Do not combine it with new caching, new state libraries, table
redesigns or backend authorization changes.

### Implementation closeout

The loader's decision body and the page's JSX/formatting functions were compared
with the previous commit and are text-identical. The page imports the extracted
loader, state type and existing cancellation predicate, and passes its real
readers explicitly. The transport, React effect lifecycle and UI are unchanged.

The test boundary changed from loading a `.tsx` module through Vite to:

```js
import { loadGameLeaderboardState } from './leaderboardDetailState.ts';

const result = await loadGameLeaderboardState('p4-vega', undefined, {
    readCatalog: async () => catalog,
    readGame: async () => { throw new Error('service unavailable'); },
});
assert.deepEqual(result, {
    status: 'error',
    game: p4VegaGame,
    message: 'service unavailable',
});
```

This test case uses fixed responses to exercise a failed game read. No browser,
real API request or database is involved. Existing logic assertions were moved,
not abandoned; cancellation, signal forwarding and missing-route cases were
added. The original hub/view tests remain in the Vite-backed route suite.

Checks actually completed:

- `node --experimental-strip-types --test frontend/ts/pages/leaderboards/leaderboardDetailState.test.mjs`
  — 13 passed independently of Vite/React/environment configuration.
- `npm --prefix frontend test` — TypeScript and all 185 tests passed.
- `npm --prefix frontend run build` — passed; existing >500 kB chunk warning
  remains. No dependency or lockfile changes; the only package edit registers
  the new test file in the existing command.
- Browser: local p4-Vega detail → leaderboard hub → Three Bosses detail loaded
  and rendered their existing tables. This was read-only, not a new gameplay,
  authentication, score-write or physical-device campaign.
- `git diff --check` — passed. Independent read-only review found no boundary
  regression. No backend/cloud configuration, Unity content or deployment changed.

## Second slice: shared Three Bosses mutation policy — 2026-09-10

Before this refactor, `leaderboardController.ts` repeated the same four guards
in both ticket issuance and run submission: enabled flag, authentication,
trusted Origin, JSON content type. Each guard built its own versioned HTTP error.
Changing that policy required keeping two copies in sync.

Both handlers now start with this actual code:

```ts
const authorization = authorizeThreeBossesMutation(req, mutationPolicy);
if (!authorization.authorized) {
    return res.status(authorization.status).json({
        success: false,
        contractVersion: LEADERBOARD_CONTRACT_VERSION,
        error: authorization.error,
    });
}
```

The new `backend/ts/security/threeBossesMutationAuthorization.ts` owns only
those shared decisions. Its discriminated union exposes a trusted identity on
success, or a status/error on rejection. TypeScript therefore requires checking
`authorized` before reading `identity`. The controller still owns HTTP response
serialization, endpoint-specific payload validation, tickets and persistence.

This removes duplicate **policy**, not every repeated line. A small response
block remains in each handler deliberately; a generic response/middleware
framework would add more indirection than this change needs. The extra module
is justified by two real callers and direct policy tests, not by file length.

Order and exact responses are retained: disabled → 403 `SUBMISSION_DISABLED`;
authentication or Origin failure → 401 `UNAUTHORIZED`; non-JSON → 400
`INVALID_RUN`. Three Bosses keeps its existing 401 authentication-configuration
failure response, distinct from p4-Vega's 500. Existing authentication and
Origin validators are reused unchanged. Router limiter/JSON middleware order,
payload/ticket rules, database calls and response DTOs are untouched.

Checks actually completed:

- `npm --prefix backend test` — TypeScript passed.
- From `backend`: `node --test -r ts-node/register ts/security/threeBossesMutationAuthorization.test.ts`
  — 8 policy cases passed; registered in the existing `test:unit` command.
- From `backend`: `node --test -r ts-node/register ts/routers/leaderboardRouter.test.ts ts/routers/threeBossesRouter.security.test.ts`
  — 7 existing HTTP/router cases passed with fake persistence, including
  disabled-before-limiter behavior and both endpoint contracts.
- `npm --prefix backend run prod` — webpack production bundles passed.
- Independent read-only review found no actionable policy/wiring issue.

### Test command simplification approved in the same batch

`frontend/package.json` now uses
`tsc -p tsconfig.json --noEmit && node --experimental-strip-types --test "ts/**/*.test.mjs"`
instead of 19 explicit file paths. The quoted glob lets Node discover tests
without relying on shell expansion. Read-only set comparison found the exact
same 19 files, and `npm --prefix frontend test` passed TypeScript and all 185
tests. New matching test files are discovered automatically. No tests were
deleted, no dependency/lockfile changed, and the completed package audit was
not reopened. Local and CI Node versions are 22.23.2.

This batch did not repeat frontend builds/device tests or production submission
checks: frontend application source and production state were unchanged.
Generated documentation stayed unchanged; `git diff --check` passed.
## Third slice: retire stale project guidance — 2026-09-10

Corrected the five backend locations in `.github/copilot-instructions.md`.
For example, the old entry `backend/app.ts` is now `backend/ts/app.ts`.
The old "Database config" entry pointed to nonexistent
`backend/config/dbConfig.ts`; the guide now distinguishes the actual database
pool (`backend/ts/db/dbConfig.ts`) from validated environment configuration
(`backend/ts/config/**`). No application files were moved or modified.

Removed `resources/project-structure.txt` (586 lines) and its dedicated
`.gitattributes` rule. The captured tree mixed obsolete source paths with
`node_modules`, `dist`, Android build intermediates, APKs and logs. Tracked
reference search found no code, build or documentation-generator consumer:
only the attribute rule, inventory/roadmap notes and the listing's own name.
Git retains the old snapshot; no replacement tree or generator was added.

The principle is to document stable responsibilities rather than maintain a
second, manually synchronized filesystem inventory. Use Git/IDE discovery
for the current file list. The trade-off is losing an in-tree historical
snapshot, which remains recoverable from Git history. The original inventory
counts above intentionally describe their dated baseline, not today's count.

Validation: all 18 frontend/backend path references in the guide resolved to
tracked files/directories; tracked-reference search confirmed no remaining
consumer of the retired listing; `git diff --check` passed. No tests, builds,
dependency installs, server restarts or deployments were needed or run for
this documentation-only slice.

## Fourth slice: a consistent auth transport boundary — 2026-09-10

Login and session verification already used `authService.ts`, but signup
constructed its request in `SignUp.tsx` and logout did so in `AuthContext.tsx`.
That split left HTTP options, response parsing, form state and alerts mixed
across different layers. The service also omitted the verified username from
its session-response type, requiring an `any` cast in the context.

New `frontend/ts/services/authApi.ts` owns the four HTTP operations through
`createAuthApi(apiBase, fetchRequest)`. The configured `authService.ts` exports
those operations using the existing `API_BASE`; tests supply a fake fetch.
This follows the existing leaderboard transport/service split, without a
generic HTTP framework, new dependency or shared form component.

Before, signup constructed `fetch`, checked HTTP status and parsed JSON in
its submit handler. The actual replacement is:

```ts
const data = await signupRequest({
    user_name: userName,
    email,
    user_password: userPassword,
});
```

Its existing alert switch, success-only field clearing, loading cleanup and
JSX remain text-identical. Login's page is unchanged. Logout now delegates
to `logoutRequest()` but still clears local state on server/network failure.
Session verification now describes both real response shapes, allowing:

```diff
- setUserName((res as any).user_name ?? null);
+ setUserName(res.user_name ?? null);
```

The benefit is one testable HTTP boundary and explicit responsibilities, not
merely fewer lines. The trade-off is an extra module and factory; it has four
real operations and tests independent of React/Vite/environment configuration.
TypeScript response types describe the expected contract; they do **not** add
runtime JSON validation. Stronger payload checks, new 429 messaging and form
validation changes are not silently included in a behavior-preserving refactor.

Preserved contracts: exact endpoints and selected payload fields, password
whitespace, `credentials: 'include'`, HTTP-200 validation errors (including
duplicate-user `status: 409` in the JSON body), non-2xx rejection before parsing,
network/JSON failure propagation, no auto-login after signup, and existing
best-effort logout. Backend and public API behavior are unchanged.

Checks actually completed:

- `node --experimental-strip-types --test frontend/ts/services/authApi.test.mjs`
  — 9 focused transport tests passed, using fake responses only.
- `npm --prefix frontend test` — TypeScript and all 194 tests passed; the new
  file was discovered by the glob without another package-script edit.
- `npm --prefix frontend run build` — passed; existing >500 kB chunk warning.
- Source comparison confirmed the unchanged signup alert/state-cleanup/JSX
  section and unchanged Login page; `git diff --check` passed.
- No real accounts, auth requests, database writes, device campaign or backend
  build. No dependency/lockfile or generated-documentation changes.

The initial session-check follow-up is completed in the next checkpoint below.

## Signup onboarding and shared alert theme — 2026-09-10

This is an explicitly requested behavior change, not a behavior-preserving
refactor: signup previously only created the account and cleared the form.
It now signs in through the existing cookie-based login endpoint, shows one
welcome message, then navigates Home. Manual login retains its normal message.

`signupFlow.ts` owns the sequence, not HTTP or React. Its explicit outcomes are
`rejected`, `authenticated`, and `login-required`. The third state matters:
account creation can succeed even if the following login request fails. The
page must then say "Account created" and offer Log in, not repeat registration.
The page's synchronous ref guard also prevents overlapping signup submissions.

The implemented dependency boundary is:

```ts
login: (user, password) => login(user, password, { showFeedback: false }),
```

Signup owns its completion message; the same login operation still owns auth
state. Suppressing its normal "Welcome back!" alert avoids two success dialogs.
`AuthContext` also ignores initial verification results after an auth action
starts or the effect is cleaned up. A late startup response must not undo a
successful signup/login. This is not a general concurrent-auth request manager.

`components/siteAlert.ts` configures one SweetAlert2 mixin; `_site-alert.scss`
owns its glass colors, typography, focus styles and responsive layout. Existing
auth consumers use this wrapper. The installed library already supports custom
classes, so no replacement dependency is needed. Keyboard/focus behavior stays
with SweetAlert2, while unnecessary height/scrollbar adjustments are disabled.
The trade-off is a small flow module and wrapper, each with one clear purpose;
no generic workflow engine or new component framework was added.

Checks completed:

- Six focused `signupFlow.test.mjs` cases cover sequencing, credentials,
  registration errors, malformed success and post-creation login failure.
- `npm --prefix frontend test` — TypeScript and all 200 tests passed.
- `npm --prefix frontend run build` — passed; existing >500 kB chunk warning.
- Isolated Chromium with intercepted API responses verified signup success at
  1366x900, 390x844 and 844x390, late startup verification, duplicate-user errors,
  failed automatic login/manual-login redirect, rapid double submission, and
  unchanged manual-login feedback/Enter-key confirmation. No page errors.
- Rendered portrait screenshot inspected; dialogs fit all three viewports with
  44px action targets. Physical iPhone/Safari behavior is not claimed.
- No real accounts, database writes, backend/cookie-policy changes, new package,
  or temporary preview/script files. Screenshots remain outside the repository.

## Shared game personal-best notification — 2026-09-10

The previous SweetAlert audit correctly covered all 12 library calls but did not
cover every game notification: p4-Vega had a custom results-card badge; Three
Bosses forwarded the accepted result only to Unity. Both now render the shared
`PersonalBestAlert` for server-confirmed personal bests. The existing p4 badge
remains; this is an explicit UI feature, not changed ranking/storage logic.

The important boundary is **save first, notify separately**. The Unity submission
bridge delivers success before calling its optional presentation observer and
contains observer failures. An alert failure must not falsely report that a
stored score failed. Three Bosses deduplicates by run ID rather than rejecting
`replayed: true`, since a replay may be the first received confirmation after a
lost response. p4 mounts its alert only for a submitted personal-best result.

The presenter shares theme, fullscreen placement and cleanup. It recreates the
dialog through SweetAlert when fullscreen placement changes so accessibility
isolation is recalculated, rather than moving an inert/aria-hidden DOM branch.
It defers behind p4's open help dialog and restores game focus without scrolling.

Verification: 13 submission-bridge cases passed, including observer throw/reject,
timeout/disposal and receipt replay. TypeScript/all 202 frontend tests passed;
Vite build passed with its existing chunk warning. Isolated Chromium used fake
game callbacks and intercepted API reads, with every real POST blocked. Portrait
p4, landscape native p4 and fallback Three Bosses, desktop Three Bosses,
fullscreen transitions while open, duplicate/non-record suppression, another
run, help deferral, focus and route cleanup passed. The first transition fixture
needed its prefixed fullscreen API disabled too; that corrected fixture passed.
Screenshots inspected; no real scores/accounts, physical-device claim, Unity
rebuild, dependency change or temporary in-repository test page/script.

## Route dependencies and shared status screens — 2026-09-14

The build warning described a JavaScript chunk above Vite's default 500 kB
minified, uncompressed threshold; it was not a failed build or proof of a
gameplay frame-rate defect. Inspection found that static page imports brought
Pixi, Tone and their dependencies into Home's initial JavaScript.

Actual before/after in `frontend/ts/App.tsx`:

```tsx
// Before: the renderer and music dependencies join the initial module graph.
import P4Vega from '@/pages/games/P4Vega';

// After: load this dependency graph when the destination is rendered.
const P4Vega = lazy(() => import('@/pages/games/P4Vega'));
```

This is a dependency-boundary improvement, not merely moving code into another
file. All destinations now share a small `RouteContentBoundary`; Home and the
404 recovery page stay eager. The boundary keeps the header/background/footer
mounted, handles pending imports and rejected downloads, and resets on pathname
navigation. Successful children gain no wrapper, preserving native direct-child
layout selectors. Each graphics composition root retains the static
`pixi.js/unsafe-eval` import that installs CSP-safe renderer generators.

The owner also requested polished loading and 404 screens. `PageStatus.tsx`
shares the cosmic glass card and orbiting-controller motif between loading,
not-found and load failure. The decoration uses CSS/SVG, not Pixi or another
package. Explicit recovery actions, accessible status/alert labels, 44px targets
and reduced-motion rules are included. No fake progress percentage, forced
delay, automatic reload or redirect timer was added. The trade-off is a short
loading screen on a destination's first uncached visit; content data requests
inside an already mounted page retain their existing loading behavior.

Measured initial JavaScript, with the same production build configuration:

| Measure | Before | After |
| --- | ---: | ---: |
| Minified bytes | 1,115,199 | 354,416 |
| Gzip bytes | 330,294 | 110,125 |

This is about 68% less initial JavaScript, not 68% faster startup or 68% smaller
total assets. A graphics destination still downloads its own required engines.
No manual vendor partitioning or warning-threshold increase was used.

Verification: `npm --prefix frontend test` passed TypeScript and all 265 tests;
`npm --prefix frontend run build` passed without the size warning. A Vite module
graph inspection confirmed Pixi/Tone were removed from the eager graph. Built
Chromium rendered all three graphics experiences, navigated back Home, and
recovered through the shared boundary from a deliberately failed chunk. An
in-memory, loopback-only preview middleware held a Login chunk pending to
capture the genuine shared loading screen; it was not committed or shipped.
Desktop and 390x844 loading/404 screenshots were inspected, with no horizontal
overflow; 404 Games navigation and matching failure controls worked. The
reduced-motion rules were code-reviewed, not tested on a physical device.

No database/account changes, new dependency, production release or TestFlight
upload. Temporary preview processes/tabs are closed after verification;
requested screenshot artifacts live outside the repository. The Docs watcher
regenerated the affected source-line link, which is included with this change.

## Shared music picker and audio/UI boundary — 2026-09-14

The owner reported greyed-out audio files in Safari's Files picker on both
Dancing Circles and Dancing Fractals. This happens before file selection reaches
the engine. Both pages duplicated a label, hidden input, keyboard handler, ref
and effect, while `AudioEngine.initializeUploadButton()` owned a DOM listener.

Before, each page separately specified:

```tsx
accept="audio/*"
```

and connected its input through `audioEngine.initializeUploadButton(input)`.
After, each page composes the same control (actual Circles code):

```tsx
<MusicUpload
    id="dancing-circles-file-upload"
    classPrefix="dancing-circles"
    onFileSelect={(file) => { void audioEngine.processAudio(file); }}
/>
```

`MusicUpload.tsx` owns picker hints, the existing accessible label/keyboard
behavior and React's change handler. Its filter combines `audio/*` with explicit
extensions including MP3, M4A, AAC, WAV, AIFF, FLAC, Ogg and Opus, following the
[HTML standard's MIME-and-extension guidance](https://html.spec.whatwg.org/multipage/input.html#attr-input-accept).
The control forwards the original File, including missing/generic MIME types;
it does not mistake picker hints for codec validation. Files remain local.

This applies the reference's responsibility guidance (printed pp. 35 and 138):
file-selection UX changes belong to UI code, not the audio-analysis engine.
The removed input-listener adapter has no remaining callers. Audio graph setup,
playback, analysis, disposal, animation timing and page styling are unchanged.
One component is justified by two actual consumers with identical behavior;
there is no generic upload framework, new dependency or playback rewrite.

Verification: 5 focused component tests, frontend TypeScript/all 373 tests and
the Vite production build passed. Tests cover both page-specific labels/classes,
filter hints, missing/generic MIME types, cancellation and synchronous keyboard
activation. Independent diff review found no actionable regressions. The Docs
watcher regenerated the removed method and source links. The actual iOS Files
picker and codec playback remain unverified on-device; no deployment occurred.

## Learning-oriented handoff for each future change

The owner requested on 2026-09-10 that improvements be taught, not merely
performed. Each implementation handoff should show:

1. The actual before-code and the concrete maintenance problem it creates.
2. The focused after-code/diff, explaining the principle and how this project
   uses it; distinguish code movement from a genuine dependency improvement.
3. Behavior preserved, relevant edge cases, verification actually performed
   and its limits. Label illustrative/proposed code clearly.
4. The trade-off, including when the same abstraction would be unnecessary.

For example, identical backend-looking configuration readers were not selected
for consolidation: runtime strings can trim whitespace, migration passwords
must preserve it, and cleanup credentials must not silently fall back to
runtime credentials. Similar syntax does not imply identical policy.

## Inventory closeout

Read-only Git/path enumeration, local reference reading and targeted frontend/
backend/tooling inspection completed. The classification sum covers all 1,586
baseline paths; no cleanup tooling or per-file generated manifest was added.
Only this inventory and roadmap documentation change in this pass. No tests,
builds, dependency installations or production checks were run because no
application behavior changed. Validation is limited to inventory consistency,
documentation links and `git diff --check`.
