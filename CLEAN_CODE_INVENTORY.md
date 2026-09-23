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

## Three Bosses browser-bridge teardown — 2026-09-14

`unityWebGl.ts` repeated the same three best-effort release operations in failed
initialization and normal shutdown: submission bridge, portrait layout, then
visibility. Updating that ordered list previously required editing both paths.
The list now lives in the local `releaseUnityBridges()` function. Each release
retains its own try/catch so one failure does not skip the remaining releases.

The important difference between the callers remains explicit. Failed startup
now contains this actual sequence:

```ts
releasePageScroll?.();
releaseUnityBridges();
await instance.Quit();
throw error;
```

Normal shutdown still releases page scrolling, attempts to disable submission,
then calls the same `releaseUnityBridges()`. Its once-only guard, readiness
cleanup, loader removal, factory reset and singleton lifecycle are unchanged.
Page-scroll release still propagates errors exactly as before; this refactor
does not silently introduce a different cleanup policy.

The reference's responsibility principle (printed p. 138) supports one owner
for the shared bridge-release sequence. This is a local extraction, not a new
module or generalized resource-management framework. Keeping the two shutdown
policies separate avoids a boolean mode flag or a changed execution order.

Verification: five mocked public-lifecycle tests exercise normal/repeated quit,
partially acquired bindings, throwing bridge cleanup, abort during startup and
the existing page-scroll error policy. The tests run the real loader lifecycle
with in-memory browser/Unity doubles, not a detached copy of the cleanup code.
Frontend TypeScript/all 378 tests and the Vite production build passed;
independent source review found no actionable regressions. No game assets,
real score submissions, device tests, Unity builds or deployments were involved.

## Renderer and upload cancellation ownership — 2026-09-14

This slice fixes lifecycle bugs, rather than just moving code. Dancing Circles
previously assigned its disposer only after asynchronous renderer startup. If
the page unmounted first, its cleanup saw no disposer and the late renderer
remained alive. The effect now captures its container and cancels its own mount;
a late result is disposed immediately. Dancing Fractals already had this guard
and was left unchanged.

The shared AudioEngine previously registered its audio element/context only
after awaiting context resume, so a concurrent dispose could miss them. Uploads
now adopt allocated resources before that wait and capture the existing session
generation. After asynchronous teardown, resume and initial playback, a stale
generation returns without publishing state or starting analysis. Example from
the corrected upload path:

```ts
const currentSessionId = ++this.sessionId;
await this.teardownTrack();
if (currentSessionId !== this.sessionId) return;
```

Teardown captures and clears its owned fields before awaiting context close;
afterward it revokes only its captured URL. An older dispose also cannot reset a
newer track's state. The unused optional close-context mode was removed: both
private callers always close. This applies explicit ownership from the reference
(printed p. 138), without a generic resource manager or new dependency.

Before the fixes, two renderer and six audio regression cases reproduced the
bugs. Afterward, three renderer/effect cases and eight fake-Web-Audio cases pass,
along with frontend TypeScript/all 389 tests and the Vite production build.
Independent review found no actionable regressions. Generated AudioEngine docs
have updated source links. No physical device/GPU/codec acceptance is claimed;
the renderer tests control hook scheduling and the audio tests defer browser
promises. Visual tuning, DSP, autoplay ordering and public APIs are unchanged.

The separate transport follow-up was completed below on 2026-09-15. Safari
Files picker acceptance remains deferred at the owner's request. No deployment
occurred.

## Audio transport intent — 2026-09-15

Previously, explicit Play awaited context resume and media playback, then
unconditionally set `playing: true`. A later Pause/Stop could therefore lose to
an older continuation. Upload autoplay and automatic interruption recovery had
the same missing transport boundary; an old Play rejection could also mark a
newer successful Play as stopped.

Before, the explicit Play path contained:

```ts
await this.ensureContextRunning();
await audio.play();
this.patchState({ playing: true });
```

All three playback paths now call one guarded `resumePlayback` helper. A fresh
Symbol identifies each explicit Play or upload-autoplay intent; Pause, Stop,
natural end and disposal clear it. The actual current-request check is:

```ts
private isCurrentPlayback(audio: HTMLAudioElement, request: symbol): boolean {
    return this.playbackRequest === request && this.audioElement === audio;
}
```

Checks surround browser waits, and success state/analysis start stay in that
same helper to avoid an extra asynchronous gap in its callers. Stale success
does not silence a newer Play on the same element. Stale failures do not change
state; a current explicit failure still reports the error and now pauses and
cancels analysis immediately. Recovery keeps its quiet retry policy. Explicit
Play also waits for a ready graph, matching the existing UI's `hasAudio` gate.

