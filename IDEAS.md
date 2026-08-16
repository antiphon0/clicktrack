# Ideas

Captured design ideas that are **not built yet**. Nothing here is committed to
gameplay; it is a backlog, not a spec.

---

## Improve — a star-power equivalent

Guitar Hero's star power, adapted to Clicktrack.

**Filling the meter.** Hitting certain combo counts within a rolling one-minute
window fills a bar. The window matters: it should reward a concentrated hot
streak rather than slow accumulation over a whole session.

**Activation.** Hold **Shift** to activate. The key must be rebindable.

**The bar.** A visible meter in the play column showing fill progress, and
showing drain while active.

**What it does — "freestyle".** While held, the player freestyles over the song.
The explicit design constraint: **it must not become a pure button mash.** Two
sketched directions, not yet chosen:

1. **Continue the pattern** — the game keeps presenting notes and the player
   sustains what it is already showing.
2. **Add on top** — the player layers extra notes of their own alongside the
   suggested ones.

**Visuals.** On activation the grid lights up with sparkles and a "moonlight"
wash.

### Open questions

- How does scoring work while active? A flat multiplier like Guitar Hero's 2x,
  or something that actually rewards freestyle quality?
- If freestyle means "add your own notes", what makes an added note *good*?
  Landing on the beat grid (`isTapOnBeat` already exists in `game.js`) is the
  obvious candidate.
- Does the meter drain on a timer, or per note played?
- What happens on a miss while active — early cancel, or just no penalty?
- Does it interact with dancers, or is it player-only like the manual bonus?
- Chords and the tier-5 center key during freestyle: included or excluded?

### Implementation notes

- Meter fill/drain and any payout math belong in `game.js` as pure functions,
  with tests, per the convention in CLAUDE.md. The renderer should own only the
  key handling and the visuals.
- A rebindable key means a new persisted setting. Note that `loadGame` merges
  saves with a shallow `Object.assign`, so it needs to be a **top-level** field
  (or the merge needs deepening first) or old saves will wipe it.
- Sparkle/moonlight effects are additive visual noise on the note track. Worth
  checking against the recent decision to strip the drop-shadow glow from notes
  for readability — whatever this looks like, it must not make notes harder to
  track while it is active.
