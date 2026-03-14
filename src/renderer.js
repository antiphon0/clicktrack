// Clicktrack renderer — live system audio onset detection + scrolling note track
// game.js globals (createDefaultState, processTap, etc.) loaded via script tag

// --- State ---
let state = createDefaultState();
let isListening = false;
let audioContext = null;
let analyserNode = null;
let mediaStream = null;
let saveInterval = null;
let animFrameId = null;

// Onset detection
const ENERGY_HISTORY_SIZE = 43;
const ONSET_THRESHOLD = 1.5;
const ONSET_COOLDOWN_MS = 200;
const MIN_ENERGY = 0.003;
let energyHistory = [];
let lastOnsetTime = 0;
let totalBeatsDetected = 0;

// Default song (always-on metronome when no audio is detected)
const DEFAULT_BPM = 90;
let lastDefaultBeatTime = 0;

// Note track
const SCROLL_TIME_MS = 1500;   // notes take 1.5s to scroll top → hit zone
const HIT_PERFECT_MS = 80;     // ±80ms = perfect
const HIT_GOOD_MS = 160;       // ±160ms = good
const HIT_OK_MS = 280;         // ±280ms = ok
const MISS_THRESHOLD_MS = 380; // past hit zone by this → miss
let activeNotes = [];
let noteIdCounter = 0;

// Combo & accuracy
let comboStreak = 0;
let accuracyCounts = { perfect: 0, good: 0, ok: 0, miss: 0 };
const PASSIVE_PER_BEAT = 0.1;

// --- Dancers ---
let dancerCooldowns = [];

function syncDancerCooldowns() {
  const count = state.dancers?.count ?? 0;
  while (dancerCooldowns.length < count) dancerCooldowns.push(0);
  dancerCooldowns.length = count;
}

// --- DOM ---
const $ = (sel) => document.querySelector(sel);
const currencyEl = $('#currency');
const comboCountEl = $('#combo-count');
const comboMultEl = $('#combo-mult');
const tapFeedbackEl = $('#tap-feedback');
const keyUpgradesEl = $('#key-upgrades');
const tierCostEl = $('#tier-cost');
const unlockTierBtn = $('#unlock-tier-btn');
const statsContentEl = $('#stats-content');
const listenBtn = $('#listen-btn');
const stopBtn = $('#stop-btn');
const vuFill = $('#vu-fill');
const beatCounterEl = $('#beat-counter');
const perfectCountEl = $('#perfect-count');
const goodCountEl = $('#good-count');
const okCountEl = $('#ok-count');
const missCountEl = $('#miss-count');
const lanesContainer = $('#lanes-container');
const laneLabels = $('#lane-labels');
const sourcePickerOverlay = null;
const sourceList = null;
const sourceCancelBtn = null;

const dancerFiguresEl = $('#dancer-figures');
const hireDancerBtn = $('#hire-dancer-btn');
const hireDancerCostEl = $('#dancer-hire-cost');
const upgradeDancerBtn = $('#upgrade-dancer-btn');
const upgradeDancerCostEl = $('#dancer-upgrade-cost');
const dancerAccuracyLabelEl = $('#dancer-accuracy-label');

// --- Helpers ---
function formatNumber(n) {
  if (n < 1000) return Math.floor(n).toString();
  if (n < 1e6) return (n / 1000).toFixed(1) + 'K';
  if (n < 1e9) return (n / 1e6).toFixed(2) + 'M';
  if (n < 1e12) return (n / 1e9).toFixed(2) + 'B';
  return (n / 1e12).toFixed(2) + 'T';
}

function getUnlockedKeys() {
  return ALL_KEYS.filter((k) => state.keys[k]?.unlocked);
}

