// Game state engine for Clicktrack
// Manages keys, combos, currency, upgrades, and the offline song

const KEY_TIERS = [
  { tier: 1, keys: ['w'], unlockCost: 0 },
  { tier: 2, keys: ['s'], unlockCost: 50 },
  { tier: 3, keys: ['a', 'd'], unlockCost: 250 },
  { tier: 4, keys: ['q', 'e', 'z', 'c'], unlockCost: 2500 },
  // Tier 5 is the center key. All eight compass directions are already spoken for, so the
  // fifth tier adds a non-directional "center" note bound to Space (Numpad 0/2 as well),
  // drawn as a diamond rather than a rotated arrow. Player-hit, not an auto lane.
  { tier: 5, keys: ['x'], unlockCost: 25000 },
];

const ALL_KEYS = KEY_TIERS.flatMap((t) => t.keys);

const OFFLINE_SONG_BPM = 90;

// --- Prestige Upgrades (Star Shop) ---
const PRESTIGE_UPGRADES = [
  { id: 'warm_start',     name: 'Warm Start',      cost: 1,   desc: 'Start each run with 100 beats' },
  { id: 'muscle_memory',  name: 'Muscle Memory',   cost: 2,   desc: 'Keep 10% of key levels on prestige' },
  { id: 'rhythm_training',name: 'Rhythm Training',  cost: 3,   desc: '+25% combo multiplier' },
  { id: 'sound_engineer', name: 'Sound Engineer',   cost: 5,   desc: 'Passive beats per note: 0.1 \u2192 0.5' },
  { id: 'quick_fingers',  name: 'Quick Fingers',    cost: 5,   desc: 'Hit windows widened by 20%' },
  { id: 'headliner',      name: 'Headliner',        cost: 10,  desc: 'Dancer hire cost halved' },
  { id: 'encore',         name: 'Encore',           cost: 15,  desc: 'Combo threshold bursts pay 2x' },
  { id: 'virtuoso',       name: 'Virtuoso',         cost: 25,  desc: 'Rare keys worth 5x instead of 3x' },
  { id: 'big_bang',       name: 'Big Bang',         cost: 50,  desc: '2x prestige star gain' },
  { id: 'tempo_master',   name: 'Tempo Master',     cost: 8,   desc: 'Unlock 240 and 300 BPM speeds' },
  { id: 'dance_captain',  name: 'Dance Captain',    cost: 12,  desc: 'Dancers gain the full combo multiplier (uncapped)' },
];

// Manual play earns 2x compared to dancer auto-hits (skill bonus)
const MANUAL_BONUS_MULTIPLIER = 2;

// Dancers' combo multiplier is capped to this until Dance Captain is purchased
const DANCER_COMBO_MULT_CAP = 3;

function hasPrestigeUpgrade(state, id) {
  return state.prestige.purchasedUpgrades.includes(id);
}

function buyPrestigeUpgrade(state, id) {
  const upg = PRESTIGE_UPGRADES.find(u => u.id === id);
  if (!upg) return { state, success: false };
  if (hasPrestigeUpgrade(state, id)) return { state, success: false };
  if (state.prestige.stars < upg.cost) return { state, success: false };
  state.prestige.stars -= upg.cost;
  state.prestige.purchasedUpgrades.push(id);
  state.prestige.multiplier = 1 + state.prestige.stars * 0.1;
  return { state, success: true };
}

// --- BPM / Tempo Scaling ---
const BPM_OPTIONS = [
  { bpm: 60,  label: '60 BPM',  mult: 0.5 },
  { bpm: 90,  label: '90 BPM',  mult: 1.0 },
  { bpm: 120, label: '120 BPM', mult: 1.5 },
  { bpm: 150, label: '150 BPM', mult: 2.5 },
  { bpm: 180, label: '180 BPM', mult: 4.0 },
  { bpm: 240, label: '240 BPM', mult: 6.0,  requiresUpgrade: 'tempo_master' },
  { bpm: 300, label: '300 BPM', mult: 10.0, requiresUpgrade: 'tempo_master' },
];

