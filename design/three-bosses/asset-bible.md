# Three Bosses — Asset Bible (v1)

## Purpose
This document defines the **visual and asset contract** for the game *Three Bosses*.
All sprites, tiles, UI, and VFX must follow this specification to ensure visual
consistency, clean scaling, and speedrun readability.

This is a **project-level contract**. Breaking changes must be intentional and
should result in a version bump of this document.

---

## Global Resolution & Scale
- Target resolution: **1920×1080** (16:9)
- Development resolution: virtual 1920×1080, scaled with letterboxing when needed
- Tile size: **32×32 pixels**
- Player height: **64px tall** (≈ 2 tiles)
- Scaling: integer scaling preferred (no pixel interpolation)

---

## Art Style
- Style: **Pixel art**
- Animation feel: **Smooth**
- Animation FPS: **16 FPS**
- Palette: **Limited palette** (see Palette section)
- Outlines: **1px outline**, dark neutral tone
- Shading:
  - 2–3 shade ramps per material
  - No pillow shading
  - Consistent light source (top-left default)

Speedrun readability always has priority over detail.

---

## Palette (LOCKED AFTER CONFIRMATION)

All assets must **exclusively** use the locked palette below.  
Speedrun readability always takes priority over visual detail.

**Palette version:** v1 (locked)  
**Palette source:** https://coolors.co/393e41-454741-6b6b6b-f0f0f0-7ed321-00ffff-003366-ffef00  
**Total colors:** 8 (excluding transparency)

### Palette Colors & Roles

| Role | Hex | Name | Usage |
|---|---|---|---|
| Outline / Primary Dark | `#393E41` | Gunmetal | 1px outlines, silhouettes, UI borders |
| Dark Neutral | `#454741` | Charcoal Brown | Shadows, depth, environment contrast |
| Mid Neutral | `#6B6B6B` | Dim Grey | Base surfaces, player clothing, platforms |
| Light Neutral | `#F0F0F0` | Platinum | UI text, highlights, HP bars |
| Toxic Accent | `#7ED321` | Yellow Green | Boss 1 (Bee), poison, radioactive effects |
| Tech Accent | `#00FFFF` | Cyan | Boss 2 (Cyborg), tech weapons, pickups |
| Depth Accent | `#003366` | Oxford Navy | Boss 3 (Kraken), deep shadows, water |
| Highlight / VFX | `#FFEF00` | Sunbeam Yellow | Hits, damage numbers, critical effects |

### Palette Rules

- No pure black or pure white allowed
- No additional colors may be introduced
- Each color must serve a **distinct gameplay role**
- Gradients must be simulated via dithering only
- Palette changes require a **version bump** (v2, v3, …)

### Status

✅ Palette locked and approved  
🚫 Do not modify without updating this document

---

## Player Character
- Theme: **Masked runner**
- Silhouette priority: clear and readable at speed
- Size: **96px tall**
- Pivot point: **Feet center**
- Outline: 1px
- Required animations (v1):
  - Idle
  - Run
  - Jump
  - Dash
  - Death

---

## Weapons
- Type: **Ranged only** (no melee)
- Count (v1): **10**
- Rules:
  - Always viable
  - Limited ammo
  - One weapon equipped at a time
- Required assets per weapon:
  - Pickup sprite
  - Projectile sprite(s)
  - UI icon
  - Optional impact / hit effect
- Pivot: center

---

## Bosses

### Boss 1 — Radioactive Bee
- Visual theme: toxic / radioactive
- Required animations:
  - Idle / hover
  - Attack(s)
  - Phase transition tell
  - Hurt
  - Death

### Boss 2 — Soldier-Cyborg
- Visual theme: military / tech
- Required animations:
  - Idle / walk
  - Ranged attack
  - Mobility or charge attack
  - Phase transition
  - Hurt
  - Death

### Boss 3 — Kraken
- Visual theme: water / ink / tentacles
- Required animations:
  - Tentacle attack
  - Projectile / ink attack
  - Arena hazard
  - Phase transition
  - Hurt
  - Death

Boss AI is **non-adaptive**, phase-based, and pattern-driven.

---

## Environments / Tilemaps
- Tile size: 32×32
- Tile categories:
  - Ground / platform
  - Edge / trim
  - Background
  - Hazards
- Collision shapes must be clear and readable
- Decoration must never obscure gameplay
- Parallax allowed only on background layers

---

## UI
- Health: **HP bar**
- Timer: always visible
- Split times: after each boss
- Font: bitmap or pixel-compatible
- Style: minimal, high contrast, readable at speed

---

## Effects (VFX)
- Screen shake: enabled (light, controlled)
- Damage numbers: enabled
- Hit sparks: small, fast, readable
- VFX must reuse existing palette ramps

---

## Naming Conventions
- Sprite naming:
  - player_run_01.png
  - bee_attack_sting_03.png
  - weapon_laser_projectile.png
- Versioning:
  - *_v01.png, *_v02.png
  - Never overwrite previous versions

---

## File Structure (Art)
- Art/Characters/Player/
- Art/Bosses/Bee/
- Art/Bosses/Cyborg/
- Art/Bosses/Kraken/
- Art/Weapons/
- Art/Tiles/Arena1/
- Art/Tiles/Arena2/
- Art/Tiles/Arena3/
- Art/UI/
- Art/VFX/

---

## Non-Goals
- No mixed pixel densities
- No inconsistent animation FPS
- No palette drift
- No excessive detail that harms readability

---

## Notes
If an animation or sprite is unclear at full speed, it is incorrect and must be revised.
