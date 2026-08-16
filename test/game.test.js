// Tests for the pure game logic in web/game.js (no DOM, no timers).
// Run with: npm test  (node --test)
const test = require('node:test');
const assert = require('node:assert/strict');

const game = require('../web/game.js');
const {
  createDefaultState,
  processTap,
  processMiss,
  upgradeKey,
  upgradeKeyBulk,
  getBulkUpgradeCost,
  getMaxAffordableUpgrades,
  unlockTier,
  getKeyUpgradeCost,
  getKeyValue,
  getComboMultiplier,
  hireDancer,
  upgradeDancers,
  getDancerHireCost,
  getPrestigeGain,
  performPrestige,
  buyPrestigeUpgrade,
  hasPrestigeUpgrade,
  checkAchievements,
  getAchievementMultiplier,
  calculateOfflineEarnings,
  migrateSave,
  ACHIEVEMENTS,
  KEY_TIERS,
  ALL_KEYS,
  COMBO_THRESHOLDS,
  ACCURACY_MULTIPLIERS,
  MANUAL_BONUS_MULTIPLIER,
  DANCER_COMBO_MULT_CAP,
  createChordMeter,
  shouldSpawnChord,
  magnitudeQuantile,
  CHORD_MAGNITUDE_FLOOR,
  CHORD_MIN_SAMPLES,
  CHORD_MIN_GAP_MS,
  CHORD_BUCKET_MAX,
  CHORD_BUCKET_REFILL_MS,
} = game;

function freshState() {
  return createDefaultState();
}

// Give the state stars and buy a prestige upgrade directly (test helper)
function grantUpgrade(state, id) {
  state.prestige.purchasedUpgrades.push(id);
}

// --- processTap ---

test('player tap earns keyValue × combo × accuracy × manual bonus', () => {
  const s = freshState();
  const { earned } = processTap(s, 'w', 'perfect', { source: 'player' });
  // level 1, combo 1 (<10 → ×1), perfect ×1, manual ×2
  assert.equal(earned, 1 * 1 * 1 * MANUAL_BONUS_MULTIPLIER);
  assert.equal(s.currency, earned);
  assert.equal(s.totalEarned, earned);
  assert.equal(s.stats.totalTaps, 1);
});

test('accuracy multipliers scale the payout', () => {
  for (const acc of ['perfect', 'good', 'ok']) {
    const s = freshState();
    const { earned } = processTap(s, 'w', acc, { source: 'player' });
    assert.equal(earned, ACCURACY_MULTIPLIERS[acc] * MANUAL_BONUS_MULTIPLIER);
  }
});

test('dancer taps get no manual bonus and no per-key combo growth', () => {
  const s = freshState();
  const { earned } = processTap(s, 'w', 'ok', { source: 'dancer' });
  assert.equal(earned, ACCURACY_MULTIPLIERS.ok); // 0.5, no ×2
  assert.equal(s.keys.w.combo, 0);
});

test('dancer combo multiplier is capped until dance_captain', () => {
  const s = freshState();
  const { earned: capped } = processTap(s, 'w', 'perfect', { source: 'dancer', externalCombo: 100 });
  assert.equal(capped, DANCER_COMBO_MULT_CAP); // 100-combo would be ×5, capped to ×3

  const s2 = freshState();
  grantUpgrade(s2, 'dance_captain');
  const { earned: uncapped } = processTap(s2, 'w', 'perfect', { source: 'dancer', externalCombo: 300 });
  assert.equal(uncapped, getComboMultiplier(300, s2)); // ×8, above the cap

  const s3 = freshState();
  const { earned: capped2 } = processTap(s3, 'w', 'perfect', { source: 'dancer', externalCombo: 300 });
  assert.equal(capped2, DANCER_COMBO_MULT_CAP);
});