// --- Hyperspeed (note scroll speed) ---
// Purely a readability setting: notes cover the same track in less time, so consecutive
// beats land further apart and dense music stops bunching up at the hit line. Hit windows
// are absolute ms and are deliberately NOT scaled here, so hyperspeed never changes
// difficulty of timing or payout — only how much room the notes have to breathe.
const HYPERSPEED_OPTIONS = [
  { mult: 1, label: '1x' },
  { mult: 2, label: '2x' },
  { mult: 4, label: '4x' },
  { mult: 8, label: '8x' },
];

// Travel time for a note at the given hyperspeed. Unknown/garbage values fall back to 1x
// so a corrupt save can't yield a zero or negative travel time, which would divide by
// zero in the renderer's progress calculation and strand notes on screen.
function getScrollTimeMs(baseMs, hyperspeed) {
  const opt = HYPERSPEED_OPTIONS.find((o) => o.mult === hyperspeed);
  return baseMs / (opt ? opt.mult : 1);
}

// Combo threshold bonuses: at these streak counts, award a burst payout
const COMBO_THRESHOLDS = [10, 25, 50, 100, 250, 500, 1000];

function createDefaultKeyState() {
  const keys = {};
  for (const key of ALL_KEYS) {
    keys[key] = {
      unlocked: key === 'w',
      level: 1,
      combo: 0,
      bestCombo: 0,
    };
  }
  return keys;
}

function createDefaultState() {
  return {
    currency: 0,
    totalEarned: 0,
    keys: createDefaultKeyState(),
    tierUnlocked: 1,
    prestige: {
      count: 0,
      stars: 0,
      multiplier: 1,
      purchasedUpgrades: [],
    },
    offlineSong: {
      bpm: OFFLINE_SONG_BPM,
      hitValue: 1,
      comboBonus: 1,
    },
    stats: {
      totalTaps: 0,
      totalMisses: 0,
      bestCombo: 0,
      songsPlayed: 0,
    },
    settings: {
      tolerancePercent: 12, // +/- % of beat interval
    },
    dancers: {
      count: 0,
      level: 1,
    },
    achievements: [],
    selectedBPM: 90,
    // Note scroll speed multiplier. Top-level rather than inside `settings` on purpose:
    // loadGame merges saves with a shallow Object.assign, so a nested field would be
    // wiped out wholesale by any old save that already carries a `settings` object.
    hyperspeed: 1,
    lastSaveTime: null,
  };
}

function getKeyUpgradeCost(level) {
  return Math.floor(10 * Math.pow(1.15, level - 1));
}

// Rare (non-WASD) keys are worth 3× more per hit (5× with Virtuoso)
// The center key pays above the tier-4 diagonals because the player actually has to hit
// it, where the diagonals resolve themselves. 4 rather than 5 so virtuoso still upgrades it.
const KEY_VALUE_BONUS = { q: 3, e: 3, z: 3, c: 3, x: 4 };

function getKeyValue(state, key) {
  const keyState = state.keys[key];
  if (!keyState || !keyState.unlocked) return 0;
  let bonus = KEY_VALUE_BONUS[key] || 1;
  if (bonus > 1 && hasPrestigeUpgrade(state, 'virtuoso')) bonus = 5;
  return keyState.level * state.prestige.multiplier * getAchievementMultiplier(state) * bonus;
}

function getComboMultiplier(combo, state) {
  let base;
  if (combo < 10) base = 1;
  else if (combo < 25) base = 1.5;
  else if (combo < 50) base = 2;
  else if (combo < 100) base = 3;
  else if (combo < 250) base = 5;
  else if (combo < 500) base = 8;
  else if (combo < 1000) base = 12;
  else base = 20;
  if (state && hasPrestigeUpgrade(state, 'rhythm_training')) base *= 1.25;
  return base;
}

