/* =================================================================================================
Project: REACH App — UI web application to control the REACH robot arm
Institution: Hokkaido University (2025)
Last Update: Q3 2025
-------------------------------------------------------------------------------------------------
Authors:
  • Mikael Nicander Kuwahara — Lead System Designer & Lead Developer (2024–)
-------------------------------------------------------------------------------------------------
File: voice-integration.js
Purpose:
  • Load voice config, initialize VoiceModule, and bridge recognized intents to REACH controls.
  • Provide minimal user feedback and a modal “Available Voice Commands” help UI.
  • Preload the /vision/panel so color/tag “find …” commands work even if panel never opens.
External Contracts:
  • VoiceModule (./voice.js) — emits { intent, slots, transcript } via callback.
  • Robot layer (global) — window.dispatchCommand / runMacro / sendPreset / macroPlay (if present).
  • Vision panel (/vision/panel) — receives postMessage({ type: "voice:find"/"voice:findTag" }).
UI Hooks:
  • #voice-command-panel .voice-wrap (optional feedback insertion)
  • #voiceHelpBtn to open modal (voice.css styles the overlay & modal)
================================================================================================= */

import { VoiceModule } from "./voice.js";

/* =================================================================================================
 * FEEDBACK WIDGET (small, optional line under “Voice Commands”)
 * ================================================================================================= */

/** Ensure there is a #voice-feedback node just under the voice panel title. */
(function ensureFeedbackNode() {
  let fb = document.getElementById("voice-feedback");
  if (!fb) {
    const wrap = document.querySelector("#voice-command-panel .voice-wrap");
    if (wrap && wrap.parentNode) {
      fb = document.createElement("div");
      fb.id = "voice-feedback";
      fb.style.cssText = "margin-top:.5rem;font-size:.9rem;";
      wrap.parentNode.insertBefore(fb, wrap.nextSibling);
    }
  }
})();

/**
 * Set feedback line text/color in the voice panel (if present).
 * Exposed on window so other modules (e.g., VoiceModule) can call it safely.
 * @param {string} msg
 * @param {string} [color="#16a34a"] hex/rgb/css color
 */
function setFeedback(msg, color = "#16a34a") {
  const text = String(msg ?? "");
  const css = color || "";
  const fb = document.getElementById("voice-feedback");
  if (fb) {
    fb.textContent = text;
    fb.style.color = css;
  }
}
window.setFeedback = setFeedback;

/** Sequence-numbered “heard” tracer for easier UX debugging (still minimal UI noise). */
window.__voiceSeq = window.__voiceSeq || 0;
window.setHeardFeedback = function setHeardFeedback(raw, normalized) {
  window.__voiceSeq = (window.__voiceSeq + 1) % 1000;
  const line = `Heard [#${window.__voiceSeq}]: “${String(raw || "").trim()}” → “${String(
    normalized || ""
  ).trim()}”`;
  setFeedback(line, "#0ea5e9"); // cyan
};

let __voiceMsgSeq = 0;
const __voiceColors = ["#1a7f37", "#0d9488"]; // green ↔ teal

/** Add a rolling short id to messages to make repeats easier to differentiate. */
function setFeedbackSequenced(msg, color) {
  __voiceMsgSeq = (__voiceMsgSeq + 1) % 1000;
  const suffix = ` [#${__voiceMsgSeq}]`;
  const useColor = color || __voiceColors[__voiceMsgSeq % __voiceColors.length];
  setFeedback(msg + suffix, useColor);
}

/* =================================================================================================
 * ROBOT READINESS (avoid race on first page load)
 * ================================================================================================= */

/** True if any robot control entry point is available. */
function robotReady() {
  return !!(
    window.dispatchCommand ||
    window.runMacro ||
    window.sendPreset ||
    window.macroPlay
  );
}

/**
 * Wait for robot APIs to appear (polling; resolves early if already present).
 * @param {number} [timeoutMs=3000]
 * @returns {Promise<void>}
 */
function waitForRobotReady(timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    if (robotReady()) return resolve();
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (robotReady()) {
        clearInterval(iv);
        resolve();
      } else if (Date.now() - t0 > timeoutMs) {
        clearInterval(iv);
        reject(new Error("robot not ready"));
      }
    }, 50);
  });
}

/* =================================================================================================
 * VISION PANEL (preload + postMessage helpers)
 * ================================================================================================= */

