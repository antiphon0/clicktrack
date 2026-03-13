// Clicktrack renderer — ties game engine, Spotify, and UI together

const {
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
} = typeof require !== 'undefined' ? require('./game.js') : window;

// --- State ---
let state = createDefaultState();
let currentBpm = state.offlineSong.bpm;
let beatOrigin = performance.now(); // reference timestamp for beat grid
let isSpotifyConnected = false;
let beatTimer = null;
let saveInterval = null;

// --- DOM refs ---
const $ = (sel) => document.querySelector(sel);
const currencyEl = $('#currency');
const bpmValueEl = $('#bpm-value');
const modeLabelEl = $('#mode-label');
const comboCountEl = $('#combo-count');
const comboMultEl = $('#combo-mult');
const tapFeedbackEl = $('#tap-feedback');
const beatPulse = $('#beat-pulse');
const keyUpgradesEl = $('#key-upgrades');
const tierCostEl = $('#tier-cost');
const unlockTierBtn = $('#unlock-tier-btn');
const statsContentEl = $('#stats-content');
const trackNameEl = $('#track-name');
const trackArtistEl = $('#track-artist');
const albumArtEl = $('#album-art');
const albumArtPlaceholder = $('#album-art-placeholder');
const spotifyConnectBtn = $('#spotify-connect');

// --- Formatting ---
function formatNumber(n) {
  if (n < 1000) return Math.floor(n).toString();
  if (n < 1e6) return (n / 1000).toFixed(1) + 'K';
  if (n < 1e9) return (n / 1e6).toFixed(2) + 'M';
  if (n < 1e12) return (n / 1e9).toFixed(2) + 'B';
  return (n / 1e12).toFixed(2) + 'T';
}

// --- UI Updates ---
function updateCurrency() {
  currencyEl.textContent = formatNumber(state.currency);
}

function updateBpm() {
  bpmValueEl.textContent = currentBpm;
  modeLabelEl.textContent = isSpotifyConnected ? '' : '(offline song)';
}

function updateCombo() {
  // Show highest active combo across all keys
  let maxCombo = 0;
  for (const key of ALL_KEYS) {
    if (state.keys[key].unlocked && state.keys[key].combo > maxCombo) {
      maxCombo = state.keys[key].combo;
    }
  }
  comboCountEl.textContent = maxCombo;
  comboMultEl.textContent = `×${getComboMultiplier(maxCombo)}`;
}

function showFeedback(text, cls) {
  tapFeedbackEl.textContent = text;
  tapFeedbackEl.className = cls;
  clearTimeout(tapFeedbackEl._timer);
  tapFeedbackEl._timer = setTimeout(() => {
    tapFeedbackEl.textContent = '';
    tapFeedbackEl.className = '';
  }, 600);
}

function updateKeyGrid() {
  for (const key of ALL_KEYS) {
    const el = $(`.key[data-key="${key}"]`);
    if (!el) continue;
    const ks = state.keys[key];
    el.classList.toggle('locked', !ks.unlocked);
    el.classList.toggle('active', ks.unlocked);
  }
}

function updateUpgrades() {
  keyUpgradesEl.innerHTML = '';
  for (const key of ALL_KEYS) {
    const ks = state.keys[key];
    if (!ks.unlocked) continue;

    const cost = getKeyUpgradeCost(ks.level);
    const div = document.createElement('div');
    div.className = 'key-upgrade';
    div.innerHTML = `
      <span class="key-upgrade-label">${key.toUpperCase()}</span>
      <span class="key-upgrade-level">Lv ${ks.level}</span>
      <button class="btn btn-small" data-upgrade-key="${key}"
        ${state.currency < cost ? 'disabled' : ''}>
        ↑ ${formatNumber(cost)}
      </button>
    `;
    keyUpgradesEl.appendChild(div);
  }

  // Tier unlock
  const nextTier = state.tierUnlocked + 1;
  const tierDef = KEY_TIERS.find((t) => t.tier === nextTier);
  if (tierDef) {
    tierCostEl.textContent = formatNumber(tierDef.unlockCost);
    unlockTierBtn.disabled = state.currency < tierDef.unlockCost;
    unlockTierBtn.style.display = '';
  } else {
    unlockTierBtn.style.display = 'none';
  }
}

