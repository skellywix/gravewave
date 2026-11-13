---
name: Gravewave
description: A kawaii-goth midnight carnival, staged like a collectible figure on a dark display card.
colors:
  midnight-ink: "#100e18"
  velvet-panel: "#211a2d"
  aubergine-card: "#30223f"
  moon-white: "#f7f0ff"
  moon-mist: "#c1b5d0"
  ghost-cyan: "#69e9f5"
  mint-glass: "#dbf7ef"
  deep-teal-ink: "#112723"
  lantern-rose: "#ff8caf"
  danger-crimson: "#ff6483"
  focus-gold: "#fff1b4"
  crate-amber: "#deac59"
  health-mint: "#a9f6d7"
typography:
  display:
    fontFamily: "Nightfall, Georgia, serif"
    fontSize: "clamp(64px, 6vw, 96px)"
    fontWeight: 600
    letterSpacing: "-0.025em"
  headline:
    fontFamily: "Nightfall, Georgia, serif"
    fontSize: "clamp(42px, 4.5vw, 66px)"
    fontWeight: 600
    letterSpacing: "-0.025em"
  title:
    fontFamily: "Nightfall, Georgia, serif"
    fontSize: "28px"
    fontWeight: 600
    lineHeight: 1.1
  numeral:
    fontFamily: "Nightfall, Georgia, serif"
    fontSize: "38px"
    fontWeight: 600
  body:
    fontFamily: "'Segoe UI', Arial, sans-serif"
    fontSize: "15px"
    fontWeight: 400
  caption:
    fontFamily: "'Segoe UI', Arial, sans-serif"
    fontSize: "13px"
    fontWeight: 400
  button:
    fontFamily: "'Segoe UI', Arial, sans-serif"
    fontSize: "16px"
    fontWeight: 700
  label:
    fontFamily: "'Segoe UI', Arial, sans-serif"
    fontSize: "12px"
    fontWeight: 800
rounded:
  crisp: "3px"
  soft: "6px"
  dialog: "12px"
  round: "50%"
spacing:
  gutter: "5vw"
  stage-max: "1460px"
  arena-max: "620px"
  top-bar: "112px"
components:
  button-primary:
    backgroundColor: "{colors.mint-glass}"
    textColor: "{colors.deep-teal-ink}"
    typography: "{typography.button}"
    rounded: "{rounded.crisp}"
    padding: "15px 24px"
    height: "58px"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.moon-white}"
    rounded: "{rounded.crisp}"
    padding: "12px 18px"
    height: "50px"
  icon-button:
    backgroundColor: "#1b142bd9"
    textColor: "{colors.moon-white}"
    rounded: "{rounded.round}"
    padding: "10px"
    size: "46px"
  dialog:
    backgroundColor: "{colors.velvet-panel}"
    textColor: "#dccde9"
    typography: "{typography.body}"
    rounded: "{rounded.dialog}"
    padding: "36px"
  upgrade-card:
    backgroundColor: "{colors.aubergine-card}"
    textColor: "{colors.moon-white}"
    typography: "{typography.title}"
    padding: "20px 10px"
  hud-label:
    backgroundColor: "#112a36e8"
    textColor: "#a6ffed"
    typography: "{typography.label}"
    rounded: "{rounded.crisp}"
    padding: "4px 8px"
  toast:
    backgroundColor: "#e7fff4"
    textColor: "#18281f"
    typography: "{typography.caption}"
    rounded: "{rounded.soft}"
    padding: "14px 20px"
  mode-tab:
    backgroundColor: "#241c32"
    textColor: "{colors.moon-white}"
    padding: "14px 10px"
---

# Design System: Gravewave

## Overview

**Creative North Star: "The Collector's Display Case"**

Gravewave opens like a collectible figure on its packaging card: one heroine, framed in an arch, lit against a midnight ground, with the box's small print around her. The case is the interface. The same surfaces carry straight into play, so choosing a heroine, deploying, and spending Echoes on an outfit feel like handling one object rather than moving between screens.

The world is a midnight monster carnival: violet night, black cathedral stone, moon-white reading surfaces, silver details, ghost-blue rewards, crimson danger. It is theatrical and cute, never cluttered. Art carries the personality; controls stay sharp and legible.

