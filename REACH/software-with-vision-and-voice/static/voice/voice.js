/* =================================================================================================
Project: REACH App — UI web application to control the REACH robot arm
Institution: Hokkaido University (2025)
Last Update: Q3 2025
-------------------------------------------------------------------------------------------------
Authors:
  • Mikael Nicander Kuwahara — Lead System Designer & Lead Developer (2024–)
-------------------------------------------------------------------------------------------------
File: voice.js
Purpose:
  • VoiceModule: wake-word(s) + intents with stay-awake, Edge-safe events, and punctuation-tolerant matching.
  • Emits a callback (opts.onCommand) and a DOM event "voice:command" for app-wide consumption.
  • Provides resilient transcript normalization for common ASR quirks.
UI Hooks (optional if elements exist in DOM):
  • #voiceToggle  — toggles listening on/off
  • #voiceStatus  — displays "off" / "idle" / "awake" / transient hints
  • [data-wakeword-hint] — shows wake-word prompt when listening but not awake
Notes:
  • Designed to be non-breaking and framework-agnostic; no external dependencies.
  • Keeps a short-lived buffer to combine partial "move {index} [to]" utterances into a full command.
  • Includes an Edge-safe CustomEvent shim for older Chromium-based Edge.
================================================================================================= */

/* -------------------------------------------------------------------------------------------------
ASR Normalization Rules
- A single, ordered list of [RegExp, replacement] pairs.
- Applied sequentially in _preNormalizeTranscript().
- All matching is done on lower-cased text.
Extend by pushing new tuples; preserve order for correctness where rules overlap.
------------------------------------------------------------------------------------------------- */
const ASR_NORMALIZERS = [
  // Phrase / intent scaffolding
  [/\bin place\b/g, " and place"],
  [/\ba target\b/g, " at tag"],
  [/\btarget\b/g, " tag"],                    // e.g., "place at target a" → "place at tag a"
  [/\bplace a tag\b/g, " place at tag"],

  // Homophones for "pour"
  [/\bpoor\b/g, " pour"],
  [/\bpore\b/g, " pour"],
  [/\bfour\b(?=\s+at\s+tag\b)/g, " pour"],    // “four at tag …” → pour at tag …

  // “that tag” variants
  [/\bplace\s+that\s+tag\b/g, " place at tag"],
  [/\bthat\s+tag\b/g, " at tag"],

  // “a taxi / ataxi / ataxy” (common for “at tag C”)
  [/\b(drop|place|pour)\s+a\s+taxi\b/g, "$1 at tag c"],
  [/\b(drop|place|pour)\s+at\s+tax[yi]\b/g, "$1 at tag c"],

  // “pick” homophones
  [/\bpeak\b/g, " pick"],
  [/\bpeek\b/g, " pick"],
  [/\bpique\b/g, " pick"],
  [/\bpig\b/g, " pick"],
];

/**
 * VoiceModule — wake-word(s) + intent matching with stay-awake behavior.
 * Emits:
 *   • Callback: opts.onCommand({ intent, slots, transcript })
 *   • DOM Event: "voice:command" (bubbles, composed) with the same detail payload
 */
export class VoiceModule {
  /**
   * @param {Object} opts
   * @param {string} [opts.wakeword="hey robot"] Legacy single wakeword (back-compat)
   * @param {string[]} [opts.wakeWords]          Preferred: array of wake words
   * @param {string} [opts.locale="en-US"]       BCP-47 language tag for ASR
   * @param {boolean} [opts.autoStart=false]     Start listening immediately
   * @param {string[]} [opts.intents]            Intent templates with {slots}
   * @param {string[]} [opts.colors]             Allowed color words
   * @param {string[]} [opts.tags]               Allowed tag labels (A–D, 1–4, etc.)
   * @param {boolean} [opts.stayAwake=true]      Keep listening after wakeword
   * @param {number} [opts.awakeMs=30000]        Auto-sleep after N ms idle
   * @param {string[]} [opts.sleepPhrases]       Phrases to force sleep
   * @param {(payload: {intent:string, slots:Object, transcript:string})=>void} [opts.onCommand]
   */
  constructor(opts = {}) {
    this.opts = Object.assign(
      {
        // Wake words & locale
        wakeword: "hey robot", // legacy single (kept for backward compat)
        wakeWords: null,       // preferred: array of wake words
        locale: "en-US",

        // Autostart & grammar
        autoStart: false,
        intents: [
          "move {index} {degree}",
          "find {color}",
          "find tag {tag}",
          "do the dance",
          "sleep",
          "get ready"
        ],
        colors: ["red", "green", "blue", "yellow", "orange", "purple", "cyan", "magenta"],
        tags: ["A", "B", "C", "D", "1", "2", "3", "4"],

        // Stay-awake behavior
        stayAwake: true, // keep listening for multiple commands after wakeword
        awakeMs: 30000,  // how long to stay awake since last heard speech
        sleepPhrases: ["goodbye", "stop listening", "thanks, reach"],

        onCommand: null
      },
      opts
    );

    // ---- Multiple wake words ----
    this._wakeList =
      Array.isArray(this.opts.wakeWords) && this.opts.wakeWords.length
        ? this.opts.wakeWords
        : [this.opts.wakeword || "hey robot"];
    this._hintWake = this._wakeList[0];

    this.SR = window.SpeechRecognition || window.webkitSpeechRecognition || null;
    this.state = { listening: false, awake: false, lastHeardAt: 0, timer: null };

    // Optional UI elements (if present)
    this.ui = {
      toggle: document.getElementById("voiceToggle"),
      status: document.getElementById("voiceStatus"),
      hint: document.querySelector("[data-wakeword-hint]")
    };

    this._bindUI();
    this._prepareIntents();
    this._setupSR();
    if (this.opts.autoStart) this.enable();
  }

