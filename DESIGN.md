---
name: Samurai Sushi
description: A tactile counter ledger for a quiet, walletless sushi service.
colors:
  counter-sumi: "#171611"
  lacquer-nori: "#163a2a"
  signal-vermilion: "#c83b2d"
  readable-vermilion: "#942a20"
  ledger-indigo: "#24445e"
  lantern-brass: "#d6a43b"
  washi-paper: "#f4e9d2"
  rice-white: "#fff8e8"
  service-muted: "#625b50"
  focus-gold: "#f4d06f"
typography:
  display:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Noto Sans JP, sans-serif"
    fontSize: "clamp(2.6rem, 5.7vw, 5.5rem)"
    fontWeight: 750
    lineHeight: 0.94
    letterSpacing: "-0.035em"
  title:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Noto Sans JP, sans-serif"
    fontSize: "clamp(2rem, 4.6vw, 4.5rem)"
    fontWeight: 750
    lineHeight: 1
    letterSpacing: "-0.035em"
  body:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Noto Sans JP, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.65
  label:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Noto Sans JP, sans-serif"
    fontSize: "0.78rem"
    fontWeight: 800
    lineHeight: 1.1
    letterSpacing: "0.08em"
rounded:
  square: "0"
spacing:
  tight: "6px"
  control: "12px"
  section: "24px"
  plane: "clamp(22px, 4vw, 58px)"
components:
  button-primary:
    backgroundColor: "{colors.lacquer-nori}"
    textColor: "{colors.rice-white}"
    rounded: "{rounded.square}"
    padding: "12px 18px"
    height: "48px"
  ingredient-tile:
    backgroundColor: "transparent"
    textColor: "{colors.rice-white}"
    rounded: "{rounded.square}"
    padding: "12px"
    height: "48px"
  counter-plane:
    backgroundColor: "{colors.washi-paper}"
    textColor: "{colors.counter-sumi}"
    rounded: "{rounded.square}"
    padding: "{spacing.plane}"
---

# Design System: Samurai Sushi

## Overview

**Creative North Star: "The Counter Ledger"**

Samurai Sushi should feel like a tiny evening counter already in service: tactile, legible, restrained, and quietly ceremonial. The interface is an operating surface, not a promotional hero. Orders, ingredients, preparation, and network truth occupy grounded planes with an authored sequence.

The visual world pairs dark lacquer rails with warm washi and rice surfaces. Pixel-like geometry and compact ledger labels supply game character without nostalgic clutter. Every state must remain truthful: walletless play is visible, unfinished capabilities are disabled, and culinary review status is never hidden.

**Key Characteristics:**

- Hard-edged lacquer rails surrounding a broad, warm preparation plane.
- Dense operational labels paired with large, decisive task headlines.
- Vermilion for authored sequence, nori for action, indigo for secondary information, and brass for restrained ceremony.
- Geometric ingredient and dish silhouettes that remain recognizable without color alone.

## Colors

The palette reads as sumi ink, lacquer, washi, rice, nori, and lantern light; accents are functional and deliberately scarce.

### Primary

- **Lacquer Nori:** Primary action surfaces and completed preparation marks.
- **Signal Vermilion:** Active-order edges, progress, and small ceremonial accents.

### Secondary

- **Ledger Indigo:** Informational scenes and secondary actions.
- **Lantern Brass:** Header rules, prototype labels, and warm status details.

### Neutral

- **Counter Sumi:** Headers, rails, navigation, ink, and hard structural borders.
- **Washi Paper:** Main work plane and quiet background.
- **Rice White:** Cutting boards, active rail cards, and text on dark surfaces.
- **Service Muted:** Secondary copy on light work surfaces.
- **Focus Gold:** Keyboard focus on dark rails and navigation.

**The Sparse Signal Rule.** Vermilion and brass mark sequence or status; they never become broad decorative fills.

## Typography