function getTierUnlockCost(tier) {
  const tierDef = KEY_TIERS.find((t) => t.tier === tier);
  return tierDef ? tierDef.unlockCost : Infinity;
}

const ACCURACY_MULTIPLIERS = { perfect: 1.0, good: 0.75, ok: 0.5 };

// Process a successful tap on a key with accuracy tier.
// opts.source: 'player' | 'dancer'  (default 'player')
// opts.externalCombo: combo count to use for the multiplier (overrides per-key combo)
function processTap(state, key, accuracy = 'perfect', opts = {}) {
  const keyState = state.keys[key];
  if (!keyState || !keyState.unlocked) return { state, earned: 0 };

  const source = opts.source || 'player';
  // Only player hits drive the per-key combo counter (bursts & bestCombo are player-only rewards)
  if (source === 'player') keyState.combo++;
  state.stats.totalTaps++;

  const baseValue = getKeyValue(state, key);
  const comboForMult = (opts.externalCombo != null) ? opts.externalCombo : keyState.combo;
  let comboMult = getComboMultiplier(comboForMult, state);
  // Cap dancers' combo multiplier unless Dance Captain is owned
  if (source === 'dancer' && !hasPrestigeUpgrade(state, 'dance_captain')) {
    comboMult = Math.min(comboMult, DANCER_COMBO_MULT_CAP);
  }
  const accuracyMult = ACCURACY_MULTIPLIERS[accuracy] || 1;
  let earned = baseValue * comboMult * accuracyMult;
  // Manual play skill bonus
  if (source === 'player') earned *= MANUAL_BONUS_MULTIPLIER;

  // Threshold bursts are a reward for player skill only
  if (source === 'player' && COMBO_THRESHOLDS.includes(keyState.combo)) {
    let burst = baseValue * keyState.combo * state.offlineSong.comboBonus * MANUAL_BONUS_MULTIPLIER;
    if (hasPrestigeUpgrade(state, 'encore')) burst *= 2;
    earned += burst;
  }

  if (source === 'player') {
    if (keyState.combo > keyState.bestCombo) {
      keyState.bestCombo = keyState.combo;
    }
    if (keyState.combo > state.stats.bestCombo) {
      state.stats.bestCombo = keyState.combo;
    }
  }

  state.currency += earned;
  state.totalEarned += earned;

  return { state, earned };
}

// Process a miss on a key - combo resets
function processMiss(state, key) {
  const keyState = state.keys[key];
  if (!keyState || !keyState.unlocked) return state;

  keyState.combo = 0;
  state.stats.totalMisses++;

  return state;
}

// Upgrade a key's value level
function upgradeKey(state, key) {
  const keyState = state.keys[key];
  if (!keyState || !keyState.unlocked) return { state, success: false };

  const cost = getKeyUpgradeCost(keyState.level);
  if (state.currency < cost) return { state, success: false };

  state.currency -= cost;
  keyState.level++;

  return { state, success: true };
}

// Calculate total cost to upgrade a key N times from its current level
function getBulkUpgradeCost(level, count) {
  let total = 0;
  for (let i = 0; i < count; i++) {
    total += getKeyUpgradeCost(level + i);
  }
  return total;
}

// How many times can we afford to upgrade a key from its current level?
function getMaxAffordableUpgrades(state, key) {
  const keyState = state.keys[key];
  if (!keyState || !keyState.unlocked) return 0;
  let budget = state.currency;
  let lvl = keyState.level;
  let count = 0;
  while (true) {
    const cost = getKeyUpgradeCost(lvl);
    if (budget < cost) break;
    budget -= cost;
    lvl++;
    count++;
  }
  return count;
}

// Upgrade a key multiple times (for 10x/100x/Max)
function upgradeKeyBulk(state, key, count) {
  const keyState = state.keys[key];
  if (!keyState || !keyState.unlocked) return { state, success: false, bought: 0 };

  let bought = 0;
  for (let i = 0; i < count; i++) {
    const cost = getKeyUpgradeCost(keyState.level);
    if (state.currency < cost) break;
    state.currency -= cost;
    keyState.level++;
    bought++;
  }

  return { state, success: bought > 0, bought };
}

