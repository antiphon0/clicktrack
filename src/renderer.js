// Clicktrack renderer — ties game engine, Spotify, and UI together
// game.js & spotify.js are loaded before this via <script> tags
// and expose window.Game and window.SpotifyIntegration

const G = window.Game;

// --- State ---
let state = G.createDefaultState();
let currentBpm = state.offlineSong.bpm;
let beatOrigin = performance.now();
let isSpotifyConnected = false;
let beatTimer = null;
let saveInterval = null;
let lastTappedKey = null;

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
  // Show combo for the last tapped key, or highest active
  let displayCombo = 0;
  if (lastTappedKey && state.keys[lastTappedKey]?.unlocked) {
    displayCombo = state.keys[lastTappedKey].combo;
  } else {
    for (const key of G.ALL_KEYS) {
      if (state.keys[key].unlocked && state.keys[key].combo > displayCombo) {
        displayCombo = state.keys[key].combo;
      }
    }
  }
  comboCountEl.textContent = displayCombo;
  comboMultEl.textContent = `×${G.getComboMultiplier(displayCombo)}`;
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
  for (const key of G.ALL_KEYS) {
    const el = $(`.key[data-key="${key}"]`);
    if (!el) continue;
    const ks = state.keys[key];
    el.classList.toggle('locked', !ks.unlocked);
    el.classList.toggle('active', ks.unlocked);

    // Show per-key combo count on the tile
    let comboSpan = el.querySelector('.key-combo');
    if (ks.unlocked && ks.combo > 0) {
      if (!comboSpan) {
        comboSpan = document.createElement('span');
        comboSpan.className = 'key-combo';
        el.appendChild(comboSpan);
      }
      comboSpan.textContent = ks.combo;
    } else if (comboSpan) {
      comboSpan.remove();
    }
  }
}

function updateUpgrades() {
  keyUpgradesEl.innerHTML = '';
  for (const key of G.ALL_KEYS) {
    const ks = state.keys[key];
    if (!ks.unlocked) continue;

    const cost = G.getKeyUpgradeCost(ks.level);
    const value = G.getKeyValue(state, key);
    const div = document.createElement('div');
    div.className = 'key-upgrade';
    div.innerHTML = `
      <span class="key-upgrade-label">${key.toUpperCase()}</span>
      <span class="key-upgrade-level">Lv ${ks.level} · ${formatNumber(value)}/tap</span>
      <button class="btn btn-small" data-upgrade-key="${key}"
        ${state.currency < cost ? 'disabled' : ''}>
        ↑ ${formatNumber(cost)}
      </button>
    `;
    keyUpgradesEl.appendChild(div);
  }

  // Tier unlock
  const nextTier = state.tierUnlocked + 1;
  const tierDef = G.KEY_TIERS.find((t) => t.tier === nextTier);
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

// --- Beat Pulse (drift-correcting) ---
function startBeatPulse() {
  if (beatTimer) cancelAnimationFrame(beatTimer);
  const interval = G.beatIntervalMs(currentBpm);
  beatOrigin = performance.now();
  let nextBeat = beatOrigin + interval;

  function tick() {
    const now = performance.now();
    if (now >= nextBeat) {
      // Fire beat
      beatPulse.classList.add('pulse');
      for (const key of G.ALL_KEYS) {
        if (state.keys[key].unlocked) {
          const el = $(`.key[data-key="${key}"]`);
          el.classList.add('on-beat');
          setTimeout(() => el.classList.remove('on-beat'), 80);
        }
      }
      setTimeout(() => beatPulse.classList.remove('pulse'), 120);

      // Schedule next beat (drift-correcting: advance from expected, not from now)
      nextBeat += interval;
      // If we fell behind by more than a full beat, snap forward
      if (nextBeat < now) nextBeat = now + interval;
    }
    beatTimer = requestAnimationFrame(tick);
  }
  beatTimer = requestAnimationFrame(tick);
}

function setBpm(bpm) {
  currentBpm = bpm;
  updateBpm();
  startBeatPulse();
}

// --- Key Aliases (arrow keys + numpad map to the same game keys) ---
const KEY_ALIASES = {
  // Arrow keys → WASD
  arrowup: 'w',
  arrowleft: 'a',
  arrowdown: 's',
  arrowright: 'd',
  // Numpad → full grid
  '5': 's',          // Numpad 5 (center)
  '8': 'w',          // Numpad 8 (up)
  '4': 'a',          // Numpad 4 (left)
  '6': 'd',          // Numpad 6 (right)
  '7': 'q',          // Numpad 7 (top-left)
  '9': 'e',          // Numpad 9 (top-right)
  '1': 'z',          // Numpad 1 (bottom-left)
  '3': 'c',          // Numpad 3 (bottom-right)
  '2': 'x',          // Numpad 2 (bottom-center)
};

function resolveKey(raw) {
  const lower = raw.toLowerCase();
  return KEY_ALIASES[lower] || lower;
}

// --- Input Handling ---
function handleTap(key) {
  const keyLower = resolveKey(key);
  if (!G.ALL_KEYS.includes(keyLower)) return;

  const ks = state.keys[keyLower];
  if (!ks || !ks.unlocked) return;

  lastTappedKey = keyLower;
  const el = $(`.key[data-key="${keyLower}"]`);
  const now = performance.now();
  const onBeat = G.isTapOnBeat(
    now,
    beatOrigin,
    currentBpm,
    state.settings.tolerancePercent
  );

  if (onBeat) {
    const { earned } = G.processTap(state, keyLower);
    el.classList.add('hit');
    setTimeout(() => el.classList.remove('hit'), 100);

    if (earned > G.getKeyValue(state, keyLower) * 2) {
      showFeedback(`+${formatNumber(earned)} BONUS!`, 'feedback-bonus');
    } else {
      showFeedback(`+${formatNumber(earned)}`, 'feedback-hit');
    }
  } else {
    G.processMiss(state, keyLower);
    el.classList.add('miss');
    setTimeout(() => el.classList.remove('miss'), 200);
    showFeedback('MISS', 'feedback-miss');
  }

  refreshUI();
}

// --- Event Listeners ---

// Keyboard input
document.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  // Don't capture when typing in inputs
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  const gameKey = resolveKey(e.key);
  if (G.ALL_KEYS.includes(gameKey)) {
    e.preventDefault(); // prevent arrow key scroll / numpad input
    handleTap(e.key);
  }
});

