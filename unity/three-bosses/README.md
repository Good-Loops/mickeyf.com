# Three Bosses

Three Bosses is a 2D Unity boss-rush project integrated into the mickeyf.com
monorepo.

## Open the project

In Unity Hub, add and open this directory from the repository root:

```text
unity\three-bosses
```

Use Unity 6.3 LTS editor version 6000.3.8f1. Do not upgrade the editor as part
of routine repository work. On a fresh checkout, allow the initial import and
script compilation to finish before entering Play Mode.

The project uses Visible Meta Files and Force Text serialization. Preserve
every `.meta` file and do not regenerate GUIDs unnecessarily.

## Scenes and controls

The enabled build scenes are:

1. `Assets/Scenes/UI/MainMenu.unity`
2. `Assets/Scenes/Level1_BeeBoss.unity`
3. `Assets/Scenes/UI/Transition_BeeToCyborg.unity`
4. `Assets/Scenes/Level2_CyborgBoss.unity`
5. `Assets/Scenes/UI/Transition_CyborgToKraken.unity`
6. `Assets/Scenes/Level3_Kraken.unity`
7. `Assets/Scenes/UI/Defeat_Bee.unity`
8. `Assets/Scenes/UI/Defeat_Cyborg.unity`
9. `Assets/Scenes/UI/Defeat_Kraken.unity`
10. `Assets/Scenes/UI/End.unity`

Baseline keyboard controls are:

- Move horizontally: `A`/`D` or Left/Right Arrow
- Jump: Space
- Dash: Left Shift
- Aim: `A`, `D`, or `W`
- Fire: Enter

On touch devices, the battle scenes add a left-side movement/aim stick and
right-side Jump, Dash, and Fire buttons. The keyboard controls remain active
and unchanged on desktop.

## Play Mode verification

Before publishing gameplay changes, traverse the complete enabled route and
confirm:

- horizontal movement, double jump, dash, player damage, and player death;
- crate spawning and pickup behavior;
- all ten weapons, including fire and impact behavior;
- all 21 weapon-related audio clips, including the Phase Anchor loop and end;
- boss health, phase changes, death, both illustrated boss transitions, and the
  final result flow;
- each boss-specific defeat screen, Try Again and Back to Menu navigation,
  countdown gating, active-combat timer behavior, and audio persistence;
- no missing scripts, prefabs, references, or Console errors.

Boss 3 enters phase two at 50% health and expands its rune attack from two
anchors to three. Defeating Boss 3 now freezes the active-combat timer and opens
the final result scene. Rules version 1 derives an S–D rank and arcade-scale
score from the canonical active-combat time. The end-screen submission flow is
connected, but its button stays unavailable until the browser catalog reports
enabled; production writes remain fail-closed by default. A normal WebGL run
signals its canonical run ID at start so the browser can obtain the matching
short-lived server ticket. Practice runs never request a ticket, and the Unity
player never receives or stores the signed value.

## Website WebGL builds

### Local development

The local website prototype reads generated WebGL output from outside the
repository. Before building, leave the Editor open on this exact project and
do not edit or stage Unity settings while the build is running. From the
repository root, run:

```powershell
npm run three-bosses:webgl:build
```

The guarded wrapper confirms that the Editor is ready and stopped, waits for
the asynchronous build to finish, restores the exact pre-build bytes of the
three known Unity/URP settings files, reloads those files in the Editor, and
fails if any other Unity source changes. It preserves legitimate existing
working-tree bytes rather than restoring from Git. Serve the output with
`npm run three-bosses:webgl:serve`; do not open or publish Unity's generated
HTML directly. Set `THREE_BOSSES_WEBGL_DIR` to override the default external
output directory. The stable local website URL is
`http://localhost:5173/games/three-bosses`.

### Production release

A production artifact must be rebuilt from clean, committed Unity source with
the Editor running in `-automated` mode:

```powershell
npm run three-bosses:webgl:release:build
npm run three-bosses:webgl:package
npm run three-bosses:webgl:release:validate
```

The release build keeps development, script-debugging, and profiler flags off
and writes a version-two completion marker bound to the committed Unity source,
required Editor version, source digest, file count, and exact uncompressed
runtime files. Firebase Hosting performs transport compression; packaging
retains one immutable content-addressed release under
`frontend/public/unity/three-bosses/releases` plus the stable no-store manifest.
Firebase preview verification must confirm the hosted bytes, headers, and
actual Unity browser startup before promotion. Never re-certify old output or
publish Unity's generated `index.html`.

`com.unity.pipeline` 0.5.0-exp.1 currently scans build scenes additively while
looking for runtime managers. The three boss scenes each contain one valid
Global Light 2D and are loaded singly during gameplay, but the scan makes those
lights coexist temporarily and records ten duplicate-light false positives.
The wrapper accepts only that exact ten-message pattern (or no such messages
after a future package fix) and fails on any deviation. Do not remove or alter
the scene lights to silence the scanner.

The accompanying `No RuntimePipelineManager components found` warning is also
intentional: Pipeline remains available to the Editor and Unity CLI, while its
code-evaluation and hot-reload server stays disabled in the production WebGL
Player. Do not add a runtime manager merely to suppress this warning.

## Repository boundaries

Commit Unity source under `Assets/`, `Packages/`, and `ProjectSettings/`, plus
the project documentation. Unity regenerates `Library/`, `Temp/`, `Obj/`,
`bin/`, `Logs/`, `UserSettings/`, `Build/`, `Builds/`, `MemoryCaptures/`,
`Recordings/`, and IDE project files locally; those paths are ignored and must
not be committed. `Assets/_Recovery` is ignored for local recovery only, but it
must be absent before a release build because ignored source is not covered by
provenance. Move recovered scenes to an external backup before certification.

The project includes focused EditMode and PlayMode regression suites covering
the run session, combat-only timer, countdown, UI feedback, death-animation
handoffs, and Boss 3 phase-two behavior. Passing those tests and source
integrity checks does not replace the hands-on Play Mode checks above.

## Licensing and provenance

- [Asset provenance](ASSET_PROVENANCE.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)
- [Unity Companion License notice](UNITY_COMPANION_LICENSE.md)