/** @returns {HTMLIFrameElement[]} iframes pointing at /vision/panel */
function getVisionFrames() {
  const iframes = Array.from(document.querySelectorAll("iframe"));
  return iframes.filter((f) => {
    try {
      const src = f.getAttribute("src") || "";
      return /\/vision\/panel(\/|$|\?)/.test(src);
    } catch {
      return false;
    }
  });
}

/** Ensure at least one /vision/panel iframe exists (hidden preload). */
function ensureVisionReady() {
  return new Promise((resolve) => {
    const frames = getVisionFrames();
    if (frames.length > 0) return resolve(frames);

    const f = document.createElement("iframe");
    f.src = "/vision/panel";
    f.setAttribute("loading", "eager");
    f.style.cssText =
      "position:absolute;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0;";
    f.dataset.voicePreload = "1";
    f.onload = () => resolve([f]);
    document.body.appendChild(f);
  });
}

/** Post a message to all ready /vision/panel frames (same-origin). */
function postToVisionAll(msg) {
  const origin = window.location.origin;
  const frames = getVisionFrames();
  if (!frames.length) return;
  frames.forEach((f) => {
    try {
      f.contentWindow?.postMessage(msg, origin);
    } catch {}
  });
}

/** Ask Vision panel to find a color badge. */
async function findColor(color) {
  await ensureVisionReady();
  postToVisionAll({ type: "voice:find", color: String(color || "").toLowerCase() });
}

/** Ask Vision panel to find a tag badge. */
async function findTag(tag) {
  await ensureVisionReady();
  postToVisionAll({ type: "voice:findTag", tag: String(tag || "").toUpperCase() });
}

/* =================================================================================================
 * 2.5D TASK: Parent → Pick/Place panel (same-window)
 * ================================================================================================= */

/** Emit a UI task payload for the Pick/Place panel to handle. */
function emitVoiceTaskToPickPlace(payload) {
  window.postMessage({ type: "voice:task", payload }, window.location.origin);
}

/* =================================================================================================
 * ROBOT HELPERS
 * ================================================================================================= */

/**
 * Send a compact robot command, uppercased, after readiness.
 * Falls back to an app-level event if dispatchCommand is absent.
 * @param {string} code e.g., "N0150", "GRP", "SSLP"
 */
async function robotSend(code) {
  const cmd = String(code || "").trim().toUpperCase();
  if (!cmd) return;
  await waitForRobotReady();
  if (typeof window.dispatchCommand === "function") {
    window.dispatchCommand(cmd, true);
    return;
  }
  // Fallback: let reach-control’s listener handle it
  window.dispatchEvent(new CustomEvent("reach:voice:command", { detail: { cmd } }));
}

/** Broadcast a soft-stop signal for anything listening in the app. */
function emitStop() {
  window.dispatchEvent(new CustomEvent("reach:voice:stop"));
}

/* =================================================================================================
 * CONFIG LOADER + NORMALIZER
 * ================================================================================================= */

/** Fetch ./voice/voice.config.json and normalize with sensible defaults. */
async function loadConfig() {
  try {
    const res = await fetch("./voice/voice.config.json", { cache: "no-store" });
    if (!res.ok) throw new Error(res.statusText);
    const raw = await res.json();
    return normalizeVoiceConfig(raw);
  } catch {
    return normalizeVoiceConfig({});
  }
}

/** Normalize older/newer schemas into one shape the app expects. */
function normalizeVoiceConfig(raw) {
  const cfg = {
    lang: raw.lang || raw.locale || "en-US",
    wakeWords: raw.wakeWords || (raw.wakeword ? [raw.wakeword] : ["reach"]),
    autoStart: !!raw.autoStart,

    // Feature gates
    features: Object.assign({ move: true, presets: true, macros: true, vision: true }, raw.features || {}),

    // Servo safety limits (default + per-index overrides)
    servoLimits: Object.assign({ default: 180, "5": 80 }, raw.servoLimits || {}),

    // Spoken → robot preset codes
    presets: Object.assign(
      {
        "sleep": "SLP",
        "center": "CTR",
        "prepare": "PLT",
        "get ready": "PLT",
        "open hand": "REL",
        "close hand": "GRP",
        "lift": "LFT",
      },
      raw.presets || {}
    ),

    // Macro phrases & named labels
    macros: {
      runCurrentPhrases: raw.macros?.runCurrentPhrases || ["run macro", "play macro"],
      labels: Object.assign(
        {
          "demo 1": "DM1",
          "wave": "DM2",
          "demo 2": "DM2",
          "dance": "DM3",
          "demo 3": "DM3",
          "safe sleep": "SSLP",
          "safe center": "SCTR",
        },
        raw.macros?.labels || {}
      ),
    },

    // Safety stop phrases
    stop: {
      phrases: raw.stop?.phrases && raw.stop.phrases.length ? raw.stop.phrases : ["stop now"],
    },

    // Vision search metadata & phrases
    vision: {
      colors: (raw.vision?.colors || raw.colors || ["red", "green", "blue", "yellow", "orange", "purple", "black", "white"]).map((s) =>
        String(s).toLowerCase()
      ),
      tags: (raw.vision?.tags || raw.tags || ["a", "b", "c", "d", "1", "2", "3", "4"]).map((s) =>
        String(s).toLowerCase()
      ),
      phrases: {
        findColor: raw.vision?.phrases?.findColor || ["find {color}"],
        findTag: raw.vision?.phrases?.findTag || ["find tag {tag}"],
      },
    },
  };
  return cfg;
}