// Lane order matches physical keyboard position left-to-right (QWERTY x-offsets)
const LANE_ORDER = ['q', 'a', 'z', 'w', 's', 'x', 'e', 'd', 'c'];
// Inline SVG arrows — one path rotated per direction, no overflow issues
const KEY_ANGLE = { w: 0, d: 90, s: 180, a: 270, e: 45, c: 135, x: 0, z: 225, q: 315 };
const KEY_COLOR = { a: '#ff4455', w: '#44dd77', s: '#4499ff', d: '#ffdd33', q: '#cc44ff', e: '#ff8833', z: '#ff44cc', x: '#aaddff', c: '#44ffcc' };
const KEY_GLOW  = { a: 'rgba(255,68,85,0.9)', w: 'rgba(68,221,119,0.9)', s: 'rgba(68,153,255,0.9)', d: 'rgba(255,221,51,0.9)', q: 'rgba(204,68,255,0.9)', e: 'rgba(255,136,51,0.9)', z: 'rgba(255,68,204,0.9)', x: 'rgba(170,221,255,0.9)', c: 'rgba(68,255,204,0.9)' };
const ARROW_PATH = 'M 50,5 L 95,50 L 68,50 L 68,95 L 32,95 L 32,50 L 5,50 Z';

function createArrowEl(key) {
  const angle = KEY_ANGLE[key] ?? 0;
  const color = KEY_COLOR[key] || '#ffffff';
  const glow  = KEY_GLOW[key]  || 'rgba(255,255,255,0.5)';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.style.filter = `drop-shadow(0 0 7px ${glow})`;
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ARROW_PATH);
  path.setAttribute('fill', color);
  if (angle !== 0) path.setAttribute('transform', `rotate(${angle}, 50, 50)`);
  svg.appendChild(path);
  return svg;
}

// --- Lane Management ---
function rebuildLanes() {
  const unlocked = getUnlockedKeys();
  const sorted = LANE_ORDER.filter((k) => unlocked.includes(k));
  lanesContainer.innerHTML = '';
  laneLabels.innerHTML = '';

  for (const key of sorted) {
    const lane = document.createElement('div');
    lane.className = 'lane';
    lane.dataset.key = key;
    lanesContainer.appendChild(lane);

    const label = document.createElement('div');
    label.className = `lane-label lane-label-key-${key}`;
    label.dataset.key = key;
    const labelArrow = createArrowEl(key);
    labelArrow.classList.add('label-arrow');
    label.appendChild(labelArrow);
    laneLabels.appendChild(label);
  }
}

// --- Source Picker ---
async function startListening() {
  await startCapture();
}

async function startCapture() {
  // If already listening, stop first before re-capturing
  if (isListening) stopListening();

  listenBtn.style.display = 'none';
  beatCounterEl.textContent = 'Starting...';

  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true,
    });

    stream.getVideoTracks().forEach((t) => t.stop());

    if (stream.getAudioTracks().length === 0) {
      console.error('No audio track in capture stream');
      beatCounterEl.textContent = 'No audio — click Listen to retry';
      listenBtn.style.display = '';
      return;
    }

    audioContext = new AudioContext();
    await audioContext.resume();

    const source = audioContext.createMediaStreamSource(stream);
    analyserNode = audioContext.createAnalyser();
    analyserNode.fftSize = 2048;
    source.connect(analyserNode);

    mediaStream = stream;
    isListening = true;
    energyHistory = [];
    lastOnsetTime = 0;

    listenBtn.style.display = 'none';
    stopBtn.style.display = '';
    beatCounterEl.textContent = 'Listening...';

    // gameLoop may already be running from startDefaultLoop — don't double-start
    if (!animFrameId) gameLoop();
  } catch (e) {
    console.error('Failed to capture audio:', e);
    beatCounterEl.textContent = 'Capture failed — click Listen to retry';
    listenBtn.style.display = '';
  }
}

function stopListening() {
  isListening = false;
  if (animFrameId) {
    cancelAnimationFrame(animFrameId);
    animFrameId = null;
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }
  analyserNode = null;

  // Clean up notes
  for (const note of activeNotes) {
    if (note.element.parentNode) note.element.parentNode.removeChild(note.element);
  }
  activeNotes = [];

  listenBtn.style.display = '';
  stopBtn.style.display = 'none';
  vuFill.style.width = '0%';
  beatCounterEl.textContent = 'Stopped';

  // Resume passive metronome
  lastDefaultBeatTime = performance.now();
  startDefaultLoop();
}

