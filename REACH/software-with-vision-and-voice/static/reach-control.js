/* =================================================================================================
Project: REACH App — UI web application to control the REACH robot arm
Institution: Hokkaido University (2025)
Last Update: Q3 2025
-------------------------------------------------------------------------------------------------
Authors:
  • Mikael Nicander Kuwahara — Lead System Designer & Lead Developer (2024–)
-------------------------------------------------------------------------------------------------
File: reach-control.js
Purpose:
  • Core browser-side controller for manual robot control, history/log UI, macro editing/playback,
    servo slider sync, and connection status monitoring.
External Endpoints:
  • POST /send             → { status | message | angles }
  • GET  /log              → [{ timestamp, response }, ...]
  • POST /log/clear        → { status: 'success'|'error' }
  • GET  /status           → { connected: boolean }
  • POST /stop             → (halts robot)
Public Globals (consumed by other modules):
  • dispatchCommand(cmd, addToHistory?)
  • sendPreset(code)
  • macroPlay(), runMacro(label), macroStop()
  • SERVO_NAMES (read by voice-integration for friendly labels)
Notes:
  • This file intentionally keeps small UX niceties (history hover highlight, compact header).
  • Validation is conservative to avoid accidental bad commands to firmware.
================================================================================================= */


/* ================================================================================================
 * 0) Configuration & constants
 * ================================================================================================ */

const MAX_SERVO = 5;
const MAX_ANGLE = 180;
const HISTORY_KEY = 'manualCommandHistory';
const SERVO_NAMES = ['Base(0)', 'Shoulder(1)', 'Elbow(2)', 'Wrist(3)', 'Twist(4)', 'Grip(5)'];

/** Built-in demo/safety macro sequences (labels used by UI & voice). */
const macroSequences = {
  DM1: ["REL", "PLT", "PCL", "GRP", "LFT", "N0150", "N4180", "WAIT1", "N480", "N0180", "PCL", "REL", "PLT"],
  DM2: ["N190,N40,N390,N0180", "BMD300", "N3135", "N345", "N3135", "N345", "N3135", "N345", "N390", "BMD2000"],
  DM3: ["N0180", "N1135,N345,N50", "N145,N3135,N580", "N1135,N345,N50", "N145,N3135,N580", "N190,N390,N50", "N090", "N1160,N3120", "WAIT1", "CTR"],
  SSLP: ["N190,N390", "N0180", "N480,N580,N3110,N1180"],
  SCTR: ["N190,N390,N480,N580", "N090"],
  RSLP: ["N190,N390", "N0180", "N480,N530,N355,N10"]
};

let currentAngles = null;               // last reported angles from firmware
let wasDisconnected = false;            // connection state edge detection
let commandHistory = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
let historyIndex = commandHistory.length;
let historyPollInterval = null;

// Prevent browser auto-restoring scroll on refresh (keeps header stable)
if ('scrollRestoration' in window.history) { window.history.scrollRestoration = 'manual'; }


/* ================================================================================================
 * 1) Validation
 * ================================================================================================ */

/**
 * Validate a single command or a comma-joined multi-servo combo.
 * Supported:
 *  - "N{servo}{angle}" or "N{servo}{angle},N{servo}{angle},..."
 *  - "WAIT{seconds}" (seconds ≥ 1)
 *  - "BMD{ms}" (non-negative)
 *  - Preset/macro tokens (A–Z up to length 5), and P/P0..P5 position query
 * @returns {string|null} error message or null if valid
 */