Track ownership (`sessionId`) and playback intent are separate responsibilities:
Pause/Stop suppress autoplay without cancelling loading or disposing the track.
Pause preserves position; Stop rewinds; a fresh Play remains possible. This is
a focused application of the reference's responsibility principle (printed
p. 138), not a new service, state-machine framework or dependency. Visuals,
DSP, file filtering and public method signatures are unchanged.

Verification: 15 new cases failed against the original source; an additional
microtask-boundary test caught the intermediate helper/caller gap. All 26
focused audio cases now pass, using the existing fake-browser fixture and
parameterized scenarios. Frontend TypeScript/all 407 tests, the Vite production
build and `git diff --check` passed. Independent source review found no
actionable regressions. Generated AudioEngine source links were refreshed.
No physical device/codec verification or deployment was performed; the Safari
Files picker check remains deferred rather than being repeated as a blocker.

## Shared hooks and dropdown interaction — 2026-09-15

Reviewed `useAudioEngineState` and `useSafariBackgroundEdges` without changing
them: subscription cleanup, the immediate current-state snapshot, stable shell
controller and disposed-callback guards are already present. This checkpoint
does not reopen completed audio transport or accepted Safari edge behavior.

The adjacent shared `Dropdown` had a concrete interaction defect. Closed menus
used only `opacity: 0` and `pointer-events: none`; an isolated Chrome probe
confirmed that Tab still focused an invisible option. Visual hiding and keyboard
interaction are different responsibilities. The existing fade CSS stays intact;
the component now controls interactivity explicitly:

The list gains `inert={!isOpen}`, where `isOpen` is `open && !disabled`.
`inert` removes the closed
subtree from focus and accessibility exposure, as described by
[MDN](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Global_attributes/inert).
The trigger uses `aria-expanded` and a stable `aria-controls` ID following the
[WAI disclosure pattern](https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/).
Removed the unsupported ARIA-menu claim rather than adding a full menu/listbox
keyboard framework to these ordinary buttons.

Escape and selection share `closeAndFocusButton`; Tab to another control and
outside clicks close without stealing focus. Null blur targets do not close
prematurely before an option click. Disabling closes the list and re-enabling
does not reopen it. The document listener now exists only while open. This
applies the reference's focused-function guidance (printed p. 35) locally;
props, values, callers, styling and dependencies are unchanged.

Six focused handler/markup cases failed before the fix and now pass. Real
React StrictMode in isolated Chrome verified closed Tab order, Enter/Space,
Escape, selection, Tab-out, outside clicks, disable/re-enable and unique IDs;
390x844 touch emulation verified selection. Frontend TypeScript/all 413 tests,
Vite build and `git diff --check` passed. Independent review found no remaining
actionable issues. No real accounts, gameplay, physical-iPhone acceptance or
deployment were involved; the deferred Safari Files check remains separate.

## Safari preview font-loading dependency — 2026-09-15

During the owner's music-picker check, Safari showed unstyled content and an
oversized fullscreen icon. The preview served its complete CSS with the correct
MIME type. Holding the five external Google Fonts imports in WebKit reproduced
the same default-font/transparent-background page, while normal requests styled
it correctly. This identifies a reproducible failure path; the actual phone's
network trace was not available.

Removed the remote `@import` chain from `_fonts.scss`, keeping every family and
fallback variable. `main.tsx` now calls `loadAppFonts`, which adds one independent
dynamic stylesheet with the same families/weights and `display=swap`. Local
layout styles no longer depend on the font server. Font availability can change
typography, but not whether the site's layout CSS applies. No font service,
dependency, permission or design was replaced.

The refreshed LAN preview stayed styled in WebKit with fonts held on both
animation pages, with font failure, and with normal successful font loading.
Two focused checks, frontend TypeScript/all 415 tests and Vite build passed;
independent review found no actionable issues. Physical Safari upload acceptance
still belongs to the owner. This refresh is local, not a public/native release.

## Safari Files acceptance — 2026-09-15

The owner still saw unstyled content on the built port-5176 preview after the
font fix. A direct LAN-bound Vite development listener on port 5173 restored
the testing path while preserving the existing localhost account gateway and
its loopback-only protections. Both animation canvases rendered in WebKit.
The owner then confirmed files were selectable and playback worked; no further
audio change was made. This closes the deferred device check, not every codec
or a public/native release. The original phone-network cause remains unproven.

## Password-account persistence boundary — 2026-09-15

Reviewed `mainController`, `leaderboardController` and the two score repositories.
The score repositories retain deliberate session/lock/receipt/write/commit order;
their length largely reflects explicit SQL. No transaction refactor was justified.
The leaderboard controller already delegates persistence and projects public DTOs.

