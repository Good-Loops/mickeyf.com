# Main Menu UI Toolkit pilot

Open `Assets/Scenes/UI/MainMenuToolkitPilot.unity` to inspect the isolated pilot.
The scene is excluded from builds. The production Main Menu, HUD, touch controls
and gameplay remain unchanged; this is not a production migration.

The source is [MainMenuPilot in Figma](https://www.figma.com/design/hH2nXiz3n12LclUjpsPgui/?node-id=3-2)
(file `hH2nXiz3n12LclUjpsPgui`, root `3:2`). Its actual node values were imported
through Unity's official `figma_import` Pipeline command. The import returned no
USS errors or notes. Desktop Figma-plugin pairing was not validated; this
checkpoint exercised the official import command only. Experimental dependencies
are pinned to
`com.unity.ui.figma` `0.1.0-exp.1` and `com.unity.pipeline` `0.6.0-exp.1`.

Generated UXML/USS, images and the sync manifest live under
`Assets/Figma/Three-Bosses---Main-Menu-UI-Toolkit-Pilot/`. Keep runtime wiring in
`Assets/Scripts/UI/Pilots/MainMenuToolkitPilot.cs` and owned presentation in
`Assets/UI/Pilots/MainMenuToolkitPilot.uss`; reimport must not overwrite them.
The controller binds the existing `Assets/Art/UI/Screens/Menu.png` directly.
Oxanium Bold intentionally replaces the production menu's Liberation Sans in
this pilot only. PLAY uses the existing run service and loads Level 1 without
the production fade; mute uses the existing saved global audio preference.

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
unity command run_tests --mode playmode --filter MainMenuToolkitPilotTests --async_tests true --project-path ./unity/three-bosses --format json
git diff --check -- PROJECT_PLAN.md unity/three-bosses/Assets/UI/Pilots/README.md
```

The test command returns an asynchronous run; confirm its final result before
claiming acceptance. The documentation diff check passed.

Before any production adoption, verify WebGL rendering and the browser-ready
signal, page/Toolkit touch ownership (`WebPageTouchScroll` currently targets
uGUI), and physical phone/browser behavior in portrait and landscape. Preserve
the current build scene list until those gates and a migration decision are
complete.