// PARKED: needs the externalCombo-driven burst logic from wip/beat-grid-changes.
// Un-skip when that lands in processTap.
test('threshold bursts fire on the external (visible) streak, not the per-key combo', { skip: 'needs externalCombo burst logic (wip/beat-grid-changes)' }, () => {
  const s = freshState();
  const streak = COMBO_THRESHOLDS[0]; // 10
  const { earned } = processTap(s, 'w', 'perfect', { source: 'player', externalCombo: streak });
  const hit = 1 * getComboMultiplier(streak, s) * 1 * MANUAL_BONUS_MULTIPLIER;
  const burst = 1 * streak * MANUAL_BONUS_MULTIPLIER;
  assert.equal(earned, hit + burst);
  // Per-key combo is only 1, so no burst would have fired under the old per-key rule
  assert.equal(s.keys.w.combo, 1);
});

// PARKED: depends on the same externalCombo burst path as the test above.
test('encore doubles threshold bursts', { skip: 'needs externalCombo burst logic (wip/beat-grid-changes)' }, () => {
  const s = freshState();
  grantUpgrade(s, 'encore');
  const { earned } = processTap(s, 'w', 'perfect', { source: 'player', externalCombo: 10 });
  const hit = 1 * getComboMultiplier(10, s) * MANUAL_BONUS_MULTIPLIER;
  const burst = 1 * 10 * MANUAL_BONUS_MULTIPLIER * 2;
  assert.equal(earned, hit + burst);
});

// PARKED: opts.premiumMult does not exist in this branch's processTap (jump notes).
test('premiumMult multiplies the hit but NOT the burst', { skip: 'needs opts.premiumMult / jump notes (wip/beat-grid-changes)' }, () => {
  const s = freshState();
  const { earned } = processTap(s, 'w', 'perfect', {
    source: 'player', externalCombo: 10, premiumMult: 2,
  });
  const hit = 1 * getComboMultiplier(10, s) * 1 * 2 /* premium */ * MANUAL_BONUS_MULTIPLIER;
  const burst = 1 * 10 * MANUAL_BONUS_MULTIPLIER; // burst excluded from premium
  assert.equal(earned, hit + burst);
});

// PARKED: opts.earningsMult (BPM tempo scaling inside processTap) is not in this branch.
test('earningsMult multiplies everything (hit + burst)', { skip: 'needs opts.earningsMult (wip/beat-grid-changes)' }, () => {
  const base = freshState();
  const { earned: plain } = processTap(base, 'w', 'perfect', { source: 'player', externalCombo: 10 });
  const s = freshState();
  const { earned } = processTap(s, 'w', 'perfect', {
    source: 'player', externalCombo: 10, earningsMult: 1.5,
  });
  assert.equal(earned, plain * 1.5);
  assert.equal(s.currency, earned);
});

// PARKED: this branch's processTap does not route externalCombo into stats.bestCombo.
test('bestCombo tracks the external streak the player sees', { skip: 'needs externalCombo -> bestCombo wiring (wip/beat-grid-changes)' }, () => {
  const s = freshState();
  processTap(s, 'w', 'perfect', { source: 'player', externalCombo: 42 });
  assert.equal(s.stats.bestCombo, 42);
  // Dancer streaks never touch player bestCombo
  processTap(s, 'w', 'perfect', { source: 'dancer', externalCombo: 999 });
  assert.equal(s.stats.bestCombo, 42);
});

test('tap on a locked key earns nothing', () => {
  const s = freshState();
  const { earned } = processTap(s, 's', 'perfect', { source: 'player' });
  assert.equal(earned, 0);
  assert.equal(s.currency, 0);
});

test('processMiss resets that key combo and counts a miss', () => {
  const s = freshState();
  processTap(s, 'w', 'perfect', { source: 'player' });
  assert.equal(s.keys.w.combo, 1);
  processMiss(s, 'w');
  assert.equal(s.keys.w.combo, 0);
  assert.equal(s.stats.totalMisses, 1);
});

// --- Upgrades & tiers ---