/* =================================================================================================
 * INTENT LIST (for VoiceModule) — based on feature gates in config
 * ================================================================================================= */

/**
 * Build the intents array for VoiceModule from normalized config.
 * Includes templated intents and literal phrases (presets/macros/stop).
 */
function buildIntents(cfg) {
  const intents = [];

  if (cfg.features.move) {
    intents.push("move {index} to {degree}");
    intents.push("move servo {index} to {degree}");
  }

  if (cfg.features.presets) {
    intents.push(...Object.keys(cfg.presets)); // e.g., "sleep", "open hand"
  }

  if (cfg.features.macros) {
    intents.push(...cfg.macros.runCurrentPhrases); // "run macro", "play macro"
    intents.push(...Object.keys(cfg.macros.labels)); // "demo 1", "wave", …
  }

  // Safety stop phrases are always added
  intents.push(...cfg.stop.phrases);

  if (cfg.features.vision) {
    // Vision commands
    intents.push(...cfg.vision.phrases.findColor);
    intents.push(...cfg.vision.phrases.findTag);

    // 2.5D Task phrases (kept compact; UI validates completeness)
    intents.push("pick tag {from} and place at tag {to}");
    intents.push("pick tag {from} and place tag {to}");
    intents.push("pick tag {from} and place {to}");
    intents.push("pick tag {from} and pour at tag {to}");
    intents.push("pick tag {from} and pour {to}");
    intents.push("pick {color} and place at tag {tag}");
    intents.push("pick {color} and place {tag}");
    intents.push("pick {color} and drop at tag {tag}");
    intents.push("pick {color} and drop {tag}");
  }

  // De-duplicate while preserving left-most order
  return Array.from(new Set(intents));
}

/* =================================================================================================
 * UTILITIES
 * ================================================================================================= */

function clamp(val, lo, hi) {
  return Math.max(lo, Math.min(hi, val));
}

/** Max safe angle per servo index (fallback to default). */
function servoMaxFor(idx, cfg) {
  const key = String(idx);
  if (Object.prototype.hasOwnProperty.call(cfg.servoLimits, key)) return cfg.servoLimits[key];
  return cfg.servoLimits.default ?? 180;
}

/** Human-friendly limits summary, e.g., “range 0–180°, except servo 5 (gripper) max 80°”. */
function limitsNote(cfg) {
  const def = cfg.servoLimits?.default ?? 180;
  const names = Array.isArray(window.SERVO_NAMES) ? window.SERVO_NAMES : [];
  const niceName = (i) => {
    const raw = names[i] || "";
    const label = raw.replace(/\(.*\)/, "").trim() || (i === 5 ? "gripper" : "");
    return label ? `servo ${i} (${label.toLowerCase()})` : `servo ${i}`;
  };

  const exceptions = Object.entries(cfg.servoLimits || {})
    .filter(([k, v]) => k !== "default" && Number(v) !== Number(def))
    .map(([k, v]) => `${niceName(Number(k))} max ${v}°`);

  if (!exceptions.length) return `range 0–${def}°`;
  if (exceptions.length === 1) return `range 0–${def}°, except ${exceptions[0]}`;
  return `range 0–${def}°, except ${exceptions.join("; ")}`;
}

/* =================================================================================================
 * HELP MODAL
 * ================================================================================================= */