The password paths in `mainController` still mixed HTTP decisions with three SQL
queries and MySQL row/error details. Before, the login lookup was embedded there:

```ts
const [rows] = await database.query<LoginUserRow[]>({
    sql: `SELECT user_id, account_uuid, user_name, user_password
        FROM users WHERE user_name = ? LIMIT 1`,
    timeout: DATABASE_QUERY_TIMEOUT_MS,
}, [userName]);
const user = rows[0];
```

Now the controller expresses the operation without knowing the row layout:

```ts
const user = await findPasswordLoginAccount(database, userName);
const passwordMatches = await bcrypt.compare(
    password, user?.passwordHash ?? DUMMY_PASSWORD_HASH
);
```

The adjacent account repository owns identifier preflight, insertion/unique-key
translation and credential lookup/projection. A missing account stays undefined;
a provider-only account still has a null password hash. Neither is authenticated
by the password path. Unexpected database errors still reach the central handler.
The database dependency remains an explicit `Pick<Pool, 'query'>`; no container,
generic repository hierarchy or new package was introduced.

This applies the reference's responsibility principle (printed p. 138): SQL
schema changes belong to persistence; HTTP response/cookie policy belongs to the
controller. It adds one small module and direct tests, not faster login or a new
security feature. Validation and duplicate preflight still precede bcrypt,
unique constraints still protect concurrent signups, and durable session creation
still precedes cookies. Queries, timeout, parameter order, hashing cost, origins,
session revocation and public response fields are unchanged.

Verification: all 15 existing controller cases passed before and after the
refactor; a new duplicate-preflight case confirms no hashing, insertion or cookie
after an existing identifier. All 24 focused cases, backend TypeScript and the
webpack production build passed; independent review found no regression.
The fixtures exercise query arguments, field projection, nullable/missing
credentials, unique-key collisions and unexpected failures. No production calls,
real accounts, SQL migration, score retest or deployment were performed.

## Main-router database injection — 2026-09-15

`mainRouter.ts` previously selected the runtime database through this import:

```ts
import { pool } from '../db/dbConfig';
```

It passed `database: pool` to the already-injectable controller. Importing the
router therefore validated environment-dependent database configuration and
constructed a pool. Existing HTTP auth fixtures bypassed that router by mounting
the controller directly, leaving the actual main-router limiter composition
untested. Pool construction is not itself a claim of an immediate connection.

The router now imports only the `Pool` type and requires
`database: Pick<Pool, 'getConnection' | 'query'>`. Its controller composition is:

```ts
const mainController = createMainController({
    database,
    sessionSecret,
    isProduction,
    p4VegaScoreSubmissionsEnabled,
    allowedMutationOrigins,
});
```

Bootstrap supplies `database: pool` at the existing `/api` mount. Resource
selection belongs to bootstrap; route registration belongs to the router;
HTTP decisions and persistence stay in their existing layers. This matches
the auth/leaderboard routers and adds one explicit dependency, not a new
container, repository wrapper, default fallback or performance optimization.
It would be unnecessary indirection if the router already had this boundary.

Routes, methods, responses, dispatch, limiter instances/order/skip rules,
parser placement, error forwarding, feature gates and startup order are
unchanged. Controllers, both score repositories and session/SQL/cookie ordering
were not modified.

Seven new cases mount the actual router with in-memory persistence. They cover
construction/GET without database calls, HEAD/unmatched routes, a POST reaching
the supplied query function, invalid-input short circuits, exact 20/account and
50/IP limits in separate fixtures, non-auth skips and sanitized central errors.
Public rate-limit headers also characterize IP-before-account ordering. The cold
import case uses a fresh child process inheriting only OS system/temp paths:
no runtime database variables, credential seeding, dbConfig mock, dotenv loading
or parent module cache. HTTP fixtures bind ephemeral loopback ports and close
their servers; no real database or provider is used.

Validation on 2026-09-15 used the existing Node 22.23.2/npm 11.6.2 installation
at `C:\Program Files\nodejs`, with process-local PATH only. In this worktree's
`backend` directory, `npm ci --include=dev --ignore-scripts --no-audit --no-fund`
exited 0; no lifecycle script was needed. The existing node-domexception
deprecation warning remains. Dependencies and the lockfile are unchanged;
`package.json` only adds the new file to its explicit `test:unit` list.

Exact validation commands below ran from `backend`, with `node` and `npm`
resolved explicitly to that installation:

