# Active project plan

This tracked roadmap records the active continuation of the broader migration
and game plan. Detailed implementation decisions remain subject to review at
each phase boundary.

## Phase 12 — Three Bosses local game flow

- Steps 12.1–12.9: implemented on the phase branch and undergoing gameplay and
  presentation polish.
- Step 12.10 — rank calibration: **deferred by owner decision on 2026-08-18**.
  Keep results `UNRANKED`; do not invent thresholds. Resume after several
  representative normal human completion times are available and after run
  timing semantics and transition pacing are finalized. This remains a
  pre-release gate but does not block Phase 13 implementation while rank output
  stays `UNRANKED` and score submission stays disabled.
- Step 12.11 — edge cases and presentation polish:
  - Step 12.11A — rename permanent Unity Editor utilities: **completed** in
    commit `46c3c775`.
  - Step 12.11B — review and stabilize the existing local UI changes:
    **completed** across commits `ac7ecd84`, `4c20b87d`, and `fa23f916`.
  - Step 12.11C — normalize button hover behavior, including Try Again, Back to
    Menu, and the disabled Submit Score button: **completed** in commits
    `ac7ecd84` and `fa23f916`.
  - Step 12.11D — fix countdown presentation so `3` begins green with no white
    flash and all `3`, `2`, `1`, and `GO!` states use consistent styling:
    **completed** in commits `4c20b87d` and `fa23f916`.
  - Step 12.11E — tune boss-defeat visibility, fade timing, and transition
    screen duration: **completed** in commits `b3308dfa`, `957c8cd7`, and
    `93df8334`.
  - Step 12.11F — add a read-only live timer at the top center of all three
    gameplay scenes using the existing run session and time formatter:
    **completed** in commit `248cfa51`.
  - Step 12.11G — exclude boss-death presentation, fades, illustrated
    transitions, loading, and next-level reveal from completion time and score;
    only active combat time counts: **completed** in commit `5549f30a`.
  - Step 12.11H — complete the full three-boss route, defeat-screen, button,
    audio-persistence, duplicate-event, and interrupted-run smoke tests:
    **controlled full-route validation completed on 2026-08-24**. Automated
    coverage passed 19 EditMode and 18 PlayMode tests, with clean Unity source
    integrity and no Console warnings or errors. Subsequent menu, timer, and
    countdown regression coverage passed 19 EditMode and 20 PlayMode tests in
    commits `7da148d7` and `5062c6b5`. Mike confirmed audible mute/unmute
    behavior on 2026-08-24. His continuous hands-on combat-feel, weapon,
    pickup, and full normal-route check remains before release.

Phase 12 release acceptance still requires Step 12.10, the remaining hands-on
gameplay check, passing Unity compilation and automated tests, clean asset/meta
integrity, and a verified complete normal route. Per the owner's sequencing
decision, those release gates may remain open while Phase 13 is implemented,
provided ranks remain `UNRANKED` and submission remains disabled.

## Phase 13 — Website and leaderboard integration

The local Three Bosses result flow is stable enough for integration work.
Continue Phase 13 on the existing feature branch; do not merge or push these
changes to `main` until Phase 13 is complete and the remaining Phase 12 release
gates above have been satisfied.

### Step 13.1 — multi-game contract and migration design

**Approved by Mike and live-schema-preflighted on 2026-08-24.** The
server-owned contract uses stable
`p4-vega` and `three-bosses` identifiers. p4-Vega remains score-descending on
its unchanged legacy endpoint. Three Bosses is completion-time-ascending but
remains `UNRANKED` with submission disabled. Persistence will use an immutable
run ledger for idempotency plus one personal-best row per player, game, and
rules version so incompatible future rules are never compared.

The additive migration, backfill, reconciliation, compatibility, security,
and rollback contract is recorded in
[`backend/LEADERBOARD_DESIGN.md`](backend/LEADERBOARD_DESIGN.md). The sanitized
live preflight confirmed the foreign-key type and current schema constraints,
so exact migration SQL may now be drafted and tested locally. Applying DDL,
backfilling data, changing production credentials, or deploying the new API
still requires a separate reviewed approval.