/** Ensure overlay + modal exist and return imperative API to open & set content. */
function ensureVoiceHelpModal() {
  // voice.css provides styles (no injected CSS here)
  let overlay = document.getElementById("voiceHelpOverlay");
  let modal = document.getElementById("voiceHelpModal");

  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "voiceHelpOverlay";
    overlay.className = "vh-overlay";
    document.body.appendChild(overlay);
  }
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "voiceHelpModal";
    modal.className = "vh-modal";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("tabindex", "-1");
    modal.innerHTML = `
      <div class="vh-head">
        <h3 class="vh-title" id="voiceHelpTitle">Available Voice Commands</h3>
        <button class="vh-close" id="voiceHelpClose" aria-label="Close">&times;</button>
      </div>
      <div class="vh-body" id="voiceHelpBody"></div>
    `;
    document.body.appendChild(modal);
  }

  const closeBtn = modal.querySelector("#voiceHelpClose");
  const bodyEl = modal.querySelector("#voiceHelpBody");
  const helpBtn = document.getElementById("voiceHelpBtn");

  let lastFocus = null;
  const onKey = (e) => {
    if (e.key === "Escape") close();
  };

  const open = () => {
    if (helpBtn) helpBtn.setAttribute("data-suppress-hint", "1");
    lastFocus = document.activeElement;
    document.body.classList.add("vh-open");
    overlay.classList.add("is-open");
    modal.classList.add("is-open");
    document.addEventListener("keydown", onKey);
    modal.focus();
  };

  const close = () => {
    overlay.classList.remove("is-open");
    modal.classList.remove("is-open");
    document.removeEventListener("keydown", onKey);
    document.body.classList.remove("vh-open");
    if (helpBtn) setTimeout(() => helpBtn.removeAttribute("data-suppress-hint"), 250);
    if (lastFocus && typeof lastFocus.focus === "function") lastFocus.focus();
  };

  overlay.onclick = close;
  closeBtn.onclick = close;

  return {
    openModal: open,
    setModalContent: (html) => {
      bodyEl.innerHTML = html;
    },
  };
}

/** Render help content grouped by features; attach click handler to #voiceHelpBtn. */
function renderVoiceHelp(cfg) {
  const btn = document.getElementById("voiceHelpBtn");
  if (!btn) return;

  const { openModal, setModalContent } = ensureVoiceHelpModal();

  const groupByValue = (obj) => {
    const map = new Map();
    for (const [phrase, code] of Object.entries(obj || {})) {
      const arr = map.get(code) || [];
      arr.push(phrase);
      map.set(code, arr);
    }
    return map;
  };

  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
  const joinPhrases = (arr) => arr.map((p) => `<code>${esc(p)}</code>`).join(" / ");

  const wake = `
    <div class="sec">
      <h4>Wake words</h4>
      <div>${(cfg.wakeWords || []).map((w) => `<code>${esc(w)}</code>`).join(" / ")}</div>
    </div>`;

  const moveSec = cfg.features?.move
    ? `
    <div class="sec">
      <h4>Move</h4>
      <ul>
        <li><code>move {index} {degree}</code> <small>(e.g. <code>move 1 135</code>; ${esc(limitsNote(cfg))})</small></li>
        <li><code>move servo {index} {degree}</code> <small>(optional phrasing)</small></li>
      </ul>
    </div>`
    : "";

  let presetsSec = "";
  if (cfg.features?.presets) {
    const grouped = groupByValue(cfg.presets || {});
    const items = Array.from(grouped.entries())
      .map(([code, phrases]) => `<li>${joinPhrases(phrases)} &rarr; <code>${esc(code)}</code></li>`)
      .join("");
    presetsSec = `<div class="sec"><h4>Presets</h4><ul>${items}</ul></div>`;
  }

  let macrosSec = "";
  if (cfg.features?.macros) {
    const runCurrent =
      (cfg.macros?.runCurrentPhrases || []).map((p) => `<code>${esc(p)}</code>`).join(" / ");
    const grouped = groupByValue(cfg.macros?.labels || {});
    const items = Array.from(grouped.entries())
      .map(([label, phrases]) => `<li>${joinPhrases(phrases)} &rarr; <code>${esc(label)}</code></li>`)
      .join("");
    macrosSec = `
      <div class="sec">
        <h4>Macros</h4>
        <ul>
          <li>${runCurrent || "<code>run macro</code> / <code>play macro</code>"} &rarr; <em>run current</em></li>
          ${items}
        </ul>
      </div>`;
  }

  const stopSec = `
    <div class="sec">
      <h4>Emergency Stop</h4>
      <div>${(cfg.stop?.phrases || ["stop now"]).map((p) => `<code>${esc(p)}</code>`).join(" / ")}</div>
    </div>`;

  let visionSec = "";
  if (cfg.features?.vision) {
    const v = cfg.vision || {};
    const phrases = v.phrases || {};
    const colors = (v.colors || []).slice(0, 12).join(", ");
    const tags = (v.tags || []).slice(0, 12).join(", ");
    visionSec = `
      <div class="sec">
        <h4>Vision (UI highlights)</h4>
        <ul>
          <li>${(phrases.findColor || ["find {color}"]).map((p) => `<code>${esc(p)}</code>`).join(" / ")}</li>
          <li>${(phrases.findTag || ["find tag {tag}"]).map((p) => `<code>${esc(p)}</code>`).join(" / ")}</li>
        </ul>
        <div style="margin-top:.25rem">
          <small>colors: ${esc(colors)}</small><br/>
          <small>tags: ${esc(tags)}</small>
        </div>
      </div>`;
  }

  const tasksSec = `
    <div class="sec">
      <h4>2.5D Tasks</h4>
      <ul>
        <li><code>pick {color} and place at tag {tag}</code></li>
        <li><code>pick {color} and drop at tag {tag}</code></li>
        <li><code>pick tag {from} and place at tag {to}</code></li>
        <li><code>pick tag {from} and pour at tag {to}</code></li>
      </ul>
      <div style="margin-top:.25rem">
        <small>Tasks only run when all three parts are present: what to pick (color or tag), what to do (place/drop/pour), and where to place (tag). Partial phrases prefill the UI but do not run.</small>
      </div>
    </div>`;

  const html = `${wake}${moveSec}${presetsSec}${macrosSec}${stopSec}${visionSec}${tasksSec}`;
  setModalContent(html);

  // Make the button behave like: "Click for available commands"
  btn.removeAttribute("title");
  btn.setAttribute("data-hint", "Click for available commands");
  btn.onclick = (e) => {
    e.preventDefault();
    openModal();
  };
}