```powershell
# Pre-change baseline: exit 0; 43 passed, 0 failed/cancelled/skipped.
node --test -r ts-node/register .\ts\routers\authRouter.security.test.ts .\ts\security\mainController.security.test.ts .\ts\security\requestRateLimits.test.ts .\ts\middleware\errorHandling.test.ts

# Post-change type checking only: exit 0.
npm test

# Post-change focused batch: exit 0; 50 passed, 0 failed/cancelled/skipped.
node --test -r ts-node/register .\ts\routers\mainRouter.test.ts .\ts\routers\authRouter.security.test.ts .\ts\security\mainController.security.test.ts .\ts\security\requestRateLimits.test.ts .\ts\middleware\errorHandling.test.ts

# Webpack production build: exit 0.
npm run prod
```

The build writes only this worktree's ignored `backend/dist`; the target was
checked for tracked files and redirected paths first. Source/diff review and
`git diff --check` passed. These are focused unit/in-memory HTTP results, not
a full backend-suite or MySQL integration pass. No migration tests, real
accounts, cloud calls, deployment, development-server restart, commit or push.
The parallel provider-fixture failure remains outside this slice and unresolved.
The separately requested Git branch/worktree hygiene task is recorded as pending
in Phase 16; none of its inventory, pruning or deletion work was performed.

## Native sign-in cancellation ownership — 2026-09-21

`frontend/ts/services/providerClient.ts` previously cancelled the native sheet
without retaining ownership of its cleanup:

```ts
const abort = () => { void Promise.resolve().then(() => identity.cancel()).catch(() => undefined); };
```

The outer credential request correctly returned promptly on abort, but its
`finally` also released the acquisition lock. A synthetic bridge reproduced a
retry starting while the earlier `cancel()` was still unacknowledged. Because
native cancellation has no request ID, its delayed effect could target that
replacement request. This is a JavaScript coordination gap, not evidence that
the current iPhone bridge actually reordered calls.

The implemented callback now owns that uncertainty separately:

```ts
nativeCancellationUnconfirmed = true;
void Promise.resolve().then(() => identity.cancel()).then(() => {
    nativeCancellationUnconfirmed = false;
}).catch(() => {
    // Without acknowledgement, keep native retries blocked until the client reloads.
});
```

New native acquisitions reject while this flag is set. Late success from the
cancelled sign-in cannot clear it. Cancellation still returns promptly; only a
new native attempt waits for confirmed cleanup. The trade-off is deliberate:
if cancellation fails or never settles, native retry remains unavailable until
the client/app reloads. An acknowledgement need not mean the sheet is dismissed;
the existing iOS 15 native `BUSY` guard still protects a retained sheet.
Google's flow, credential contracts, native Swift code and activation flags are
unchanged. No abstraction, dependency, provider call or database change was added.

Three regression cases first failed on the old implementation (18 passed,
3 failed), then the provider-client suite passed 21/21. Auth transport/signup
tests passed 73/73; frontend TypeScript and Vite production build passed. These
checks use synthetic providers; no physical-device acceptance, deployment or
Apple revocation completion is claimed. Commands from the repository root:

```text
node --experimental-strip-types --test frontend/ts/services/providerClient.test.mjs
node --experimental-strip-types --test --test-reporter=spec frontend/ts/services/authApi.test.mjs frontend/ts/services/authProviderSignup.test.mjs
node frontend/node_modules/typescript/bin/tsc -p frontend/tsconfig.json --noEmit
npm.cmd --prefix frontend run build
git diff --check
```

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

## Shared hue-distance calculation — 2026-09-21

`utils/hsl.ts` and `PitchColorPhaseController.ts` duplicated the same hue
wrapping and shortest-path calculation. Both now use `signedHueDistance` in the
existing color utility. The controller no longer owns a private math copy.

Before: interpolation and transition completion each calculated and adjusted
their own hue delta. After:

```ts
// hsl.ts: interpolation
return wrapHue(wrapHue(h1) + signedHueDistance(h1, h2) * t);
// PitchColorPhaseController.ts: transition completion
const hueDelta = signedHueDistance(nextColor.hue, target.hue);
```

This centralizes one rule, not merely similar-looking code. A transition from
350° to 10° travels +20°, not -340°. Exact ±180° ties retain their original
direction; rounding, extrapolation, invalid-input propagation and animation
thresholds are unchanged. One small named function replaces the duplicate;
no new module, dependency or generalized animation framework was added.

Three characterization tests passed before the change; all four focused tests
passed afterward, including direct signed-distance cases. Commands from
`frontend`: `node --experimental-strip-types --test --test-reporter=spec
ts/utils/hsl.test.mjs` and `node node_modules/typescript/bin/tsc -p tsconfig.json
--noEmit`. Root `git diff --check` passed. No full suite, production build,
device/gameplay retest or deployment was needed for this calculation-only change.

