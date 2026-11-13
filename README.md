# Gravewave: Midnight Parade

A portrait-first kawaii-goth arcade roguelike that runs in the browser. Lead one of three original adult heroines and her ghost-fan squad across moonlit cathedral bridges, break cursed amplifier crates, dodge telegraphed boss attacks, and build a different set list on every run.

There are no accounts, ads, real-money purchases, or energy-style timers that limit how often you can play. Echoes, the in-game currency, come from a one-time 300-Echo starting grant and from what you earn by playing; they cannot be bought. Runs themselves are timed: each act lasts about 72 seconds before its boss.

## The game

- **Three heroines.** Each has her own weapon and Encore burst.
  - Mira (27), parasol railgun, piercing shots. Moonbreaker cuts a beam through the crowd. Unlocked from the start.
  - Rin (26), coffin-guitar scatter fire. Heartbreaker detonates in a ring of sparks. Unlock for 600 Echoes.
  - Sera (29), spectral grimoire with a protective shield. Velvet Requiem restores shield and pushes enemies back. Unlock for 600 Echoes.
- **Campaign.** Three acts, each about 72 seconds before its boss: Ghostlight Pier (Sir Cuddles), Velvet Midway (The Mourning Carriage), and Cathedral of Static (Saint Static). Boss attacks are telegraphed and always leave a safe lane.
- **Survival.** The acts repeat with escalating enemy health and boss strength until you fall.
- **Roguelike choices.**
  - Twice per act (at 24 and 48 seconds) pick one of three offered upgrades from a pool of twelve, each up to rank 3.
  - Three synergies unlock when you hold both halves: Thunder Rail (Silver Needle + Static Kiss), Prism Barrage (Crowd Pleaser + Broken Record), and Guardian Choir (Lace Aegis + Sweet Requiem). Offers that complete a synergy are more likely to appear.
  - After each boss, choose a route: Quiet procession (recover 25 health), Raise the dead (next act has 25% tougher enemies and pays 50% more Echoes for kills, amplifiers, and its boss clear), or Afterparty detour (75 extra Echoes, no healing).
- **Squad and Encore.** Gates recruit ghost fans, amplifier crates add power, and kills charge the Encore burst.
- **Earned-only shop.** Spend Echoes in the backstage wardrobe on the two other heroines and on nine outfits (three per heroine: a free original, a Nocturne outfit for 400 Echoes, and an Afterparty outfit for 500). Outfits are cosmetic and never change stats. You start with 300 Echoes, and every Echo after that is earned by playing, including from runs that end in defeat.
- **Skippable cutscenes.** Short original illustrated cutscenes (character artwork, text, and simple animated transitions) introduce the mission, each boss, Encore bursts, and the ending. They are not voice-acted and not pre-rendered video.

## Controls

| Input | Action |
| --- | --- |
| Drag or tap the arena (touch or mouse) | Steer toward that position |
| `A` / `D` or `←` / `→` | Steer left and right |
| `Space` or the Encore button | Fire the Encore burst when charged |
| `Esc` or the pause button | Pause and resume |

Your heroine fires automatically. The game pauses when the tab is hidden. Settings for sound and reduced motion are in the backstage footer; the system's reduced-motion preference is also respected.

## Saves

Progress is stored in this browser's `localStorage`. It persists across reloads on the same browser and device, and there is no cloud save, sync, or account. The save is JSON that the device owner can edit, so it is a convenience, not a security or anti-cheat mechanism. If a save cannot be read or written, the game says so, keeps what it could not read untouched, and does not overwrite it. See [docs/development.md](docs/development.md) for details.

## Run it

Requires Node.js 24.12 or newer and a browser with WebGL.

```sh
npm ci --ignore-scripts
npm run dev        # local development server
npm test           # unit tests
npm run typecheck  # TypeScript check
npm run build      # typecheck, then production bundle in dist/
```

The production bundle in `dist/` is static and uses relative asset paths, so it can be served from a site root or a subpath. To replay the same encounters, add `?seed=12345` (a positive whole number up to 4294967295) to the URL. The first run after load uses it; later runs use random seeds.

## Hosting

`.github/workflows/pages.yml` runs `npm ci`, `npm test`, and `npm run build` on pull requests, on pushes to `main` or `publish/gravewave`, and on manual dispatch. On the repository's default branch only, it then publishes `dist/` to GitHub Pages.

Game URL: https://skellywix.github.io/gravewave/

## Design

[DESIGN.md](DESIGN.md) records the visual system (palette, type, shapes, components) derived from `src/style.css`. The product register and audience are in [PRODUCT.md](PRODUCT.md).

## Status

Verified:

- 145 unit tests pass, and the TypeScript check and production build succeed.
- Headless-browser play, including phone-sized and touch input: a full campaign win, a Survival run to its natural defeat, Rin and Sera unlocked with earned Echoes, a 400-Echo Nocturne outfit purchased and equipped and still equipped after a reload, and a retry that restores a fresh run.
- Visual finish: on a 390×844 phone viewport the Start button is inside the first screen without scrolling; boss intros name the selected heroine and the boss she faces; upgrade cards show their name before the family and rank line. A finish review found no open issues; it had no external quality-bar reference to compare against.
- Recovery paths: graphics-context loss and restore during combat, an upgrade choice, and a skipped cutscene; unreadable or blocked saves; and a blocked write followed by a retry.

Not verified or not claimed:

- Native background pause. The page-visibility handler was exercised with an injected visibility change; the operating system's real app backgrounding was not.
- Native iOS. There is no iOS build, and nothing has been tested on a physical iPhone, in Safari, or in a Capacitor wrapper; [docs/ios.md](docs/ios.md) describes the planned path.
- A formal accessibility audit, a security certification, voice acting, or pre-rendered video.

See [CHANGELOG.md](CHANGELOG.md) for the release notes.

## Credits and notices

- Character illustrations are original, AI-generated artwork (see `asset-provenance.json`), stylized adult characters. They are not copied from any franchise.
- The world is built from procedural Three.js geometry. Sound effects and music are synthesized in the browser with Web Audio. No sampled recordings are shipped.
- Display type is self-hosted Cormorant Garamond under the SIL Open Font License 1.1.
- Third-party license details: [public/THIRD_PARTY_NOTICES.txt](public/THIRD_PARTY_NOTICES.txt) and [public/fonts/OFL.txt](public/fonts/OFL.txt).