/* =================================================================================================
 * BOOT
 * ================================================================================================= */

(async function boot() {
  // Preload vision so "find red" works even if user never opens the panel
  ensureVisionReady();

  const cfg = await loadConfig();
  const intents = buildIntents(cfg);
  renderVoiceHelp(cfg);

  // On re-mounts, ensure modal state is closed
  (() => {
    const ov = document.getElementById("voiceHelpOverlay");
    const md = document.getElementById("voiceHelpModal");
    ov?.classList.remove("is-open");
    md?.classList.remove("is-open");
    document.body.classList.remove("vh-open");
  })();

  const vm = new VoiceModule({
    wakeWords: cfg.wakeWords,
    wakeword: cfg.wakeWords?.[0] || "hey robot",
    locale: cfg.lang || "en-US",
    autoStart: !!cfg.autoStart,
    intents,
    colors: cfg.vision.colors.map((c) => c.toLowerCase()),
    tags: cfg.vision.tags.map((t) => t.toUpperCase()), // VM matches A/B/C/…
    stayAwake: true,

    /**
     * Bridge recognized intent to robot/vision/panel behavior.
     * All feedback remains short and non-blocking.
     */
    onCommand: async ({ intent, slots, transcript }) => {
      const normIntent = (s) => {
        const t = String(s || "").toLowerCase().trim();
        const tNo = t.replace(/\s+/g, "");
        if (/^move(?:\s+servo)?(?:\s+to)?$/.test(t)) return "move";
        if (/^move(?:servo)?(?:to)?$/.test(tNo)) return "move";
        return t;
      };
      const t = normIntent(intent);

      // Guard: nothing matched
      if (!intent || !t) {
        setHeardFeedback(transcript, transcript);
        setFeedbackSequenced('I didn’t catch a full command. Try: "pick red and place at tag B".', "#cc8b00");
        return;
      }

      try {
        // 0) STOP (safety)
        if (cfg.stop.phrases.map((s) => s.toLowerCase()).includes(t)) {
          setFeedback("Emergency stop requested…");
          emitStop();
          return;
        }

        // 1) MOVE (single-servo)
        if (cfg.features.move && t === "move" && slots?.index != null && slots?.degree != null) {
          let idx = parseInt(slots.index, 10);
          let deg = parseInt(slots.degree, 10);
          if (Number.isFinite(idx) && Number.isFinite(deg)) {
            idx = clamp(idx, 0, 5);
            deg = clamp(deg, 0, servoMaxFor(idx, cfg));
            const code = `N${idx}${deg}`;
            setFeedback(`Move servo ${idx} to ${deg}° → ${code}`);
            reachSpeak(`Moving servo ${idx} to ${deg} degrees.`);
            await robotSend(code);
            return;
          }
        }

        // 2) PRESETS
        if (cfg.features.presets) {
          const presetCode = cfg.presets[t]; // direct match on phrase key (lowercased)
          if (presetCode) {
            setFeedback(`Preset: ${t.toUpperCase()} → ${presetCode}`);
            reachSpeak(`Preset ${t} executed.`);
            await robotSend(presetCode);
            return;
          }
        }

        // 3) MACROS (run current or named)
        if (cfg.features.macros) {
          if (cfg.macros.runCurrentPhrases.map((s) => s.toLowerCase()).includes(t)) {
            setFeedback("Running current macro…");
            await waitForRobotReady();
            if (typeof window.macroPlay === "function") window.macroPlay();
            else if (typeof window.runMacro === "function") window.runMacro("DM1"); // fallback
            return;
          }
          const label = cfg.macros.labels[t];
          if (label) {
            setFeedback(`Macro: ${t} → ${label}`);
            await waitForRobotReady();
            if (typeof window.runMacro === "function") window.runMacro(label);
            else await robotSend(label); // last resort
            return;
          }
        }

        // 4) VISION “find …”
        if (cfg.features.vision) {
          const color = slots?.color ? String(slots.color).toLowerCase() : null;
          const tag = slots?.tag ? String(slots.tag).toLowerCase() : null;

          if (t === "find" && color && cfg.vision.colors.includes(color)) {
            setFeedback(`Finding color: ${color}…`);
            reachSpeak(`Looking for ${color}.`);
            await findColor(color);
            return;
          }
          if (t === "find tag" && tag && cfg.vision.tags.includes(tag)) {
            setFeedback(`Finding tag: ${tag.toUpperCase()}…`);
            await findTag(tag);
            return;
          }
        }

        // 5) 2.5D Tasks (UI-only; always prefill; run only when complete)
        if (cfg.features.vision) {
          // Source (color OR tag)
          let source = null;
          if (slots?.color) source = { kind: "color", value: String(slots.color).toLowerCase() };
          else if (slots?.from) source = { kind: "tag", value: String(slots.from).toUpperCase() };

          // Destination tag
          const destTag =
            slots?.tag ? String(slots.tag).toUpperCase() :
            slots?.to ? String(slots.to).toUpperCase() :
            undefined;

          // Operation
          let op;
          const it = (intent || "").toLowerCase();
          if (/\bdrop\b|\brelease\b/.test(it)) op = "drop";
          else if (/\bpour\b|\bspill\b/.test(it)) op = "pour";
          else if (/\bplace\b|\bput\b/.test(it) || it.includes("pick")) op = "place";

          const payload = { op };
          if (source?.kind === "color") payload.color = source.value;
          else if (source?.kind === "tag") payload.from = source.value;
          if (destTag) {
            payload.tag = destTag;
            payload.to = destTag;
          }

          // Prefill the Pick/Place panel with parsed parts
          emitVoiceTaskToPickPlace(payload);

          const haveSource = !!(source && source.kind && source.value);
          const haveOp = !!op;
          const haveDest = !!destTag;

          if (haveSource && haveOp && haveDest) {
            const srcLabel = source.kind === "color" ? source.value : `tag ${source.value}`;
            setFeedbackSequenced(`OK — pick ${srcLabel} → ${op} at tag ${destTag}…`);
            reachSpeak(`Picking ${source.kind === "color" ? source.value : `tag ${source.value}`} and ${op} at tag ${destTag}.`);
          } else {
            const missing = [];
            if (!haveSource) missing.push("what to pick (color or tag)");
            if (!haveOp) missing.push("what to do (place/drop/pour)");
            if (!haveDest) missing.push("where to place (tag)");
            if (missing.length) setFeedbackSequenced(`I need ${missing.join(", ")}.`, "#cc8b00");
          }
          return;
        }

        // Unknown command (soft notice)
        setFeedback(`Unknown command: ${intent}`, "#ffcc66");
      } catch {
        setFeedback("Voice command failed.", "#ff6666");
      }
    },
  });

  // Optional exposure for manual testing
  window.vm = vm;
})();