## Gameplay note-selection state and fixed data — 2026-09-21

`GameplayNoteSelector` previously rebuilt its interval lookup for each candidate
note, and rebuilt chord-pattern/scale mappings for each subsequent pickup.
These unchanged tables are now module-local readonly constants. The semitone
offset is local to the calculation, not an instance field requiring a reset.
Two misleading key-history fields were removed: both always remained C, so the
same transposition is now explicitly relative to `BASE_SCALE_KEY = 'C'`.

Before: `this.halfTones = ...; transpose(notes, this.halfTones); this.halfTones = 0`.
After: `let semitoneOffset = ...; transpose(notes, semitoneOffset)`.
The private setter is named `selectScale` rather than `getNotesForScale`; its
previous return value was unused. This separates fixed data, temporary work and
actual per-player state without introducing a service or a new runtime module.

All eight selector/playback cases passed before and after, including captured
note sequences and random-call counts; frontend TypeScript and whitespace checks
passed. Root command: `node --experimental-strip-types --test --test-reporter=spec
frontend/ts/games/helpers/GameplayNoteSelector.test.mjs
frontend/ts/games/helpers/gameplayNotePlayback.test.mjs`; typecheck:
`node frontend/node_modules/typescript/bin/tsc -p frontend/tsconfig.json --noEmit`.
Audio output is mocked; no device listening test, full suite or deployment.

Follow-up defects exposed by characterization, intentionally not fixed here:
the existing transpose wrap maps the first G pickup to 415.3 Hz, and one tested
scale/key-switch sequence yields an undefined candidate. These preserved outputs
are baseline evidence, not assertions that the musical behavior is correct.
Review the pitch-index/interval units and empty-candidate policy as a separate
behavior-changing fix before updating those expectations.

## Pickup pitch and missing-note corrections — 2026-09-21

Resolved the preceding characterization findings as an explicit behavior fix:

- `transpose` previously wrapped over 13 array entries, counting both C4 and C5
  as different pitch classes. It now wraps by 12 while retaining either endpoint
  when in range: the G tonic is 392 Hz, not 415.3 Hz. Unsupported frequencies and
  noninteger shifts fail explicitly; two scale-catalog G values now consistently
  use 392 rather than 391.99 Hz.
- Interval filtering previously subtracted Hz values but compared the result
  with semitone rules. It now uses `12 * Math.log2(note / previousNote)`, rounded
  and wrapped into a pitch class. Frequency ratios, not differences, determine
  musical intervals.
- Chord/non-chord selection now chooses from valid candidates directly. If a
  key/scale switch leaves none, the selected tonic restarts the melody. Unknown
  scale names use Major for both notes and interval rules.

The existing note register, duration, volume and gameplay remain unchanged;
the incorrect note sequences and their random draw counts are not preserved.
No new runtime module or dependency was needed. Seventeen focused cases passed:
`node --experimental-strip-types --test --test-reporter=spec
frontend/ts/utils/transpose.test.mjs
frontend/ts/games/helpers/GameplayNoteSelector.test.mjs
frontend/ts/games/helpers/gameplayNotePlayback.test.mjs`.
`node frontend/node_modules/typescript/bin/tsc -p frontend/tsconfig.json --noEmit`
and scoped `git diff --check` passed. Audio is mocked; no listening test, full
suite, production build or deployment was performed.

## p4-Vega entity sprite ownership — 2026-09-21

`P4` and `Water` already store their own sprites, but their update methods also
accepted another sprite on every tick. The only production caller always passed
the stored sprite back. This duplicate input allowed movement/collision checks
to target one sprite while completion or destruction targeted another.

Before: `p4.update(p4.p4Anim)` and `water.update(water.waterAnim, p4, notesPlaying, stage)`.
After: `p4.update()` and `water.update(p4, notesPlaying, stage)`.
Each update reads its owned sprite locally. No new abstraction or object is
introduced. Movement, faster diagonals, collision, audio preference, ten-point
pickups, hazard spawning and 1000-point completion retain their existing rules.

Verification: five entity cases and all fifteen existing rule cases passed,
including independent entity instances, misses, optional audio and completion
without repeated effects. Commands from the repository root:

```powershell
node --test frontend/ts/games/p4-Vega/classes/p4Entities.test.mjs
node --experimental-strip-types --test --test-reporter=spec frontend/ts/games/p4-Vega/p4Rules.test.mjs
node frontend/node_modules/typescript/bin/tsc -p frontend/tsconfig.json --noEmit
git diff --check
```

