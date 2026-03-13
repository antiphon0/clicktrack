// Game state engine for Clicktrack
// Manages keys, combos, currency, upgrades, and the offline song

const KEY_TIERS = [
  { tier: 1, keys: ['s'], unlockCost: 0 },
  { tier: 2, keys: ['w', 'a', 'd'], unlockCost: 100 },
  { tier: 3, keys: ['q', 'e'], unlockCost: 1000 },
  { tier: 4, keys: ['z', 'c'], unlockCost: 10000 },
  { tier: 5, keys: ['x'], unlockCost: 100000 },
];

const ALL_KEYS = KEY_TIERS.flatMap((t) => t.keys);

const OFFLINE_SONG_BPM = 90;

// Combo threshold bonuses: at these streak counts, award a burst payout
const COMBO_THRESHOLDS = [10, 25, 50, 100, 250, 500, 1000];

function createDefaultKeyState() {
  const keys = {};
  for (const key of ALL_KEYS) {
    keys[key] = {
      unlocked: key === 's',
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
  };
}

function getKeyUpgradeCost(level) {
  return Math.floor(10 * Math.pow(1.15, level - 1));
}

function getKeyValue(state, key) {
  const keyState = state.keys[key];
  if (!keyState || !keyState.unlocked) return 0;
  return keyState.level * state.prestige.multiplier;
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

// Process a successful tap on a key
function processTap(state, key) {
  const keyState = state.keys[key];
  if (!keyState || !keyState.unlocked) return { state, earned: 0 };

  keyState.combo++;
  state.stats.totalTaps++;

  const baseValue = getKeyValue(state, key);
  const comboMult = getComboMultiplier(keyState.combo);
  let earned = baseValue * comboMult;

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

const _gameExports = {
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
  KEY_TIERS,
  ALL_KEYS,
  COMBO_THRESHOLDS,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = _gameExports;
}
if (typeof window !== 'undefined') {
  window.Game = _gameExports;
}