  // =================================================================================================
  // UI WIRING
  // =================================================================================================

  _bindUI() {
    if (!this.ui.toggle || !this.ui.status) return;
    if (!this.SR) {
      this.ui.toggle.disabled = true;
      this.ui.status.textContent = "speech not supported";
      if (this.ui.hint) this.ui.hint.style.display = "none";
      return;
    }
    this.ui.toggle.addEventListener("click", () => {
      if (this.state.listening) {        
        this.disable();
      }
      else {
        this.enable();     
      }
    });
    this._renderUI();
  }

  _renderUI() {
    if (!this.ui.toggle || !this.ui.status) return;
    const on = this.state.listening;
    this.ui.toggle.classList.toggle("on", on);
    this.ui.toggle.textContent = on ? "🎙️ Voice: On" : "🎙️ Voice: Off";
    this.ui.status.textContent = on ? (this.state.awake ? "awake" : "idle") : "off";
    if (this.ui.hint) {
      if (on && !this.state.awake) {
        const wakes =
          this._wakeList && this._wakeList.length
            ? this._wakeList
            : [this.opts.wakeword || "hey robot"];
        this.ui.hint.textContent = `Say ${wakes.map((w) => `"${w}"`).join(" / ")} to wake.`;
        this.ui.hint.style.display = "";
      } else {
        this.ui.hint.style.display = "none";
      }
    }
  }

  // =================================================================================================
  // SPEECH RECOGNITION SETUP
  // =================================================================================================

  _setupSR() {
    if (!this.SR) return;
    this.rec = new this.SR();
    this.rec.lang = this.opts.locale;
    this.rec.continuous = true;
    this.rec.interimResults = true;

    this.rec.onstart = () => {
      this.state.listening = true;
      this._renderUI();
    };

    this.rec.onerror = (e) => {
      this._setStatus(`error: ${e.error}`);
    };

    this.rec.onend = () => {
      this.state.listening = false;
      this._renderUI();
      if (this._wantOn) {
        try {
          this.rec.start();
        } catch {}
      }
    };

    this.rec.onresult = (evt) => {
      // Interim (for quick wake feedback)
      let interim = "";
      for (let i = evt.resultIndex; i < evt.results.length; i++) {
        const res = evt.results[i];
        const t = res[0]?.transcript || "";
        if (!res.isFinal) interim += t + " ";
      }
      interim = interim.trim().toLowerCase();
      if (interim) {
        this.state.lastHeardAt = Date.now();
        if (!this.state.awake && this._looksLikeWakeword(interim)) this._wake();
        if (this.state.awake && this._looksLikeSleepPhrase(interim)) this._sleep();
      }

      // Finals (for actual intent execution)
      let finalText = "";
      for (let i = evt.resultIndex; i < evt.results.length; i++) {
        const res = evt.results[i];
        if (res.isFinal) finalText += (res[0]?.transcript || "") + " ";
      }

      // keep a copy BEFORE normalization
      const rawFinalText = finalText; // eslint-disable-line no-unused-vars

      // normalize (now powered by ASR_NORMALIZERS)
      finalText = this._preNormalizeTranscript(finalText);

      if (finalText) {
        this.state.lastHeardAt = Date.now();
        if (!this.state.awake && this._looksLikeWakeword(finalText)) {
          this._wake();
          return;
        }
        if (this.state.awake && this._looksLikeSleepPhrase(finalText)) {
          this._sleep();
          return;
        }
        // Auto-wake for clear 2.5D triples …
        if (!this.state.awake) {
          const tripleRe = /^\s*pick\b[\s\S]*\band\b[\s\S]*\bat\s+tag\b/i;
          if (tripleRe.test(finalText)) {
            this._wake();
            // fall-through to handle the command right away
          }
        }
        this._handleTranscript(finalText);
      }
    };
  }