test('upgradeKey spends currency and raises level', () => {
  const s = freshState();
  s.currency = 100;
  const cost = getKeyUpgradeCost(1);
  const { success } = upgradeKey(s, 'w');
  assert.ok(success);
  assert.equal(s.keys.w.level, 2);
  assert.equal(s.currency, 100 - cost);
});

test('bulk upgrade helpers agree with each other', () => {
  const s = freshState();
  s.currency = 1000;
  const max = getMaxAffordableUpgrades(s, 'w');
  assert.ok(max > 0);
  assert.ok(getBulkUpgradeCost(1, max) <= 1000);
  assert.ok(getBulkUpgradeCost(1, max + 1) > 1000);
  const { bought } = upgradeKeyBulk(s, 'w', max);
  assert.equal(bought, max);
  assert.equal(s.keys.w.level, 1 + max);
});

test('unlockTier unlocks the tier keys and charges the cost', () => {
  const s = freshState();
  s.currency = 50;
  const { success } = unlockTier(s);
  assert.ok(success);
  assert.equal(s.tierUnlocked, 2);
  assert.ok(s.keys.s.unlocked);
  assert.equal(s.currency, 0);
  // Can't unlock the next tier without funds
  assert.equal(unlockTier(s).success, false);
});

test('getKeyValue applies rare-key bonus and virtuoso', () => {
  const s = freshState();
  s.keys.q.unlocked = true;
  assert.equal(getKeyValue(s, 'q'), 3);
  grantUpgrade(s, 'virtuoso');
  assert.equal(getKeyValue(s, 'q'), 5);
});

// --- Dancers ---

test('hireDancer doubles in cost each time', () => {
  const s = freshState();
  s.currency = 50 + 100;
  assert.ok(hireDancer(s).success);
  assert.equal(getDancerHireCost(s.dancers.count, s), 100);
  assert.ok(hireDancer(s).success);
  assert.equal(s.dancers.count, 2);
  assert.equal(hireDancer(s).success, false);
});

test('upgradeDancers caps at level 3', () => {
  const s = freshState();
  s.currency = 1e9;
  assert.ok(upgradeDancers(s).success);
  assert.ok(upgradeDancers(s).success);
  assert.equal(s.dancers.level, 3);
  assert.equal(upgradeDancers(s).success, false);
});

// --- Prestige ---

test('prestige gain is floor(sqrt(totalEarned/1000)), doubled by big_bang', () => {
  assert.equal(getPrestigeGain(999), 0);
  assert.equal(getPrestigeGain(1000), 1);
  assert.equal(getPrestigeGain(9000), 3);
  const s = freshState();
  grantUpgrade(s, 'big_bang');
  assert.equal(getPrestigeGain(9000, s), 6);
});

test('performPrestige resets the run and awards stars', () => {
  const s = freshState();
  s.totalEarned = 9000;
  s.currency = 5000;
  s.tierUnlocked = 3;
  s.keys.w.level = 50;
  s.dancers.count = 4;
  const { success } = performPrestige(s);
  assert.ok(success);
  assert.equal(s.prestige.stars, 3);
  assert.equal(s.prestige.count, 1);
  assert.equal(s.prestige.multiplier, 1.3);
  assert.equal(s.currency, 0);
  assert.equal(s.tierUnlocked, 1);
  assert.equal(s.keys.w.level, 1);
  assert.equal(s.dancers.count, 0);
});

test('warm_start and muscle_memory shape the post-prestige state', () => {
  const s = freshState();
  s.totalEarned = 1000;
  s.keys.w.level = 40;
  grantUpgrade(s, 'warm_start');
  grantUpgrade(s, 'muscle_memory');
  performPrestige(s);
  assert.equal(s.currency, 100);
  assert.equal(s.keys.w.level, 4); // 10% of 40
});

test('buyPrestigeUpgrade spends stars and rejects rebuys', () => {
  const s = freshState();
  s.prestige.stars = 3;
  assert.ok(buyPrestigeUpgrade(s, 'warm_start').success);
  assert.ok(hasPrestigeUpgrade(s, 'warm_start'));
  assert.equal(s.prestige.stars, 2);
  assert.equal(buyPrestigeUpgrade(s, 'warm_start').success, false);
  assert.equal(buyPrestigeUpgrade(s, 'big_bang').success, false); // can't afford
});