// --- Onset Detection ---
function detectOnset() {
  const bufLen = analyserNode.fftSize;
  const data = new Float32Array(bufLen);
  analyserNode.getFloatTimeDomainData(data);

  let sum = 0;
  for (let i = 0; i < bufLen; i++) sum += data[i] * data[i];
  const rms = Math.sqrt(sum / bufLen);

  vuFill.style.width = Math.min(100, rms * 800) + '%';

  energyHistory.push(rms);
  if (energyHistory.length > ENERGY_HISTORY_SIZE) energyHistory.shift();
  if (energyHistory.length < 5) return false;

  const avg = energyHistory.reduce((a, b) => a + b, 0) / energyHistory.length;
  const now = performance.now();

  if (rms > avg * ONSET_THRESHOLD && avg > MIN_ENERGY && now - lastOnsetTime > ONSET_COOLDOWN_MS) {
    lastOnsetTime = now;
    return true;
  }
  return false;
}

// --- Note Spawning ---
// Primary keys appear 4× more often than rare keys
const KEY_SPAWN_WEIGHT = { w: 4, a: 4, s: 4, d: 4, q: 1, e: 1, z: 1, x: 1, c: 1 };

function weightedKey(keys) {
  const weights = keys.map((k) => KEY_SPAWN_WEIGHT[k] ?? 1);
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < keys.length; i++) {
    r -= weights[i];
    if (r <= 0) return keys[i];
  }
  return keys[keys.length - 1];
}

function spawnNote(now) {
  const unlocked = getUnlockedKeys();
  if (unlocked.length === 0) return;

  const key = weightedKey(unlocked);
  const hitTime = now + SCROLL_TIME_MS;

  const lane = lanesContainer.querySelector(`.lane[data-key="${key}"]`);
  if (!lane) return;

  const noteEl = createArrowEl(key);
  noteEl.classList.add('note', `note-key-${key}`);
  noteEl.style.top = '0%';
  lane.appendChild(noteEl);

  activeNotes.push({
    id: noteIdCounter++,
    key,
    spawnTime: now,
    hitTime,
    element: noteEl,
    hit: false,
  });
}

// --- Game Loop ---
function gameLoop() {

  const now = performance.now();

  // Detect onsets from live audio, fall back to default BPM metronome
  const beatIntervalMs = (60 / DEFAULT_BPM) * 1000;
  const audioOnset = isListening && detectOnset();
  const defaultBeat = !audioOnset && (now - lastDefaultBeatTime >= beatIntervalMs);

  if (audioOnset || defaultBeat) {
    if (defaultBeat) lastDefaultBeatTime = now;
    totalBeatsDetected++;
    beatCounterEl.textContent = totalBeatsDetected + ' beats';

    // Passive income
    const passive = PASSIVE_PER_BEAT * state.prestige.multiplier;
    state.currency += passive;
    state.totalEarned += passive;
    updateCurrency();

    // Background pulse
    document.getElementById('app').classList.add('pulse');
    setTimeout(() => document.getElementById('app').classList.remove('pulse'), 150);

    spawnNote(now);
  }

  // Update note positions and check for misses
  for (let i = activeNotes.length - 1; i >= 0; i--) {
    const note = activeNotes[i];
    if (note.hit) continue;

    const elapsed = now - note.spawnTime;
    const progress = elapsed / SCROLL_TIME_MS; // 0 = top, 1.0 = hit zone

    // Position the note — 100% = bottom of lane = hit zone line
    const topPercent = progress * 100;
    note.element.style.top = topPercent + '%';

    // Fade in as it approaches
    note.element.style.opacity = Math.min(1, progress * 2);

    const pastHitMs = now - note.hitTime;

    // Dancer auto-hit — claim note as soon as it reaches the hit zone
    if (pastHitMs >= 0 && state.dancers && state.dancers.count > 0) {
      const di = dancerCooldowns.findIndex((cd) => cd <= now);
      if (di !== -1) {
        dancerCooldowns[di] = now + 400;
        autoDancerHit(note);
        activeNotes.splice(i, 1);
        continue;
      }
    }

    // Missed — past the hit zone by threshold
    if (pastHitMs > MISS_THRESHOLD_MS) {
      onNoteMiss(note);
      activeNotes.splice(i, 1);
    }
  }

  animFrameId = requestAnimationFrame(gameLoop);
}

function startDefaultLoop() {
  if (animFrameId) return;
  lastDefaultBeatTime = performance.now();
  gameLoop();
}

