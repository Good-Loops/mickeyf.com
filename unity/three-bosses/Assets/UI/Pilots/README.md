# Main Menu UI Toolkit

Open `Assets/Scenes/UI/MainMenu.unity` to inspect the active menu. On 2026-09-22,
the user approved replacing the old uGUI scene with the new UI Toolkit scene.
Its original GUID is preserved and Build Settings starts with this scene.
The legacy scene, controller implementation and menu-generation commands were
removed; they remain recoverable from Git. This source-adoption checkpoint did
not include a WebGL build or deployment. The later remaining-screen migration
is recorded below; gameplay HUD elements remain uGUI.

The source is [MainMenuPilot in Figma](https://www.figma.com/design/hH2nXiz3n12LclUjpsPgui/?node-id=3-2)
(file `hH2nXiz3n12LclUjpsPgui`, root `3:2`). Its actual node values were imported
through Unity's official `figma_import` Pipeline command. The import returned no
USS errors or notes. Desktop Figma-plugin pairing was not validated; this
checkpoint exercised the official import command only. Experimental dependencies
are pinned to
`com.unity.ui.figma` `0.1.0-exp.1` and `com.unity.pipeline` `0.6.0-exp.1`.

Generated UXML/USS, images and the sync manifest live under
`Assets/Figma/Three-Bosses---Main-Menu-UI-Toolkit-Pilot/`. Keep runtime wiring in
`Assets/Scripts/UI/MainMenuController.cs` and owned presentation in
`Assets/UI/Pilots/MainMenuToolkitPilot.uss`; reimport must not overwrite them.
The controller binds the existing `Assets/Art/UI/Screens/Menu.png` directly.
The imported assets retain their pilot names to preserve Figma sync provenance.
Oxanium Bold replaces the legacy menu's Liberation Sans. PLAY uses the existing
run service and loads Level 1 directly; mute uses the saved global preference.
The controller preserves the WebGL browser-ready callback after the splash.
An EventSystem connects Toolkit controls to existing page-touch ownership;
noninteractive artwork ignores picking so background swipes can scroll.

Isolated implementation verified on 2026-09-22: the focused PlayMode run passed
2/2 tests in 2.81 seconds. Coverage includes 360x800, 390x844, 844x390, 768x1024,
1024x768, 1280x720, 1920x1080 and 2560x1080, plus three rotation/safe-area repeat
steps. Tests checked centers within 1px, minimum 48px targets, the audio icon
with and without focus, mute toggles, and PLAY starting a new run and loading
Level 1. All eight actual UIDocument RenderTexture captures in
`%TEMP%/three-bosses-menu-pilot/` were visually inspected; no clipped labels were
observed. These are Editor checks, not physical-device or WebGL acceptance.

The visual-centering follow-up also checks PLAY's rendered glyph bounds against
the artwork's inner frame within 1.5px. The controller compensates Oxanium's
font-metric offset separately from the button's touch target. The audio symbol
uses an intermediate size (37 authored pixels, minimum 20) without shrinking its
48px minimum target; the follow-up run passed 2/2 tests.

From the repository root, the portable equivalent of the verified PowerShell
test command is below (`--project-path` was absolute in the recorded run):

```powershell
$unityProject = (Resolve-Path ./unity/three-bosses).Path
unity command run_tests --mode playmode --filter MainMenu --async_tests true --project-path $unityProject --format json
git diff --check -- PROJECT_PLAN.md unity/three-bosses/Assets/UI/Pilots/README.md
```

The test command returns an asynchronous run; confirm its final result before
claiming acceptance. The documentation diff check passed.

After replacement, the focused `MainMenu` PlayMode run passed 4/4 tests in
4.89 seconds: build-entry identity, button/background touch ownership, the
existing viewport/centering checks, Play/mute, and pause-to-menu navigation.

Before release, verify the rebuilt WebGL's rendering, browser-ready signal and
physical phone/browser behavior in portrait and landscape. Source adoption is
approved; release acceptance and deployment remain separate.

## Remaining screens

The 2026-09-22 follow-up migrates pause in all three battles, the three defeat
screens, both boss transitions and the final results screen to UI Toolkit.
`Assets/UI/Screens/` contains the owned UXML/USS and panel settings. Existing
artwork and scene GUIDs are retained. The timer, health bars, countdown and
touch HUD remain uGUI; this is a screen-presentation migration, not a gameplay
rewrite.

`OutcomeScreenView` owns layout, safe areas, typography and fading for the six
outcome scenes. The existing controllers still own run validation, navigation,
ranking and score-submission states. `GameplayPauseController` uses Toolkit
controls while preserving input-gate ownership and browser-pause composition.
Its panel renders above the touch HUD; closed decorative UI ignores picking.

The obsolete outcome/pause/button scene builders and four unused presentation
helpers were removed. `PauseGlassGraphic` is retained because an existing local
Unity recovery scene still references it; no recovery files were modified.

Focused validation command (asynchronous; inspect its final result):

```powershell
$unityProject = (Resolve-Path ./unity/three-bosses).Path
unity command run_tests --mode playmode --filter ScreenUI --filter_type category --async_tests true --project-path $unityProject --format json
```

Tests cover actual UIDocument rendering, readout/button centering, safe areas,
touch targets, pause/focus/input, transition splits and submission states.
Render captures are outside the repository under
`%TEMP%/three-bosses-outcome-toolkit/` and `%TEMP%/three-bosses-screen-ui/`.

Validation: `ScreenUI` passed 12/12 tests. Visual review then found captions
wrapping outside the painted frames at phone width; caption sizing now uses
the artwork independently of the 48px touch target. The three outcome tests
passed again, including natural text dimensions and the resolved Oxanium font.
Portrait/landscape captures were inspected. `npm run three-bosses:webgl:build`
completed one guarded local rebuild, preserving the source/settings baseline.
Its one warning states that Pipeline is disabled in the player without a
runtime configuration; developer remote tooling is intentionally not enabled.
This does not constitute a deployment or physical-device acceptance.

### Glass and interaction follow-up

`PauseGlassElement` restores the former pause graphics using translucent vertex
colors, directional rims and short highlights. It is decorative and ignores
picking; the existing Toolkit buttons retain input ownership and 48px targets.
Native pointer/focus events brighten the glass without resizing those targets.
The original uGUI touch HUD, its shared prefab and press feedback are unchanged.

The menu and outcome styles now provide hover/pressed feedback. PLAY and audio
enlarge gently without adding another frame over the artwork. PLAY's imported
inline color was removed so the owned stylesheet can control its interaction
states; keep that color out of inline UXML when reimporting the design.

Validation: all four pause tests passed, including transparent rendered pixels,
native hover/focus/press/drag-out behavior and unchanged hit targets. The full
14-test `ScreenUI` run then passed 13 tests; its remaining menu check exposed
countdown teardown in the test harness. After fixing that cleanup, the focused
`ThreeBosses.Tests.MainMenuTests` run passed 4/4, including native hover, borderless
buttons and hover reset. Hover and glass captures were inspected. The follow-up
guarded WebGL build succeeded with only the same disabled-Pipeline warning.
The rebuilt localhost browser preview loaded successfully; Play and pause opened
the scene and the translucent panel correctly over the live game artwork.