// --- Achievements ---

test('every achievement is satisfiable by a reachable state', () => {
  // Build a maxed-but-legal state; if any achievement's check can never pass
  // (e.g. a threshold above what the game can produce), this catches it.
  const s = freshState();
  s.stats.totalTaps = 1e6;
  s.stats.bestCombo = 1000;
  s.totalEarned = 1e12;
  s.tierUnlocked = KEY_TIERS.length; // max reachable tier
  s.dancers.count = 50;
  s.prestige.count = 100;
  s.prestige.stars = 1000;
  s.prestige.purchasedUpgrades = ['warm_start', 'muscle_memory', 'rhythm_training', 'sound_engineer', 'quick_fingers'];
  for (const ach of ACHIEVEMENTS) {
    assert.ok(ach.check(s), `achievement "${ach.id}" can never unlock`);
  }
});

test('checkAchievements unlocks once and multiplier grows', () => {
  const s = freshState();
  s.stats.totalTaps = 1;
  const first = checkAchievements(s);
  assert.ok(first.some((a) => a.id === 'first_beat'));
  assert.equal(checkAchievements(s).length, 0); // no double unlock
  assert.equal(getAchievementMultiplier(s), 1 + s.achievements.length * 0.01);
});

// --- Offline earnings ---

test('offline earnings require dancers and scale with time', () => {
  const s = freshState();
  assert.equal(calculateOfflineEarnings(s, 3600e3), 0);
  s.dancers.count = 2;
  const oneHour = calculateOfflineEarnings(s, 3600e3);
  assert.ok(oneHour > 0);
  const twoHours = calculateOfflineEarnings(s, 7200e3);
  assert.equal(twoHours, oneHour * 2);
});

// --- Save migration ---

// PARKED: migrateSave does not exist here; loadGame still does a shallow Object.assign
// merge in renderer.js. Un-skip once the migration path is ported over.
test('migrateSave back-fills fields missing from old saves', { skip: 'migrateSave not implemented on this branch (wip/beat-grid-changes)' }, () => {
  // Simulates a save written before dancers/achievements/settings existed
  const oldSave = {
    currency: 500,
    totalEarned: 1234,
    keys: { w: { unlocked: true, level: 7, combo: 0, bestCombo: 12 } },
    tierUnlocked: 1,
    prestige: { count: 1, stars: 2 }, // missing multiplier & purchasedUpgrades
    stats: { totalTaps: 10 },         // missing totalMisses/bestCombo
  };
  const s = migrateSave(oldSave);
  assert.equal(s.currency, 500);
  assert.equal(s.keys.w.level, 7);
  assert.deepEqual(s.prestige.purchasedUpgrades, []);
  assert.equal(s.stats.totalMisses, 0);
  assert.equal(s.dancers.count, 0);
  assert.deepEqual(s.achievements, []);
  assert.equal(s.selectedBPM, 90);
  assert.equal(s.settings.audioOffsetMs, 0);
  // Keys added after the save was made get valid defaults
  for (const key of ALL_KEYS) {
    assert.ok(s.keys[key], `key "${key}" missing after migration`);
    assert.equal(typeof s.keys[key].unlocked, 'boolean');
  }
});

// PARKED: see above, migrateSave is not implemented on this branch.
test('migrateSave tolerates garbage input', { skip: 'migrateSave not implemented on this branch (wip/beat-grid-changes)' }, () => {
  for (const garbage of [null, undefined, 42, 'hi', { keys: 'nope' }]) {
    const s = migrateSave(garbage);
    assert.ok(s.keys.w);
    assert.equal(typeof s.currency, 'number');
  }
});

// --- Chord gating (simultaneous notes) ---

