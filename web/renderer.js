// Clicktrack renderer — web version for galaxy.click
// game.js globals (createDefaultState, processTap, etc.) loaded via script tag

// --- State ---
let state = createDefaultState();
let isListening = false;
let audioContext = null;
let analyserNode = null;
let mediaStream = null;
let saveInterval = null;
let animFrameId = null;

// Buy mode for bulk upgrades: '1x', '10x', '100x', 'max'
let buyMode = '1x';

// Audio sync calibration. Positive ms = treat onsets as having occurred this much later
// (use when audio reaches your ears AFTER it's detected, e.g. Bluetooth/monitor latency).
// Negative = onsets are treated as earlier. Future settings panel will expose this.
let audioOffsetMs = 0;

// Onset detection
const ENERGY_HISTORY_SIZE = 43;
const ONSET_THRESHOLD = 1.3;
const ONSET_COOLDOWN_MS = 200;
const MIN_ENERGY = 0.003;
// Onsets at or above this magnitude (rms / rolling avg) spawn a 2-note chord
const CHORD_MAGNITUDE_THRESHOLD = 1.8;
let energyHistory = [];
let lastOnsetTime = 0;
let totalBeatsDetected = 0;

// Rolling buffer of recent onset timestamps for live BPM estimation
const BPM_HISTORY_SIZE = 16;
const BPM_MIN = 60;
const BPM_MAX = 200;
let onsetTimes = [];
let detectedBPM = 0;

// Default song (always-on metronome when no audio is detected)
let currentBPM = 90;
let bpmEarningsMult = 1.0;
let lastDefaultBeatTime = 0;

// Grace period — notes spawned in the first few seconds don't penalize
const GRACE_PERIOD_MS = 3000;
let gameStartTime = 0;

// Note track
// Base travel time at 1x. The live value comes from getScrollTimeMs(), so raising
// hyperspeed shortens travel and spreads consecutive beats further apart on screen.
const BASE_SCROLL_TIME_MS = 2500;   // notes take 2.5s to scroll top → hit zone
let HIT_PERFECT_MS = 80;     // ±80ms = perfect
let HIT_GOOD_MS = 160;       // ±160ms = good
let HIT_OK_MS = 280;         // ±280ms = ok
let MISS_THRESHOLD_MS = 380; // past hit zone by this → miss
let activeNotes = [];
let noteIdCounter = 0;

// Combo & accuracy
let playerStreak = 0;
let dancerStreak = 0;
let accuracyCounts = { perfect: 0, good: 0, ok: 0, miss: 0 };
let PASSIVE_PER_BEAT = 0.1;

// --- Chord detection (two cardinals → diagonal) ---
const CHORD_MAP = {
  'a+w': 'q', 'w+a': 'q',  // left + up    = up-left
  'd+w': 'e', 'w+d': 'e',  // right + up   = up-right
  'a+s': 'z', 's+a': 'z',  // left + down  = down-left
  'd+s': 'c', 's+d': 'c',  // right + down = down-right
};
const CHORD_WINDOW_MS = 80;
let pendingCardinal = null; // { key, timestamp, timerId }

// --- Input method detection ---
const INPUT_HISTORY_SIZE = 5;
let recentInputCodes = []; // raw e.code values
let detectedInputMethod = 'keyboard'; // 'keyboard' | 'arrows' | 'numpad'

const DISPLAY_NAMES = {
  keyboard: { w: 'W', a: 'A', s: 'S', d: 'D', q: 'Q', e: 'E', z: 'Z', c: 'C' },
  arrows:   { w: '\u2191', a: '\u2190', s: '\u2193', d: '\u2192', q: '\u2196', e: '\u2197', z: '\u2199', c: '\u2198' },
  numpad:   { w: '8', a: '4', s: '5', d: '6', q: '7', e: '9', z: '1', c: '3' },
};

function getKeyDisplayName(key) {
  return DISPLAY_NAMES[detectedInputMethod]?.[key] ?? key.toUpperCase();
}

function detectInputMethod() {
  if (recentInputCodes.length === 0) return;
  const arrowCodes = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
  const numpadCodes = ['Numpad1', 'Numpad2', 'Numpad3', 'Numpad4', 'Numpad5', 'Numpad6', 'Numpad7', 'Numpad8', 'Numpad9'];
  const arrows = recentInputCodes.filter(c => arrowCodes.includes(c)).length;
  const numpads = recentInputCodes.filter(c => numpadCodes.includes(c)).length;
  const letters = recentInputCodes.length - arrows - numpads;
  const prev = detectedInputMethod;
  if (arrows > letters && arrows >= numpads) detectedInputMethod = 'arrows';
  else if (numpads > letters && numpads > arrows) detectedInputMethod = 'numpad';
  else detectedInputMethod = 'keyboard';
  if (detectedInputMethod !== prev) {
    updateUpgrades();
    updateLaneLabels();
  }
}

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

// Audio guide
const audioGuideEl = $('#audio-guide');
const audioGuideStatusEl = $('#audio-guide-status');
const audioGuideCloseBtn = $('#audio-guide-close');
const audioHelpBtn = $('#audio-help-btn');

const dancerFiguresEl = $('#dancer-figures');
const hireDancerBtn = $('#hire-dancer-btn');
const hireDancerCostEl = $('#dancer-hire-cost');
const upgradeDancerBtn = $('#upgrade-dancer-btn');
const upgradeDancerCostEl = $('#dancer-upgrade-cost');
const dancerAccuracyLabelEl = $('#dancer-accuracy-label');

// Prestige DOM refs
const prestigeStarsEl = $('#prestige-stars');
const prestigeMultiplierEl = $('#prestige-multiplier');
const prestigeCountEl = $('#prestige-count');
const prestigePendingEl = $('#prestige-pending');
const prestigeGainEl = $('#prestige-gain');
const prestigeBtn = $('#prestige-btn');
const prestigeHintEl = $('#prestige-hint');

// Achievement DOM refs
const achievementListEl = $('#achievement-list');
const achievementCounterEl = $('#achievement-counter');

// --- Tab switching ---
document.querySelectorAll('.side-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.side-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    const pane = document.querySelector(`.tab-pane[data-tab="${tab.dataset.tab}"]`);
    if (pane) pane.classList.add('active');
  });
});

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

// Lane order matches physical keyboard position left-to-right (QWERTY x-offsets),
// with W and S swapped so the down arrow sits on the middle-left and up arrow on the middle-right
const LANE_ORDER = ['q', 'z', 'a', 's', 'w', 'd', 'e', 'c'];
const KEY_ANGLE = { w: 0, d: 90, s: 180, a: 270, e: 45, c: 135, z: 225, q: 315 };
const KEY_COLOR = { a: '#ff4455', w: '#44dd77', s: '#4499ff', d: '#ffdd33', q: '#cc44ff', e: '#ff8833', z: '#ff44cc', c: '#44ffcc' };
const KEY_GLOW  = { a: 'rgba(255,68,85,0.9)', w: 'rgba(68,221,119,0.9)', s: 'rgba(68,153,255,0.9)', d: 'rgba(255,221,51,0.9)', q: 'rgba(204,68,255,0.9)', e: 'rgba(255,136,51,0.9)', z: 'rgba(255,68,204,0.9)', c: 'rgba(68,255,204,0.9)' };
// DDR-style arrow: wide head, narrow stem, clean proportions
const ARROW_SHAPE = 'M 50,4 L 92,46 L 66,46 L 66,96 L 34,96 L 34,46 L 8,46 Z';