// Unlock the next tier of keys
function unlockTier(state) {
  const nextTier = state.tierUnlocked + 1;
  const tierDef = KEY_TIERS.find((t) => t.tier === nextTier);
  if (!tierDef) return { state, success: false };

  const cost = tierDef.unlockCost;
  if (state.currency < cost) return { state, success: false };

  state.currency -= cost;
  state.tierUnlocked = nextTier;
  for (const key of tierDef.keys) {
    state.keys[key].unlocked = true;
  }

  return { state, success: true };
}

// --- Auto-Dancers ---
function getDancerHireCost(count, state) {
  let cost = Math.floor(50 * Math.pow(2, count));
  if (state && hasPrestigeUpgrade(state, 'headliner')) cost = Math.floor(cost * 0.5);
  return cost;
}

function getDancerUpgradeCost(level) {
  if (level === 1) return 500;
  if (level === 2) return 5000;
  return Infinity;
}

function getDancerAccuracy(level) {
  if (level >= 3) return 'perfect';
  if (level >= 2) return 'good';
  return 'ok';
}

function hireDancer(state) {
  const cost = getDancerHireCost(state.dancers.count, state);
  if (state.currency < cost) return { state, success: false };
  state.currency -= cost;
  state.dancers.count++;
  return { state, success: true };
}

function upgradeDancers(state) {
  if (state.dancers.level >= 3) return { state, success: false };
  const cost = getDancerUpgradeCost(state.dancers.level);
  if (state.currency < cost) return { state, success: false };
  state.currency -= cost;
  state.dancers.level++;
  return { state, success: true };
}

// --- Prestige ---
function getPrestigeGain(totalEarned, state) {
  if (totalEarned < 1000) return 0;
  let gain = Math.floor(Math.sqrt(totalEarned / 1000));
  if (state && hasPrestigeUpgrade(state, 'big_bang')) gain *= 2;
  return gain;
}

function performPrestige(state) {
  const gain = getPrestigeGain(state.totalEarned, state);
  if (gain <= 0) return { state, success: false };

  state.prestige.count++;
  state.prestige.stars += gain;
  state.prestige.multiplier = 1 + state.prestige.stars * 0.1;

  // Muscle Memory: keep 10% of key levels
  const keepLevels = hasPrestigeUpgrade(state, 'muscle_memory');

  // Reset run-specific progress
  const oldKeys = state.keys;
  state.currency = 0;
  state.totalEarned = 0;
  state.tierUnlocked = 1;
  state.keys = createDefaultKeyState();
  state.dancers = { count: 0, level: 1 };
  state.stats = { totalTaps: 0, totalMisses: 0, bestCombo: 0, songsPlayed: 0 };

  // Warm Start: begin with 100 beats
  if (hasPrestigeUpgrade(state, 'warm_start')) {
    state.currency = 100;
    state.totalEarned = 100;
  }

  // Muscle Memory: restore 10% of old key levels (min 1)
  if (keepLevels) {
    for (const key of Object.keys(oldKeys)) {
      if (state.keys[key]) {
        state.keys[key].level = Math.max(1, Math.floor(oldKeys[key].level * 0.1));
      }
    }
  }

  return { state, success: true };
}