// --- Input ---
function classifyTiming(offsetMs) {
  const abs = Math.abs(offsetMs);
  if (abs <= HIT_PERFECT_MS) return 'perfect';
  if (abs <= HIT_GOOD_MS) return 'good';
  if (abs <= HIT_OK_MS) return 'ok';
  return null; // too far
}

function flashLane(key) {
  // Always flash the lane + label on any key press so input feels responsive
  const lane = lanesContainer.querySelector(`.lane[data-key="${key}"]`);
  const label = laneLabels.querySelector(`.lane-label[data-key="${key}"]`);
  if (lane) {
    lane.classList.add('lane-flash');
    setTimeout(() => lane.classList.remove('lane-flash'), 150);
  }
  if (label) {
    label.classList.add('label-hit');
    setTimeout(() => label.classList.remove('label-hit'), 150);
  }
}

function onKeyPress(key) {
  if (!state.keys[key]?.unlocked) return;

  // Visual feedback on every press
  flashLane(key);

  const now = performance.now();

  // Find the closest unhit note in this key's lane within timing window
  let bestNote = null;
  let bestOffset = Infinity;

  for (const note of activeNotes) {
    if (note.hit || note.key !== key) continue;
    const offset = now - note.hitTime;
    const abs = Math.abs(offset);
    if (abs < bestOffset && abs <= MISS_THRESHOLD_MS) {
      bestOffset = abs;
      bestNote = note;
    }
  }

  if (!bestNote) return; // no note nearby

  const offset = now - bestNote.hitTime;
  const accuracy = classifyTiming(offset);

  if (!accuracy) return; // outside timing window

  bestNote.hit = true;

  // Visual feedback on the note
  bestNote.element.classList.add('note-hit');
  setTimeout(() => {
    if (bestNote.element.parentNode) bestNote.element.parentNode.removeChild(bestNote.element);
    const idx = activeNotes.indexOf(bestNote);
    if (idx >= 0) activeNotes.splice(idx, 1);
  }, 150);

  comboStreak++;
  const result = processTap(state, key, accuracy);
  showFeedback(accuracy, result.earned);
  accuracyCounts[accuracy]++;

  updateCurrency();
  updateCombo();
  updateAccuracy();
}

// --- Stick Figures ---
const STICK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 90" width="20" height="20">
  <circle cx="50" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="7"/>
  <line x1="50" y1="22" x2="50" y2="54" stroke="currentColor" stroke-width="7" stroke-linecap="round"/>
  <line x1="50" y1="34" x2="26" y2="48" stroke="currentColor" stroke-width="7" stroke-linecap="round"/>
  <line x1="50" y1="34" x2="74" y2="48" stroke="currentColor" stroke-width="7" stroke-linecap="round"/>
  <line x1="50" y1="54" x2="32" y2="80" stroke="currentColor" stroke-width="7" stroke-linecap="round"/>
  <line x1="50" y1="54" x2="68" y2="80" stroke="currentColor" stroke-width="7" stroke-linecap="round"/>