function createArrowEl(key, isTarget) {
  const angle = KEY_ANGLE[key] ?? 0;
  const color = KEY_COLOR[key] || '#ffffff';
  const glow  = KEY_GLOW[key]  || 'rgba(255,255,255,0.5)';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 100 100');

  const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  if (angle !== 0) g.setAttribute('transform', `rotate(${angle}, 50, 50)`);

  if (isTarget) {
    // Hollow ghost arrow at the hit zone
    svg.style.opacity = '0.35';
    const outline = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    outline.setAttribute('d', ARROW_SHAPE);
    outline.setAttribute('fill', 'none');
    outline.setAttribute('stroke', color);
    outline.setAttribute('stroke-width', '2.5');
    outline.setAttribute('stroke-linejoin', 'round');
    g.appendChild(outline);
  } else {
    // Solid filled arrow for scrolling notes
    svg.style.filter = `drop-shadow(0 0 6px ${glow})`;
    const fill = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    fill.setAttribute('d', ARROW_SHAPE);
    fill.setAttribute('fill', color);
    fill.setAttribute('stroke', '#111122');
    fill.setAttribute('stroke-width', '3');
    fill.setAttribute('stroke-linejoin', 'round');
    g.appendChild(fill);
  }

  svg.appendChild(g);
  return svg;
}

// --- Lane Management ---
function rebuildLanes() {
  const unlocked = getUnlockedKeys();
  const sorted = LANE_ORDER.filter((k) => unlocked.includes(k));
  lanesContainer.innerHTML = '';
  laneLabels.innerHTML = '';
  lanesContainer.dataset.count = sorted.length;
  laneLabels.dataset.count = sorted.length;

  for (const key of sorted) {
    const lane = document.createElement('div');
    lane.className = 'lane';
    lane.dataset.key = key;
    lanesContainer.appendChild(lane);

    const label = document.createElement('div');
    label.className = `lane-label lane-label-key-${key}`;
    label.dataset.key = key;
    if (detectedInputMethod === 'keyboard') {
      const labelArrow = createArrowEl(key, true);
      labelArrow.classList.add('label-arrow');
      label.appendChild(labelArrow);
    } else {
      const txt = document.createElement('span');
      txt.className = 'lane-label-text';
      txt.textContent = getKeyDisplayName(key);
      label.appendChild(txt);
    }
    laneLabels.appendChild(label);
  }
}

function updateLaneLabels() {
  const labels = laneLabels.querySelectorAll('.lane-label');
  labels.forEach((label) => {
    const key = label.dataset.key;
    label.innerHTML = '';
    if (detectedInputMethod === 'keyboard') {
      const labelArrow = createArrowEl(key, true);
      labelArrow.classList.add('label-arrow');
      label.appendChild(labelArrow);
    } else {
      const txt = document.createElement('span');
      txt.className = 'lane-label-text';
      txt.textContent = getKeyDisplayName(key);
      label.appendChild(txt);
    }
  });
}

// --- Audio Setup Guide ---
function showAudioGuide() {
  audioGuideEl.style.display = '';
  setGuideStep(1);
  setGuideStatus('', '');
}

function hideAudioGuide() {
  audioGuideEl.style.display = 'none';
}

function setGuideStep(activeStep) {
  const steps = audioGuideEl.querySelectorAll('.guide-step');
  steps.forEach((el) => {
    const s = parseInt(el.dataset.step);
    el.classList.remove('active', 'done');
    if (s < activeStep) el.classList.add('done');
    else if (s === activeStep) el.classList.add('active');
  });
}

function setGuideStatus(msg, level) {
  audioGuideStatusEl.className = '';
  if (!msg) {
    audioGuideStatusEl.style.display = 'none';
    return;
  }
  audioGuideStatusEl.textContent = msg;
  audioGuideStatusEl.className = `status-${level}`;
  audioGuideStatusEl.style.display = 'block';
}

function hasSeenAudioGuide() {
  return localStorage.getItem('clicktrack_audio_guide_done') === '1';
}

function markAudioGuideDone() {
  localStorage.setItem('clicktrack_audio_guide_done', '1');
}

// --- Audio Capture (system audio via getDisplayMedia, mic fallback) ---
async function startCapture() {
  if (isListening) stopListening();

  // Show guide on first use, or if already visible keep it open
  const guideVisible = audioGuideEl.style.display !== 'none';
  if (!hasSeenAudioGuide() || guideVisible) {
    showAudioGuide();
    setGuideStep(3); // step 1-2 done (music playing + clicked button)
  }

  listenBtn.style.display = 'none';
  beatCounterEl.textContent = 'Pick a tab playing music and check "Share audio"';

  let stream = null;
  let usedDisplayMedia = false;

  try {
    if (guideVisible || !hasSeenAudioGuide()) setGuideStep(3);
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true,
    });

    // Drop the video track, we only need audio
    stream.getVideoTracks().forEach((t) => t.stop());

    if (stream.getAudioTracks().length === 0) {
      // User shared a tab but did NOT check "Share audio"
      stream = null;
      if (audioGuideEl.style.display !== 'none') {
        setGuideStep(4);
        setGuideStatus('No audio track detected. Did you check "Share audio" in the picker?', 'warn');
      }
    } else {
      usedDisplayMedia = true;
    }
  } catch (e) {
    console.warn('getDisplayMedia failed, trying mic fallback:', e.message);
    stream = null;
    if (audioGuideEl.style.display !== 'none') {
      setGuideStatus('Tab sharing cancelled or unavailable. Trying microphone...', 'warn');
    }
  }

  // Fallback: microphone input (captures system audio via stereo mix / loopback)
  if (!stream) {
    try {
      beatCounterEl.textContent = 'Trying microphone...';
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e2) {
      console.error('All audio capture failed:', e2);
      beatCounterEl.textContent = 'Audio capture failed - using metronome';
      listenBtn.style.display = '';
      if (audioGuideEl.style.display !== 'none') {
        setGuideStatus('Could not access any audio source. Check browser permissions, or just use the metronome.', 'error');
      }
      return;
    }
  }

  if (!stream || stream.getAudioTracks().length === 0) {
    beatCounterEl.textContent = 'No audio - using metronome';
    listenBtn.style.display = '';
    if (audioGuideEl.style.display !== 'none') {
      setGuideStatus('No audio track found. Make sure "Share audio" is checked when picking a tab.', 'warn');
    }
    return;
  }

  try {
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
    onsetTimes = [];
    detectedBPM = 0;

    // If the shared tab/screen ends, stop gracefully
    stream.getAudioTracks()[0].addEventListener('ended', () => {
      stopListening();
    });

    listenBtn.style.display = 'none';
    stopBtn.style.display = '';
    beatCounterEl.textContent = 'Listening...';
    buildBPMSelector();

    // Guide success
    if (audioGuideEl.style.display !== 'none') {
      setGuideStep(6); // all done
      if (usedDisplayMedia) {
        setGuideStatus('Audio connected! Notes will now sync to the beat of your music.', 'ok');
      } else {
        setGuideStatus('Connected via microphone. For best results, try tab sharing next time.', 'ok');
      }
      markAudioGuideDone();
      // Auto-close guide after 3 seconds on success
      setTimeout(() => {
        if (isListening) hideAudioGuide();
      }, 3000);
    }

    if (!animFrameId) gameLoop();
  } catch (e) {
    console.error('Audio setup failed:', e);
    beatCounterEl.textContent = 'Audio error - using metronome';
    listenBtn.style.display = '';
    if (audioGuideEl.style.display !== 'none') {
      setGuideStatus('Audio setup failed: ' + e.message, 'error');
    }
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

  for (const note of activeNotes) {
    if (note.element.parentNode) note.element.parentNode.removeChild(note.element);
  }
  activeNotes = [];

  listenBtn.style.display = '';
  stopBtn.style.display = 'none';
  vuFill.style.width = '0%';
  beatCounterEl.textContent = 'Stopped';
  onsetTimes = [];
  detectedBPM = 0;
  buildBPMSelector();

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
  if (energyHistory.length < 5) return 0;

  const avg = energyHistory.reduce((a, b) => a + b, 0) / energyHistory.length;
  const now = performance.now();

  if (rms > avg * ONSET_THRESHOLD && avg > MIN_ENERGY && now - lastOnsetTime > ONSET_COOLDOWN_MS) {
    lastOnsetTime = now;
    // Return magnitude (rms relative to rolling baseline). Higher = bigger hit.
    return rms / avg;
  }
  return 0;
}