Tests use plain sprite fixtures and mock the note selector/hazard spawn; no
rendering, listening or physical-device claim. No full-suite/build run, server
restart, dependency change, deployment or Unity operation was needed.

The review also left the focused envelope/pitch helpers unchanged. A possible
same-note color-resumption issue after sustained silence needs a separate
policy/controller check before changing artistic behavior or timing.

## Pitch-color recovery after silence — 2026-09-21

The preceding candidate is confirmed at the policy/state boundary, not as a
continuously stuck visible color. `lastGood` held two different concepts: the
last committed pitch color and the most recent idle color. Sustained silence
overwrote it. Returning to the same pitch correctly produced `changed: false`,
but then reused the idle color indefinitely. Continuous phase rendering still
held the pitch anchor; resetting the phase later could seed it from stale idle
state. A real tracker/policy/phase regression reproduced that reset path.

The policy now keeps `lastPitchColor` separately. A stable pitch restores that
color; only a newly accepted pitch color updates it. Silence still chooses idle
colors exactly as before. This separates states with different lifetimes instead
of pretending a repeated note is a new pitch-class commit. Tracker signals,
stabilization, color mapping, drift and phase timing remain unchanged.

Three of five new cases failed before the fix. Afterward all five policy cases
and four existing hue cases passed, including brief silence, repeated recovery,
pending/new pitch commits, continuous micro drift and phase reset. Commands:

```powershell
node --test frontend/ts/animations/helpers/audio/PitchColorPolicy.test.mjs
node --test --test-reporter=spec frontend/ts/animations/helpers/audio/PitchColorPolicy.test.mjs frontend/ts/utils/hsl.test.mjs
node frontend/node_modules/typescript/bin/tsc -p frontend/tsconfig.json --noEmit
git diff --check
```

The first command captured the failing baseline; the combined command and
TypeScript passed after the fix. These are deterministic logic checks using
fixed idle-color ranges, not a browser/device or music-listening claim. No new
dependency, production build, deployment or Unity operation was performed.
The reset regression covers reset after pitch recovery. The separate case of
resetting during ongoing silence is addressed in the following checkpoint.

## Pitch-color phase reset during silence — 2026-09-22

The outstanding lifecycle case is reproduced: after a musical note, sustained
silence, phase reset and another silent sample, the controller treats the idle
color as its committed anchor. The tracker deliberately retains the note across
the phase-only reset, so the same note returns with `changed: false`. The old
boolean `hasCommittedHue` cannot distinguish that idle anchor from a musical
one, and rendering remains idle. Fractal switching/restart can take this path
through `MusicFeatureExtractor.reset()`; Circles resets its tracker too.

Before, the state was `hasCommittedHue: boolean`. After, it is
`colorAnchorKind: "silence" | "pitch" | null`. Existing presence checks use
`!== null`, preserving their semantics. One additional condition initializes a
musical anchor when a pitch decision arrives and the current anchor is idle.
This is a responsibility/state-model correction, not a file move or a fake
pitch-change event. Hold duration, smoothing, palette, drift, pitch detection
and tracker ownership are unchanged; no extra parallel flag or dependency was
introduced. Constructor/reset deduplication is deliberately outside this fix.

The new regression failed before the fix while all five prior policy cases
passed. Afterward, all six policy/phase cases and four hue tests passed. It checks
unchanged tracker signals, departure from idle and gradual recovery. The final
color assertion allows existing integer-channel interpolation rounding (one
percentage point); this pass does not alter interpolation/settling behavior.

```powershell
node --test --test-reporter=spec frontend/ts/animations/helpers/audio/PitchColorPolicy.test.mjs
node --test --test-reporter=spec frontend/ts/animations/helpers/audio/PitchColorPolicy.test.mjs frontend/ts/utils/hsl.test.mjs
node frontend/node_modules/typescript/bin/tsc -p frontend/tsconfig.json --noEmit
git diff --check
```

The first command captured the failing baseline; the combined checks and
TypeScript passed after the fix. The shared deterministic phase fixture is reused
by the two reset tests. No device/music-listening acceptance, Unity rebuild,
production build or deployment is claimed. The owner's Three Bosses phone layout
acceptance is recorded separately; its accepted gameplay checks were not repeated.

## Failed audio initialization ownership and feedback — 2026-09-22

This extends the earlier cancellation review to active initialization failures;
it does not reopen accepted playback or the Safari file-picker check. A current
`AudioContext.resume()` rejection previously escaped while retaining the object
URL, audio element/listener and context until the next upload or page disposal.
Construction/graph connection errors had the same cleanup gap. This was bounded
retention of an unusable track, not evidence of resources accumulating forever.
Both animation pages discarded the returned promise, producing an unhandled
rejection and no user-facing explanation.