  // =================================================================================================
  // WAKE/SLEEP STATE
  // =================================================================================================

  _wake() {
    this.state.awake = true;
    this._setStatus("awake");
    this._renderUI();
    if (this.opts.stayAwake) this._armAwakeTimer();
  }

  _sleep() {
    this.state.awake = false;
    this._setStatus("idle");
    this._renderUI();
    this._clearAwakeTimer();
  }

  _armAwakeTimer() {
    this._clearAwakeTimer();
    this.state.timer = setInterval(() => {
      if (!this.state.awake) return;
      const idleMs = Date.now() - (this.state.lastHeardAt || 0);
      if (idleMs > this.opts.awakeMs) this._sleep();
    }, 500);
  }

  _clearAwakeTimer() {
    if (this.state.timer) clearInterval(this.state.timer);
    this.state.timer = null;
  }

  // =================================================================================================
  // MATCHING HELPERS
  // =================================================================================================

  _looksLikeWakeword(text) {
    const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const t = norm(text);
    return this._wakeList.some((w) => t.includes(norm(w)));
  }

  _looksLikeSleepPhrase(text) {
    const t = (text || "").toLowerCase();
    return (this.opts.sleepPhrases || []).some((p) => t.includes(p.toLowerCase()));
  }

  // =================================================================================================
  // NUMBER WORD PARSING & ASR NORMALIZATION
  // =================================================================================================