// --- Achievements ---
const ACHIEVEMENTS = [
  // Taps
  { id: 'first_beat',    name: 'First Beat',       desc: 'Hit your first note',         check: s => s.stats.totalTaps >= 1 },
  { id: 'hundred_hits',  name: 'Centurion',         desc: 'Hit 100 notes',               check: s => s.stats.totalTaps >= 100 },
  { id: 'thousand_hits', name: 'Dedicated',         desc: 'Hit 1,000 notes',             check: s => s.stats.totalTaps >= 1000 },
  { id: 'ten_k_hits',    name: 'Rhythm Machine',    desc: 'Hit 10,000 notes',            check: s => s.stats.totalTaps >= 10000 },
  // Currency
  { id: 'earn_1k',       name: 'Getting Started',   desc: 'Earn 1,000 total beats',      check: s => s.totalEarned >= 1000 },
  { id: 'earn_100k',     name: 'Big Earner',        desc: 'Earn 100K total beats',       check: s => s.totalEarned >= 100000 },
  { id: 'earn_1m',       name: 'Millionaire',       desc: 'Earn 1M total beats',         check: s => s.totalEarned >= 1000000 },
  { id: 'earn_1b',       name: 'Billionaire',       desc: 'Earn 1B total beats',         check: s => s.totalEarned >= 1000000000 },
  // Combo
  { id: 'combo_10',      name: 'On a Roll',         desc: 'Reach a 10 combo',            check: s => s.stats.bestCombo >= 10 },
  { id: 'combo_50',      name: 'Streak Master',     desc: 'Reach a 50 combo',            check: s => s.stats.bestCombo >= 50 },
  { id: 'combo_100',     name: 'Combo King',        desc: 'Reach a 100 combo',           check: s => s.stats.bestCombo >= 100 },
  { id: 'combo_500',     name: 'Untouchable',       desc: 'Reach a 500 combo',           check: s => s.stats.bestCombo >= 500 },
  { id: 'combo_1000',    name: 'Legendary',         desc: 'Reach a 1,000 combo',         check: s => s.stats.bestCombo >= 1000 },
  // Keys / Tiers
  { id: 'tier_2',        name: 'New Keys',          desc: 'Unlock tier 2',               check: s => s.tierUnlocked >= 2 },
  { id: 'tier_3',        name: 'Expanding',         desc: 'Unlock tier 3',               check: s => s.tierUnlocked >= 3 },
  { id: 'tier_5',        name: 'Full Band',         desc: 'Unlock all 5 tiers',          check: s => s.tierUnlocked >= 5 },
  // Dancers
  { id: 'dancer_1',      name: 'Backup Dancer',     desc: 'Hire your first dancer',      check: s => (s.dancers?.count ?? 0) >= 1 },
  { id: 'dancer_5',      name: 'Dance Crew',        desc: 'Hire 5 dancers',              check: s => (s.dancers?.count ?? 0) >= 5 },
  { id: 'dancer_10',     name: 'Flash Mob',         desc: 'Hire 10 dancers',             check: s => (s.dancers?.count ?? 0) >= 10 },
  // Prestige
  { id: 'prestige_1',    name: 'Fresh Start',       desc: 'Prestige for the first time', check: s => s.prestige.count >= 1 },
  { id: 'prestige_5',    name: 'Star Collector',    desc: 'Prestige 5 times',            check: s => s.prestige.count >= 5 },
  { id: 'prestige_10',   name: 'Veteran',           desc: 'Prestige 10 times',           check: s => s.prestige.count >= 10 },
  { id: 'stars_10',      name: 'Starry Night',      desc: 'Accumulate 10 stars',         check: s => (s.prestige.stars ?? 0) >= 10 },
  { id: 'stars_50',      name: 'Constellation',     desc: 'Accumulate 50 stars',         check: s => (s.prestige.stars ?? 0) >= 50 },
  // Star Shop
  { id: 'first_upgrade',  name: 'Shopper',           desc: 'Buy your first star upgrade',  check: s => (s.prestige.purchasedUpgrades?.length ?? 0) >= 1 },
  { id: 'five_upgrades',  name: 'Collector',         desc: 'Buy 5 star upgrades',          check: s => (s.prestige.purchasedUpgrades?.length ?? 0) >= 5 },
];

