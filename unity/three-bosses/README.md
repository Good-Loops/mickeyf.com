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

1. `Assets/Scenes/Level1_BeeBoss.unity`
2. `Assets/Scenes/Level2_CyborgBoss.unity`
3. `Assets/Scenes/Level3_Kraken.unity`

Baseline keyboard controls are:

- Move horizontally: `A`/`D` or Left/Right Arrow
- Jump: Space
- Dash: Left Shift
- Aim: `A`, `D`, or `W`
- Fire: Enter

## Play Mode verification

Before publishing gameplay changes, check all three scenes and confirm:

- horizontal movement, double jump, dash, player damage, and player death;
- crate spawning and pickup behavior;
- all ten weapons, including fire and impact behavior;
- all 21 weapon-related audio clips, including the Phase Anchor loop and end;
- boss health, phase changes, death, and the Level 1 to Level 2 and Level 2 to
  Level 3 transitions;
- no missing scripts, prefabs, references, or Console errors.

Boss 3 enters phase two at 50% health and expands its rune attack from two
anchors to three. The current project intentionally has no scene transition
after the Level 3 boss; that completion flow is deferred until its artwork and
scene design are integrated.

## Repository boundaries

Commit Unity source under `Assets/`, `Packages/`, and `ProjectSettings/`, plus
the project documentation. Unity regenerates `Library/`, `Temp/`, `Obj/`,
`bin/`, `Logs/`, `UserSettings/`, `Build/`, `Builds/`, `MemoryCaptures/`,
`Recordings/`, and IDE project files locally; those paths are ignored and must
not be committed. `Assets/_Recovery` is deliberately excluded.

The project includes four focused Play Mode regression tests for Boss 3's
phase-two threshold, one-way latch, lethal-damage path, and rune expansion.
Passing those tests and the headless script compile does not replace the
hands-on Play Mode checks above.

## Licensing and provenance

- [Asset provenance](ASSET_PROVENANCE.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)
- [Unity Companion License notice](UNITY_COMPANION_LICENSE.md)