// --- Note Spawning ---
const KEY_SPAWN_WEIGHT = { w: 4, a: 4, s: 4, d: 4, q: 1, e: 1, z: 1, c: 1 };

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

function spawnNote(now, excludeKey = null) {
  const allUnlocked = getUnlockedKeys();
  const unlocked = excludeKey ? allUnlocked.filter((k) => k !== excludeKey) : allUnlocked;
  if (unlocked.length === 0) return null;

  const key = weightedKey(unlocked);
  // Apply audio sync offset to where the note should LAND on the hit line
  const hitTime = now + getScrollTimeMs(BASE_SCROLL_TIME_MS, state.hyperspeed) + audioOffsetMs;

  const lane = lanesContainer.querySelector(`.lane[data-key="${key}"]`);
  if (!lane) return null;

  const noteEl = createArrowEl(key);
  noteEl.classList.add('note', `note-key-${key}`);
  if (excludeKey) noteEl.classList.add('chord-note');
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
  return key;
}

// --- Game Loop ---
function gameLoop() {
  const now = performance.now();

  const beatIntervalMs = (60 / currentBPM) * 1000;
  const onsetMagnitude = isListening ? detectOnset() : 0;
  const audioOnset = onsetMagnitude > 0;
  const defaultBeat = !isListening && (now - lastDefaultBeatTime >= beatIntervalMs);

  if (audioOnset || defaultBeat) {
    if (defaultBeat) lastDefaultBeatTime = now;
    if (audioOnset) updateDetectedBPM(now);
    totalBeatsDetected++;
    beatCounterEl.textContent = totalBeatsDetected + ' beats';

    const passive = PASSIVE_PER_BEAT * state.prestige.multiplier * bpmEarningsMult;
    state.currency += passive;
    state.totalEarned += passive;
    updateCurrency();

    document.getElementById('app').classList.add('pulse');
    setTimeout(() => document.getElementById('app').classList.remove('pulse'), 150);

    const firstKey = spawnNote(now);
    // Chord on big hits (audio mode only): spawn a second simultaneous note
    if (audioOnset && onsetMagnitude >= CHORD_MAGNITUDE_THRESHOLD && firstKey) {
      spawnNote(now, firstKey);
    }
  }

  for (let i = activeNotes.length - 1; i >= 0; i--) {
    const note = activeNotes[i];
    if (note.hit) continue;

    const travelMs = note.hitTime - note.spawnTime;
    const elapsed = now - note.spawnTime;
    const progress = elapsed / travelMs;

    const topPercent = progress * 100;
    note.element.style.top = topPercent + '%';
    note.element.style.opacity = Math.min(1, progress * 2);

    const pastHitMs = now - note.hitTime;

    // Dancers only step in AFTER the player's full hit window passes (fallback, not autopilot)
    if (pastHitMs > HIT_OK_MS && state.dancers && state.dancers.count > 0) {
      const di = dancerCooldowns.findIndex((cd) => cd <= now);
      if (di !== -1) {
        dancerCooldowns[di] = now + 400;
        // The player failed to hit in time -> their skill streak breaks
        if (playerStreak > 0) {
          playerStreak = 0;
          updateCombo();
        }
        autoDancerHit(note);
        activeNotes.splice(i, 1);
        continue;
      }
    }

    if (pastHitMs > MISS_THRESHOLD_MS) {
      // During grace period, silently remove instead of penalizing
      if (now - gameStartTime < GRACE_PERIOD_MS) {
        if (note.element.parentNode) note.element.parentNode.removeChild(note.element);
      } else {
        onNoteMiss(note);
      }
      activeNotes.splice(i, 1);
    }
  }

  // Hide onboarding hint after first successful hit
  if (accuracyCounts.perfect + accuracyCounts.good + accuracyCounts.ok > 0) {
    const hint = document.getElementById('onboarding-hint');
    if (hint) hint.remove();
  }

  animFrameId = requestAnimationFrame(gameLoop);
}

function startDefaultLoop() {
  if (animFrameId) return;
  gameStartTime = performance.now();
  lastDefaultBeatTime = performance.now();
  gameLoop();
}

// --- Input ---
function classifyTiming(offsetMs) {
  const abs = Math.abs(offsetMs);
  if (abs <= HIT_PERFECT_MS) return 'perfect';
  if (abs <= HIT_GOOD_MS) return 'good';
  if (abs <= HIT_OK_MS) return 'ok';
  return null;
}