function validateCommand(cmd) {
  cmd = cmd.trim().toUpperCase();

  // Combo: N0xxx,N1xxx,...
  if (cmd.includes(',')) {
    const parts = cmd.split(',');
    for (let part of parts) {
      if (!part.startsWith('N')) return `Invalid segment: "${part}"`;
      const servoIndex = parseInt(part[1]);
      const angle = parseInt(part.substring(2));
      if (isNaN(servoIndex) || isNaN(angle)) return `Invalid segment: "${part}"`;
      if (servoIndex < 0 || servoIndex > MAX_SERVO) return `Servo index ${servoIndex} out of range in "${part}".`;
      if (angle < 0 || angle > MAX_ANGLE) return `Angle ${angle} out of range in "${part}".`;
    }
    return null;
  }

  // Single N- command
  if (cmd.startsWith("N")) {
    const servoIndex = parseInt(cmd[1]);
    const angle = parseInt(cmd.substring(2));
    if (isNaN(servoIndex) || isNaN(angle)) return "Invalid format.";
    if (servoIndex < 0 || servoIndex > MAX_SERVO) return `Servo index ${servoIndex} out of range.`;
    if (angle < 0 || angle > MAX_ANGLE) return `Angle ${angle} out of range.`;
    return null;
  }

  // Macro tokens (e.g., REL, PLT), P query, WAIT/BMD
  if (/^[A-Z]{1,5}$/.test(cmd)) return null;
  if (cmd.startsWith("WAIT")) {
    const sec = parseInt(cmd.substring(4));
    if (isNaN(sec) || sec < 1) return "WAIT must be an integer ≥ 1";
    return null;
  }
  if (cmd.startsWith("BMD")) {
    const ms = parseInt(cmd.substring(3));
    if (isNaN(ms) || ms < 0) return "BMD must be a non-negative integer";
    return null;
  }
  if (cmd === "P") return null;
  if (/^P[0-5]$/.test(cmd)) return null;

  // 2.5D macro step (handled at playback time): "PP pick=... dest=... op=..."
  if (cmd.startsWith("PP ")) return null;

  return "Unknown or invalid command format.";
}


/* ================================================================================================
 * 2) Sliders & angle display
 * ================================================================================================ */

/** Reflect slider UI from a 6-length angles array. */
function updateSliders(angles) {
  if (!Array.isArray(angles) || angles.length !== 6) return;
  angles.forEach((angle, index) => {
    const slider = document.getElementById(`slider-${index}`);
    const valLabel = document.getElementById(`slider-val-${index}`);
    if (slider) slider.value = angle;
    if (valLabel) valLabel.innerText = `${angle}°`;
  });
}

/**
 * Build servo sliders dynamically, wire change/input handlers.
 * Sends an N{servo}{deg} command on change (not during drag).
 */
function setupSliders() {
  const grid = document.getElementById('servo-slider-grid');
  if (!grid) return;

  for (let i = 0; i <= MAX_SERVO; i++) {
    const wrapper = document.createElement('div');
    wrapper.className = 'slider-wrapper';

    const label = document.createElement('label');
    label.htmlFor = `slider-${i}`;
    label.textContent = SERVO_NAMES[i];

    const valueDisplay = document.createElement('div');
    valueDisplay.id = `slider-val-${i}`;
    valueDisplay.className = 'slider-value';
    valueDisplay.innerText = '90°';

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = 0;
    slider.max = (i === 5) ? 80 : MAX_ANGLE;     // Grip typically limited to 0..80
    slider.id = `slider-${i}`;
    slider.dataset.servo = i;
    slider.value = 90;

    let startValue = slider.value;
    slider.addEventListener('mousedown', () => startValue = slider.value);
    slider.addEventListener('change', () => {
      if (slider.value !== startValue) {
        const cmd = `N${i}${slider.value}`;
        dispatchCommand(cmd, true);
      }
    });
    slider.addEventListener('input', () => { valueDisplay.innerText = `${slider.value}°`; });

    wrapper.appendChild(label);
    wrapper.appendChild(valueDisplay);
    wrapper.appendChild(slider);
    grid.appendChild(wrapper);
  }
}

