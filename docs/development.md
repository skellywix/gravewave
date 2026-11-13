# Development

## Requirements and commands

- Node.js 24.12 or newer (`engines` in `package.json`). Unit tests run TypeScript directly with Node's type stripping, so no test runner is installed.
- A browser with WebGL for play.

```sh
npm ci --ignore-scripts   # install exactly what package-lock.json pins, without running install scripts
npm run dev               # Vite development server
npm test                  # node --test tests/*.test.ts
npm run typecheck         # tsc --noEmit
npm run build             # tsc --noEmit && vite build, output in dist/
```

Source files use explicit `.ts` import extensions and erasable TypeScript only (no enums, parameter properties, or runtime namespaces), because Node executes them directly.

## Architecture

The simulation is separated from everything that touches a browser, so it can be tested in Node and reused by any wrapper.

| Path | Responsibility |
| --- | --- |
| `src/game/types.ts` | Shared data shapes and the function types every provider module is annotated with. |
| `src/game/catalog.ts` | Single source of truth for heroines, outfits, upgrades, sectors, `ECONOMY` (prices, rewards, caps), `WORLD` and `LIMITS`. No other module duplicates these numbers. |
| `src/game/engine.ts` | Deterministic simulation: `createRun`, `tick`, `chooseUpgrade`, `chooseRoute`, `activeSynergies`. Pure TypeScript with no DOM, storage, clock, or `Math.random`; it has its own seeded generator. The renderer and UI read state and never write it. |
| `src/game/progression.ts` | The profile: defaults, decoding and validation of stored saves, purchase, equip, select, and run settlement. All functions are pure except explicit load and save. |
| `src/session.ts` | Thin stateful wrapper over progression. Owns the current profile, persists after each successful change, and decides when saving is allowed. |
| `src/main.ts` | DOM application: menu and wardrobe, HUD, dialogs, the fixed-step game loop, pause, cinematics, and wiring of the modules below. |
| `src/ui.ts` | Markup builders and pure view helpers (shop button state, event callouts). |
| `src/input.ts` | Pointer, touch, and keyboard sampling; `?seed=` parsing. |
| `src/audio.ts` | Synthesized sound cues and melody with Web Audio, started only after a user gesture. |
| `src/cinematics.ts` | Skippable scene sequences (text, portraits, timing) and the event policy that decides which events open one. |
| `src/render/` | Three.js scene and procedural models. Projects world positions for the HTML labels. |
| `public/` | Static assets copied as-is: illustrations in `art/` with an adjacent `<image>.webp.json` prompt record for each, the font and its license in `fonts/`, and a notices file. |
| `asset-provenance.json` | Records how each shipped asset was made. |

The main loop steps the simulation at a fixed 1/60 second, clamps long frames, and pauses when the tab is hidden, a dialog needs input, or the graphics context is lost.

## Determinism, seeds, and run IDs

- A run is `createRun(seed, hero, mode, runId)`. The same seed, hero, mode, and inputs produce the same encounters, which is what unit tests rely on.
- `?seed=N` (a positive integer up to 4294967295) fixes the encounter sequence for the first run after page load. It changes which enemies and objects appear, never health, damage, or rewards, and never grants a bypass. Later runs use random seeds.
- Every run gets its own unique run ID (128 random bits, from `crypto.getRandomValues`). The seed is not an identity: two runs with the same seed settle separately.

## Saves and progression

There is no backend. Everything persists in `localStorage` under the key `gravewave.profile.v1`.

- **Device-editable.** A save is plain JSON that the device owner can change. Validation protects the game from corrupt or hand-edited files; it is not security, not anti-cheat, and not a trusted entitlement. Paid products would need a separate trusted purchase design. This version has none.
- **Earned currency only.** A new profile starts with `ECONOMY.starterEchoes` (300) Echoes, a one-time grant that is part of the default profile, not a settlement. Every Echo after that comes from run settlement, and nothing can be purchased with real money. A run credits at most `ECONOMY.settlementCap` Echoes, and the wallet is capped at `ECONOMY.walletCap`.
- **Bounded duplicate protection.** Settlement is deduplicated by run ID against the last 32 settled IDs (`ECONOMY.settlementHistory`). Settling the same run again credits nothing. An ID older than that window could be settled again; this is an accepted limit of an editable offline save. A valid save with a longer history is trimmed to the most recent 32 on load.
- **Strict decoding.** A stored save is rejected if it is not valid JSON, has the wrong shape or version, contains unknown or duplicate IDs, out-of-range numbers, unowned equipped items, or malformed settings or history. Unknown keys are rejected rather than copied.
- **Failures are explicit and nothing is overwritten.**
  - An empty or missing entry is a clean new profile.
  - An unreadable or invalid save is reported, the raw text is left in storage, and the session runs on a temporary profile that is not written back.
  - If storage is blocked, the session also stays temporary. If only a later write fails, the UI offers "Retry saving" and keeps the in-memory progress.
- **Purchases are rule-checked.** Duplicate or unaffordable purchases and unknown IDs are rejected with the original profile unchanged. An outfit for a heroine you have not unlocked can be bought but is worn only once she is unlocked and selected.

## Static hosting

`vite.config.ts` sets `base: './'`, and the app references its own assets with relative URLs. The contents of `dist/` therefore work when served from a site root or from a project subpath, and from any static file host, without server configuration. Run `npm run build` and serve `dist/` to check this.

`.github/workflows/pages.yml` is the hosting workflow. Its `verify` job runs `npm ci --ignore-scripts`, `npm test`, and `npm run build` on pull requests, pushes to `main` or `publish/gravewave`, and manual dispatch. Only on the default branch does it upload `dist/` and run the `deploy` job to GitHub Pages. Game URL: https://skellywix.github.io/gravewave/

## Visual system

[DESIGN.md](../DESIGN.md) documents the palette, type, layout, shapes, and components, all derived from `src/style.css`; its machine-readable companion is `.impeccable/design.json`. Change the stylesheet and DESIGN.md together. Visual finish checks (mobile Start anchor, boss intro identity, upgrade heading order) are covered by the unit tests only where they are logic (`tests/cinematics.test.ts`); layout is checked by viewing the build in a browser.

## Tests

`tests/` holds one file per module group: contracts and catalog, engine, progression, session, input, audio, cinematics, UI helpers, and the renderer's scene and model logic (run against Three.js objects in Node, without a GPU). Storage is injected as a small `getItem`/`setItem` interface, so progression tests never touch a real browser. Browser behavior (touch, WebGL, audio, layout) is checked by playing the build in a browser, not by the unit tests.

## Licenses and provenance

Shipped third-party notices live in `public/THIRD_PARTY_NOTICES.txt` (copied into `dist/`), the font license in `public/fonts/OFL.txt`, and asset provenance in `asset-provenance.json`. Each illustration's generation prompt fields are recorded in an adjacent sidecar, `public/art/<image>.webp.json`; these are adjacent files, not metadata embedded in the images. Those files are the canonical record; update them when a shipped runtime dependency, font, or asset changes. Build and test tooling (Vite, TypeScript, type packages) is not shipped in the bundle. This repository does not state a license for the game's own code.
