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
const sourcePickerOverlay = $('#source-picker-overlay');
const sourceList = $('#source-list');
const sourceCancelBtn = $('#source-cancel-btn');

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
const KEY_ARROWS = { q: '↖', w: '↑', e: '↗', a: '←', s: '↓', d: '→', z: '↙', x: '⬇', c: '↘' };
// Map each key to a clip-path arrow direction (diagonals have their own shapes — no rotation needed)
const KEY_DIR = { w: 'up', s: 'down', a: 'left', d: 'right', q: 'upleft', e: 'upright', z: 'downleft', x: 'down', c: 'downright' };
const KEY_ROT = {};

function createArrowEl(key) {
  const dir = KEY_DIR[key] || 'up';
  const rot = KEY_ROT[key] || 0;
  const wrap = document.createElement('div');
  wrap.classList.add('arrow-wrap');
  if (rot !== 0) wrap.style.transform = `rotate(${rot}deg)`;
  const outer = document.createElement('div');
  outer.classList.add('arrow-outer', `arrow-${dir}`);
  const inner = document.createElement('div');
  inner.classList.add('arrow-inner', `arrow-${dir}`);
  wrap.appendChild(outer);
  wrap.appendChild(inner);
  return wrap;
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
async function openSourcePicker() {
  beatCounterEl.textContent = 'Loading sources...';
  const sources = await window.clicktrack.getSources();

  sourceList.innerHTML = '';
  for (const src of sources) {
    const item = document.createElement('div');
    item.className = 'source-item';
    item.innerHTML = `
      <img src="${src.thumbnail}" alt="">
      <span>${src.name}</span>
    `;
    item.addEventListener('click', async () => {
      await window.clicktrack.setSource(src.id);
      sourcePickerOverlay.style.display = 'none';
      await startCapture();
    });
    sourceList.appendChild(item);
  }

  sourcePickerOverlay.style.display = 'flex';
}

sourceCancelBtn.addEventListener('click', () => {
  sourcePickerOverlay.style.display = 'none';
  beatCounterEl.textContent = 'Play some music and click Listen';
});

// --- Audio Capture ---
async function startListening() {
  await openSourcePicker();
}

async function startCapture() {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true,
    });

    stream.getVideoTracks().forEach((t) => t.stop());

    if (stream.getAudioTracks().length === 0) {
      console.error('No audio track in capture stream');
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

    listenBtn.style.display = '';
    stopBtn.style.display = '';
    beatCounterEl.textContent = 'Listening...';

    // gameLoop may already be running from startDefaultLoop — don't double-start
    if (!animFrameId) gameLoop();
  } catch (e) {
    console.error('Failed to capture audio:', e);
    beatCounterEl.textContent = 'Capture failed — try again';
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
function spawnNote(now) {
  const unlocked = getUnlockedKeys();
  if (unlocked.length === 0) return;

  const key = unlocked[Math.floor(Math.random() * unlocked.length)];
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

    // Missed — past the hit zone by threshold
    const pastHitMs = now - note.hitTime;
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
listenBtn.addEventListener('click', openSourcePicker);
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
  rebuildLanes();
  updateCurrency();
  updateUpgrades();
  updateStats();
  updateAccuracy();
  updateCombo();
  // Start default metronome immediately so notes appear right away,
  // then attempt to grab system audio in the background
  startDefaultLoop();
  startCapture();

  saveInterval = setInterval(() => {
    saveGame();
    updateUpgrades();
    updateStats();
  }, 30000);
}

init();