Allocation and graph setup now share a failure boundary. It tears down only the
current failed session, resets its analysis state, and rethrows the original
error. Session checks before and after asynchronous teardown prevent an older
failure from clearing a newer upload or showing obsolete feedback. The source
node is recorded before connecting it, so a failed connection is owned too.
Autoplay denial remains separate: the loaded track is retained for manual Play.

Before, both pages discarded completion:

```tsx
onFileSelect={(file) => { void audioEngine.processAudio(file); }}
```

After, both return it to the shared control:

```tsx
onFileSelect={(file) => audioEngine.processAudio(file)}
```

`MusicUpload` accepts `void | Promise<void>`, awaits the callback, and reports
loading errors through the existing styled alert. It captures the input before
awaiting and skips the popup if that input was detached by navigation. Clearing
the input after capturing the File allows retrying the same file. Cancellation,
picker hints, keyboard activation, successful playback and UI styling remain
unchanged. This keeps resource ownership in the engine and feedback in the UI,
without a new service, hook or dependency.

Three engine regression cases and three UI assertions failed before their
respective changes; the old UI also emitted unhandled promise rejections.
Afterward, 28 engine, nine upload-control and three existing page-mount cases
passed (40 total), including partial graph cleanup, a new upload during failed
cleanup, synchronous/asynchronous errors and navigation during loading.

```powershell
node --experimental-strip-types --test frontend/ts/animations/helpers/audio/AudioEngine.test.mjs
node --test --test-reporter=spec frontend/ts/components/MusicUpload.test.mjs
node frontend/node_modules/typescript/bin/tsc -p frontend/tsconfig.json --noEmit
node --experimental-strip-types --test --test-reporter=spec frontend/ts/animations/helpers/audio/AudioEngine.test.mjs frontend/ts/components/MusicUpload.test.mjs frontend/ts/pages/animations/DancingCircles.test.mjs
git diff --check
```

TypeScript passed. These are controlled failure/lifecycle and markup checks,
not a real-device codec, alert screenshot or new Safari acceptance claim. No
production build, deployment or Unity operation was performed.

The following checkpoint addresses the separate fractal timer cancellation gap.

## Fractal automatic-disposal cancellation — 2026-09-23

The real host with a controlled animation timer reproduced the defect: disabling
auto-dispose changed the displayed countdown to `null`, but the animation still
started fading at the old deadline. Before, the disabled branch only assigned
`remainingLifetime = null`. After, `applyLifetime()` also calls
`currentFractal.cancelScheduledDisposal()`; `setLifetime()` now reuses that same
path instead of duplicating its enable/disable logic.

The animation contract now exposes explicit cancellation. Tree and FlowerSpiral
clear their automatic timer flag, delay and elapsed counter; Mandelbrot clears
its pending delay. These methods deliberately preserve any fade already started,
its progress and its resources. They do not resurrect a disposed animation.
Re-enabling keeps the existing fresh-countdown behavior. The host still remembers
lifetime settings made before an animation is mounted and reapplies them on
restart/switch. No shader, palette, motion, fade rate or audio behavior changed.

The host's disable regression failed before the fix while its re-enable and
restart/swap checks passed. The three host cases now pass. Six real-class state
checks cover cancellation, repetition, re-arming and active-fade preservation
across all three fractals; these do not initialize a GPU or claim rendered output.
Frontend TypeScript, the documentation rebuild and whitespace checks passed.
Generated API documentation includes the cancellation contract. Commands:

```powershell
node --test --test-reporter=spec "frontend/ts/animations/dancing fractals/createFractalHost.test.mjs"
node frontend/node_modules/typescript/bin/tsc -p frontend/tsconfig.json --noEmit
npm run docs
git diff --check
# Real-class check, run from frontend:
node --experimental-strip-types --test "ts/animations/dancing fractals/fractals/disposalCancellation.test.mjs"
```

No production build, physical-device retest, Unity operation or deployment was
performed. The following checkpoint covers animation settings/default-reset flow.

## Fractal settings and default-reset synchronization — 2026-09-23

The page's async mount captured its original selection/configuration/lifetime.
Controls stayed usable while startup waited, but their effects saw no host and
returned. When startup finished it used the stale captured values, leaving the
controls and renderer inconsistent. Reset defaults also returned early before
host readiness. Separately, all three config handlers called `host.updateConfig`
inside React state updater functions, so replaying an updater repeated a renderer
side effect.

Host readiness is now React state. Mount only creates and owns the host; selection
and lifetime effects apply current settings when the host becomes ready. Cleanup
retains its cancelled-start guard and disposes the host owned by that mount.
Reset defaults updates UI state even during startup, and initializes the active
host immediately when available. Slider edits still patch rather than recreate
the animation. Before, renderer mutation lived inside `setTreeConfig(prev => ...)`.
After, the two responsibilities are explicit:

