# Clicktrack — Game Design Document

> **Status:** Living document. Sections marked **`TODO`** are vision/direction calls only the
> designer can make — everything else is reverse-engineered from the current implementation
> (`web/game.js`, `web/renderer.js`) and recent design decisions, so it reflects how the game
> *actually behaves today*. When code and this doc disagree, fix whichever is wrong on purpose.

---

## 1. Vision

Clicktrack is a **rhythm-based incremental game synced to your own music**. Notes don't come from
a fixed chart — they're spawned live from whatever audio you're playing (a browser tab, or the mic),
so every song is a different "level." When no music is shared, a metronome keeps a steady beat so the
game is always playable.

The fantasy: *you are performing to your music, and getting better/richer for playing well.*

**`TODO` (designer):**
- One-sentence pitch you'd put on a store page.
- Target player + session length (quick coffee-break taps? long idle sessions? both?).
- Tone/mood (chill, hype, competitive?).
- What "winning" or long-term satisfaction looks like.

---

## 2. Design Pillars

These are the principles every mechanic should serve. Derived from existing code comments and recent
balance work — confirm/edit as the canonical list.

1. **Skill is always rewarded over automation.** Manual hits pay **2×** what dancers pay, threshold
   bursts are player-only, and dancers' combo multiplier is capped until a late upgrade. Playing well
   should always beat idling.
2. **Your music drives the game.** Audio onset detection is the primary note source; the metronome is
   a fallback, not the main mode.
3. **Precision matters, mashing is punished.** Tighter timing pays more (accuracy tiers), and a press
   with no note to hit now breaks your streak (anti-mash). You can't button-spam your way to a combo.
4. **Idle is a safety net, not autopilot.** Dancers only catch notes *after* your hit window has fully
   passed — they cover for you, they don't play for you.

**`TODO`:** confirm these four, add/remove, and rank them if they ever conflict.

---

## 3. Core Loop

```
music/metronome beat
   → note spawns in a lane, scrolls toward the hit line (2.5s travel)
      → player presses the matching key in time   → hit (perfect/good/ok) → earn "beats"
      → player misses / whiffs                     → streak breaks
      → (fallback) a dancer catches a missed note  → smaller earn, player streak still broke
   → spend beats on key upgrades / new key tiers / dancers
   → accumulate enough → Prestige for Stars → spend Stars in the Star Shop on permanent boosts
   → repeat at a higher baseline
```

Currency is called **"beats"** everywhere (code + UI).

---

## 4. Input & Notes

- **The core gameplay is the four cardinals** (`w a s d`). These are the only keys the player
  actually presses. Three input layouts auto-detect from recent presses and relabel the UI:
  **keyboard (WASD)**, **arrow keys**, or **numpad** — same internal keys under the hood.
- **Diagonals (`q e z c`) are auto-hit "bonus lanes," not played by the player.** They still scroll
  down their own (dimmed) lanes, but the game resolves them automatically at the hit line for modest
  ambient income. This was a deliberate change after testers were overwhelmed by 8 playable lanes +
  the old chord mechanic. The chord input (two cardinals → a diagonal) has been **removed**.
  - Auto-lane payout is intentionally modest: routed through the dancer path (no manual 2× bonus,
    capped combo) at a fixed ×1 combo and "ok" accuracy. The rare-key value bonus still applies, so
    diagonals remain a *flavorful* income trickle — but skill on the cardinals stays the real earner.
- **Note spawning** is weighted: each cardinal is 4× as likely as each diagonal (≈80% cardinal notes,
  ≈20% auto diagonals once unlocked). Big audio onsets (magnitude ≥ threshold) spawn a second
  simultaneous note.
- **Timing windows** (± from the hit line): perfect ≤ 88ms, good ≤ 160ms, ok ≤ 280ms,
  miss > 380ms. The *Quick Fingers* upgrade widens these by ~20%. The perfect window is
  deliberately a touch wider than a strict half-of-good so perfect doesn't feel knife-edge.
- **Whiff = miss:** a press that lands on no note (or a note outside even the "ok" window) counts as
  a miss and resets the player streak. Near-miss presses consume the note so it can't double-penalize.

---

## 5. Economy & Scaling

### Earning a hit
`earned = keyValue × comboMultiplier × accuracyMultiplier × (manual 2× if player) × bpmMult`

- **Key value** = `keyLevel × prestigeMult × achievementMult × keyBonus`.
  Rare keys (`q e z c`) have a **3× bonus** (→ **5×** with *Virtuoso*). Since these are now the
  auto-hit diagonals, that bonus shapes their *ambient income*, not a player-skill payout.
- **Accuracy multipliers:** perfect 1.0, good 0.75, ok 0.5.
- **Manual bonus:** player hits ×2; dancer hits ×1.
- **BPM earnings multiplier:** faster songs pay more (see §8).

### Combo multiplier (by streak length)
`<10 → ×1`, `<25 → ×1.5`, `<50 → ×2`, `<100 → ×3`, `<250 → ×5`, `<500 → ×8`,
`<1000 → ×12`, `≥1000 → ×20`. (*Rhythm Training* adds +25% on top.)

