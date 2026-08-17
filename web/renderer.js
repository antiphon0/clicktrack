// Clicktrack renderer — web version for galaxy.click
// game.js globals (createDefaultState, processTap, etc.) loaded via script tag

// --- State ---
let state = createDefaultState();
let isListening = false;
let audioContext = null;
let analyserNode = null;
let mediaStream = null;
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
// Chord gating lives in game.js (shouldSpawnChord). The renderer just keeps the running
// state it needs: a token-bucket meter, and a rolling window of recent onset magnitudes
// so "is this a big moment" is judged against the current passage, not a fixed number.
const ONSET_MAGNITUDE_WINDOW = 40;
let recentOnsetMagnitudes = [];
let chordMeter = null;
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

// --- Auto-hit bonus lanes ---
// The player's skill gameplay is the four cardinals plus the tier-5 center key. The
// diagonals (q/e/z/c) are NOT played: they scroll in their own dimmed lanes and the game
// resolves them at the hit line for modest ambient income. Eight playable lanes overwhelmed
// testers. This also removes the old two-cardinal chord input, which buffered every
// cardinal press for 80ms and made the core lanes feel laggy.
const AUTO_KEYS = ['q', 'e', 'z', 'c'];
const isAutoKey = (key) => AUTO_KEYS.includes(key);

// --- Diagonal chording (two cardinals pressed together) ---
// Arrow players reach the diagonals the way every other game does it: press the two
// adjacent arrows. The previous implementation buffered EVERY cardinal press for 80ms
// waiting for a partner, which put that latency on the core lanes permanently and is why
// it was removed. This version buffers only when a diagonal note using that cardinal is
// actually live on screen, so normal play has zero added latency and the wait exists only
// in the narrow window where it can pay off.
const CARDINALS = ['w', 'a', 's', 'd'];
const CHORD_MAP = {
  'a+w': 'q', 'w+a': 'q',  // left  + up   = up-left
  'd+w': 'e', 'w+d': 'e',  // right + up   = up-right
  'a+s': 'z', 's+a': 'z',  // left  + down = down-left
  'd+s': 'c', 's+d': 'c',  // right + down = down-right
};
// Which two cardinals make each diagonal, used to decide whether buffering is worthwhile.
const DIAGONAL_PARTS = { q: ['a', 'w'], e: ['d', 'w'], z: ['a', 's'], c: ['d', 's'] };
const CHORD_WINDOW_MS = 55;
let pendingCardinal = null; // { key, timerId, shiftHeld }

// --- Input method detection ---
const INPUT_HISTORY_SIZE = 5;
let recentInputCodes = []; // raw e.code values
let detectedInputMethod = 'keyboard'; // 'keyboard' | 'arrows' | 'numpad'