  // Converts "ninety", "one hundred thirty five", "one thirty five" → number
  _wordsToNumber(phrase) {
    if (phrase == null) return NaN;
    const s = String(phrase)
      .trim()
      .toLowerCase()
      .replace(/[-–—]/g, " ")
      .replace(/\band\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (/^-?\d+$/.test(s)) return parseInt(s, 10);

    const units = {
      zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
      ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19
    };
    const tens = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

    const toks = s.split(" ").filter(Boolean);
    if (!toks.length) return NaN;

    // Heuristic: handle "one thirty five" as 100 + 35
    const isTens = (w) => Object.prototype.hasOwnProperty.call(tens, w);
    if (toks.length >= 2 && toks[0] === "one" && isTens(toks[1])) {
      const rest = toks.slice(1).join(" ");
      const restVal = this._wordsToNumber(rest);
      if (Number.isFinite(restVal)) return 100 + restVal;
    }

    let total = 0;
    let curr = 0;
    for (const w of toks) {
      if (w === "hundred") {
        curr = (curr || 1) * 100;
      } else if (Object.prototype.hasOwnProperty.call(tens, w)) {
        curr += tens[w];
      } else if (Object.prototype.hasOwnProperty.call(units, w)) {
        curr += units[w];
      } else {
        return NaN; // unknown token
      }
    }
    total += curr;
    return total;
  }

  // Normalize common ASR mishears before intent matching
  _preNormalizeTranscript(s) {
    let out = String(s || "").toLowerCase();

    // Apply ordered regex replacements from ASR_NORMALIZERS
    for (const [rx, repl] of ASR_NORMALIZERS) {
      out = out.replace(rx, repl);
    }

    // Whitespace compaction & trim at the end (keep behavior identical)
    return out.replace(/\s+/g, " ").trim();
  }

  // Canonicalize a tag token (handles letters A–D and digits 1–4, with common homophones)
  _canonTagToken(v) {
    const t = String(v || "").trim().toLowerCase();
    const map = {
      // Letters
      a: "A", ay: "A", eh: "A",
      b: "B", be: "B", bee: "B",
      c: "C", see: "C", sea: "C", cee: "C",
      d: "D", dee: "D", di: "D",
      // Numbers
      "1": "1", one: "1", won: "1",
      "2": "2", two: "2", too: "2", to: "2",
      "3": "3", three: "3", tree: "3", free: "3",
      "4": "4", four: "4", for: "4", fore: "4"
    };
    return (map[t] || String(v || "")).toUpperCase();
  }

  // =================================================================================================
  // INTENTS
  // =================================================================================================

  _prepareIntents() {
    const colors = (this.opts.colors || []).map((s) => String(s).toLowerCase());
    const tags = (this.opts.tags || []).map((s) => String(s).toUpperCase());

    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const alt = (arr, up = false) =>
      arr.length ? arr.map((x) => esc(up ? String(x).toUpperCase() : String(x))).join("|") : ".*";

    const colorAlt = alt(colors);
    const tagOnly = alt(tags, true); // A|B|C|1|2|3 …

    // Build extended alternatives to catch common homophones/spellings for tags A–D and 1–4
    const tagSyn = [];
    if (tags.includes("A")) tagSyn.push("a", "ay", "eh");
    if (tags.includes("B")) tagSyn.push("b", "be", "bee");
    if (tags.includes("C")) tagSyn.push("c", "see", "sea", "cee");
    if (tags.includes("D")) tagSyn.push("d", "dee", "di");
    if (tags.includes("1")) tagSyn.push("one", "won");
    if (tags.includes("2")) tagSyn.push("two", "too", "to");
    if (tags.includes("3")) tagSyn.push("three", "tree", "free");
    if (tags.includes("4")) tagSyn.push("four", "for", "fore");
    const tagAltExtended = tagSyn.length ? tagOnly + "|" + tagSyn.map((x) => esc(x)).join("|") : tagOnly;

    // Take configured intents and expand move → move servo
    const base = Array.isArray(this.opts.intents) ? [...this.opts.intents] : [];
    if (base.includes("move {index} to {degree}") && !base.includes("move servo {index} to {degree}")) {
      base.push("move servo {index} to {degree}");
    }

    const slotRegex = /\{(\w+)\}/g;
    this.patterns = base.map((p) => {
      const slots = [];
      // Build a regex, then allow "to|too|two|2" specifically when template has ' to '
      let rx =
        "^" +
        p.replace(slotRegex, (_, name) => {
          slots.push(name);
          if (name === "color") return `(${colorAlt})`;
          if (name === "tag") return `(?:tag\\s+)?(${tagAltExtended})`; // single capture, optional "tag "
          if (name === "from") return `(?:tag\\s+)?(${tagAltExtended})`;
          if (name === "to") return `(?:tag\\s+)?(${tagAltExtended})`;
          if (name === "text") return "(.+)";
          if (name === "index") return `(-?\\d+|[a-z]+)`; // digit or word ("one".."five")
          if (name === "degree") return `(-?\\d+|[a-z]+(?:\\s+[a-z]+){0,3})`; // digits or up to 4 words
          return "(.+)";
        }) + "$";

      // Loosen " to " to catch ASR variants: to | too | two | 2
      rx = rx.replace(/\sto\s/g, "\\s+(?:to|too|two|2)\\s+");

      return { raw: p, rx: new RegExp(rx, "i"), slots };
    });
  }

  // =================================================================================================
  // TRANSCRIPT HANDLING
  // =================================================================================================

  _handleTranscript(text) {
    if (!this.state.awake) return;

    // --- partial move combiner (simple one-shot buffer) ---
    this._pendingMove = this._pendingMove || null;

    // If we already buffered a partial move, try combine now
    if (this._pendingMove) {
      const combined = (this._pendingMove + " " + text).trim();
      const matchCombined = this._matchIntent(combined);
      if (matchCombined) {
        let { intent, slots } = matchCombined;
        intent = this._normalizeIntent(intent);
        this._pendingMove = null;
        this._emitCommand(intent, slots, combined);
        if (!this.opts.stayAwake) this._sleep();
        return;
      }
    }

    const match = this._matchIntent(text);
    if (match) {
      let { intent, slots } = match;
      intent = this._normalizeIntent(intent);
      this._emitCommand(intent, slots, text);
      if (!this.opts.stayAwake) this._sleep();
      return;
    }

    // If not a full match, check if the text looks like a partial "move {index} [to]"
    // Accepts: "move one", "move 1", "move one to", "move servo two", "move servo 3 to"
    const looksPartial = /^\s*move(?:\s+servo)?\s+([a-z]+|\d+)(?:\s+(?:to|too|two|2))?\s*$/i.test(text);
    if (looksPartial) {
      this._pendingMove = text; // buffer for next final
      this._setStatus("…");
      return;
    }

    // ── NEW: suppress "no match" UI for pure wake/sleep phrases ─────────────────
    const tx = String(text || "").toLowerCase().trim();
    if (typeof this._looksLikeWakeword === "function" && this._looksLikeWakeword(tx)) {
      // already handled by the wake logic elsewhere — keep hint/status clean
      this._setStatus("listening…");
      return;
    }
    if (typeof this._looksLikeSleepPhrase === "function" && this._looksLikeSleepPhrase(tx)) {
      // sleep phrase acknowledged; status widget will show idle
      this._setStatus("idle");
      return;
    }
    // ────────────────────────────────────────────────────────────────────────────

    // Gentle feedback; keep listening
    console.warn("[voice] no intent matched:", text);
    if (typeof setFeedback === "function") {
      setFeedback(`No matching command. We heard: “${String(text || "").trim()}”`, "#cc8b00");
    } else {
      console.log(`[voice:ui] No matching command. We heard: "${String(text || "").trim()}"`);
    }

    // Not a match, clear pending if it’s stale-ish
    this._pendingMove = null;
    this._setStatus("listening…");
  }

  _matchIntent(text) {
    // Normalize: lowercase, convert hyphens to spaces first, strip punctuation (Edge often adds it), collapse spaces
    const t = this._preNormalizeTranscript(text)
      .replace(/[-–—]/g, " ")
      .replace(/[^\w\s]/g, "")
      .replace(/\s+/g, " ")
      .replace(/^okay |^ok /, "")
      .trim();

    for (const p of this.patterns) {
      const m = t.match(p.rx);
      if (m) {
        const slots = {};
        let idx = 1;
        for (const name of p.slots) {
          let v = (m[idx] || "").trim();
          if (name === "tag") {
            v = this._canonTagToken(v);
          } else if (name === "from" || name === "to") {
            v = this._canonTagToken(v);
          } else if (name === "color") {
            v = v.toLowerCase();
          } else if (name === "index" || name === "degree") {
            const num = this._wordsToNumber(v);
            if (Number.isFinite(num)) v = String(num);
          }
          slots[name] = v;
          idx += 1;
        }
        const intent = p.raw.replace(/\s*\{.*?\}\s*/g, "").trim();
        return { intent, slots };
      }
    }
    return null;
  }

  _normalizeIntent(base) {
    // Normalize with and without spaces so "moveto" also maps to "move"
    const t = String(base || "").toLowerCase().trim();
    const tNoSpace = t.replace(/\s+/g, "");
    if (/^move(?:\s+servo)?(?:\s+to)?$/.test(t)) return "move";
    if (/^move(?:servo)?(?:to)?$/.test(tNoSpace)) return "move";
    return t;
  }

  _emitCommand(intent, slots, transcript) {
    if (typeof this.opts.onCommand === "function") {
      try {
        this.opts.onCommand({ intent, slots, transcript });
      } catch {}
    }

    // Edge-safe CustomEvent (bubbling)
    (function ensureCE() {
      try {
        new CustomEvent("x", { bubbles: true });
      } catch {
        window.CustomEvent = function (event, params) {
          params = params || { bubbles: false, cancelable: false, detail: undefined };
          const evt = document.createEvent("CustomEvent");
          evt.initCustomEvent(event, params.bubbles, params.cancelable, params.detail);
          return evt;
        };
        window.CustomEvent.prototype = window.Event.prototype;
      }
    })();

    const evt = new CustomEvent("voice:command", {
      detail: { intent, slots, transcript },
      bubbles: true,
      cancelable: false,
      composed: true
    });
    (document || window).dispatchEvent(evt);
  }

  // =================================================================================================
  // PUBLIC API
  // =================================================================================================

  enable() {
    if (!this.SR) return;
    this._wantOn = true;
    try {
      this.rec.start();
    } catch {}
    this.state.listening = true;
    this.state.awake = false;
    this.state.lastHeardAt = Date.now();
    this._renderUI();
  }

  disable() {
    if (!this.SR) return;
    this._wantOn = false;
    try {
      this.rec.stop();
    } catch {}
    this.state.listening = false;
    this._sleep();
    this._renderUI();
  }

  setWakeword(w) {
    this.opts.wakeword = (w || "").trim();
    this._wakeList = [this.opts.wakeword || "hey robot"];
    this._hintWake = this._wakeList[0];
    this._renderUI();
  }

  setWakeWords(list) {
    const arr = Array.isArray(list) ? list.filter(Boolean) : [];
    this._wakeList = arr.length ? arr : [this.opts.wakeword || "hey robot"];
    this._hintWake = this._wakeList[0];
    this._renderUI();
  }

  setLocale(l) {
    this.opts.locale = l || "en-US";
    if (this.rec) this.rec.lang = this.opts.locale;
  }

  setIntents(a) {
    this.opts.intents = Array.isArray(a) ? a : [];
    this._prepareIntents();
  }

  setColors(a) {
    this.opts.colors = Array.isArray(a) ? a : [];
    this._prepareIntents();
  }

  setTags(a) {
    this.opts.tags = Array.isArray(a) ? a : [];
    this._prepareIntents();
  }

  _setStatus(msg) {
    if (this.ui.status) this.ui.status.textContent = msg;
  }
}
