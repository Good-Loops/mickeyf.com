# Ludolume native artwork

Celestial glass artwork created with the built-in image-generation tool on
2026-09-10. It preserves Ludolume's controller-and-musical-notes identity and the
website's navy, cyan and frosted-glass palette. The same approved controller
master now supplies the website favicon, Apple touch icon and PWA icons.
Updating source assets does not publish a website release.

## Sources and exports

- `icon-only.png`: opaque, full-bleed iOS and legacy Android icon source.
- `icon-foreground.png`: real RGBA controller cutout for Android adaptive icons.
- `icon-background.png`: solid midnight-navy adaptive background (`#08121e`).
- `splash.png`: centered emblem/wordmark with generous celestial crop space.

The generated icon/splash masters are 1254 pixels square. Larger launch-screen
exports are resized from that master; they are not independently generated
high-resolution detail. The foreground was chroma-keyed at the owner's request,
then centered with room for Android's launcher masks. The controller is opaque
frosted glass; the surrounding area and arch are transparent.

To regenerate the platform exports, run from `frontend`:

```sh
npm exec --package=@capacitor/assets@3.0.5 -- capacitor-assets generate --ios --android --assetPath resources
```

This is an on-demand build tool, not an application runtime dependency. Review
the generated diff before committing. Do not retain both PNG and WebP files with
the same Android resource name. Keep the adaptive background full-bleed; the
generator's foreground inset supplies the launcher-safe padding. Preserve the
navy launch-theme/storyboard colors after regeneration.

The exporter produces three byte-identical 2732-square iOS splashes. Keep one as
`Splash.imageset/LaunchArtwork.png`, registered as the universal 1x image in
`Contents.json`; the storyboard scales that single image to fill the screen.
Remove the redundant exports and any unreferenced former template images.

iOS uses the illustrated launch screen. Android 12+ uses the platform's centered
icon on a solid navy background; older Android versions have the illustrated
launch resources. Neither platform has an artificial splash delay. Actual native
launch appearance still needs device validation.

## Website icons

`frontend/public` contains the browser PNG (96 pixels), ICO (16/32/48 pixels),
Apple touch icon (180 pixels) and PWA icons (192/512 pixels). The browser favicon
contains only the approved controller on a fully transparent canvas, including
the area beneath its arch. The complete silhouette is centered vertically and
fills the width with a one-pixel antialiasing margin on either side, preserving
both handles and the musical notes. It has no circle or cosmic background.
Apple/PWA exports retain opaque backgrounds and launcher-safe padding. The
obsolete SVG favicon wrapper was removed so browsers do not select old artwork.
Browser icon URLs carry a brand revision query to refresh cached favicons.

Browser exports trim the full nonzero-alpha bounds of `icon-foreground.png` to
`(72, 233, 880, 558)`. For each output size, resize the cropped controller to
`size - 2` pixels wide, preserving its aspect ratio, then center it on a square
RGBA canvas with zero background alpha. Render at 8x output size and downsample
with Lanczos3; pack the 16/32/48-pixel PNG frames into the ICO. No icon generation
is needed.

These are deterministic size/crop/composite exports of the existing masters using
Sharp from `@capacitor/assets` 3.0.5's dependency installation, not independently
generated artwork. Source/native icons are unchanged by the website exports.

## Current regeneration prompts

The original masters were created under the previous brand name. The splash
wordmark was edited with the built-in image-generation tool for the Ludolume
rename. After comparing psychedelic alternatives, the owner selected the clean
cosmic/geometric lettering. Text-free icon artwork remains unchanged. The recipes
below use the current brand; the focused wordmark-edit prompt is recorded below.

### Icon master

Use case: logo-brand. Asset type: production Ludolume mobile app icon, one square
1024 by 1024 PNG, full-bleed opaque background, no rounded outer corners, no device
mockup. Primary request: a premium celestial/glass reinterpretation of Ludolume's
existing identity: a game controller with a pair of joined musical eighth notes
in its center, D-pad at left, four round buttons at right. Ludolume is an
interactive music, math, games and animations app. Match its website's deep
midnight-navy space background, restrained blue-teal nebulae, pale silver lettering
and translucent glass panels. Subject: one bold, instantly readable glass game
controller, front view, softly sculpted frosted silver-blue translucent body with
a clean cyan rim, dark navy D-pad and buttons and clearly legible silver/cyan
musical notes in the center. Keep the entire controller inside the central 65%
square with balanced generous padding so OS circular/squircle masks won't clip
it. Subtle teal-blue nebulous depth behind it, very sparse fine stars, a delicate
curved orbital arc suggesting rhythm; no busy galaxy collage, no purple wash, no
fire, no text, no wordmark, no watermark. Strong silhouette readable at 48 pixels;
polished material depth, controlled highlights, NOT a generic neon gaming badge.
Background reaches every edge, near #08121e at edges, no frame or white margin.
Return the single final app icon artwork, not a presentation sheet.

### Launch artwork (icon master as reference)

Use case: compositing. Reference image: Ludolume celestial glass controller app
icon. Create matching production native launch/splash artwork, a single opaque
square PNG 3072 by 3072 (or largest supported square), NOT a phone mockup. Preserve
the controller's exact frosted silver/cyan design and musical notes, but make it a
SMALL center emblem occupying only 25% of canvas width and 18% of canvas height.
Directly below in quiet, crisp silver geometric sans-serif, write exactly
"Ludolume" (capital L, remaining letters lowercase, no spaces), wordmark width
at most 25% of full image.
Both logo and wordmark contained within the central 30% square of the entire
canvas so extreme portrait and landscape center-crops keep them complete. Extend
the midnight navy #08121e celestial background to every edge, subtle smoky
blue/teal nebula sweeping softly across with sparse tiny stars and a very fine
orbital arc near the small central mark. Much quieter and darker than icon;
luminous but restrained. No huge controller, no hard black fades, no UI panels,
no progress bar or fake loading percentage, no slogans, no borders, no watermark.
Think calm high-end astronomy/music instrument software, not loud gaming splash.
The outer 70% is atmospheric negative space. One final square art asset.

### Selected wordmark edit (splash master as edit target)

Use case: text-localization. Replace only the existing app-name lettering with
exactly "Ludolume" (L-u-d-o-l-u-m-e). Preserve the clean cosmic/geometric
silver/cyan type treatment, centered placement below the controller and generous
crop margins. Keep the controller, musical notes, orbital arc, stars, nebula,
navy palette, scale and full-bleed square composition unchanged. No added text,
slogan, border or loading UI. This is a normalized record of the selected edit
specification; the rejected psychedelic variants are not project assets.

### Keyable controller (icon master as edit target)

Use case: background-extraction. Edit target: this Ludolume app icon. Keep ONLY
the silver/cyan frosted glass controller and its existing dark D-pad, four buttons
and joined musical notes. Preserve its front-view shape and design. Replace ALL
space background, orbit arcs, stars and area under the controller's arch with a
perfectly uniform solid chroma-key MAGENTA #FF00FF. This will be keyed out
programmatically at the user's request. No gradients, shadows, reflections,
checkerboard, orbit lines or extra objects on the magenta. Do not tint the
controller magenta: keep cool silver/cyan material and dark navy details, opaque
frosted controller. Center the complete controller with generous equal clear
margins. Single square PNG; no text. Background should be pure flat magenta up to
the controller's clean antialiased silhouette.
