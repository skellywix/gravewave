# Changelog

## 1.0.0

### Features

- Browser-playable, portrait-first arcade roguelike with touch, mouse, and keyboard controls.
- Three original adult heroines (Mira, Rin, Sera), each with a distinct weapon and Encore burst.
- Campaign of three acts with a boss each, and a Survival mode that cycles the acts with escalating difficulty.
- Between-wave upgrade choices from twelve upgrades, three synergies, and post-boss route choices (Quiet procession, Raise the dead, Afterparty detour).
- Ghost-fan squad recruitment, amplifier crates, and telegraphed boss attacks with a guaranteed safe lane.
- Earned-only Echoes shop: unlock two heroines and nine cosmetic outfits. No real-money purchases, accounts, or backend.
- Local browser save with strict validation, preserved-on-error behavior, and duplicate-settlement protection for the last 32 run IDs.
- Skippable illustrated cutscenes, synthesized audio, reduced-motion and sound settings, and pause on hidden tab.
- Deterministic `?seed=` encounters for the first run after load. Seeds never change rewards or health.
- Static bundle with relative asset paths so it can be hosted at a site root or subpath. A GitHub Actions workflow verifies pull requests and pushes to `main` or `publish/gravewave`, and publishes `dist/` to GitHub Pages from the default branch.
- Self-hosted Cormorant Garamond (SIL OFL 1.1) and original AI-generated character illustrations; notices in `public/THIRD_PARTY_NOTICES.txt`.

### Verified

- 145 unit tests pass, and the TypeScript check and production build succeed.
- Headless-browser play, including phone-sized and touch input: a full campaign win, a Survival run to its natural defeat, Rin and Sera unlocked with earned Echoes, a 400-Echo outfit purchase and equip that survived a reload, and a retry that restores a fresh run.
- Graphics-context loss and restore during combat, an upgrade choice, and a skipped cutscene; unreadable or blocked saves; and a blocked write followed by a retry.
- Visual finish: on a 390×844 phone viewport the Start button is inside the first screen without scrolling; boss intros name the selected heroine and the boss she faces; upgrade cards show their name before the family and rank line. The visual system is documented in [DESIGN.md](DESIGN.md).

### Not verified or not claimed

- Native background pause: the page-visibility handler was exercised with an injected event, not real operating-system backgrounding.
- Native iOS: not built or tested on a device, in Safari, or in a Capacitor wrapper. See [docs/ios.md](docs/ios.md).
- Voice acting and pre-rendered video are not included.
- No formal accessibility audit or security certification. The save is device-editable local storage, not security or anti-cheat, and there is no cross-device or cloud save.