/** Update text boxes showing the current angles and mirror into sliders. */
function updateAngleGrid(angles) {
  if (!Array.isArray(angles) || angles.length !== 6) {
    console.warn("⚠️ angles invalid:", angles);
    return;
  }
  const boxes = document.querySelectorAll('.servo-box');
  boxes.forEach((box, i) => {
    box.innerText = `${SERVO_NAMES[i]}: ${angles[i]}°`;
  });
  currentAngles = angles;
  updateSliders(angles);
}


/* ================================================================================================
 * 3) Command history (UI + localStorage)
 * ================================================================================================ */

/** Push a sent command to local history (de-duplicates tail; caps at 50). */
function updateHistory(cmd) {
  if (!cmd) return;
  if (commandHistory[commandHistory.length - 1] !== cmd) commandHistory.push(cmd);
  if (commandHistory.length > 50) commandHistory.shift();
  localStorage.setItem(HISTORY_KEY, JSON.stringify(commandHistory));
  historyIndex = commandHistory.length;
}

/** Prepend a human-readable sent line to the “sent” column with a shared line-id. */
function appendSentCommand(cmd) {
  const sentList = document.getElementById('sent-history');
  const responseList = document.getElementById('response-history');
  const now = new Date();
  const timestamp = formatTimestamp(now);
  const lineId = responseList.children.length + 1; // shared ID across columns

  // Avoid accidental duplicates when several actions happen quickly
  const alreadyExists = [...sentList.children].some(li => li.dataset.lineId === `${lineId}` && li.textContent.includes(cmd));
  if (alreadyExists) return;

  const li = document.createElement('li');
  li.textContent = `[#${lineId} - ${timestamp}] ${cmd}`;
  li.dataset.lineId = `${lineId}`;
  sentList.insertBefore(li, sentList.firstChild);

  setupHoverHighlighting();
}


/* ================================================================================================
 * 4) Robot communication
 * ================================================================================================ */

/**
 * Send a command to the backend (validates first), update feedback area, and
 * reflect returned angles into UI. When addToHistory=true, store it for ↑/↓ recall.
 */
async function dispatchCommand(code, addToHistory = false) {
  const feedback = document.getElementById('robot-feedback');
  const cmd = code.trim().toUpperCase();

  appendSentCommand(cmd);

  const validationError = validateCommand(cmd);
  if (validationError) {
    feedback.style.color = 'red';
    feedback.innerText = validationError;
    return;
  }

  feedback.style.color = '#333';
  feedback.innerText = '...';

  try {
    const response = await fetch('/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: cmd })
    });
    const result = await response.json();

    if (addToHistory) updateHistory(cmd);

    // Long-running sequences may not reply with angles immediately
    if (result.status === 'no_response' || result.message === 'No Response') {
      feedback.style.color = '#666';
      feedback.innerText = `🕐 Executing sequence...`;
      return;
    }

    // Some firmwares wrap JSON in a string field
    let parsedMessage = result;
    if (typeof result.message === 'string' && result.message.startsWith('{')) {
      try { parsedMessage = JSON.parse(result.message); }
      catch (e) { console.warn("⚠️ Failed to parse result.message:", result.message); }
    }

    if (parsedMessage?.status === 'ok') {
      feedback.style.color = 'green';
      feedback.innerText = '✅ Command accepted';
      if ('angles' in parsedMessage) {
        updateAngleGrid(parsedMessage.angles);
      } else {
        console.warn("⚠️ No angles in parsed response:", parsedMessage);
      }
    } else if (parsedMessage?.status === 'error') {
      feedback.style.color = 'red';
      feedback.innerText = `❌ Error: ${parsedMessage.message || 'Unknown error'}`;
    } else {
      feedback.style.color = 'orange';
      feedback.innerText = `⚠️ Unknown response: "${result.message}"`;
    }
  } catch (err) {
    feedback.style.color = 'red';
    feedback.innerText = 'Error sending command.';
    console.error(err);
  }
}

/** Read from the text input, send command, and add to history. */
function sendCommand() {
  const input = document.getElementById('commandInput');
  const cmd = input.value.trim().toUpperCase();
  if (!cmd) return;
  input.value = '';
  dispatchCommand(cmd, true);
}