const DISPLAY_NAMES = {
  // The tier-5 center key is Space on keyboard and arrows (there is no ninth arrow), and
  // Numpad 0 for the numpad layout.
  keyboard: { w: 'W', a: 'A', s: 'S', d: 'D', q: 'Q', e: 'E', z: 'Z', c: 'C', x: 'SPACE' },
  arrows:   { w: '\u2191', a: '\u2190', s: '\u2193', d: '\u2192', q: '\u2196', e: '\u2197', z: '\u2199', c: '\u2198', x: 'SPACE' },
  numpad:   { w: '8', a: '4', s: '5', d: '6', q: '7', e: '9', z: '1', c: '3', x: '0' },
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
    // Lane labels no longer vary by input method, so only the upgrade panel needs redrawing.
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
const audioGuideStepsEl = $('#audio-guide-steps');
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

// Keys the player actually hits: everything unlocked except the auto-resolving diagonals.
function getPlayableKeys() {
  return getUnlockedKeys().filter((k) => !isAutoKey(k));
}

// Lane order matches physical keyboard position left-to-right (QWERTY x-offsets),
// with W and S swapped so the down arrow sits on the middle-left and up arrow on the middle-right
const LANE_ORDER = ['q', 'z', 'a', 's', 'w', 'd', 'e', 'c'];
// 'x' is the tier-5 center key. Angle 0 because a diamond has no direction to point.
const KEY_ANGLE = { w: 0, d: 90, s: 180, a: 270, e: 45, c: 135, z: 225, q: 315, x: 0 };
// x was #ffffff, which now disappears into the white note outline. #aaddff also matches
// the --key-color already declared for .note-key-x in styles.css, which it had drifted from.
const KEY_COLOR = { a: '#ff4455', w: '#44dd77', s: '#4499ff', d: '#ffdd33', q: '#cc44ff', e: '#ff8833', z: '#ff44cc', c: '#44ffcc', x: '#aaddff' };
// KEY_GLOW removed with the note drop-shadow. The --key-glow CSS variables still exist
// and drive the lane-label hit flash, which is a deliberate momentary pop, not scroll blur.
// DDR-style arrow: wide head, narrow stem, clean proportions
const ARROW_SHAPE = 'M 50,4 L 92,46 L 66,46 L 66,96 L 34,96 L 34,46 L 8,46 Z';
// Center key (tier 5) is a diamond, so it reads as "no direction, just hit it" and stays
// visually distinct from the eight arrows at a glance.
const CENTER_SHAPE = 'M 50,6 L 94,50 L 50,94 L 6,50 Z';
const KEY_SHAPE = { x: CENTER_SHAPE };

function createArrowEl(key, isTarget) {
  const angle = KEY_ANGLE[key] ?? 0;
  const color = KEY_COLOR[key] || '#ffffff';
  const shape = KEY_SHAPE[key] || ARROW_SHAPE;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 100 100');

  const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  if (angle !== 0) g.setAttribute('transform', `rotate(${angle}, 50, 50)`);

  if (isTarget) {
    // Hollow ghost arrow at the hit zone
    svg.style.opacity = '0.35';
    const outline = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    outline.setAttribute('d', shape);
    outline.setAttribute('fill', 'none');
    outline.setAttribute('stroke', color);
    outline.setAttribute('stroke-width', '2.5');
    outline.setAttribute('stroke-linejoin', 'round');
    g.appendChild(outline);
  } else {
    // Solid filled arrow for scrolling notes. Deliberately no drop-shadow: the glow
    // smeared the edges, and at higher note speeds a fast-moving halo reads as motion
    // blur and makes the arrow hard to track. A hard white outline does the opposite,
    // sharpening the silhouette against the dark track without adding any blur.
    const fill = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    fill.setAttribute('d', shape);
    fill.setAttribute('fill', color);
    fill.setAttribute('stroke', '#ffffff');
    fill.setAttribute('stroke-width', '3.5');
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
    lane.className = 'lane' + (isAutoKey(key) ? ' auto-lane' : '');
    lane.dataset.key = key;
    lanesContainer.appendChild(lane);

    const label = document.createElement('div');
    label.className = `lane-label lane-label-key-${key}` + (isAutoKey(key) ? ' auto-lane' : '');
    label.dataset.key = key;
    // The label is the ghost target for what is about to arrive, so it always mirrors the
    // note art regardless of input method. It used to swap to a bare text character for
    // arrow/numpad players, which rendered a tiny glyph next to full-size notes.
    const labelArrow = createArrowEl(key, true);
    labelArrow.classList.add('label-arrow');
    label.appendChild(labelArrow);
    laneLabels.appendChild(label);
  }

  maybeShowAutoLaneHint();
}

// One-time reassurance the first time the dim lanes appear. Four extra lanes arriving at
// once reads as "four more things I must hit"; they are optional, so say so before the
// player panics. Fires from rebuildLanes so it covers the tier unlock however it was
// bought (button or Shift + center key) and a reload that already has them.
function maybeShowAutoLaneHint() {
  if (localStorage.getItem('clicktrack_auto_lane_hint_done') === '1') return;
  if (!getUnlockedKeys().some(isAutoKey)) return;

  const noteTrack = document.getElementById('note-track');
  if (!noteTrack || document.getElementById('auto-lane-hint')) return;

  const hint = document.createElement('div');
  hint.id = 'auto-lane-hint';
  hint.className = 'auto-lane-hint';
  hint.textContent = "Don't worry about the dim lanes. They score themselves, and you can hit them for extra if you like.";
  noteTrack.appendChild(hint);
  localStorage.setItem('clicktrack_auto_lane_hint_done', '1');
  setTimeout(() => { if (hint.parentNode) hint.remove(); }, 9000);
}

// --- Audio Setup Guide ---
function showAudioGuide() {
  audioGuideEl.style.display = '';
  // Restore the checklist; a previous successful connect collapses it.
  if (audioGuideStepsEl) audioGuideStepsEl.style.display = '';
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
      // Collapse the checklist rather than ticking every step. Marking all five "done" lit
      // up a column of green check-marked cards that reads as a pile of achievement
      // unlocks and shoves the note track down the page. One confirmation line is enough.
      if (audioGuideStepsEl) audioGuideStepsEl.style.display = 'none';
      if (usedDisplayMedia) {
        setGuideStatus('Audio connected! Notes will now sync to the beat of your music.', 'ok');
      } else {
        setGuideStatus('Connected via microphone. For best results, try tab sharing next time.', 'ok');
      }
      markAudioGuideDone();
      // Auto-close the guide shortly after success
      setTimeout(() => {
        if (isListening) hideAudioGuide();
      }, 2500);
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

function spawnNote(now, excludeKey = null, isChord = false) {
  // Chords must land on two lanes the player can actually press together. Ordinary notes
  // may use the auto lanes, since those resolve themselves as ambient income.
  const allUnlocked = isChord ? getPlayableKeys() : getUnlockedKeys();
  const unlocked = excludeKey ? allUnlocked.filter((k) => k !== excludeKey) : allUnlocked;
  if (unlocked.length === 0) return null;

  const key = weightedKey(unlocked);
  // Apply audio sync offset to where the note should LAND on the hit line
  const hitTime = now + getScrollTimeMs(BASE_SCROLL_TIME_MS, state.hyperspeed) + audioOffsetMs;

  const lane = lanesContainer.querySelector(`.lane[data-key="${key}"]`);
  if (!lane) return null;

  const noteEl = createArrowEl(key);
  noteEl.classList.add('note', `note-key-${key}`);
  // Both halves of a chord get the class, so the pair is styled identically. Keying this
  // off excludeKey marked only the second note, which made the pair look mismatched.
  if (isChord) noteEl.classList.add('chord-note');
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

    // Track this onset's magnitude so chord gating can judge it against the passage.
    if (audioOnset) {
      recentOnsetMagnitudes.push(onsetMagnitude);
      if (recentOnsetMagnitudes.length > ONSET_MAGNITUDE_WINDOW) recentOnsetMagnitudes.shift();
    }

    // Chords are audio-only, need somewhere to put the second note, and must clear the
    // floor/relative/meter gates in shouldSpawnChord. Decided before the first spawn so
    // both notes can be styled as a pair, and only asked once so it spends one token.
    if (!chordMeter) chordMeter = createChordMeter(now);
    const chord = audioOnset
      && getPlayableKeys().length >= 2
      && shouldSpawnChord(chordMeter, onsetMagnitude, recentOnsetMagnitudes, now);

    const firstKey = spawnNote(now, null, chord);
    if (chord && firstKey) {
      spawnNote(now, firstKey, true);
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
    // No fade-in. It ramped opacity over the first half of a note's travel, which at
    // higher note speeds is most of the time the note exists, so the player spent the
    // lead time reading a ghost. That cancelled out the point of raising note speed.

    const pastHitMs = now - note.hitTime;

    // Diagonals resolve themselves only AFTER the player's full window has passed, exactly
    // like the dancer fallback below. Resolving at pastHitMs >= 0 stole the note on the
    // beat, leaving only the early half hittable, which is why playing them felt dead.
    if (isAutoKey(note.key) && pastHitMs > HIT_OK_MS) {
      autoLaneHit(note);
      activeNotes.splice(i, 1);
      continue;
    }

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

// Resolve one press: play the note, and if Shift was held, buy that lane's upgrade too.
function firePress(key, shiftHeld) {
  onKeyPress(key);
  if (shiftHeld) buyFromKeyboard(key);
}

// Is a diagonal note that uses this cardinal currently within reach? Only then is it worth
// delaying the press to see whether a partner arrow follows.
function isDiagonalLiveFor(cardinal) {
  const now = performance.now();
  for (const note of activeNotes) {
    if (note.hit || !isAutoKey(note.key)) continue;
    if (!state.keys[note.key]?.unlocked) continue;
    if (Math.abs(now - note.hitTime) > MISS_THRESHOLD_MS) continue;
    if (DIAGONAL_PARTS[note.key]?.includes(cardinal)) return true;
  }
  return false;
}

// Flush a buffered cardinal as an ordinary press.
function flushPendingCardinal() {
  if (!pendingCardinal) return;
  const p = pendingCardinal;
  pendingCardinal = null;
  clearTimeout(p.timerId);
  firePress(p.key, p.shiftHeld);
}

function handleCardinalPress(key, shiftHeld) {
  // A partner arrived in time: resolve the pair as the diagonal instead of two cardinals.
  if (pendingCardinal && pendingCardinal.key !== key) {
    const diagonal = CHORD_MAP[pendingCardinal.key + '+' + key];
    if (diagonal && state.keys[diagonal]?.unlocked) {
      const shift = pendingCardinal.shiftHeld || shiftHeld;
      clearTimeout(pendingCardinal.timerId);
      pendingCardinal = null;
      firePress(diagonal, shift);
      return;
    }
  }

  // Nothing diagonal is live in this lane pairing, so there is nothing to wait for.
  if (!isDiagonalLiveFor(key)) {
    flushPendingCardinal();
    firePress(key, shiftHeld);
    return;
  }

  // Hold this press just long enough for a partner arrow to land.
  flushPendingCardinal();
  const timerId = setTimeout(() => {
    if (pendingCardinal && pendingCardinal.key === key) flushPendingCardinal();
  }, CHORD_WINDOW_MS);
  pendingCardinal = { key, timerId, shiftHeld };
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

// Auto-hit lane (diagonal) resolves itself at the hit line. Flat, modest "ambient" income:
// routed through the dancer source (no manual 2x, capped combo) at a fixed ×1 combo and "ok"
// accuracy, so the rare-key value bonus still pays out but skill on the cardinals stays the
// real earner. Kept quiet (no tap feedback, no streak) so it reads as background income
// rather than a hit the player should have reacted to.

function autoLaneHit(note) {
  note.hit = true;
  note.element.classList.add('note-hit');
  setTimeout(() => {
    if (note.element.parentNode) note.element.parentNode.removeChild(note.element);
  }, 150);
  const result = processTap(state, note.key, 'ok', { source: 'dancer', externalCombo: 1 });
  if (bpmEarningsMult !== 1) {
    const bonus = result.earned * (bpmEarningsMult - 1);
    state.currency += bonus;
    state.totalEarned += bonus;
  }
  updateCurrency();
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
      label = count > 0 ? `MAX ×${count}` : '—';
    } else {
      count = parseInt(buyMode);
      cost = getBulkUpgradeCost(ks.level, count);
      label = state.currency >= cost ? `BUY ${buyMode}` : '—';
    }
    const canAfford = buyMode === 'Max' ? count > 0 : state.currency >= cost;

    const costEl = row.querySelector('.key-upgrade-cost');
    const actionEl = row.querySelector('.key-upgrade-action');
    const meterEl = row.querySelector('.key-upgrade-meter-fill');
    if (costEl) costEl.textContent = formatNumber(cost);
    if (actionEl) actionEl.textContent = label;
    if (meterEl) meterEl.style.width = (cost > 0 ? Math.min(100, (state.currency / cost) * 100) : 100) + '%';

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
      label = count > 0 ? `MAX ×${count}` : '—';
    } else {
      count = parseInt(buyMode);
      cost = getBulkUpgradeCost(ks.level, count);
      label = state.currency >= cost ? `BUY ${buyMode}` : '—';
    }
    const canAfford = buyMode === 'Max' ? count > 0 : state.currency >= cost;

    // Channel-strip meter: how much of this buy your balance currently covers.
    // Full bar means it is affordable right now, so the meter and the lit action
    // button always agree.
    const fillPct = cost > 0 ? Math.min(100, (state.currency / cost) * 100) : 100;
    const displayName = getKeyDisplayName(key);

    const div = document.createElement('div');
    // lane-label-key-* supplies --key-color / --key-glow, tying each strip to the
    // colour of its lane on the track.
    div.className = `key-upgrade lane-label-key-${key}` + (canAfford ? ' affordable' : '');
    div.dataset.key = key;
    div.innerHTML = `
      <span class="key-upgrade-label${displayName.length > 2 ? ' key-word' : ''}">${displayName}</span>
      <span class="key-upgrade-info">
        <span class="key-upgrade-readout">
          <span class="key-upgrade-level">LV ${ks.level}</span>
          <span class="key-upgrade-cost">${formatNumber(cost)}</span>
        </span>
        <span class="key-upgrade-meter"><span class="key-upgrade-meter-fill" style="width:${fillPct}%"></span></span>
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
  // Derived from the constant rather than hardcoded in the markup, so the stated
  // threshold cannot drift away from the one getPrestigeGain actually enforces.
  prestigeHintEl.textContent =
    `Earn ${formatNumber(PRESTIGE_EARNED_PER_STAR)} total beats to unlock prestige`;
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
      <span class="achievement-icon">${done ? '\u25cf' : '\u25cb'}</span>
      <div class="achievement-info">
        <div class="achievement-name">${ach.name}</div>
        <div class="achievement-desc">${ach.desc}</div>
      </div>
    </div>`;
  }
  achievementListEl.innerHTML = html;
}

// Small, quiet confirmation for keyboard purchases. Only one is ever on screen: a rapid
// series of upgrades should not stack a column of toasts.
let purchaseToastEl = null;
function showToast(msg) {
  if (purchaseToastEl && purchaseToastEl.parentNode) purchaseToastEl.remove();
  const el = document.createElement('div');
  el.className = 'purchase-toast';
  el.textContent = msg;
  document.body.appendChild(el);
  purchaseToastEl = el;
  setTimeout(() => { if (el.parentNode) el.remove(); }, 1100);
}

function showAchievementToast(ach) {
  const toast = document.createElement('div');
  toast.className = 'achievement-toast';
  toast.textContent = ach.name.toUpperCase() + ' — UNLOCKED';
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

// Keyboard purchasing. Each lane buys its own upgrade at the current buy mode, so the
// mapping needs no lookup table and is identical on WASD, arrows and numpad (all three
// resolve to the same internal key). The center key buys the tier unlock instead, and is
// deliberately NOT gated on the center lane being unlocked, since tier 5 unlocks it
// so requiring it first would be circular.
function buyFromKeyboard(key) {
  if (key === 'x') {
    const before = state.tierUnlocked;
    unlockTier(state);
    if (state.tierUnlocked !== before) {
      rebuildLanes();
      afterKeyboardPurchase(`Tier ${state.tierUnlocked} unlocked`);
    }
    return;
  }

  const count = resolveBuyCount(state, key, buyMode);
  if (count < 1) return; // unaffordable or locked: stay silent, the note still counted
  const { bought } = upgradeKeyBulk(state, key, count);
  if (bought > 0) {
    afterKeyboardPurchase(`${getKeyDisplayName(key)} +${bought}`);
  }
}

// Shared refresh after a keyboard purchase. Skips showFeedback so it cannot stomp the
// hit rating for the same press, which the player still needs to read.
function afterKeyboardPurchase(msg) {
  updateCurrency();
  updateUpgrades();
  updateStats();
  runAchievementCheck();
  saveGame();
  showToast(msg);
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
    // Tier-5 center key. Space works on every layout; Numpad 0 and 2 are the numpad
    // equivalents (2 is the only free numpad direction, 5 is already taken by 's').
    'Space': 'x', 'Numpad0': 'x', 'Numpad2': 'x',
  };

  const key = KEY_MAP[e.code] || KEY_MAP[e.key] || e.key.toLowerCase();

  if (ALL_KEYS.includes(key)) {
    e.preventDefault();

    // Track input method
    recentInputCodes.push(e.code);
    if (recentInputCodes.length > INPUT_HISTORY_SIZE) recentInputCodes.shift();
    detectInputMethod();

    // Cardinals may combine into a diagonal, so they route through the chord handler.
    // Everything else (diagonals pressed directly, the centre key) fires immediately.
    if (CARDINALS.includes(key)) {
      handleCardinalPress(key, e.shiftKey);
      return;
    }

    firePress(key, e.shiftKey);
  }
});

document.addEventListener('keyup', () => {
  // Improve hooks in here: on Shift release, if no lane key was pressed during the hold,
  // that was a bare tap and should activate Improve rather than buy anything.
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
      // A pristine second copy is required, not paranoia: Object.assign MUTATES its
      // target, so after the merge `defaults` is the same object as `state` and
      // defaults.keys has already been replaced by the save's keys. Back-filling from it
      // would assign values to themselves, leaving keys the save predates (the tier-5
      // center key, for anything saved before it existed) as undefined. unlockTier then
      // throws on state.keys[key].unlocked for that key.
      const pristine = createDefaultState();
      // Merge top-level fields so new/missing keys always have defaults
      state = Object.assign(defaults, parsed);
      // Ensure every expected key has a valid entry
      for (const key of ALL_KEYS) {
        if (!state.keys[key] || typeof state.keys[key].unlocked !== 'boolean') {
          state.keys[key] = pristine.keys[key];
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
      <span class="star-shop-badge ${owned ? 'owned' : canAfford && !locked ? 'buy' : 'locked'}">${owned ? 'OWNED' : canAfford && !locked ? 'BUY' : 'LOCKED'}</span>
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
  } catch {
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

  // Styled from styles.css, not from inline cssText: this modal is the first thing
  // a returning player sees, so it has to carry the same console vocabulary as the
  // rest of the UI rather than its own colours.
  const overlay = document.createElement('div');
  overlay.className = 'welcome-overlay';

  const modal = document.createElement('div');
  modal.className = 'welcome-modal';
  modal.innerHTML = `
    <div class="welcome-eyebrow">Offline session</div>
    <div class="welcome-readout">${formatNumber(earnings)}</div>
    <div class="welcome-unit">beats banked by your dancers</div>
    <div class="welcome-away">Away for <span>${timeStr}</span></div>
    <button class="btn welcome-collect">Collect</button>
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
  if (!state.prestige) state.prestige = { count: 0, stars: 0, starsEarned: 0, multiplier: 1, purchasedUpgrades: [] };
  if (state.prestige.stars === undefined) state.prestige.stars = 0;
  if (!state.prestige.purchasedUpgrades) state.prestige.purchasedUpgrades = [];
  // Must run after purchasedUpgrades exists: it reconstructs lifetime stars from the
  // unspent balance plus everything already sunk into the shop. Without it, a save from
  // before starsEarned existed would load with a 1x multiplier.
  backfillStarsEarned(state);
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

  // Handle intentionally not retained: the autosave runs for the life of the page.
  setInterval(() => {
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