function checkAchievements(state) {
  if (!state.achievements) state.achievements = [];
  const newlyUnlocked = [];
  for (const ach of ACHIEVEMENTS) {
    if (state.achievements.includes(ach.id)) continue;
    if (ach.check(state)) {
      state.achievements.push(ach.id);
      newlyUnlocked.push(ach);
    }
  }
  return newlyUnlocked;
}

function getAchievementMultiplier(state) {
  const count = state.achievements ? state.achievements.length : 0;
  return 1 + count * 0.01; // +1% per achievement
}

// --- Offline Progress ---
function calculateOfflineEarnings(state, elapsedMs) {
  if (!state.dancers || state.dancers.count <= 0) return 0;
  const dancerCount = state.dancers.count;
  const accuracy = getDancerAccuracy(state.dancers.level);
  const accMult = ACCURACY_MULTIPLIERS[accuracy] || 0.5;
  // Average key value across unlocked keys
  const unlockedKeys = Object.entries(state.keys).filter(([, v]) => v.unlocked);
  if (unlockedKeys.length === 0) return 0;
  const avgKeyValue = unlockedKeys.reduce((sum, [k]) => sum + getKeyValue(state, k), 0) / unlockedKeys.length;
  // Dancers hit roughly every 0.4s (400ms cooldown) while online
  const hitsPerSecond = dancerCount / 0.4;
  const earningsPerSecond = hitsPerSecond * avgKeyValue * accMult;
  const offlineEfficiency = 0.25; // 25% of online rate
  const elapsedSeconds = elapsedMs / 1000;
  return Math.floor(earningsPerSecond * elapsedSeconds * offlineEfficiency);
}

// Calculate beat interval in ms from BPM
function beatIntervalMs(bpm) {
  return 60000 / bpm;
}

// Check if a tap timestamp is within tolerance of the beat grid
function isTapOnBeat(tapTime, beatOrigin, bpm, tolerancePercent) {
  const interval = beatIntervalMs(bpm);
  const tolerance = interval * (tolerancePercent / 100);
  const offset = (tapTime - beatOrigin) % interval;
  // Check if within tolerance of either side of a beat
  return offset <= tolerance || offset >= interval - tolerance;
}

if (typeof module !== 'undefined') {
  module.exports = {
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
    getTierUnlockCost,
    beatIntervalMs,
    isTapOnBeat,
    getDancerHireCost,
    getDancerUpgradeCost,
    getDancerAccuracy,
    hireDancer,
    upgradeDancers,
    getPrestigeGain,
    performPrestige,
    PRESTIGE_UPGRADES,
    hasPrestigeUpgrade,
    buyPrestigeUpgrade,
    BPM_OPTIONS,
    HYPERSPEED_OPTIONS,
    getScrollTimeMs,
    ACHIEVEMENTS,
    checkAchievements,
    getAchievementMultiplier,
    calculateOfflineEarnings,
    KEY_TIERS,
    ALL_KEYS,
    COMBO_THRESHOLDS,
    ACCURACY_MULTIPLIERS,
    MANUAL_BONUS_MULTIPLIER,
    DANCER_COMBO_MULT_CAP,
  };
} else if (typeof window !== 'undefined') {
  Object.assign(window, {
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
    getTierUnlockCost,
    beatIntervalMs,
    isTapOnBeat,
    getDancerHireCost,
    getDancerUpgradeCost,
    getDancerAccuracy,
    hireDancer,
    upgradeDancers,
    getPrestigeGain,
    performPrestige,
    PRESTIGE_UPGRADES,
    hasPrestigeUpgrade,
    buyPrestigeUpgrade,
    BPM_OPTIONS,
    HYPERSPEED_OPTIONS,
    getScrollTimeMs,
    ACHIEVEMENTS,
    checkAchievements,
    getAchievementMultiplier,
    calculateOfflineEarnings,
    KEY_TIERS,
    ALL_KEYS,
    COMBO_THRESHOLDS,
    ACCURACY_MULTIPLIERS,
    MANUAL_BONUS_MULTIPLIER,
    DANCER_COMBO_MULT_CAP,
  });
}