/** Convenience wrapper for preset buttons. */
function sendPreset(code) {
  console.log("Send Preset: ", code);
  dispatchCommand(code, false);
}


/* ================================================================================================
 * 5) History & connection panels
 * ================================================================================================ */

/** Populate the response column from /log (newest first), decorate errors, link line-ids. */
async function loadHistoryPanel() {
  try {
    const response = await fetch('/log');
    const data = await response.json();

    const responseList = document.getElementById('response-history');
    responseList.innerHTML = '';

    [...data].reverse().forEach((entry, i) => {
      const responseItem = document.createElement('li');
      const timestamp = new Date(entry.timestamp);
      const formattedTime = formatTimestamp(timestamp);
      const lineId = data.length - i;

      responseItem.textContent = `[#${lineId} - ${formattedTime}] ${entry.response}`;
      responseItem.dataset.lineId = `${lineId}`;

      if (entry.response.startsWith("ERR") || entry.response.includes('"status":"error"')) {
        responseItem.classList.add('error');
      }
      responseList.appendChild(responseItem);
    });
  } catch (err) {
    console.error("Failed to load history:", err);
  }

  setupHoverHighlighting();
}

/** Full-screen red modal for disconnect state. */
function setDisconnectedState(isDisconnected) {
  const modal = document.getElementById('disconnect-modal');
  modal.classList.toggle('hidden', !isDisconnected);
}

/** Poll /status and keep modal + angles in sync; re-probe angles after reconnect. */
function startConnectionMonitor() {
  setInterval(async () => {
    try {
      const response = await fetch('/status');
      const result = await response.json();

      if (result.connected) {
        if (wasDisconnected) {
          wasDisconnected = false;
          setDisconnectedState(false);
          reachSpeak("Robot reconnected.");
          if (!currentAngles) dispatchCommand('P', false); // ask for positions on reconnect
        }
      } else {
        throw new Error('Robot reported as disconnected');
      }
    } catch (err) {
      if (!wasDisconnected) {
        wasDisconnected = true;
        setDisconnectedState(true);
        currentAngles = null;
      }
    }
  }, 5000);
}