</svg>`;

function updateDancerPanel() {
  if (!state.dancers) return;
  const { count, level } = state.dancers;

  // Hire button
  const hireCost = getDancerHireCost(count);
  hireDancerCostEl.textContent = formatNumber(hireCost);
  hireDancerBtn.disabled = state.currency < hireCost;

  // Upgrade button
  if (level >= 3) {
    upgradeDancerBtn.style.display = 'none';
  } else {
    upgradeDancerBtn.style.display = '';
    const upgradeCost = getDancerUpgradeCost(level);
    upgradeDancerCostEl.textContent = formatNumber(upgradeCost);
    upgradeDancerBtn.disabled = state.currency < upgradeCost;
  }

  // Accuracy label
  const ACC_LABEL = { ok: 'OK', good: 'GOOD', perfect: 'PERFECT' };
  const ACC_CLASS = { ok: 'acc-ok', good: 'acc-good', perfect: 'acc-perfect' };
  const acc = getDancerAccuracy(level);
  dancerAccuracyLabelEl.innerHTML = count > 0
    ? `<span class="${ACC_CLASS[acc]}">${count} dancer${count !== 1 ? 's' : ''} &middot; ${ACC_LABEL[acc]}</span>`
    : '<span class="hint">No dancers yet &mdash; hire one below</span>';

  // Stick figures (cap at 20 visible)
  const MAX_VISIBLE = 20;
  const visible = Math.min(count, MAX_VISIBLE);
  let html = '';
  for (let i = 0; i < visible; i++) {
    const delay = (i * 0.09).toFixed(2);
    html += `<span class="dancer-figure" style="animation-delay:${delay}s">${STICK_SVG}</span>`;
  }
  if (count > MAX_VISIBLE) {
    html += `<span class="dancer-more">+${count - MAX_VISIBLE}</span>`;
  }
  dancerFiguresEl.innerHTML = html;
}

function autoDancerHit(note) {
  note.hit = true;
  const accuracy = getDancerAccuracy(state.dancers.level);
  note.element.classList.add('note-hit');
  setTimeout(() => {
    if (note.element.parentNode) note.element.parentNode.removeChild(note.element);
  }, 150);
  comboStreak++;
  const result = processTap(state, note.key, accuracy);
  showFeedback(accuracy, result.earned);
  accuracyCounts[accuracy]++;
  updateCurrency();
  updateCombo();
  updateAccuracy();
}

function onNoteMiss(note) {
  note.element.classList.add('note-miss');
  setTimeout(() => {
    if (note.element.parentNode) note.element.parentNode.removeChild(note.element);
  }, 200);

  comboStreak = 0;
  if (state.keys[note.key]?.unlocked) {
    processMiss(state, note.key);
  }
  accuracyCounts.miss++;
  showFeedback('miss', 0);
  updateCombo();
  updateAccuracy();
}

// --- UI ---
function updateCurrency() {
  currencyEl.textContent = formatNumber(state.currency);

  // Keep buttons enabled/disabled in sync with current currency
  const nextTier = state.tierUnlocked + 1;
  const nextTierDef = KEY_TIERS.find((t) => t.tier === nextTier);
  if (nextTierDef) {
    unlockTierBtn.disabled = state.currency < nextTierDef.unlockCost;
  }
  if (state.dancers) {
    hireDancerBtn.disabled = state.currency < getDancerHireCost(state.dancers.count);
    if (state.dancers.level < 3) {
      upgradeDancerBtn.disabled = state.currency < getDancerUpgradeCost(state.dancers.level);
    }
  }
}

function updateCombo() {
  comboCountEl.textContent = comboStreak;
  comboMultEl.textContent = '\u00d7' + getComboMultiplier(comboStreak);
}

function updateUpgrades() {
  keyUpgradesEl.innerHTML = '';
  for (const key of getUnlockedKeys()) {
    const ks = state.keys[key];
    const cost = getKeyUpgradeCost(ks.level);
    const div = document.createElement('div');
    div.className = 'key-upgrade';
    div.innerHTML = `
      <span class="key-upgrade-label">${key.toUpperCase()}</span>
      <span class="key-upgrade-level">Lv.${ks.level}</span>
      <button class="btn btn-small upgrade-btn" data-key="${key}"
        ${state.currency < cost ? 'disabled' : ''}>
        \u2191 ${formatNumber(cost)}
      </button>
    `;
    keyUpgradesEl.appendChild(div);
  }

  const nextTier = state.tierUnlocked + 1;
  const tierDef = KEY_TIERS.find((t) => t.tier === nextTier);
  if (tierDef) {
    unlockTierBtn.style.display = '';
    tierCostEl.textContent = formatNumber(tierDef.unlockCost);
    unlockTierBtn.disabled = state.currency < tierDef.unlockCost;
  } else {
    unlockTierBtn.style.display = 'none';
  }
}

function updateStats() {
  statsContentEl.innerHTML = `
    <div class="stat-row"><span class="stat-label">Total taps</span><span class="stat-value">${formatNumber(state.stats.totalTaps)}</span></div>
    <div class="stat-row"><span class="stat-label">Total earned</span><span class="stat-value">${formatNumber(state.totalEarned)}</span></div>
    <div class="stat-row"><span class="stat-label">Best combo</span><span class="stat-value">${state.stats.bestCombo}</span></div>
    <div class="stat-row"><span class="stat-label">Keys unlocked</span><span class="stat-value">${getUnlockedKeys().length} / ${ALL_KEYS.length}</span></div>
    <div class="stat-row"><span class="stat-label">Tier</span><span class="stat-value">${state.tierUnlocked} / ${KEY_TIERS.length}</span></div>
  `;
}

function updateAccuracy() {
  perfectCountEl.textContent = accuracyCounts.perfect;
  goodCountEl.textContent = accuracyCounts.good;
  okCountEl.textContent = accuracyCounts.ok;
  missCountEl.textContent = accuracyCounts.miss;
}

function showFeedback(type, earned) {
  const labels = { perfect: 'PERFECT!', good: 'Good!', ok: 'OK', miss: 'Miss' };
  const classes = {
    perfect: 'feedback-perfect',
    good: 'feedback-good',
    ok: 'feedback-ok',
    miss: 'feedback-miss',
  };

  tapFeedbackEl.textContent = labels[type] + (earned > 0 ? ' +' + formatNumber(earned) : '');
  tapFeedbackEl.className = classes[type];

  clearTimeout(tapFeedbackEl._timer);
  tapFeedbackEl._timer = setTimeout(() => {
    tapFeedbackEl.textContent = '';
    tapFeedbackEl.className = '';
  }, 600);
}

// --- Events ---
// Listen btn = pick a different source
listenBtn.addEventListener('click', startCapture);
stopBtn.addEventListener('click', stopListening);

document.addEventListener('keydown', (e) => {
  if (e.repeat) return;

  // Map arrow keys and numpad to game keys
  const KEY_MAP = {
    'ArrowLeft':  'a', 'ArrowUp':  'w', 'ArrowDown': 's', 'ArrowRight': 'd',
    'Numpad7': 'q', 'Numpad8': 'w', 'Numpad9': 'e',
    'Numpad4': 'a', 'Numpad5': 's', 'Numpad6': 'd',
    'Numpad1': 'z', 'Numpad2': 'x', 'Numpad3': 'c',
  };

  const key = KEY_MAP[e.code] || KEY_MAP[e.key] || e.key.toLowerCase();

  if (ALL_KEYS.includes(key)) {
    e.preventDefault();
    onKeyPress(key);
  }
});

keyUpgradesEl.addEventListener('click', (e) => {
  const btn = e.target.closest('.upgrade-btn');
  if (!btn) return;
  const key = btn.dataset.key;
  const result = upgradeKey(state, key);
  if (result.success) {
    state = result.state;
    updateCurrency();
    updateUpgrades();
  }
});

unlockTierBtn.addEventListener('click', () => {
  const result = unlockTier(state);
  if (result.success) {
    state = result.state;
    rebuildLanes();
    updateCurrency();
    updateUpgrades();
  }
});

hireDancerBtn.addEventListener('click', () => {
  const result = hireDancer(state);
  if (result.success) {
    state = result.state;
    syncDancerCooldowns();
    updateCurrency();
    updateDancerPanel();
    updateUpgrades();
  }
});

upgradeDancerBtn.addEventListener('click', () => {
  const result = upgradeDancers(state);
  if (result.success) {
    state = result.state;
    updateCurrency();
    updateDancerPanel();
    updateUpgrades();
  }
});

// --- Save/Load ---
async function saveGame() {
  await window.clicktrack.saveGame(state);
}

async function loadGame() {
  const saved = await window.clicktrack.loadGame();
  if (saved) state = saved;
}

// --- Init ---
async function init() {
  await loadGame();
  if (!state.dancers) state.dancers = { count: 0, level: 1 };
  syncDancerCooldowns();
  rebuildLanes();
  updateCurrency();
  updateUpgrades();
  updateDancerPanel();
  updateStats();
  updateAccuracy();
  updateCombo();
  // Show listen button immediately so user can always trigger capture
  listenBtn.style.display = '';

  // Start default metronome immediately so notes appear right away,
  // then attempt to grab system audio in the background
  startDefaultLoop();
  startCapture();

  saveInterval = setInterval(() => {
    saveGame();
    updateUpgrades();
    updateDancerPanel();
    updateStats();
  }, 30000);
}

init();