// A passage of uniformly middling onsets, long enough to satisfy CHORD_MIN_SAMPLES.
function quietPassage(n = 20, v = 1.0) {
  return new Array(n).fill(v);
}

test('a weak onset never chords, however long the drought', () => {
  const m = createChordMeter(0);
  const passage = quietPassage();
  assert.equal(shouldSpawnChord(m, CHORD_MAGNITUDE_FLOOR - 0.01, passage, 600000), false);
});

test('no chord until there is enough history to judge "standout"', () => {
  const m = createChordMeter(0);
  const tooFew = new Array(CHORD_MIN_SAMPLES - 1).fill(1.0);
  assert.equal(shouldSpawnChord(m, 5.0, tooFew, 10000), false);
  // Same huge onset succeeds once the window has filled out
  const enough = new Array(CHORD_MIN_SAMPLES).fill(1.0);
  assert.equal(shouldSpawnChord(m, 5.0, enough, 10000), true);
});

test('a strong-but-typical onset in a loud passage does NOT chord', () => {
  const m = createChordMeter(0);
  // Everything recent is loud, so 2.0 is unremarkable here even though it clears the floor
  const loud = quietPassage(20, 2.0);
  assert.ok(2.0 >= CHORD_MAGNITUDE_FLOOR, 'precondition: clears the absolute floor');
  assert.equal(shouldSpawnChord(m, 2.0, loud, 10000), false);
  // A genuine spike above the passage does chord
  assert.equal(shouldSpawnChord(m, 4.0, loud, 10000), true);
});

test('chords cannot fire back to back inside the minimum gap', () => {
  const m = createChordMeter(0);
  const passage = quietPassage();
  const t = 10000;
  assert.equal(shouldSpawnChord(m, 5.0, passage, t), true);
  // Still has a token, but the hard gap blocks it
  assert.ok(m.tokens >= 1, 'precondition: a token remains');
  assert.equal(shouldSpawnChord(m, 5.0, passage, t + CHORD_MIN_GAP_MS - 1), false);
  assert.equal(shouldSpawnChord(m, 5.0, passage, t + CHORD_MIN_GAP_MS), true);
});

test('the bucket bounds chord frequency even under sustained loud music', () => {
  const m = createChordMeter(0);
  const passage = quietPassage();
  let fired = 0;
  // Hammer it with huge onsets every 250ms for a solid minute
  for (let t = 10000; t < 70000; t += 250) {
    if (shouldSpawnChord(m, 8.0, passage, t)) fired++;
  }
  // Burst capacity plus refills over ~60s, NOT one per onset (240 onsets)
  const ceiling = CHORD_BUCKET_MAX + Math.ceil(60000 / CHORD_BUCKET_REFILL_MS);
  assert.ok(fired <= ceiling, `fired ${fired}, expected <= ${ceiling}`);
  assert.ok(fired > 0, 'should still fire sometimes on a genuine climax');
});

test('a full bucket does not bank credit across a long quiet stretch', () => {
  const m = createChordMeter(0);
  const passage = quietPassage();
  // Ten minutes of silence, then a climax. Measured over a window shorter than one refill
  // period so nothing is granted mid-test: the idle time must not have banked extra
  // tokens, so this is capped at burst capacity no matter how long the drought was.
  const start = 600000;
  let fired = 0;
  for (let t = start; t < start + CHORD_BUCKET_REFILL_MS; t += CHORD_MIN_GAP_MS) {
    if (shouldSpawnChord(m, 8.0, passage, t)) fired++;
  }
  assert.equal(fired, CHORD_BUCKET_MAX, `fired ${fired}, expected exactly ${CHORD_BUCKET_MAX}`);
});

test('magnitudeQuantile handles empty and single-element input', () => {
  assert.equal(magnitudeQuantile([], 0.9), null);
  assert.equal(magnitudeQuantile(null, 0.9), null);
  assert.equal(magnitudeQuantile([3], 0.9), 3);
  assert.equal(magnitudeQuantile([1, 2, 3, 4, 5], 1.0), 5);
});