/** DELETE history on backend, clear UI/local copy, and reset indices. */
async function clearHistory() {
  try {
    const res = await fetch('/log/clear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const result = await res.json();
    if (result.status === 'success') {
      loadHistoryPanel();
      document.getElementById('sent-history').innerHTML = '';
      commandHistory = [];
      localStorage.setItem(HISTORY_KEY, '[]');
      historyIndex = 0;
    } else {
      alert("Failed to clear history");
    }
  } catch (err) {
    console.error("Error clearing history:", err);
  }
}

/** Start polling the log (2s) and do an immediate refresh. */
function startHistoryAutoRefresh() {
  if (historyPollInterval) clearInterval(historyPollInterval);
  loadHistoryPanel();
  historyPollInterval = setInterval(loadHistoryPanel, 2000);
}

/** Format ISO date as "YYYY-MM-DD HH:MM:SS". */
function formatTimestamp(date = new Date()) {
  return date.toISOString().replace('T', ' ').split('.')[0];
}

/** Hovering an item highlights the same line-id in both columns. */
function setupHoverHighlighting() {
  document.querySelectorAll('.history-list li').forEach(entry => {
    entry.addEventListener('mouseenter', () => {
      const lineId = entry.dataset.lineId;
      if (!lineId) return;
      document.querySelectorAll(`.history-list li[data-line-id="${lineId}"]`).forEach(el => el.classList.add('highlight'));
    });
    entry.addEventListener('mouseleave', () => {
      const lineId = entry.dataset.lineId;
      if (!lineId) return;
      document.querySelectorAll(`.history-list li[data-line-id="${lineId}"]`).forEach(el => el.classList.remove('highlight'));
    });
  });
}


/* ================================================================================================
 * 6) Macro manager (editing, save/load, playback, canned demos)
 * ================================================================================================ */

let macroSteps = [];            // editable macro lines (strings)
let lastSavedAngles = null;     // last snapshot used to compute delta line
let isPlayingMacro = false;
let playIndex = 0;

/**
 * Run a built-in macro sequence by label (DM1/DM2/DM3/SSLP/SCTR/RSLP).
 * Uses MUTE1/MUTE0 to silence chatter during playback.
 */
function runMacro(label) {
  const steps = macroSequences[label];
  if (!steps || steps.length === 0) return;

  let i = 0;
  const executeStep = () => {
    if (i >= steps.length) {
      dispatchCommand("MUTE0", false);
      return;
    }
    const step = steps[i++];

    if (step.startsWith("WAIT")) {
      const sec = parseInt(step.substring(4));
      setTimeout(executeStep, sec > 0 ? sec * 1000 : 0);
    } else {
      dispatchCommand(step, false).then(() => setTimeout(executeStep, 80));
    }
  };

  dispatchCommand("MUTE1", false).then(() => setTimeout(executeStep, 50));
}

/** Repaint the macro textbox from macroSteps and try to keep the caret near its previous line. */
function updateMacroTextbox(caretOffset = 0) {
  const textarea = document.getElementById('macroTextbox');
  const caretIndex = textarea.selectionStart;
  const linesBeforeCaret = textarea.value.substring(0, caretIndex).split('\n').length - 1;

  // Ensure we have enough lines after insertion
  let newCaretLine = linesBeforeCaret + caretOffset;
  if (newCaretLine > macroSteps.length) {
    macroSteps.push('');
  }

  textarea.value = macroSteps.join('\n');
  validateMacroSteps();

  // Restore caret to intended position
  let pos = 0;
  for (let i = 0; i < newCaretLine; i++) {
    pos += macroSteps[i]?.length + 1;
  }
  textarea.setSelectionRange(pos, pos);
  textarea.focus();
}

/** Validate each line with validateCommand() and display a small status summary. */
function validateMacroSteps() {
  const status = document.getElementById('macroStatus');
  let errors = macroSteps
    .map((line, idx) => validateCommand(line) ? `Line ${idx + 1}: ${validateCommand(line)}` : null)
    .filter(x => x !== null);

  if (errors.length === 0) {
    status.innerText = '✅ Macro is valid';
    status.style.color = 'green';
  } else {
    status.innerText = `⚠️ ${errors.length} issue(s):\n${errors.join('\n')}`;
    status.style.color = 'red';
  }
}

/** Insert a delta line for the current 6x angles (only the servos that changed). */
function macroAddCurrentState() {
  if (!Array.isArray(currentAngles)) return;

  const changed = currentAngles.map((angle, i) => {
    if (!lastSavedAngles || angle !== lastSavedAngles[i]) {
      return `N${i}${angle}`;
    }
    return null;
  }).filter(x => x !== null);

  if (changed.length > 0) {
    const line = changed.join(',');
    const textarea = document.getElementById('macroTextbox');
    let caretLine = textarea.value.substring(0, textarea.selectionStart).split('\n').length - 1;
    if (caretLine < macroSteps.length) caretLine += 1;
    macroSteps.splice(caretLine, 0, line);
    lastSavedAngles = [...currentAngles];
    updateMacroTextbox(1);
  }
}

/** Insert a WAIT{seconds} at caret line. */
function macroAddWait() {
  const val = parseInt(document.getElementById('waitDuration').value);
  if (isNaN(val) || val < 1) return;

  const textarea = document.getElementById('macroTextbox');
  let caretLine = textarea.value.substring(0, textarea.selectionStart).split('\n').length - 1;
  if (caretLine < macroSteps.length) caretLine += 1;

  macroSteps.splice(caretLine, 0, `WAIT${val}`);
  updateMacroTextbox(1);
}

/** Insert a BMD{ms} (backend motion delay) at caret line. */
function macroAddBMD() {
  const val = parseInt(document.getElementById('bmdDuration').value);
  if (isNaN(val) || val < 0) return;

  const textarea = document.getElementById('macroTextbox');
  let caretLine = textarea.value.substring(0, textarea.selectionStart).split('\n').length - 1;
  if (caretLine < macroSteps.length) caretLine += 1;

  macroSteps.splice(caretLine, 0, `BMD${val}`);
  updateMacroTextbox(1);
}

/** Insert a PP (2.5D) macro step using the dropdowns below. */
function macroAddPP() {
  const color = (document.getElementById('macroPPColor') || {}).value || 'red';
  const dest  = (document.getElementById('macroPPTag')   || {}).value || 'A';
  const op    = (document.getElementById('macroPPOp')    || {}).value || 'place';

  // Canonical human-friendly line; parser is flexible, but keep this shape:
  // PP pick=<source> dest=<destination> op=<place|drop|pour>
  const line = `PP pick=${color} dest=${dest} op=${op}`;

  const textarea = document.getElementById('macroTextbox');
  let caretLine = textarea.value.substring(0, textarea.selectionStart).split('\n').length - 1;
  if (caretLine < macroSteps.length) caretLine += 1;

  macroSteps.splice(caretLine, 0, line);
  updateMacroTextbox(1);
}


/** Clear macro editor and state. */
function macroClear() {
  macroSteps = [];
  lastSavedAngles = null;
  updateMacroTextbox();
}

/**
 * Save macro to a file:
 *  - Uses File System Access API when available (Chromium), else falls back to a blob download.
 */
async function macroSaveToFile() {
  const defaultName = `macro-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;

  // Preferred: File System Access API (Chromium-based)
  if ('showSaveFilePicker' in window) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: defaultName,
        types: [{ description: 'Text Files', accept: { 'text/plain': ['.txt'] } }]
      });

      const writable = await handle.createWritable();
      await writable.write(macroSteps.join('\n'));
      await writable.close();
      alert("✅ Macro saved successfully.");
      return;
    } catch (err) {
      console.warn("Save picker failed or was cancelled:", err);
      // Fall through to fallback below
    }
  }

  // Fallback: regular browser download
  const fileName = prompt("Enter filename to save:", defaultName);
  if (!fileName) return;

  const blob = new Blob([macroSteps.join('\n')], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName.endsWith('.txt') ? fileName : fileName + '.txt';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  alert("✅ Macro saved using fallback method. Choose the folder in the browser’s dialog.");
}

/** Load macro steps from a local .txt file (one command per line). */
function macroLoadFromFile() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.txt';
  input.onchange = () => {
    const file = input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = e => {
      macroSteps = e.target.result.split('\n').map(l => l.trim()).filter(l => l !== '');
      lastSavedAngles = null;
      updateMacroTextbox();
    };
    reader.readAsText(file);
  };
  input.click();
}

/** Parse "PP ..." line into { pick, dest, op }.
 * Accepts flexible forms like:
 *   PP pick=red dest=C op=place
 *   PP red -> C : pour
 *   PP red C drop
 */
function parsePP(line) {
  const raw = line.trim();
  if (!raw.toUpperCase().startsWith('PP')) return null;

  // Try key=value form first
  const kv = {};
  raw.replace(/([a-z]+)\s*=\s*([^\s]+)/gi, (_, k, v) => (kv[k.toLowerCase()] = v));
  let pick = kv.pick, dest = kv.dest, op = kv.op;

  // Fallback: free-form "PP red -> C : pour" or "PP red C drop"
  if (!pick || !dest) {
    const mArrow = raw.match(/^PP\s+(\S+)\s*->\s*([A-Za-z0-9]+)(?:\s*[:]\s*(\S+))?/i);
    const mFree  = raw.match(/^PP\s+(\S+)\s+([A-Za-z0-9]+)(?:\s+(\S+))?/i);
    const m = mArrow || mFree;
    if (m) {
      pick = pick || m[1];
      dest = dest || m[2];
      op   = op   || m[3];
    }
  }

  op = (op || 'place').toLowerCase();
  if (!pick || !dest) throw new Error('PP line needs pick and dest.');
  if (!['place','drop','pour'].includes(op)) throw new Error('PP op must be place|drop|pour.');
  return { pick, dest, op };
}

/** Execute a parsed PP step using pickplace.js public API. */
async function runPP({ pick, dest, op }) {
  if (op === 'drop') {
    if (typeof window.runGrabDrop !== 'function') throw new Error('runGrabDrop not available');
    await window.runGrabDrop(pick, dest);
  } else if (op === 'pour') {
    if (typeof window.runGrabPour !== 'function') throw new Error('runGrabPour not available');
    await window.runGrabPour(pick, dest);
  } else {
    if (typeof window.runPickPlace !== 'function') throw new Error('runPickPlace not available');
    await window.runPickPlace(pick, dest);
  }
}


/**
 * Play the macro shown in the editor (or loop it if toggle set).
 * Uses a tiny visual arrow (➡️) to indicate the current line.
 */
async function macroPlay() {
  if (isPlayingMacro) return;

  macroSteps = document.getElementById('macroTextbox').value
    .split('\n').map(l => l.trim()).filter(l => l !== '');

  function isLoopEnabled() { return document.getElementById('macroLoopToggle').checked; }

  const textbox = document.getElementById('macroTextbox');

  const playLine = (idx) => {
    const all = textbox.value.split('\n');
    textbox.value = all.map((line, i) => i === idx ? `➡️ ${line}` : line).join('\n');
  };
  const clearHighlight = () => { textbox.value = macroSteps.join('\n'); };

  const runStep = async () => {
    if (!isPlayingMacro) return;

    if (playIndex >= macroSteps.length) {
      if (isLoopEnabled()) {
        playIndex = 0;
      } else {
        isPlayingMacro = false;
        playIndex = 0;
        clearHighlight();
        return;
      }
    }

    const step = macroSteps[playIndex];
    playLine(playIndex);
    playIndex++;

    if (step.startsWith('WAIT')) {
      setTimeout(runStep, parseInt(step.substring(4)) * 1000);
    } else {
      if (step.startsWith('PP ')) {
        try {
          const spec = parsePP(step);
          await runPP(spec);
          setTimeout(runStep, 80);
        } catch (err) {
          console.error('PP step failed:', err);
          // stop playback on error, keep arrow on failing line for clarity
          isPlayingMacro = false;
          return;
        }
      } else {
        await dispatchCommand(step, false);
        setTimeout(runStep, 80);
      }
    }
  };

  isPlayingMacro = true;
  playIndex = 0;
  runStep();
}

/** Stop playback and remove the inline play indicator arrow. */
function macroStop() {
  isPlayingMacro = false;
  playIndex = 0;
  document.getElementById('macroTextbox').value = macroSteps.join('\n');
}


/* ================================================================================================
 * 7) App bootstrap (DOMContentLoaded)
 * ================================================================================================ */

window.addEventListener('DOMContentLoaded', async () => {
  // Start with a fresh, readable panel
  await fetch('/log/clear', { method: 'POST', headers: { 'Content-Type': 'application/json' } });

  loadHistoryPanel();
  startHistoryAutoRefresh();
  startConnectionMonitor();

  // Ask firmware for current positions shortly after UI is ready
  setTimeout(() => { if (!currentAngles) dispatchCommand('P', false); }, 1000);

  // Ensure we start at top (especially on mobile refresh)
  setTimeout(() => window.scrollTo(0, 0), 0);

  // Command box: Enter to send; ↑/↓ to navigate local history
  const commandInput = document.getElementById('commandInput');
  commandInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault(); sendCommand();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (historyIndex > 0) { historyIndex--; commandInput.value = commandHistory[historyIndex]; }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (historyIndex < commandHistory.length - 1) {
        historyIndex++; commandInput.value = commandHistory[historyIndex];
      } else {
        historyIndex = commandHistory.length;
        commandInput.value = '';
      }
    }
  });

  // Inline validation preview (beneath input)
  commandInput.addEventListener('input', () => {
    const value = commandInput.value.trim().toUpperCase();
    const preview = document.getElementById('command-preview');
    if (value === '') { preview.innerText = ''; preview.style.color = ''; return; }
    const error = validateCommand(value);
    preview.innerText = error ? `⚠️ ${error}` : '';
    preview.style.color = error ? 'red' : 'green';
  });

  // Compact header after 30s (reduce visual weight)
  setTimeout(() => {
    document.querySelector('.header')?.classList.add('compact-header');
    document.body.style.marginTop = '70px';
  }, 30000);

  // Collapsible panels — only toggle via the little triangle or the title
  document.querySelectorAll('.panel').forEach(panel => {
    const btn   = panel.querySelector('.toggle-btn');
    const title = panel.querySelector('.panel-title');

    const toggle = () => panel.classList.toggle('collapsed');

    if (btn) {
      btn.setAttribute('role', 'button');
      btn.setAttribute('tabindex', '0');
      btn.addEventListener('click', e => { e.stopPropagation(); toggle(); });
      btn.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
      });
    }

    if (title) {
      title.setAttribute('role', 'button');
      title.setAttribute('tabindex', '0');
      title.addEventListener('click', e => { e.stopPropagation(); toggle(); });
      title.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
      });
    }
  });


  setupSliders();

  // Macro editor live-validate
  const macroTextbox = document.getElementById('macroTextbox');
  macroTextbox.addEventListener('input', () => {
    macroSteps = macroTextbox.value
      .split('\n')
      .map(l => l.trim())
      .filter(l => l !== '');
    validateMacroSteps();
  });
});


/* ================================================================================================
 * 8) Voice → Robot bridge (events from voice-integration.js / VoiceModule)
 * ================================================================================================ */

/** Raw command path (used when voice wants to inject a firmware token directly). */
window.addEventListener("reach:voice:command", (e) => {
  const cmd = (e?.detail?.cmd || "").trim().toUpperCase();
  if (!cmd) return;

  if (typeof dispatchCommand === "function") {
    dispatchCommand(cmd, true);
    return;
  }

  // Last-resort HTTP (in case dispatchCommand wasn’t defined yet)
  fetch("/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command: cmd })
  }).catch(() => {});
});

/** Voice-level macro controls (play current, or run a labeled demo). */
window.addEventListener("reach:voice:macro", (e) => {
  const { type, label } = e.detail || {};

  if (type === "playCurrent") {
    if (typeof macroPlay === "function") macroPlay();
    return;
  }

  if (type === "runLabel" && label) {
    if (typeof runMacro === "function") runMacro(label);
  }
});

/** Emergency stop from voice: halts local playback and tells backend to stop motion. */
window.addEventListener("reach:voice:stop", () => {
  // Stop any local macro playback immediately
  if (typeof macroStop === "function") {
    try { macroStop(); } catch {}
  }
  // Signal backend/firmware
  fetch("/stop", { method: "POST" }).catch(() => {});

  // If firmware adds a STOP token later, you could:
  // if (typeof dispatchCommand === "function") dispatchCommand("STOP", true);
});

/** Optional: demo integration for voice “find color/tag” actions → Vision UI hooks if present. */
window.addEventListener("reach:voice:vision", (e) => {
  const { action, color, tag } = e.detail || {};

  if (action === "findColor" && typeof window.visionFindColor === "function") {
    window.visionFindColor(color);
  } else if (action === "findTag" && typeof window.visionFindTag === "function") {
    window.visionFindTag(tag);
  }
});

// ==== /Voice bridge ====