function updateStats() {
  statsContentEl.innerHTML = `
    <div class="stat-row"><span class="stat-label">Total taps</span><span class="stat-value">${formatNumber(state.stats.totalTaps)}</span></div>
    <div class="stat-row"><span class="stat-label">Total misses</span><span class="stat-value">${formatNumber(state.stats.totalMisses)}</span></div>
    <div class="stat-row"><span class="stat-label">Best combo</span><span class="stat-value">${formatNumber(state.stats.bestCombo)}</span></div>
    <div class="stat-row"><span class="stat-label">Total earned</span><span class="stat-value">${formatNumber(state.totalEarned)}</span></div>
    <div class="stat-row"><span class="stat-label">Prestige</span><span class="stat-value">×${state.prestige.multiplier}</span></div>
    <div class="stat-row"><span class="stat-label">Tier</span><span class="stat-value">${state.tierUnlocked} / 5</span></div>
  `;
}

function refreshUI() {
  updateCurrency();
  updateBpm();
  updateCombo();
  updateKeyGrid();
  updateUpgrades();
  updateStats();
}

// --- Beat Pulse ---
function startBeatPulse() {
  if (beatTimer) clearInterval(beatTimer);
  const interval = beatIntervalMs(currentBpm);
  beatOrigin = performance.now();

  beatTimer = setInterval(() => {
    beatPulse.classList.add('pulse');
    // Flash on-beat indicator on active keys
    for (const key of ALL_KEYS) {
      if (state.keys[key].unlocked) {
        const el = $(`.key[data-key="${key}"]`);
        el.classList.add('on-beat');
        setTimeout(() => el.classList.remove('on-beat'), 100);
      }
    }
    setTimeout(() => beatPulse.classList.remove('pulse'), 150);
  }, interval);
}

function setBpm(bpm) {
  currentBpm = bpm;
  updateBpm();
  startBeatPulse();
}

// --- Input Handling ---
function handleKeyPress(key) {
  const keyLower = key.toLowerCase();
  if (!ALL_KEYS.includes(keyLower)) return;

  const ks = state.keys[keyLower];
  if (!ks || !ks.unlocked) return;

  const el = $(`.key[data-key="${keyLower}"]`);
  const now = performance.now();
  const onBeat = isTapOnBeat(
    now,
    beatOrigin,
    currentBpm,
    state.settings.tolerancePercent
  );

  if (onBeat) {
    const { earned } = processTap(state, keyLower);
    el.classList.add('hit');
    setTimeout(() => el.classList.remove('hit'), 100);

    if (earned > getKeyValue(state, keyLower) * 2) {
      showFeedback(`+${formatNumber(earned)} BONUS!`, 'feedback-bonus');
    } else {
      showFeedback(`+${formatNumber(earned)}`, 'feedback-hit');
    }
  } else {
    processMiss(state, keyLower);
    el.classList.add('miss');
    setTimeout(() => el.classList.remove('miss'), 200);
    showFeedback('MISS', 'feedback-miss');
  }

  refreshUI();
}

// --- Event Listeners ---
document.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  handleKeyPress(e.key);
});

// Upgrade buttons (delegated)
keyUpgradesEl.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-upgrade-key]');
  if (!btn) return;
  const key = btn.dataset.upgradeKey;
  upgradeKey(state, key);
  refreshUI();
});

unlockTierBtn.addEventListener('click', () => {
  unlockTier(state);
  refreshUI();
});

// Spotify connect placeholder
spotifyConnectBtn.addEventListener('click', () => {
  // TODO: wire up SpotifyIntegration.login() once client ID is set
  showFeedback('Set SPOTIFY_CLIENT_ID first', 'feedback-miss');
});

// --- Save / Load ---
async function saveGame() {
  if (window.clicktrack?.saveGame) {
    await window.clicktrack.saveGame(state);
  }
}

async function loadGame() {
  if (window.clicktrack?.loadGame) {
    const saved = await window.clicktrack.loadGame();
    if (saved) {
      state = saved;
    }
  }
}

// --- Init ---
async function init() {
  await loadGame();
  refreshUI();
  startBeatPulse();
  // Auto-save every 30 seconds
  saveInterval = setInterval(saveGame, 30000);
}

init();
