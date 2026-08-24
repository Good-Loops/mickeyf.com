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
  timing semantics and transition pacing are finalized.
- Step 12.11 — edge cases and presentation polish:
  - Step 12.11A — rename permanent Unity Editor utilities: **completed** in
    commit `46c3c775`.
  - Step 12.11B — review and stabilize the existing local UI changes:
    **in progress**.
  - Step 12.11C — normalize button hover behavior, including Try Again, Retry,
    and the disabled Submit Score button.
  - Step 12.11D — fix countdown presentation so `3` begins green with no white
    flash and all `3`, `2`, `1`, and `GO!` states use consistent styling.
  - Step 12.11E — tune boss-defeat visibility, fade timing, and transition
    screen duration.
  - Step 12.11F — add a read-only live timer at the top center of all three
    gameplay scenes using the existing run session and time formatter:
    **completed** in commit `248cfa51`.
  - Step 12.11G — exclude boss-death presentation, fades, illustrated
    transitions, loading, and next-level reveal from completion time and score;
    only active combat time counts: **completed** on the gameplay branch.
  - Step 12.11H — complete the full three-boss route, defeat-screen, button,
    audio-persistence, duplicate-event, and interrupted-run smoke tests.

Phase 12 closes only after Steps 12.10 and 12.11 are complete, Unity compilation
and automated tests pass, asset/meta integrity passes, and the complete manual
route is verified.

## Phase 13 — Website and leaderboard integration

Begin only after the local Three Bosses result flow is stable.

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