```ts
setTreeConfig(prev => ({ ...prev, ...patch }));
host?.updateConfig(patch);
```

The Tree had a second mismatch: every frame smoothed motion toward a baseline
captured only by its constructor, overriding later rotation-slider values.
`updateConfig` now applies explicit patches to both current config and `baseConfig`.
It does not copy music-boosted runtime values into that baseline. Quiet rotation
can remain at zero; resetting custom motion returns to defaults. Existing beat
boosts, clamps, smoothing, palettes and geometry are unchanged. FlowerSpiral and
Mandelbrot already forward their settings correctly and were not modified.

Five page cases and two real-Tree cases failed before their respective fixes.
All nine pass afterward: late startup, pending reset, one renderer update despite
updater replay for all three types, reset UI/host agreement, cancelled startup,
zero rotation, baseline reset and no accidental persistence of beat boosts.
Page tests use controlled hook scheduling/host spies; Tree tests execute real
frame steps with inert graphics. Neither is a real DOM/GPU/device acceptance claim.

```powershell
node --test --test-reporter=spec frontend/ts/pages/animations/DancingFractals.test.mjs
node --test --test-reporter=spec frontend/ts/pages/animations/DancingFractals.test.mjs "frontend/ts/animations/dancing fractals/fractals/TreeConfig.test.mjs"
node frontend/node_modules/typescript/bin/tsc -p frontend/tsconfig.json --noEmit
git diff --check
# Initial Tree characterization, run from frontend:
node --experimental-strip-types --test "ts/animations/dancing fractals/fractals/TreeConfig.test.mjs"
```

TypeScript and whitespace checks passed. No new dependency, production build,
deployment, Unity operation or repeat of accepted gameplay/audio tests. The
following checkpoint covers backend controller error handling.

## Backend asynchronous error boundary — 2026-09-23

Reviewed the main/leaderboard controllers and routers, plus authentication,
session renewal, logout, account deletion, provider authentication and Apple
notification/maintenance handlers. These paths already await their work and
return fixed public errors rather than raw SQL/provider diagnostics. Their
different error codes and response envelopes are intentional contracts, not
duplication to flatten into one response. No controller rewrite was warranted.

One shared boundary gap was reproduced locally. `asyncHandler` previously used
`.catch(next)`. JavaScript can reject with a primitive instead of an Error;
Express interprets falsy values and the strings `route`/`router` as routing
instructions. A rejection without a reason therefore reached the test's fallback
route instead of the error handler. This is a controlled regression, not evidence
that a production request has encountered that failure.

Now the catch receives `unknown` and forwards:

```ts
next(typeof error === 'object' && error !== null
    ? error
    : new Error('Asynchronous request failed'));
```

Error objects and structured status/parser metadata keep their identity. Primitive
rejections become generic errors without copying their values into logs. Explicit
controller calls to `next('route')`/`next('router')` are unaffected. Existing
validation, versioned leaderboard errors, status codes, cookies, feature gates
and persistence behavior remain unchanged.

The new HTTP regression failed before the fix (fallback status 418 rather than
500 for `undefined`) and passes afterward across eight rejection values. The
focused set passed all 19 tests; synchronous throw/metadata preservation, existing
sanitization, main-router composition and Three Bosses parser contracts are covered.
Backend TypeScript and whitespace checks passed. Commands (Node/npm from `backend`,
Git from the repository root):

```powershell
node --test -r ts-node/register ts/middleware/errorHandling.test.ts
node --test -r ts-node/register ts/middleware/errorHandling.test.ts ts/routers/mainRouter.test.ts ts/routers/leaderboardRouter.test.ts ts/routers/threeBossesRouter.security.test.ts
npm test
git diff --check
```

Tests use local ephemeral HTTP servers and fake persistence, not real accounts or
SQL. No dependency, schema, cloud resource, running dev server or public contract
changed; no production build, deployment or device retest. The middleware is not
part of the generated API documentation surface. Next: review backend startup and
shutdown resource ownership, leaving already-reviewed score transactions closed.

## Inventory closeout

Read-only Git/path enumeration, local reference reading and targeted frontend/
backend/tooling inspection completed. The classification sum covers all 1,586
baseline paths; no cleanup tooling or per-file generated manifest was added.
Only this inventory and roadmap documentation change in this pass. No tests,
builds, dependency installations or production checks were run because no
application behavior changed. Validation is limited to inventory consistency,
documentation links and `git diff --check`.
