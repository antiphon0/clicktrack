// Game state engine for Clicktrack
// Manages keys, combos, currency, upgrades, and the offline song

const KEY_TIERS = [
  { tier: 1, keys: ['w'], unlockCost: 0 },
  { tier: 2, keys: ['s'], unlockCost: 50 },
  { tier: 3, keys: ['a', 'd'], unlockCost: 250 },
  { tier: 4, keys: ['q', 'e', 'z', 'c'], unlockCost: 2500 },
  { tier: 5, keys: ['x'], unlockCost: 25000 },
];

const ALL_KEYS = KEY_TIERS.flatMap((t) => t.keys);

const OFFLINE_SONG_BPM = 90;

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
    lastSaveTime: null,
  };
}

function getKeyUpgradeCost(level) {
  return Math.floor(10 * Math.pow(1.15, level - 1));
}

// Rare (non-WASD) keys are worth 3× more per hit
const KEY_VALUE_BONUS = { q: 3, e: 3, z: 3, x: 3, c: 3 };

function getKeyValue(state, key) {
  const keyState = state.keys[key];
  if (!keyState || !keyState.unlocked) return 0;
  return keyState.level * state.prestige.multiplier * getAchievementMultiplier(state) * (KEY_VALUE_BONUS[key] || 1);
}

function getComboMultiplier(combo) {
  if (combo < 10) return 1;
  if (combo < 25) return 1.5;
  if (combo < 50) return 2;
  if (combo < 100) return 3;
  if (combo < 250) return 5;
  if (combo < 500) return 8;
  if (combo < 1000) return 12;
  return 20;
}

function getTierUnlockCost(tier) {
  const tierDef = KEY_TIERS.find((t) => t.tier === tier);
  return tierDef ? tierDef.unlockCost : Infinity;
}

const ACCURACY_MULTIPLIERS = { perfect: 1.0, good: 0.75, ok: 0.5 };

// Process a successful tap on a key with accuracy tier
function processTap(state, key, accuracy = 'perfect') {
  const keyState = state.keys[key];
  if (!keyState || !keyState.unlocked) return { state, earned: 0 };

  keyState.combo++;
  state.stats.totalTaps++;

  const baseValue = getKeyValue(state, key);
  const comboMult = getComboMultiplier(keyState.combo);
  const accuracyMult = ACCURACY_MULTIPLIERS[accuracy] || 1;
  let earned = baseValue * comboMult * accuracyMult;

  // Check combo threshold bonuses
  if (COMBO_THRESHOLDS.includes(keyState.combo)) {
    const burst = baseValue * keyState.combo * state.offlineSong.comboBonus;
    earned += burst;
  }

  if (keyState.combo > keyState.bestCombo) {
    keyState.bestCombo = keyState.combo;
  }
  if (keyState.combo > state.stats.bestCombo) {
    state.stats.bestCombo = keyState.combo;
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
function getDancerHireCost(count) {
  return Math.floor(50 * Math.pow(2, count));
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
  const cost = getDancerHireCost(state.dancers.count);
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
function getPrestigeGain(totalEarned) {
  if (totalEarned < 1000) return 0;
  return Math.floor(Math.sqrt(totalEarned / 1000));
}

function performPrestige(state) {
  const gain = getPrestigeGain(state.totalEarned);
  if (gain <= 0) return { state, success: false };

  state.prestige.count++;
  state.prestige.stars += gain;
  state.prestige.multiplier = 1 + state.prestige.stars * 0.1;

  // Reset run-specific progress
  state.currency = 0;
  state.totalEarned = 0;
  state.tierUnlocked = 1;
  state.keys = createDefaultKeyState();
  state.dancers = { count: 0, level: 1 };
  state.stats = { totalTaps: 0, totalMisses: 0, bestCombo: 0, songsPlayed: 0 };

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
    ACHIEVEMENTS,
    checkAchievements,
    getAchievementMultiplier,
    calculateOfflineEarnings,
    KEY_TIERS,
    ALL_KEYS,
    COMBO_THRESHOLDS,
    ACCURACY_MULTIPLIERS,
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
    ACHIEVEMENTS,
    checkAchievements,
    getAchievementMultiplier,
    calculateOfflineEarnings,
    KEY_TIERS,
    ALL_KEYS,
    COMBO_THRESHOLDS,
    ACCURACY_MULTIPLIERS,
  });
}