**Key Characteristics:**
- Portrait first. The heroine's arch and the Start action open the home view.
- A pale mint primary button against deep violet.
- Tonal layering instead of shadows; light comes from the art and the accent, not from the chrome.
- Serif display type for names and numbers, a plain system sans for body copy and buttons.
- Each outfit recolors the accent, so the interface wears the same trim as the figure.

## Colors

A violet-black night with a mint primary button, a cyan default accent, and warm rose and crimson reserved for the heroine's world and for danger.

### Primary
- **Mint Glass** (`mint-glass`): the filled primary button (Start, Deploy, Equip, Retry), always with **Deep Teal Ink** (`deep-teal-ink`) text.
- **Ghost Cyan** (`ghost-cyan`): the default accent, seen on the pressed mode tab and the active outfit thumbnail. Each outfit's trim color replaces it at runtime.

### Secondary
- **Lantern Rose** (`lantern-rose`): the heroine's warmth, declared as a root custom property for warm accents. Rose-red tints in the stylesheet sit near it.
- **Crate Amber** (`crate-amber`): amplifier crate labels.

### Neutral
- **Midnight Ink** (`midnight-ink`): the page and the play background.
- **Velvet Panel** (`velvet-panel`): dialogs and the portrait ground.
- **Aubergine Card** (`aubergine-card`): upgrade and route choice cards.
- **Moon White** (`moon-white`): primary text.
- **Moon Mist** (`moon-mist`): secondary text and captions.
- **Focus Gold** (`focus-gold`): the keyboard focus ring.

### Status
- **Danger Crimson** (`danger-crimson`): a root custom property for danger. The boss bar, damage callouts, and failure states use nearby pink-crimson tints defined in the stylesheet, which is canonical for those one-off values.
- **Health Mint** (`health-mint`): the player's health and shield fill.

One-off surfaces keep their exact CSS values in the components above and in the stylesheet, including the alpha channels on the icon button and HUD label fills. The sidecar's tonal ramps are synthesized previews, not color scales implemented by the game.

### Named Rules
**The Gold Ring Rule.** Focus Gold is the focus outline on buttons, links, and the game canvas: 3px wide with a 4px offset.

## Typography

**Display font:** Nightfall (self-hosted Cormorant Garamond, weights 300 to 700), with Georgia and serif as fallbacks.
**Body font:** Segoe UI, with Arial and sans-serif as fallbacks.

**Character:** a theatrical serif with tight tracking for names, headings, and numerals, set against a neutral system sans that stays out of the art's way.

### Hierarchy
- **Display** (600, clamp 64 to 96px): the heroine's name over her portrait on the home view.
- **Headline** (600, clamp 42 to 66px): the mission strip heading and similar section headings. Dialog headings use 48px and cinematic headings clamp 48 to 80px from the same family.
- **Title** (600, 28px, line height 1.1): upgrade and route card names, act labels.
- **Numeral** (600, 38px, tabular): result figures.
- **Body** (400, 15px): descriptions and dialog copy.
- **Caption** (400, 13px): toast text and card descriptions.
- **Button** (700, 16px): primary button text.
- **Label** (800, 12px): HUD world and crate labels. Smaller eyebrow labels (8 to 12px) are tracked from .05em up to .3em.
- **Wordmark:** the GRAVEWAVE wordmark is 30px Nightfall tracked at .1em, over a 10px sans subline tracked at .3em.

### Named Rules
**The Name First Rule.** On upgrade cards the name comes before the family and rank line, in both reading order and vertical order.

## Layout

A centered backstage grid on desktop and a single flex column on a phone. The stage is portrait-framed at every size.

- **Desktop** (above 1000px): the page is capped at the `stage-max` width with `gutter` side padding, a 74px rail, a 1.25fr portrait column and a .9fr mission column, with a 4% gap. The top bar is `top-bar` tall. The play arena is `arena-max` wide at most, centered.
- **Tablet** (1000px and below): two equal columns, the editorial rail hidden, a 90px top bar, and 4vw side padding.
- **Phone** (650px and below): the home view becomes a single flex column with a 79px top bar and 22px side padding. The portrait arch clamps between 300px and 390px, and the description, weapon detail, and controls notes move after the actions so Start sits inside the first screen. This was verified on a 390 by 844 viewport. At 370px and below the padding drops to 16px and the arch clamps between 280px and 350px.
- **Short screens** (650px high or less, wider than 650px) use a 70px top bar. Safe-area insets pad the HUD and bars.
- **Touch targets:** the base button rule sets a 44px minimum height. The primary button is 58px, the secondary 50px, and the icon button 46px; a few small text controls, such as the save-warning button, set their own smaller minimum.

