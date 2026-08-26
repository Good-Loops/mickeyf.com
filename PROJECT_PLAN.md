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
and the exact additive table migrations, checksum-recorded runner, fail-closed
empty rollback, and isolated MySQL 8.0.31 test harness were implemented and
verified locally on 2026-08-25. The migration adds no backfill and does not
alter `users.p4_score`. Applying DDL, backfilling data, changing production
credentials, or deploying the new API still requires a separate reviewed
approval.

The approved Phase 13 storage end state is for both the existing p4-Vega API
operations and the generic leaderboard read to use `game_personal_bests` as
their source of truth. After transactional dual writes, a complete backfill,
old-revision drain, reconciliation, API cutover, and proof that no deployed or
rollback code depends on the legacy column, a separately reviewed immutable
migration will drop `users.p4_score`. The initial additive migrations remain
unchanged, and the drop requires its own production approval and recovery
evidence.

The transitional p4-Vega write path was implemented and verified locally on
2026-08-25. That candidate updated `users.p4_score` and
`game_personal_bests` atomically on one acquired connection; either write
failure rolled the transaction back, concurrent submissions converged on the
same maximum, and the legacy HTTP response remained unchanged. It was not
deployed and remains the pre-cutover phase of the rollout sequence.

The generic-authoritative p4-Vega writer was prepared and verified locally on
2026-08-26. It locks the authenticated user and scoped generic personal best,
compares only `game_personal_bests`, and writes only a strict improvement on
the same transaction connection. It preserves the legacy HTTP contract and
missing-user result, leaves a sentinel legacy score unchanged, survives
concurrent submissions, and was tested after physically dropping
`users.p4_score` in the disposable MySQL fixture. This candidate is not
deployed: the additive schema, dual-write rollout, backfill, legacy-only
revision drain, exact reconciliation, and production submission-freeze gates
still come first.

The Phase 13.1 repeatable, privileged p4-Vega historical-backfill CLI and
separate read-only aggregate reconciliation gate were implemented and verified
locally on 2026-08-25. The backfill is operational tooling rather than an HTTP
endpoint or numbered schema migration so it can run once after dual writes
deploy and again after every legacy-only revision drains. It copies all
non-null historical scores monotonically without fabricating run history; the
reconciliation reports only aggregate equality and missing, extra, score, and
metadata discrepancy counts plus unexpected p4-Vega run/rules counts, never
player identities. Before writing, the command refuses target-ahead scores,
extra rows, metadata anomalies, run-ledger rows, and unexpected rules versions
rather than guessing how to repair them. Every pass reuses the verified
personal-best migration timestamp, so retries remain stable.

The existing p4-Vega `get_leaderboard` read path was switched locally to
`game_personal_bests` and verified on 2026-08-25. Its anonymous legacy route,
request, response fields, ten-row bound, cache behavior, and numeric historical
scores remain compatible; game/rules scoping and tie order now follow the
approved generic contract. This code has not been deployed or activated in
production. The generic-only writer is locally prepared, but its production
cutover and `users.p4_score` removal remain incomplete; the multi-game frontend
is recorded below.

The additive backend catalog and per-game read routes were implemented and
verified locally on 2026-08-26. The catalog is projected from server-owned
definitions; the generic p4-Vega response adds only version metadata and
one-based positions to the existing repository rows. Known Three Bosses reads
return a typed empty `UNRANKED` game result while its catalog submission state
remains disabled, and no generic submission route exists. Versioned 404, 429,
and 500 responses do not alter legacy API error bodies. These routes have not
been deployed or activated in production and do not replace the production
backfill, revision-drain, or reconciliation gates.

Neither a production backfill nor a production reconciliation has been
performed. Production execution requires the additive schema, an explicitly
approved short-lived least-privilege principal, exact target confirmation, and
recovery evidence.
Only a zero-discrepancy post-drain reconciliation permits the later read/write
cutover to `game_personal_bests`. The final production switch requires a
server-side score-submission freeze spanning in-flight request drain, the last
exact reconciliation, generic-only deployment, dual-writer drain, and a second
exact reconciliation against the still-static legacy column. Only then may
submissions resume. After generic-only traffic starts, legitimate improvements
make exact equality with the stale legacy column impossible; rollback must use
a generic-authoritative compatible revision or a forward fix, never the old
dual writer. After every code/job/tool reference is removed, a new immutable
migration may drop `users.p4_score` under separate production approval. The
initial additive migrations remain unchanged.

### Step 13.2 — local Three Bosses website playability prototype (no publication)

Status: In progress. The development-only Games card, route, external asset
server, Unity loader, and first live browser launch/re-entry/fullscreen checks
were implemented on 2026-08-25. The full three-level hands-on browser matrix
below remains a release gate; no WebGL build or route has been published.

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

Future gameplay polish, deferred until after the current local playability
work: add an in-game pause button and a simple pause menu. Pausing must freeze
gameplay, active-combat timing, and audio consistently, and Resume must restore
them cleanly.

Website presentation polish: **completed and browser-verified on 2026-08-25**.
At a 1920 × 1080 desktop viewport, the Three Bosses frame now matches the
existing p4-Vega canvas footprint and heading scale. This reduces only the
website page heading above the canvas; the title inside the Unity main menu is
unchanged.

### Multi-game leaderboard redesign

Redesign `/leaderboards` as a multi-game experience rather than extending the
current p4-Vega-only list in place.

Frontend hub and generic read integration: **implemented locally on
2026-08-26**. The plural route contains catalog-driven leaderboard cards, each
linking to its own direct detail route. These are leaderboard destinations,
not playable game cards; game launching remains under `/games`. The p4-Vega
detail now uses the generic GET API, while Three Bosses exposes its typed empty,
unranked, submission-disabled state. Transport tests, production build, and
desktop plus narrow browser checks pass. A disposable loopback API verified the
populated p4-Vega table without applying approval-gated database migrations;
the unmigrated live local p4 read correctly remains in its bounded server-error
state. Three Bosses submission, the complete route/UI mobile matrix, production
migration, and deployment remain separate pending steps.

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

## Phase 14 — Site information architecture, feedback, responsiveness, and literal-dark redesign (deferred)

After the current leaderboard and migration work, redesign the header's
information architecture as a separate site-wide task:

- group Animations, Games, and Leaderboards into an accessible
  **Entertainment** dropdown;
- group Login and Register into an accessible **Account** dropdown, with the
  username and Logout represented coherently when authenticated;
- make the navigation genuinely responsive and verify keyboard, focus, and
  disclosure behavior;
- choose a clearer replacement name for **Social** before changing that area,
  including deliberate handling of the existing route;
- add a dedicated user-feedback page with server-side validation, abuse/rate
  limiting, and an explicit privacy and retention policy; and
- after the navigation and content structure are settled, redesign the full
  website with a more professional, responsive, literally dark visual theme.
  "Dark" here means a deliberate dark color palette with readable contrast,
  not a gloomy or moody creative direction.

## Deferred tooling follow-up

- TypeDoc drift CI guard: **deferred by owner decision on 2026-08-25**.
  Documentation generation is deterministic as of commit `7386191a`. If this
  work resumes, add a `docs:check` command that regenerates the tracked output
  and fails on unexpected output, canonical source-link, local-reference, or
  line-ending drift. This is preventative tooling and does not block current
  Three Bosses work.
