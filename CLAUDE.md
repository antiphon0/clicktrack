# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Clicktrack is a rhythm-based incremental (idle) game that plays in the browser. Notes scroll down "Guitar Hero"–style lanes and the player presses keys (WASD / arrows / numpad) in time. The twist: instead of a fixed chart, notes spawn from **live onset detection on the player's own music**, captured from a browser tab via `getDisplayMedia` (with a microphone fallback). When no audio is shared, a metronome at the selected BPM drives the beat.

There is no backend. All state lives in `localStorage`; the app is pure static HTML/CSS/JS with **no build step and no dependencies** for the game itself (the only `node_modules` are ESLint/devtools).

## Commands

```bash
npm run dev        # serve web/ at http://localhost:8080 (python -m http.server)
npm start          # same as dev
node build-single.js > clicktrack.html   # bundle web/* into one self-contained HTML file
```

- **Running the game:** open `http://localhost:8080` after `npm run dev`. Audio sync requires a Chromium browser (Chrome/Edge) because it depends on `getDisplayMedia({ audio: true })` tab-audio capture.
- **Deploy:** pushing to `main` triggers `.github/workflows/pages.yml`, which publishes the `web/` directory to GitHub Pages. Nothing else is built or run in CI.
- **`build-single.js`** inlines `index.html` + `styles.css` + `game.js` + `renderer.js` into a single `clicktrack.html` for single-file hosts (e.g. galaxy.click). The output `clicktrack.html` is gitignored.
- **Tests:** there is no test runner configured. `test/` is empty and `package.json` has no `test` script. `web/game.js` is written to be testable (it `module.exports` its pure functions when `module` exists), so any added Node tests should `require('./web/game.js')`.

## Architecture

The whole game is two source files plus a shell HTML page (`web/index.html`) whose DOM ids the renderer manipulates directly. There is no framework and no virtual DOM — UI updates are explicit `updateX()` calls.

### `web/game.js` — pure game logic (the model)
Stateless functions over a plain `state` object. **No DOM, no audio, no timers.** This is where all the economy/balance lives:
- `createDefaultState()` defines the entire save shape.
- Earning: `processTap(state, key, accuracy, opts)` is the core money function. It folds together per-key value, combo multiplier, accuracy multiplier, the manual-play `MANUAL_BONUS_MULTIPLIER` (players earn 2× dancers), combo-threshold bursts, and prestige/achievement multipliers. `opts.source` is `'player'` or `'dancer'` and meaningfully changes payout (dancers are capped by `DANCER_COMBO_MULT_CAP` until the Dance Captain upgrade).
- Progression systems: key tiers (`KEY_TIERS`), key upgrades (`getKeyUpgradeCost` exponential curve + bulk-buy helpers), auto-`dancers`, `prestige` (stars + `PRESTIGE_UPGRADES` "Star Shop"), `ACHIEVEMENTS`, BPM tempo scaling (`BPM_OPTIONS`), and offline earnings (`calculateOfflineEarnings`).
- Beat-grid helpers `beatIntervalMs` / `isTapOnBeat` exist but live onset timing in the renderer currently classifies hits by proximity to spawned notes, not this grid.

When adding a gameplay/economy rule, put the math here and keep it DOM-free so it stays testable. The bottom of the file has a dual export block (`module.exports` for Node, `Object.assign(window, …)` for the browser) — **any new function used by the renderer must be added to both lists.**

### `web/renderer.js` — everything stateful (the controller + view)
Holds the live `state`, owns the audio pipeline, the `requestAnimationFrame` game loop, all DOM rendering, input handling, and persistence. Key pieces:
- **Audio capture** (`startCapture`/`stopListening`): tab audio via `getDisplayMedia`, drops the video track, falls back to mic. Feeds an `AnalyserNode`.
- **Onset detection** (`detectOnset`): RMS energy vs. a rolling average (`ENERGY_HISTORY_SIZE`, `ONSET_THRESHOLD`, `ONSET_COOLDOWN_MS`). Returns a magnitude; large hits (`CHORD_MAGNITUDE_THRESHOLD`) spawn a second "chord" note. `updateDetectedBPM` does median-interval, octave-folded live BPM estimation.
- **Game loop** (`gameLoop`): one `requestAnimationFrame` driver. Each beat (audio onset OR metronome tick when not listening) pays passive beats and spawns a note. It also animates active notes down their lane, lets **dancers** auto-hit notes only *after* the player's hit window has fully passed (dancers are a fallback, not autopilot, and a player miss there breaks the player streak), and applies the `GRACE_PERIOD_MS` no-penalty window at start.
- **Input** (`onKeyPress`): maps physical keys across keyboard/arrows/numpad layouts (auto-detected by `detectInputMethod`), classifies timing (`HIT_PERFECT_MS`/`GOOD`/`OK`/`MISS_THRESHOLD_MS`, all widened 20% by the Quick Fingers upgrade via `applyPrestigeEffects`), resolves two-cardinal **chords** into diagonal keys (`CHORD_MAP`, `CHORD_WINDOW_MS`), then calls `processTap` and refreshes the relevant panels.
- **Two parallel combo streaks:** `playerStreak` (skill) and `dancerStreak` (auto) are tracked separately in the renderer — distinct from the per-key `combo` counters inside `state`.
- **Persistence:** `saveGame`/`loadGame` to `localStorage` key `clicktrack-save`, autosave every 30s + on `beforeunload`. `loadGame` merges the parsed save over `createDefaultState()` so old saves survive new fields — **preserve this forward-migration when changing state shape**, and note `init()` also has defensive back-fills for older saves.

### `web/index.html` / `web/styles.css`
`index.html` is a static shell; the renderer fills the `#note-track` lanes, upgrade lists, star shop, etc. by id. Lanes and key labels are generated dynamically (`rebuildLanes`, `updateLaneLabels`) based on which tiers are unlocked and the detected input method. Adding UI usually means adding an element/id here and a matching `updateX()` in the renderer.

## Conventions & gotchas

- In-game currency is called **"beats"** throughout the UI and code.
- Onset/audio constants and hit-window timings are tuned magic numbers at the top of `renderer.js` — change them deliberately; they directly affect game feel.
- The gitignore excludes an older Electron variant (`src/analyzer.js`, `audio-engine.js`, `db.js`, `dj.js`, `spotify-api.js`) and a `dist/` Electron build. The web app under `web/` is the live project; don't assume those `src/` files are part of it.