## Elevation & Depth

Depth is tonal. Midnight Ink, Velvet Panel, and Aubergine Card step up in lightness, and borders in a muted violet separate layers.

Shadows appear in three places: the cinematic burst (0 8px 32px at 33% black), the toast (0 8px 30px at 40% black), and the desktop arena frame (0 0 100px at 53% black). Buttons do not lift on hover; they brighten by 16%.

### Named Rules
**The Flat Stage Rule.** Controls, cards, and panels carry no box shadow; only the cinematic burst, the toast, and the desktop arena frame do.

## Shapes

Sharp and small for tools, arched for the figure.

- **Controls and labels:** `crisp` (3px). The Encore button uses 4px.
- **Toast:** `soft` (6px). **Dialogs:** `dialog` (12px). **Icon buttons:** `round`.
- **Portrait frame:** a full arch (150px by 130px radii on the top corners, square base). Outfit thumbnails use a smaller arch (28/34/18px top radii, 4px bottom).
- **Health and boss bars:** 6px tall, 2px radius.
- **Choice cards:** square corners, with a 1px lighter top border.

## Components

### Buttons
- **Primary:** `button-primary`. Hover brightens 16%; pressed moves down 1px; disabled drops to 48% opacity (on locked heroes, a muted violet fill with mist text at full opacity so the reason stays readable). Focus shows the gold ring.
- **Secondary:** `button-secondary`. Transparent with a 1px muted-violet border; hover and focus match the primary.
- **Text button:** underlined 13px text for low-priority actions.
- **Icon button:** `icon-button`, a 46px circle with a thin violet border, for sound, pause, and wardrobe.

### Choice cards
- **Upgrade card:** `upgrade-card`. Name in Title, then the family and rank line, then a description and a detail line. A lighter 1px top border separates it. It appears twice per act.
- **Route card:** the same surface for Quiet procession, Raise the dead, and Afterparty detour.

### Dialogs and cinematics
- **Dialog:** `dialog`. A 12px panel with a violet border, a 48px heading, and a .35s arrive animation.
- **Cinematic:** a near-opaque night overlay with the equipped heroine's portrait, a speaker line, and a skip control. Boss intros credit the selected heroine as speaker.

### HUD
- **World label:** `hud-label`, a tinted chip with a bordered edge for the act name; crate labels use Crate Amber the same way.
- **Health and boss bars:** Health Mint on a deep wine track for the player; a pink-crimson fill on a darker track for the boss.
- **Encore button:** 196 by 58px, dim while charging, bright mint-and-white when ready.

### Feedback
- **Toast:** `toast`. Bright mint fill, dark 13px text, floats above the stage with a shadow. It is non-interactive feedback.
- **Save warning:** a wine-colored banner with warm cream text when a save cannot be read or written.

### Selection
- **Mode switch:** two tabs; the pressed tab gets a bottom border in the accent and a deeper panel fill.
- **Hero and outfit selectors:** arch thumbnails dimmed until active; an active outfit thumbnail gets an accent bottom border and an active hero gets a highlight behind it. Locked items show their Echo price.

## Do's and Don'ts

### Do:
- **Do** keep the primary button as the boldest control on a view: mint fill, dark text, 58px tall.
- **Do** put the card name before the family and rank metadata.
- **Do** let the equipped outfit's trim replace Ghost Cyan wherever the accent appears.
- **Do** honor `[data-motion="reduced"]` and `prefers-reduced-motion`: decorative CSS animations and transitions stop. Gameplay continues, and the renderer reduces its own bob, shake, and scroll separately.
- **Do** keep the Focus Gold ring, 3px with a 4px offset, on focusable controls.
- **Do** check layout changes on a 390 by 844 viewport and on desktop.

### Don't:
- **Don't** add box shadows to controls, cards, or panels; depth is tonal.
- **Don't** use the accent color as a status signal; it changes with the equipped outfit.
- **Don't** put descriptions, weapon notes, or controls notes ahead of Start on the phone home view.
- **Don't** make the home view a generic landing-page hero or card grid; the figure showcase opens directly into play.
- **Don't** introduce a font other than Nightfall and the system sans.