function flashLane(key) {
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

  flashLane(key);

  const now = performance.now();

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

  if (!bestNote) { onWhiff(key); return; }

  const offset = now - bestNote.hitTime;
  const accuracy = classifyTiming(offset);

  if (!accuracy) {
    // Pressed near a note but outside even the "ok" window. Consume the note as a
    // miss so it can't later also register as a scroll-past miss (no double penalty).
    bestNote.hit = true;
    bestNote.element.classList.add('note-miss');
    setTimeout(() => {
      if (bestNote.element.parentNode) bestNote.element.parentNode.removeChild(bestNote.element);
      const idx = activeNotes.indexOf(bestNote);
      if (idx >= 0) activeNotes.splice(idx, 1);
    }, 200);
    onWhiff(key);
    return;
  }

  bestNote.hit = true;

  bestNote.element.classList.add('note-hit');
  setTimeout(() => {
    if (bestNote.element.parentNode) bestNote.element.parentNode.removeChild(bestNote.element);
    const idx = activeNotes.indexOf(bestNote);
    if (idx >= 0) activeNotes.splice(idx, 1);
  }, 150);

  playerStreak++;
  const result = processTap(state, key, accuracy, { source: 'player', externalCombo: playerStreak });
  // Apply BPM earnings multiplier
  if (bpmEarningsMult !== 1) {
    const bonus = result.earned * (bpmEarningsMult - 1);
    state.currency += bonus;
    state.totalEarned += bonus;
    result.earned *= bpmEarningsMult;
  }
  showFeedback(accuracy, result.earned);
  accuracyCounts[accuracy]++;

  updateCurrency();
  updateCombo();
  updateAccuracy();
  updateStats();
  runAchievementCheck();
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

  const hireCost = getDancerHireCost(count, state);
  hireDancerCostEl.textContent = formatNumber(hireCost);
  hireDancerBtn.disabled = state.currency < hireCost;

  if (level >= 3) {
    upgradeDancerBtn.style.display = 'none';
  } else {
    upgradeDancerBtn.style.display = '';
    const upgradeCost = getDancerUpgradeCost(level);
    upgradeDancerCostEl.textContent = formatNumber(upgradeCost);
    upgradeDancerBtn.disabled = state.currency < upgradeCost;
  }

  const ACC_LABEL = { ok: 'OK', good: 'GOOD', perfect: 'PERFECT' };
  const ACC_CLASS = { ok: 'acc-ok', good: 'acc-good', perfect: 'acc-perfect' };
  const acc = getDancerAccuracy(level);
  dancerAccuracyLabelEl.innerHTML = count > 0
    ? `<span class="${ACC_CLASS[acc]}">${count} dancer${count !== 1 ? 's' : ''} &middot; ${ACC_LABEL[acc]}</span>`
    : '<span class="hint">No dancers yet</span>';

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
  dancerStreak++;
  const result = processTap(state, note.key, accuracy, { source: 'dancer', externalCombo: dancerStreak });
  // Apply BPM multiplier
  let earned = result.earned * bpmEarningsMult;
  if (bpmEarningsMult !== 1) {
    const bonus = result.earned * (bpmEarningsMult - 1);
    state.currency += bonus;
    state.totalEarned += bonus;
  }
  showFeedback(accuracy, earned);
  accuracyCounts[accuracy]++;
  updateCurrency();
  updateCombo();
  updateAccuracy();
  updateStats();
  runAchievementCheck();
}

function onNoteMiss(note) {
  note.element.classList.add('note-miss');
  setTimeout(() => {
    if (note.element.parentNode) note.element.parentNode.removeChild(note.element);
  }, 200);

  // True miss: no dancer was available to save it. Both streaks reset.
  playerStreak = 0;
  dancerStreak = 0;
  if (state.keys[note.key]?.unlocked) {
    processMiss(state, note.key);
  }
  accuracyCounts.miss++;
  showFeedback('miss', 0);
  updateCombo();
  updateAccuracy();
}

// A key press that lands on no note (mashing or a badly mistimed tap) counts as a
// miss: it breaks the player's skill streak. Dancers run on their own streak, so a
// player whiff leaves dancerStreak untouched.
function onWhiff(key) {
  playerStreak = 0;
  if (state.keys[key]?.unlocked) {
    processMiss(state, key);
  }
  accuracyCounts.miss++;
  showFeedback('miss', 0);
  updateCombo();
  updateAccuracy();
  updateStats();
}

// --- UI ---
let lastUpgradeRefreshCurrency = -1;

function updateCurrency() {
  currencyEl.textContent = formatNumber(state.currency);

  const nextTier = state.tierUnlocked + 1;
  const nextTierDef = KEY_TIERS.find((t) => t.tier === nextTier);
  if (nextTierDef) {
    unlockTierBtn.disabled = state.currency < nextTierDef.unlockCost;
  }
  if (state.dancers) {
    hireDancerBtn.disabled = state.currency < getDancerHireCost(state.dancers.count, state);
    if (state.dancers.level < 3) {
      upgradeDancerBtn.disabled = state.currency < getDancerUpgradeCost(state.dancers.level);
    }
  }
  updatePrestigePanel();

  // Refresh upgrade rows when currency crosses an upgrade cost threshold
  const rounded = Math.floor(state.currency);
  if (rounded !== lastUpgradeRefreshCurrency) {
    lastUpgradeRefreshCurrency = rounded;
    refreshUpgradeAffordability();
  }
}

function updateCombo() {
  // Primary combo display = player's earned skill streak
  comboCountEl.textContent = playerStreak;
  comboMultEl.textContent = '\u00d7' + getComboMultiplier(playerStreak, state);

  const autoEl = document.getElementById('auto-count');
  const autoTrack = document.getElementById('combo-auto');
  if (autoEl) {
    // Show dancer streak with their (possibly capped) multiplier
    let dancerMult = getComboMultiplier(dancerStreak, state);
    if (!hasPrestigeUpgrade(state, 'dance_captain')) dancerMult = Math.min(dancerMult, 3);
    autoEl.textContent = dancerStreak + ' \u00d7' + dancerMult;
  }
  if (autoTrack) {
    autoTrack.classList.toggle('combo-leading', dancerStreak > playerStreak);
  }
}

// Lightweight refresh: update cost/label/affordability on existing upgrade rows without full rebuild
function refreshUpgradeAffordability() {
  const rows = keyUpgradesEl.querySelectorAll('.key-upgrade');
  for (const row of rows) {
    const key = row.dataset.key;
    if (!key) continue;
    const ks = state.keys[key];
    if (!ks) continue;

    let count, cost, label;
    if (buyMode === 'Max') {
      count = getMaxAffordableUpgrades(state, key);
      cost = count > 0 ? getBulkUpgradeCost(ks.level, count) : getKeyUpgradeCost(ks.level);
      label = count > 0 ? `MAX (${count})` : '\u{1F512}';
    } else {
      count = parseInt(buyMode);
      cost = getBulkUpgradeCost(ks.level, count);
      label = state.currency >= cost ? `UPGRADE ${buyMode}` : '\u{1F512}';
    }
    const canAfford = buyMode === 'Max' ? count > 0 : state.currency >= cost;

    const costEl = row.querySelector('.key-upgrade-cost');
    const actionEl = row.querySelector('.key-upgrade-action');
    if (costEl) costEl.textContent = formatNumber(cost) + ' beats';
    if (actionEl) actionEl.textContent = label;

    const wasAffordable = row.classList.contains('affordable');
    if (canAfford !== wasAffordable) {
      row.classList.toggle('affordable', canAfford);
      // Re-attach or remove click handler by triggering a full rebuild
      updateUpgrades();
      return;
    }
  }
}