// Mouse/touch input on the beat grid
document.getElementById('beat-grid').addEventListener('click', (e) => {
  const keyEl = e.target.closest('.key');
  if (!keyEl) return;
  const key = keyEl.dataset.key;
  if (key) handleTap(key);
});

// Upgrade buttons (delegated)
keyUpgradesEl.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-upgrade-key]');
  if (!btn) return;
  const key = btn.dataset.upgradeKey;
  G.upgradeKey(state, key);
  refreshUI();
});

unlockTierBtn.addEventListener('click', () => {
  G.unlockTier(state);
  refreshUI();
});

// Spotify connect
const spotify = new window.SpotifyIntegration();

spotify.onBpmChange = (bpm) => {
  setBpm(bpm);
};

spotify.onTrackChange = (track) => {
  trackNameEl.textContent = track.name;
  trackArtistEl.textContent = track.artist;
  if (track.artUrl) {
    albumArtEl.src = track.artUrl;
    albumArtEl.style.display = '';
    albumArtPlaceholder.style.display = 'none';
  }
};

spotify.onConnectionChange = (connected) => {
  isSpotifyConnected = connected;
  spotifyConnectBtn.textContent = connected ? 'Connected ✓' : 'Connect Spotify';
  spotifyConnectBtn.disabled = connected;
  if (!connected) {
    setBpm(state.offlineSong.bpm);
    trackNameEl.textContent = 'No song playing';
    trackArtistEl.textContent = '';
    albumArtEl.style.display = 'none';
    albumArtPlaceholder.style.display = '';
  }
  updateBpm();
};

spotifyConnectBtn.addEventListener('click', async () => {
  await spotify.login();
});

// Check for OAuth callback on load
(async function checkSpotifyCallback() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  if (code) {
    try {
      await spotify.handleCallback(code);
      // Load Spotify Web Playback SDK
      const script = document.createElement('script');
      script.src = 'https://sdk.scdn.co/spotify-player.js';
      document.body.appendChild(script);
      window.onSpotifyWebPlaybackSDKReady = () => {
        spotify.initPlayer();
      };
      // Clean URL
      window.history.replaceState({}, '', window.location.pathname);
    } catch (err) {
      showFeedback('Spotify auth failed', 'feedback-miss');
    }
  }
})();

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
      // Merge with defaults to handle new fields added in updates
      const defaults = G.createDefaultState();
      state = { ...defaults, ...saved, keys: { ...defaults.keys } };
      // Restore saved key state
      for (const key of G.ALL_KEYS) {
        if (saved.keys?.[key]) {
          state.keys[key] = { ...defaults.keys[key], ...saved.keys[key] };
        }
      }
      state.stats = { ...defaults.stats, ...(saved.stats || {}) };
      state.prestige = { ...defaults.prestige, ...(saved.prestige || {}) };
      state.settings = { ...defaults.settings, ...(saved.settings || {}) };
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
  // Also save on window close
  window.addEventListener('beforeunload', () => saveGame());
}

init();