- **Display Font:** System sans with Segoe UI and Noto Sans JP fallbacks
- **Body Font:** System sans with Segoe UI and Noto Sans JP fallbacks
- **Label/Mono Font:** System monospace for order numbers, chain evidence, and step counts

**Character:** The type system is direct and workmanlike. Oversized, tightly tracked task headings carry the moment; compact uppercase labels make the rest read like a working ledger.

### Hierarchy

- **Display** (750, fluid 2.6–5.5rem, 0.94): Threshold statements only.
- **Title** (750, fluid 2–4.5rem, 1): Current task and settled service states.
- **Body** (400, 1rem, 1.65): Explanatory copy, limited to roughly 60 characters per line.
- **Label** (800, 0.78rem, 0.08em, uppercase): Rail headings, task context, and truth labels.

**The One Loud Line Rule.** Only the current threshold or task receives display scale; everything else supports it.

## Layout

Desktop uses a three-part counter: order rail, flexible preparation plane, and mise-en-place rail. At 1120px, ingredients become a full-width ribbon beneath the order and prep areas. Below 768px, the visual order becomes active order, prep plane, then ingredients, with a safe-area-aware fixed navigation bar. The DOM preserves ingredient-before-action focus order while focus management follows the authored service sequence.

Spacing follows a compact 6–12px control rhythm, 24px section rhythm, and a fluid 22–58px preparation-plane inset. Touch controls never fall below 48px.

## Elevation & Depth

The system is flat by default. Depth comes from tonal planes, 2–3px sumi borders, a brass header rule, and one restrained ambient shadow on the scene, cutting board, and primary action. Interaction never depends on shadow alone.

**The Grounded Plane Rule.** A shadow may lift a working object from its surface, but rails and navigation remain fixed architectural layers.

## Shapes

Corners are square. Hierarchy comes from proportion, inset rules, and geometric silhouettes rather than rounded cards. Ingredient marks use blocky two-tone constructions; completed dishes use layered rice, nori, and filling geometry with a full silhouette change at completion.

## Components

### Buttons

- **Shape:** Square, bordered, and at least 48px tall.
- **Primary:** Nori fill, rice text, sumi border, and 12px × 18px padding.
- **Hover / Focus:** Brighter nori on hover, one-pixel press travel, indigo focus on light planes, focus-gold on dark planes.
- **Secondary:** Transparent with indigo text and a two-pixel underline.

### Cards / Containers

- **Corner Style:** Square.
- **Background:** Dark rail cards at rest; rice-white for the active order and cutting board.
- **Shadow Strategy:** Only working planes and primary actions receive ambient lift.
- **Border:** One-pixel rail dividers; two- or three-pixel sumi working-object borders.
- **Internal Padding:** 10–14px for rail objects; fluid 24–44px inside the cutting board.

### Navigation

Navigation is a four-cell dark ledger bar. The active cell uses rice text and a full-width vermilion top rule; unavailable destinations remain visibly disabled. Mobile navigation is fixed and respects the bottom safe area.

### Ingredient Tile

Ingredient tiles pair a 42px geometric mark with an exact name and disclosure. Selection changes both background and a full inset indigo outline, never a color-only side marker. Disabled tiles remain readable but clearly unavailable.

### Network Plaque

The compact header plaque shows network, exact chain ID, and abbreviated pinned runtime revision. Its green lamp is evidence of validated configuration, not a claim of deployment or wallet readiness.

## Do's and Don'ts

### Do:

- **Do** make the current service action the strongest line on the screen.
- **Do** pair state color with text, position, silhouette, or a full outline.
- **Do** keep wallet, network, culinary-review, and prototype claims visibly truthful.
- **Do** preserve 48px controls, visible focus, and the authored ingredient-to-action sequence.

### Don't:

- **Don't** turn the counter into a marketing hero, dashboard grid, or rounded-card collection.
- **Don't** use vermilion or brass as broad decorative backgrounds.
- **Don't** communicate ingredient identity, progress, or availability by color alone.
- **Don't** add wallet prompts before a complete settled service.
