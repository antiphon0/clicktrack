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
      multiplier: 1,
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
  return keyState.level * state.prestige.multiplier * (KEY_VALUE_BONUS[key] || 1);
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
    KEY_TIERS,
    ALL_KEYS,
    COMBO_THRESHOLDS,
    ACCURACY_MULTIPLIERS,
  });
}