function updateUpgrades() {
  keyUpgradesEl.innerHTML = '';

  // Buy-mode toggle bar
  const modeBar = document.createElement('div');
  modeBar.className = 'buy-mode-bar';
  for (const mode of ['1x', '10x', '100x', 'Max']) {
    const btn = document.createElement('button');
    btn.className = 'buy-mode-btn' + (buyMode === mode ? ' active' : '');
    btn.textContent = mode;
    btn.addEventListener('click', () => {
      buyMode = mode;
      updateUpgrades();
    });
    modeBar.appendChild(btn);
  }
  keyUpgradesEl.appendChild(modeBar);

  for (const key of getUnlockedKeys()) {
    const ks = state.keys[key];
    let count, cost, label;
    if (buyMode === 'Max') {
      count = getMaxAffordableUpgrades(state, key);
      cost = count > 0 ? getBulkUpgradeCost(ks.level, count) : getKeyUpgradeCost(ks.level);
      label = count > 0 ? `MAX (${count})` : '\u{1F512}';
    } else {
      count = parseInt(buyMode);
      cost = getBulkUpgradeCost(ks.level, count);
      label = state.currency >= cost ? `UPGRADE ${buyMode}` : '\u{1F512}';
    }
    const canAfford = buyMode === 'Max' ? count > 0 : state.currency >= cost;

    const div = document.createElement('div');
    div.className = 'key-upgrade' + (canAfford ? ' affordable' : '');
    div.dataset.key = key;
    div.innerHTML = `
      <span class="key-upgrade-label">${getKeyDisplayName(key)}</span>
      <span class="key-upgrade-info">
        <span class="key-upgrade-level">Level ${ks.level}</span>
        <span class="key-upgrade-cost">${formatNumber(cost)} beats</span>
      </span>
      <span class="key-upgrade-action">${label}</span>
    `;
    if (canAfford) {
      div.addEventListener('click', () => {
        const result = buyMode === '1x'
          ? upgradeKey(state, key)
          : upgradeKeyBulk(state, key, buyMode === 'Max' ? getMaxAffordableUpgrades(state, key) : parseInt(buyMode));
        if (result.success) {
          state = result.state;
          updateCurrency();
          updateUpgrades();
          saveGame();
        }
      });
    }
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
  const bpmLabel = currentBPM + ' BPM (' + bpmEarningsMult + 'x)';
  statsContentEl.innerHTML = `
    <div class="stat-row"><span class="stat-label">Hits</span><span class="stat-value">${formatNumber(state.stats.totalTaps)}</span></div>
    <div class="stat-row"><span class="stat-label">Total earned</span><span class="stat-value">${formatNumber(state.totalEarned)}</span></div>
    <div class="stat-row"><span class="stat-label">Best combo</span><span class="stat-value">${state.stats.bestCombo}</span></div>
    <div class="stat-row"><span class="stat-label">Keys unlocked</span><span class="stat-value">${getUnlockedKeys().length} / ${ALL_KEYS.length}</span></div>
    <div class="stat-row"><span class="stat-label">Tier</span><span class="stat-value">${state.tierUnlocked} / ${KEY_TIERS.length}</span></div>
    <div class="stat-row"><span class="stat-label">Tempo</span><span class="stat-value">${bpmLabel}</span></div>
    <div class="stat-row"><span class="stat-label">Prestiges</span><span class="stat-value">${state.prestige.count}</span></div>
    <div class="stat-row"><span class="stat-label">Star upgrades</span><span class="stat-value">${state.prestige.purchasedUpgrades.length} / ${PRESTIGE_UPGRADES.length}</span></div>
  `;
}

function updatePrestigePanel() {
  const stars = state.prestige.stars || 0;
  const mult = state.prestige.multiplier || 1;
  const count = state.prestige.count || 0;
  const pending = getPrestigeGain(state.totalEarned, state);

  prestigeStarsEl.textContent = formatNumber(stars);
  prestigeMultiplierEl.textContent = mult.toFixed(1) + 'x';
  prestigeCountEl.textContent = count;
  prestigePendingEl.textContent = pending;
  prestigeGainEl.textContent = pending;

  prestigeBtn.disabled = pending <= 0;
  prestigeHintEl.style.display = pending > 0 ? 'none' : '';
}

function updateAchievementsPanel() {
  if (!state.achievements) state.achievements = [];
  const unlocked = state.achievements;
  achievementCounterEl.textContent = `(${unlocked.length}/${ACHIEVEMENTS.length})`;

  let html = '';
  for (const ach of ACHIEVEMENTS) {
    const done = unlocked.includes(ach.id);
    html += `<div class="achievement-item ${done ? 'unlocked' : 'locked'}">
      <span class="achievement-icon">${done ? '\u2705' : '\u{1F512}'}</span>
      <div class="achievement-info">
        <div class="achievement-name">${ach.name}</div>
        <div class="achievement-desc">${ach.desc}</div>
      </div>
    </div>`;
  }
  achievementListEl.innerHTML = html;
}

function showAchievementToast(ach) {
  const toast = document.createElement('div');
  toast.className = 'achievement-toast';
  toast.textContent = '\u{1F3C6} ' + ach.name + ' unlocked!';
  document.body.appendChild(toast);
  setTimeout(() => { if (toast.parentNode) toast.remove(); }, 2800);
}

function runAchievementCheck() {
  const newlyUnlocked = checkAchievements(state);
  if (newlyUnlocked.length > 0) {
    for (const ach of newlyUnlocked) showAchievementToast(ach);
    updateAchievementsPanel();
  }
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

  tapFeedbackEl.textContent = labels[type] + (earned > 0 ? ' +' + (earned < 1 ? earned.toFixed(1) : formatNumber(earned)) : '');
  tapFeedbackEl.className = classes[type];

  clearTimeout(tapFeedbackEl._timer);
  tapFeedbackEl._timer = setTimeout(() => {
    tapFeedbackEl.textContent = '';
    tapFeedbackEl.className = '';
  }, 600);
}

// --- Events ---
listenBtn.addEventListener('click', startCapture);
stopBtn.addEventListener('click', stopListening);
audioHelpBtn.addEventListener('click', () => {
  if (audioGuideEl.style.display === 'none') showAudioGuide();
  else hideAudioGuide();
});
audioGuideCloseBtn.addEventListener('click', () => {
  hideAudioGuide();
  markAudioGuideDone();
});

document.addEventListener('keydown', (e) => {
  if (e.repeat) return;

  const KEY_MAP = {
    'ArrowLeft':  'a', 'ArrowUp':  'w', 'ArrowDown': 's', 'ArrowRight': 'd',
    'Numpad7': 'q', 'Numpad8': 'w', 'Numpad9': 'e',
    'Numpad4': 'a', 'Numpad5': 's', 'Numpad6': 'd',
    'Numpad1': 'z', 'Numpad3': 'c',
    '7': 'q', '8': 'w', '9': 'e',
    '4': 'a', '5': 's', '6': 'd',
    '1': 'z', '3': 'c',
  };

  const key = KEY_MAP[e.code] || KEY_MAP[e.key] || e.key.toLowerCase();

  if (ALL_KEYS.includes(key)) {
    e.preventDefault();

    // Track input method
    recentInputCodes.push(e.code);
    if (recentInputCodes.length > INPUT_HISTORY_SIZE) recentInputCodes.shift();
    detectInputMethod();

    const cardinals = ['w', 'a', 's', 'd'];
    const isCardinal = cardinals.includes(key);

    // If a cardinal is pending and this cardinal completes a chord, fire the diagonal
    if (isCardinal && pendingCardinal && pendingCardinal.key !== key) {
      const chordKey = CHORD_MAP[pendingCardinal.key + '+' + key];
      if (chordKey && state.keys[chordKey]?.unlocked) {
        clearTimeout(pendingCardinal.timerId);
        pendingCardinal = null;
        onKeyPress(chordKey);
        return;
      }
    }

    // If this is a cardinal and diagonals are unlocked, buffer it briefly
    if (isCardinal) {
      // Check if any diagonal using this key is unlocked
      const hasDiagonal = cardinals.some(other => {
        if (other === key) return false;
        const dk = CHORD_MAP[key + '+' + other];
        return dk && state.keys[dk]?.unlocked;
      });

      if (hasDiagonal) {
        // Flush any existing pending cardinal first
        if (pendingCardinal) {
          clearTimeout(pendingCardinal.timerId);
          onKeyPress(pendingCardinal.key);
          pendingCardinal = null;
        }
        // Buffer this cardinal
        const timerId = setTimeout(() => {
          if (pendingCardinal && pendingCardinal.key === key) {
            pendingCardinal = null;
            onKeyPress(key);
          }
        }, CHORD_WINDOW_MS);
        pendingCardinal = { key, timestamp: performance.now(), timerId };
        return;
      }
    }

    // Non-cardinal or no diagonals unlocked - fire immediately
    onKeyPress(key);
  }
});

document.addEventListener('keyup', (e) => {
  // no-op, chord detection uses buffering not held-key tracking
});

unlockTierBtn.addEventListener('click', () => {
  const result = unlockTier(state);
  if (result.success) {
    state = result.state;
    rebuildLanes();
    updateCurrency();
    updateUpgrades();
    runAchievementCheck();
    saveGame();
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
    runAchievementCheck();
    saveGame();
  }
});

upgradeDancerBtn.addEventListener('click', () => {
  const result = upgradeDancers(state);
  if (result.success) {
    state = result.state;
    updateCurrency();
    updateDancerPanel();
    updateUpgrades();
    saveGame();
  }
});

prestigeBtn.addEventListener('click', () => {
  const gain = getPrestigeGain(state.totalEarned, state);
  if (gain <= 0) return;
  if (!confirm(`Prestige for ${gain} star${gain !== 1 ? 's' : ''}? This resets your keys, currency, dancers, and tiers.`)) return;
  const result = performPrestige(state);
  if (result.success) {
    state = result.state;
    playerStreak = 0;
    dancerStreak = 0;
    accuracyCounts = { perfect: 0, good: 0, ok: 0, miss: 0 };
    syncDancerCooldowns();
    rebuildLanes();
    updateCurrency();
    updateUpgrades();
    updateDancerPanel();
    updatePrestigePanel();
    updateStarShop();
    updateStats();
    updateCombo();
    updateAccuracy();
    runAchievementCheck();
    saveGame();
  }
});

// --- Export/Import Buttons ---
document.getElementById('export-save-btn').addEventListener('click', exportSave);
document.getElementById('import-save-btn').addEventListener('click', importSave);

// --- Save/Load (localStorage) ---
const SAVE_KEY = 'clicktrack-save';

function saveGame() {
  try {
    state.lastSaveTime = Date.now();
    localStorage.setItem(SAVE_KEY, JSON.stringify(state));
  } catch (e) {
    console.warn('Save failed:', e);
  }
}

function loadGame() {
  try {
    const saved = localStorage.getItem(SAVE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      const defaults = createDefaultState();
      // Merge top-level fields so new/missing keys always have defaults
      state = Object.assign(defaults, parsed);
      // Ensure every expected key has a valid entry
      for (const key of ALL_KEYS) {
        if (!state.keys[key] || typeof state.keys[key].unlocked !== 'boolean') {
          state.keys[key] = defaults.keys[key];
        }
      }
    }
  } catch (e) {
    console.warn('Load failed, starting fresh:', e);
    state = createDefaultState();
  }
}

// --- Apply prestige upgrade side-effects ---
function applyPrestigeEffects() {
  // Sound Engineer: passive 0.1 -> 0.5
  PASSIVE_PER_BEAT = hasPrestigeUpgrade(state, 'sound_engineer') ? 0.5 : 0.1;

  // Quick Fingers: widen hit windows by 20%
  if (hasPrestigeUpgrade(state, 'quick_fingers')) {
    HIT_PERFECT_MS = 96;
    HIT_GOOD_MS = 192;
    HIT_OK_MS = 336;
    MISS_THRESHOLD_MS = 456;
  } else {
    HIT_PERFECT_MS = 80;
    HIT_GOOD_MS = 160;
    HIT_OK_MS = 280;
    MISS_THRESHOLD_MS = 380;
  }

  // Restore BPM from state
  if (state.selectedBPM) {
    const opt = BPM_OPTIONS.find(o => o.bpm === state.selectedBPM);
    if (opt) {
      currentBPM = opt.bpm;
      bpmEarningsMult = opt.mult;
    }
  }
}

// --- Star Shop ---
function updateStarShop() {
  const container = document.getElementById('star-shop');
  if (!container) return;
  container.innerHTML = '';

  for (const upg of PRESTIGE_UPGRADES) {
    const owned = hasPrestigeUpgrade(state, upg.id);
    const canAfford = !owned && state.prestige.stars >= upg.cost;
    const locked = upg.requiresUpgrade && !hasPrestigeUpgrade(state, upg.requiresUpgrade);

    const div = document.createElement('div');
    div.className = 'star-shop-item' + (owned ? ' purchased' : '') + (canAfford && !locked ? ' affordable' : '');
    div.innerHTML = `
      <span class="star-shop-cost">${upg.cost} \u2b50</span>
      <div class="star-shop-info">
        <div class="star-shop-name">${upg.name}</div>
        <div class="star-shop-desc">${upg.desc}</div>
      </div>
      <span class="star-shop-badge ${owned ? 'owned' : canAfford && !locked ? 'buy' : 'locked'}">${owned ? 'OWNED' : canAfford && !locked ? 'BUY' : '\u{1F512}'}</span>
    `;

    if (canAfford && !locked) {
      div.addEventListener('click', () => {
        const result = buyPrestigeUpgrade(state, upg.id);
        if (result.success) {
          state = result.state;
          applyPrestigeEffects();
          updatePrestigePanel();
          updateStarShop();
          buildBPMSelector();
          saveGame();
        }
      });
    }
    container.appendChild(div);
  }
}

// --- BPM Selector ---
function updateDetectedBPM(now) {
  onsetTimes.push(now);
  if (onsetTimes.length > BPM_HISTORY_SIZE) onsetTimes.shift();
  if (onsetTimes.length < 4) return;

  // Build interval list, fold into 60-200 BPM range (handle half/double time)
  const minMs = 60000 / BPM_MAX; // ~300ms
  const maxMs = 60000 / BPM_MIN; // 1000ms
  const folded = [];
  for (let i = 1; i < onsetTimes.length; i++) {
    let d = onsetTimes[i] - onsetTimes[i - 1];
    while (d < minMs) d *= 2;
    while (d > maxMs) d /= 2;
    folded.push(d);
  }
  if (folded.length === 0) return;

  folded.sort((a, b) => a - b);
  const median = folded[Math.floor(folded.length / 2)];
  const bpm = Math.round(60000 / median);

  // Smooth: blend with previous estimate
  detectedBPM = detectedBPM ? Math.round(detectedBPM * 0.6 + bpm * 0.4) : bpm;

  const el = document.getElementById('detected-bpm-value');
  if (el) el.textContent = detectedBPM + ' BPM';
}

function buildBPMSelector() {
  const container = document.getElementById('bpm-selector');
  if (!container) return;
  container.innerHTML = '';

  if (isListening) {
    const card = document.createElement('div');
    card.className = 'bpm-detected';
    card.innerHTML = `<span class="bpm-detected-label">Detected</span><span id="detected-bpm-value">${detectedBPM ? detectedBPM + ' BPM' : '...listening'}</span>`;
    container.appendChild(card);
    return;
  }

  for (const opt of BPM_OPTIONS) {
    const locked = opt.requiresUpgrade && !hasPrestigeUpgrade(state, opt.requiresUpgrade);
    const btn = document.createElement('button');
    btn.className = 'bpm-btn' + (currentBPM === opt.bpm ? ' active' : '');
    btn.disabled = locked;
    btn.innerHTML = opt.label + (opt.mult !== 1 ? `<span class="bpm-mult">${opt.mult}x</span>` : '');

    if (!locked) {
      btn.addEventListener('click', () => {
        currentBPM = opt.bpm;
        bpmEarningsMult = opt.mult;
        state.selectedBPM = opt.bpm;
        buildBPMSelector();
        saveGame();
      });
    }
    container.appendChild(btn);
  }
}

// Note-speed picker. Unlike the BPM buttons this stays available while listening, since
// scroll speed is a readability preference and has nothing to do with the music's tempo.
function buildHyperspeedSelector() {
  const container = document.getElementById('hyperspeed-selector');
  if (!container) return;
  container.innerHTML = '';

  for (const opt of HYPERSPEED_OPTIONS) {
    const btn = document.createElement('button');
    btn.className = 'hyperspeed-btn' + (state.hyperspeed === opt.mult ? ' active' : '');
    btn.textContent = opt.label;
    const travelMs = Math.round(getScrollTimeMs(BASE_SCROLL_TIME_MS, opt.mult));
    btn.title = `Notes cross the track in ${travelMs}ms`;

    btn.addEventListener('click', () => {
      state.hyperspeed = opt.mult;
      // Notes already in flight keep their original speed, because the game loop derives
      // travel from each note's own spawnTime/hitTime rather than the current setting.
      // The new speed eases in with the next spawn instead of yanking the screen.
      buildHyperspeedSelector();
      saveGame();
    });
    container.appendChild(btn);
  }
}

// --- Export / Import ---
function exportSave() {
  try {
    state.lastSaveTime = Date.now();
    const json = JSON.stringify(state);
    const encoded = btoa(unescape(encodeURIComponent(json)));
    navigator.clipboard.writeText(encoded).then(() => {
      showFeedback('perfect', 0);
      const el = document.getElementById('tap-feedback');
      if (el) { el.textContent = 'Save copied to clipboard!'; el.className = 'feedback-perfect'; }
    }).catch(() => {
      prompt('Copy this save string:', encoded);
    });
  } catch (e) {
    console.warn('Export failed:', e);
  }
}

function importSave() {
  const input = prompt('Paste your save string:');
  if (!input || !input.trim()) return;
  try {
    const json = decodeURIComponent(escape(atob(input.trim())));
    const imported = JSON.parse(json);
    if (!imported.keys || !imported.prestige) {
      alert('Invalid save data.');
      return;
    }
    state = imported;
    applyPrestigeEffects();
    syncDancerCooldowns();
    rebuildLanes();
    updateCurrency();
    updateUpgrades();
    updateDancerPanel();
    updatePrestigePanel();
    updateStarShop();
    updateAchievementsPanel();
    updateStats();
    buildBPMSelector();
    saveGame();
    const el = document.getElementById('tap-feedback');
    if (el) { el.textContent = 'Save imported!'; el.className = 'feedback-perfect'; }
  } catch (e) {
    alert('Failed to import save. Make sure you pasted the full string.');
  }
}

// --- Tutorial ---
const TUTORIAL_STEPS = [
  {
    target: '#note-track',
    title: 'The Note Track',
    text: 'Notes scroll down the screen. Your goal is to press the right key when each note reaches the purple hit line at the bottom.',
  },
  {
    target: '#hit-zone',
    title: 'The Hit Zone',
    text: 'Time your key presses here. The closer to the line, the better your accuracy: Perfect, Good, or OK.',
  },
  {
    target: '#combo-display',
    title: 'Combos',
    text: 'Hit notes in a row to build combos. Higher combos multiply the beats you earn. Miss a note and it resets!',
  },
  {
    target: '#currency-display',
    title: 'Beats',
    text: 'Beats are your currency. Earn them by hitting notes, then spend them on upgrades.',
  },
  {
    target: '#side-tabs',
    title: 'Tabs',
    text: 'Use these tabs to switch between Upgrades, Dancers, Prestige, Achievements, and Stats.',
  },
  {
    target: '.tab-pane.active',
    title: 'Upgrades',
    text: 'Spend beats to level up your keys. Higher levels mean more beats per hit. Unlock new tiers to get more lanes!',
  },
  {
    target: '#listen-btn',
    title: 'Sync Audio',
    text: 'Click Sync Audio to play along with your own music. Notes will match the beat! Click the ? button anytime for setup help.',
  },
];

let tutorialStep = 0;
let tutorialOverlay = null;

function showTutorial() {
  if (tutorialOverlay) tutorialOverlay.remove();

  const overlay = document.createElement('div');
  overlay.id = 'tutorial-overlay';
  tutorialOverlay = overlay;

  function renderStep() {
    const step = TUTORIAL_STEPS[tutorialStep];
    const targetEl = document.querySelector(step.target);

    // Clear overlay
    overlay.innerHTML = '';

    // Spotlight cutout
    if (targetEl) {
      const rect = targetEl.getBoundingClientRect();
      const pad = 8;
      overlay.style.clipPath = `polygon(
        0% 0%, 100% 0%, 100% 100%, 0% 100%, 0% 0%,
        ${rect.left - pad}px ${rect.top - pad}px,
        ${rect.left - pad}px ${rect.bottom + pad}px,
        ${rect.right + pad}px ${rect.bottom + pad}px,
        ${rect.right + pad}px ${rect.top - pad}px,
        ${rect.left - pad}px ${rect.top - pad}px
      )`;
    } else {
      overlay.style.clipPath = '';
    }

    // Tooltip
    const tooltip = document.createElement('div');
    tooltip.className = 'tutorial-tooltip';

    // Step counter
    const counter = document.createElement('div');
    counter.className = 'tutorial-counter';
    counter.textContent = `${tutorialStep + 1} / ${TUTORIAL_STEPS.length}`;
    tooltip.appendChild(counter);

    const title = document.createElement('h3');
    title.className = 'tutorial-title';
    title.textContent = step.title;
    tooltip.appendChild(title);

    const text = document.createElement('p');
    text.className = 'tutorial-text';
    text.textContent = step.text;
    tooltip.appendChild(text);

    const buttons = document.createElement('div');
    buttons.className = 'tutorial-buttons';

    const skipBtn = document.createElement('button');
    skipBtn.className = 'tutorial-skip';
    skipBtn.textContent = 'Skip';
    skipBtn.addEventListener('click', closeTutorial);
    buttons.appendChild(skipBtn);

    if (tutorialStep === TUTORIAL_STEPS.length - 1) {
      const doneBtn = document.createElement('button');
      doneBtn.className = 'tutorial-next';
      doneBtn.textContent = 'Got it!';
      doneBtn.addEventListener('click', closeTutorial);
      buttons.appendChild(doneBtn);
    } else {
      const nextBtn = document.createElement('button');
      nextBtn.className = 'tutorial-next';
      nextBtn.textContent = 'Next';
      nextBtn.addEventListener('click', () => {
        tutorialStep++;
        renderStep();
      });
      buttons.appendChild(nextBtn);
    }

    tooltip.appendChild(buttons);

    // Position tooltip relative to target
    if (targetEl) {
      const rect = targetEl.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      const spaceRight = window.innerWidth - rect.right;
      if (spaceBelow > 200) {
        tooltip.style.top = `${rect.bottom + 16}px`;
        tooltip.style.left = `${Math.max(16, Math.min(rect.left, window.innerWidth - 340))}px`;
      } else if (rect.top > 200) {
        tooltip.style.bottom = `${window.innerHeight - rect.top + 16}px`;
        tooltip.style.left = `${Math.max(16, Math.min(rect.left, window.innerWidth - 340))}px`;
      } else if (spaceRight > 360) {
        tooltip.style.top = `${Math.max(16, rect.top)}px`;
        tooltip.style.left = `${rect.right + 16}px`;
      } else {
        tooltip.style.top = `${Math.max(16, rect.top)}px`;
        tooltip.style.right = `${window.innerWidth - rect.left + 16}px`;
      }
    } else {
      tooltip.style.top = '50%';
      tooltip.style.left = '50%';
      tooltip.style.transform = 'translate(-50%, -50%)';
    }

    overlay.appendChild(tooltip);
  }

  document.body.appendChild(overlay);
  renderStep();
}

function closeTutorial() {
  if (tutorialOverlay) {
    tutorialOverlay.remove();
    tutorialOverlay = null;
  }
  tutorialStep = 0;
  localStorage.setItem('clicktrack_tutorial_done', '1');
}

function shouldShowTutorial() {
  return !localStorage.getItem('clicktrack_tutorial_done');
}

// --- Welcome Back Modal ---
function showWelcomeBack(elapsedMs, earnings) {
  const minutes = Math.floor(elapsedMs / 60000);
  const hours = Math.floor(minutes / 60);
  const timeStr = hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;z-index:2000;';

  const modal = document.createElement('div');
  modal.style.cssText = 'background:#1a1a2e;border:1px solid #333;border-radius:12px;padding:28px 36px;text-align:center;max-width:340px;color:#eee;';
  modal.innerHTML = `
    <h2 style="margin:0 0 12px;color:#f0c040;">Welcome back!</h2>
    <p style="margin:0 0 8px;color:#aaa;">You were away for <strong style="color:#eee;">${timeStr}</strong></p>
    <p style="margin:0 0 18px;font-size:1.2rem;">Your dancers earned <strong style="color:#44dd77;">${formatNumber(earnings)}</strong> beats</p>
    <button style="padding:8px 24px;background:#44dd77;color:#111;border:none;border-radius:6px;font-weight:700;cursor:pointer;font-size:0.95rem;">Collect</button>
  `;
  modal.querySelector('button').addEventListener('click', () => overlay.remove());
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
}

// --- Init ---
function init() {
  loadGame();
  if (!state.dancers) state.dancers = { count: 0, level: 1 };
  if (!state.stats) state.stats = { totalTaps: 0, totalMisses: 0, bestCombo: 0 };
  if (!state.prestige) state.prestige = { count: 0, stars: 0, multiplier: 1, purchasedUpgrades: [] };
  if (state.prestige.stars === undefined) state.prestige.stars = 0;
  if (!state.prestige.purchasedUpgrades) state.prestige.purchasedUpgrades = [];
  if (!state.achievements) state.achievements = [];
  if (!state.selectedBPM) state.selectedBPM = 90;
  // Saves written before hyperspeed existed have no value here, and loadGame's shallow
  // merge only back-fills absent keys, so an explicit guard keeps a 0/undefined out of
  // the divisor in getScrollTimeMs.
  if (!state.hyperspeed) state.hyperspeed = 1;
  syncDancerCooldowns();
  applyPrestigeEffects();

  // Offline progress
  if (state.lastSaveTime) {
    const elapsed = Date.now() - state.lastSaveTime;
    if (elapsed > 60000) { // at least 1 minute away
      const earnings = calculateOfflineEarnings(state, elapsed);
      if (earnings > 0) {
        state.currency += earnings;
        state.totalEarned += earnings;
        showWelcomeBack(elapsed, earnings);
      }
    }
  }

  rebuildLanes();
  updateCurrency();
  updateUpgrades();
  updateDancerPanel();
  updatePrestigePanel();
  updateStarShop();
  updateAchievementsPanel();
  updateStats();
  updateAccuracy();
  updateCombo();
  buildBPMSelector();
  buildHyperspeedSelector();
  listenBtn.style.display = '';

  // Onboarding hint
  const noteTrack = document.getElementById('note-track');
  if (noteTrack && !document.getElementById('onboarding-hint')) {
    const hint = document.createElement('div');
    hint.id = 'onboarding-hint';
    hint.textContent = 'Press ' + getKeyDisplayName('w') + ' when notes reach the line';
    hint.style.cssText = 'position:absolute;top:40%;left:50%;transform:translate(-50%,-50%);color:rgba(255,255,255,0.6);font-size:1.1rem;letter-spacing:0.05em;pointer-events:none;z-index:10;text-align:center;';
    noteTrack.style.position = 'relative';
    noteTrack.appendChild(hint);
    // Auto-remove after 8 seconds even if no hit
    setTimeout(() => { if (hint.parentNode) hint.remove(); }, 8000);
  }

  startDefaultLoop();

  // Passive glow hint on Sync Audio button: 5 pulses, one every 10 seconds
  (function scheduleSyncHint() {
    const btn = document.getElementById('listen-btn');
    if (!btn || isListening) return;
    let count = 0;
    const MAX = 5;
    const INTERVAL = 10000;
    function pulse() {
      if (isListening || count >= MAX) return;
      btn.classList.remove('sync-hint-pulse');
      // Force reflow so re-adding the class restarts the animation
      void btn.offsetWidth;
      btn.classList.add('sync-hint-pulse');
      btn.addEventListener('animationend', () => btn.classList.remove('sync-hint-pulse'), { once: true });
      count++;
      if (count < MAX) setTimeout(pulse, INTERVAL);
    }
    setTimeout(pulse, INTERVAL);
  })();

  // Show tutorial for new users
  if (shouldShowTutorial()) {
    setTimeout(showTutorial, 600);
  }

  saveInterval = setInterval(() => {
    saveGame();
    updateUpgrades();
    updateDancerPanel();
    updateStats();
  }, 30000);

  // Save on page hide/refresh so progress isn't lost between auto-save ticks
  window.addEventListener('beforeunload', () => {
    saveGame();
  });
}

init();
