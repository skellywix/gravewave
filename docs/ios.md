# iOS packaging path (future work)

Gravewave runs in the browser today. **There is no native iOS app, no Capacitor dependency, and no iOS project in this repository, and nothing here has been tested on an iPhone or iPad.** This page records the intended route so a later task starts from checked facts.

The game is built to wrap cleanly: a static bundle (`dist/`, relative asset paths), a pure TypeScript simulation, touch and keyboard input, and no backend or network access.

## Requirements (Capacitor 8 documentation)

From the official Capacitor v8 documentation, as read on 2026-11-12:

- Capacitor iOS apps use `WKWebView`. iOS 15+ is supported and Xcode 26.0+ is required. [iOS](https://capacitorjs.com/docs/ios)
- Building iOS apps needs macOS, Xcode, and the Xcode Command Line Tools. Capacitor itself needs Node.js 22 or newer; this project already requires Node.js 24.12 or newer. [Environment setup](https://capacitorjs.com/docs/getting-started/environment-setup)
- Swift Package Manager is the default iOS dependency manager in Capacitor 8; CocoaPods is optional. [Environment setup](https://capacitorjs.com/docs/getting-started/environment-setup)
- An existing web project needs a `package.json`, a built-assets directory such as `dist`, and an `index.html` containing a `<head>` tag. This project meets all three. [Getting started](https://capacitorjs.com/docs/getting-started)

Re-check these pages for the current version before starting; they change between releases.

## Planned steps

1. **Add Capacitor.** Install `@capacitor/core`, the CLI (`@capacitor/cli`, dev dependency), and `@capacitor/ios`, then run `npx cap init` and choose the app name and bundle identifier when the owner decides them. [Getting started](https://capacitorjs.com/docs/getting-started)
2. **Point at the existing build.** Set `webDir` to `dist` in `capacitor.config.ts`, the directory of compiled web assets that contains the final `index.html`. No separate native build of the game is needed. [Configuration](https://capacitorjs.com/docs/config)
3. **Create and sync the platform.** `npm run build`, `npx cap add ios`, then `npx cap sync` to copy `dist` into the native project. Repeat build and sync after each web change. [iOS](https://capacitorjs.com/docs/ios), [Getting started](https://capacitorjs.com/docs/getting-started)
4. **Run it.** `npx cap open ios` to use Xcode, or `npx cap run ios` to pick a simulator or device. [iOS](https://capacitorjs.com/docs/ios)

The wrapper loads the bundle from the app's own local origin, not a web server, so the relative `base: './'` setting in `vite.config.ts` is what lets assets resolve. Do not use the config's `server.url` option, which the documentation marks as not intended for production.

## What must be tested on a real device

None of this has been verified. Each item needs a simulator or, better, a physical device:

- **WebGL.** Rendering, frame rate, pixel-ratio cap, and recovery from a lost graphics context inside `WKWebView`.
- **Touch.** Drag and tap steering, multi-touch, edge gestures, and scrolling or zoom interfering with the arena. The Capacitor config has options for web view zoom and scroll behavior.
- **Safe areas.** The page uses `viewport-fit=cover`; check notches, the home indicator, and orientation, and add safe-area padding where HUD controls collide with them.
- **Audio.** Web Audio starts only after a user gesture; check unlock, the silent switch, interruptions such as calls, and resume.
- **Lifecycle.** Backgrounding, app switching, and returning mid-run. The game pauses when the page is hidden; confirm that happens in the web view too.
- **Storage.** Progress lives in `localStorage` inside the web view. Confirm it survives app restarts, and learn when the system can evict it before relying on it. There is still no cloud sync.

## Later, outside this repository's current scope

- Signing, provisioning, an Apple Developer account, and App Store Connect listing, review, and age-rating requirements. These need the owner's accounts and decisions; Capacitor's `ios.buildOptions` signing settings exist but no identifiers, teams, or credentials are chosen here.
- Any store-compliant treatment of the game's AI-generated artwork and the privacy and data disclosures Apple requires.
- Any real-money purchase would need a new trusted entitlement design. The current local save is device-editable and cannot be one.