### Step 13.2 — local Three Bosses website playability prototype (no publication)

Before any public release, add Three Bosses to the website on the feature
branch and prove that the actual Unity WebGL game is playable through the
local site. This is a local integration and evaluation step only: do not merge
it to `main`, publish the WebGL build, change Firebase Hosting, or expose a
production game route until Mike separately approves release.

Keep `/games/three-bosses` as the stable browser-facing local URL. Updating the
game replaces the build at the same external location, so it normally does not
require a new browser-facing link. Internal Unity loader, data, framework, and
WebAssembly filenames may change between builds, especially if hashed filenames
are later enabled; the React loader must resolve the current generated build
configuration instead of hard-coding asset filenames. Keep generated WebGL
output outside the repository at
`%LOCALAPPDATA%\mickeyf.com\three-bosses-webgl`, serve it only on loopback at
`127.0.0.1:4174`, and proxy it through the Vite development server at
`/__local/three-bosses/`. Register the card and route only when both
`import.meta.env.DEV` and `VITE_ENABLE_THREE_BOSSES_LOCAL=1` are true. Keep the
flag unset in CI and production builds. The integration must:

- add a Three Bosses entry to the local Games page and a dedicated game page
  that follows the existing site's layout, typography, spacing, controls, and
  responsive conventions;
- load the Unity WebGL build from a deterministic local asset location through
  a small React-owned loader that reports loading progress and useful failures,
  disposes the Unity instance when the route unmounts, and never creates a
  second running instance during development remounts;
- provide an appropriately sized game frame plus clear focus and fullscreen
  controls without trapping normal website navigation;
- keep ranks `UNRANKED` and score submission disabled during this prototype;
- keep generated build output separate from hand-authored source and document
  the repeatable external build and local-serve commands before deciding which
  artifacts, if any, should later be versioned or deployed; and
- identify any Content Security Policy, compression, caching, MIME-type, or
  static-path changes that a future deployment would require, but do not apply
  production hosting changes during local playability testing.

Before each build, require the Unity Editor to be ready, stopped, and not
compiling. Afterward, review Git status and reject incidental `ProjectSettings`,
asset, scene, prefab, or `.meta` changes. Test the production-style WebGL build
through the real local frontend rather
than opening Unity's generated `index.html` directly. Run the normal local
frontend, backend, database proxy, and WebGL asset server together so existing
authentication checks are healthy; a disconnected-backend `Failed to fetch`
message is not an acceptable clean-console result. Use the local browser to
inspect the new Games entry and game page at desktop, narrow/mobile, and
ultrawide sizes. Narrow/mobile acceptance covers the responsive website shell;
gameplay acceptance remains desktop while the game requires keyboard controls.
Verify direct navigation and refresh, loading and error states,
canvas scaling, focus recovery, keyboard controls, fullscreen enter/exit,
audio on/off persistence, pause/background behavior, all three boss levels,
defeat/retry/menu flows, completion, route exit/re-entry, browser Console and
network errors, and that the rest of the website still works. Record any
remaining hands-on gameplay or browser-specific defects before public-release
work begins.

### Multi-game leaderboard redesign

Redesign `/leaderboard` as a multi-game experience rather than extending the
current p4-Vega-only list in place.

The design must include:

- a clear, responsive game selector, such as tabs, cards, a dropdown, or
  direct game-specific routes;
- direct-linkable game selection;
- game-specific score, time, and rank labels and ranking rules;
- independent loading, empty, and error states for each game;
- storage and API contracts keyed by a stable `gameId`;
- a backward-compatible migration that preserves existing p4-Vega scores;
- authenticated, validated, idempotent Three Bosses score submission; and
- desktop and mobile tests covering selection, sorting, refresh, empty states,
  failures, and preserved legacy results.

Do not assume that scores from different games have the same meaning or can be
ranked together.