- **Two separate streaks** are tracked: **player skill streak** and **dancer auto streak**, shown as
  distinct counters. Dancers' multiplier is capped at **×3** until the *Dance Captain* upgrade.
- **Threshold bursts (player only):** hitting streak counts of 10/25/50/100/250/500/1000 pays a bonus
  lump (doubled by *Encore*).

### Key upgrades & tiers
- **Key upgrade cost:** `floor(10 × 1.15^(level-1))` — standard exponential. Bulk-buy (10×/100×/Max)
  supported.
- **Tier unlocks:** Tier 1 `w` (free) → Tier 2 `s` (50) → Tier 3 `a d` (250) → Tier 4 `q e z c` (2500).
- **Passive income:** every beat grants `0.1` beats passively (→ `0.5` with *Sound Engineer*),
  scaled by prestige and BPM.

**`TODO`:** Is the long-run curve tuned, or are these numbers placeholders? Intended time-to-first-
prestige? Where should the game start to feel "idle-heavy" vs "active-heavy"?

---

## 6. Dancers (Automation)

- **Purpose:** catch notes you miss — a fallback, never autopilot. A dancer only fires on a note
  *after* the player's full hit window has elapsed, and doing so still breaks the player streak.
- **Hire cost:** `floor(50 × 2^count)` (halved by *Headliner*). **Accuracy by level:** L1 ok, L2 good,
  L3 perfect. Each dancer acts on a ~400ms cooldown.
- **Offline earnings:** while away, dancers earn at **25%** of their online rate (requires ≥ 1 dancer;
  shown as a "welcome back" payout).

**`TODO`:** Should there be a hard cap on dancer count? Intended ratio of idle:active income at the
"endgame"?

---

## 7. Prestige & Star Shop

- **Prestige** resets the run (currency, keys, tiers, dancers, run stats) in exchange for **Stars**.
  - **Gain:** `floor(sqrt(totalEarned / 1000))` (needs ≥ 1000 total earned; ×2 with *Big Bang*).
  - **Permanent multiplier:** `1 + stars × 0.1`.
- **Star Shop upgrades** (cost in Stars): Warm Start (1), Muscle Memory (2), Rhythm Training (3),
  Sound Engineer (5), Quick Fingers (5), Headliner (10), Encore (15), Virtuoso (25), Big Bang (50),
  Tempo Master (8), Dance Captain (12).

**`TODO`:** Intended prestige cadence (how many runs to "complete" the shop?). Any second prestige
layer planned beyond Stars?

---

## 8. Tempo / BPM

- **Selectable BPM** with an earnings multiplier each: 60 (×0.5), 90 (×1.0), 120 (×1.5), 150 (×2.5),
  180 (×4.0), and — after *Tempo Master* — 240 (×6.0) and 300 (×10.0). Higher tempo = more notes =
  more risk/reward.
- **Live BPM detection:** when listening to audio, the game estimates the song's BPM (median of recent
  onset intervals, octave-folded into 60–200) and displays it.

**`TODO`:** Should detected BPM ever *auto-set* the earnings tier, or stay display-only? Is 300 the
intended ceiling?

---

## 9. Achievements

26 achievements across taps, total earned, combos, tiers, dancers, prestige count, stars, and shop
purchases. Each unlocked achievement grants a small permanent **+1% earnings** multiplier (stacking).

**`TODO`:** Are achievements meant to be a meaningful progression vector or just flavor/completion?

---

## 10. Audio Capture (technical constraint that shapes design)

- Primary path: **tab audio via `getDisplayMedia`** (Chromium only; user must check "Share audio").
- Fallback: **microphone**. Final fallback: **metronome** at the selected BPM.
- This is why onboarding has a 5-step audio guide and a glowing "Sync Audio" prompt — getting users
  past the share-audio step is the biggest first-run hurdle.

**`TODO`:** Is non-Chromium / mobile support a goal, or is "best on desktop Chrome" acceptable?

---

## 11. Persistence

- Single save in `localStorage` under `clicktrack-save`; autosaves every 30s and on page hide.
- Saves forward-migrate (new fields merge over defaults), so old saves survive updates.
- Players can **Export/Import** a save string and **Reset** (with confirmation) from the Stats tab.

---

## 12. Open Questions / Roadmap

A scratchpad for direction. **`TODO` (designer)** — fill these in:

- [ ] Monetization? (Pure free/portfolio piece, or anything else?)
- [ ] Audio sync calibration UI (an `audioOffsetMs` hook already exists in code, unused in UI).
- [ ] Distinct visual/sound for *whiff* vs *scroll-past miss* (currently shared "miss" feedback).
- [ ] Multiplayer / leaderboards / sharing a song's score?
- [ ] Mobile or touch support?
- [ ] More content cadence: new key layouts, song-reactive visuals, themes?

---

*Keep this doc honest: when you change a number or rule in code, reflect the intent here. It's the
"why," `CLAUDE.md` is the "how."*
