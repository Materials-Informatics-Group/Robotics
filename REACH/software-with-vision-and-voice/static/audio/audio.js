/* =================================================================================================
Project: REACH App — UI web application to control the REACH robot arm
Institution: Hokkaido University (2025)
Last Update: Q3 2025
-------------------------------------------------------------------------------------------------
Authors:
  • Mikael Nicander Kuwahara — Lead System Designer & Lead Developer (2024–)
  • ChatGPT — audio helpers + loudness bus (2025)
-------------------------------------------------------------------------------------------------
File: audio/audio.js
Purpose:
  • Speech + beep helpers with autoplay-safe unlock.
  • Louder beeps via a shared compressor/boost bus.
API:
  • window.reachSpeak(text, opts?)
  • window.reachBeep(ms | "r2d2" | {mode:"r2d2", ...}, freq?)
  • window.reachBeepR2D2(opts?)
  • window.reachBeepSad(opts?)
  • window.reachAudioSet({ beepGain?: number })  // master multiplier for beeps
================================================================================================= */

(() => {
  const synth = window.speechSynthesis || null;

  let unlocked = false;
  let ctx = null;

  // --- Audio bus (one-time): vol -> compressor -> masterGain -> destination
  let master = null;
  let comp = null;

  // Master multiplier you can tune at runtime:
  // window.reachAudioSet({ beepGain: 1.8 })
  const state = { beepGain: 1.6 }; // 1.0 = baseline; >1 = louder

  const queue = [];

  // ---------- Unlock ----------
  function unlockOnGestureOnce() {
    if (unlocked) return;
    const events = ["pointerdown", "mousedown", "touchstart", "keydown"];
    const handler = () => {
      try {
        ensureCtx(); // creates context + bus
        if (ctx && ctx.state === "suspended") ctx.resume();
      } catch {}
      unlocked = true;
      flushQueue();
      events.forEach(ev => document.removeEventListener(ev, handler, true));
    };
    events.forEach(ev => document.addEventListener(ev, handler, { capture: true, once: true }));
  }
  unlockOnGestureOnce();

  function flushQueue() {
    if (!queue.length) return;
    const items = queue.splice(0, queue.length);
    for (const { text, opts } of items) _speakNow(text, opts);
  }

  // ---------- Audio setup ----------
  function ensureCtx() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();

    // Build the loudness bus once
    comp = ctx.createDynamicsCompressor();
    // Mild but punchy settings for short beeps
    comp.threshold.setValueAtTime(-24, ctx.currentTime);
    comp.knee.setValueAtTime(30, ctx.currentTime);
    comp.ratio.setValueAtTime(12, ctx.currentTime);
    comp.attack.setValueAtTime(0.003, ctx.currentTime);
    comp.release.setValueAtTime(0.25, ctx.currentTime);

    master = ctx.createGain();
    master.gain.value = 0.95; // headroom against clipping

    comp.connect(master);
    master.connect(ctx.destination);

    return ctx;
  }

  function getBus() {
    ensureCtx();
    return { comp, master, ctx };
  }

  function safeNum(v, def) {
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
  }

  // ---------- Tone scheduling ----------
  function scheduleTone({ start, dur = 0.16, f0 = 800, f1 = null, type = "sine", gain = 0.32 }) {
    const { ctx, comp } = getBus();
    if (!ctx) return safeNum(start, 0) + safeNum(dur, 0.16);

    const now = safeNum(ctx.currentTime, 0);
    const tStart = Math.max(now, safeNum(start, now));
    const d = Math.max(0.05, safeNum(dur, 0.16));
    const tEnd = tStart + d;

    const fMin = 80, fMax = 8000;
    const fA = Math.min(fMax, Math.max(fMin, safeNum(f0, 800)));
    const fBraw = (f1 == null) ? null : safeNum(f1, fA);
    const fB = (fBraw == null) ? null : Math.min(fMax, Math.max(fMin, fBraw));

    const osc = ctx.createOscillator();
    const vol = ctx.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(fA, tStart);
    if (fB != null && fB !== fA) {
      try { osc.frequency.linearRampToValueAtTime(fB, tEnd); } catch {}
    }

    // Louder beeps: raise internal gain and multiply by state.beepGain
    const g = Math.max(0, Math.min(1, safeNum(gain * state.beepGain, 0.32 * state.beepGain)));
    vol.gain.setValueAtTime(0.0001, tStart);
    vol.gain.linearRampToValueAtTime(g, tStart + 0.012);
    vol.gain.linearRampToValueAtTime(0.0001, tEnd);

    osc.connect(vol);
    vol.connect(comp);

    try { osc.start(tStart); osc.stop(tEnd + 0.02); } catch {}

    return tEnd;
  }

  // ---------- Beeps ----------
  function _beep(ms = 140, freq = 880) {
    if (!unlocked || window.REACH_VOICE_MUTE) return;
    const { ctx } = getBus();
    if (!ctx) return;
    const dur = Math.max(0.05, safeNum(ms, 140) / 1000);
    const f = Math.min(8000, Math.max(80, safeNum(freq, 880)));
    scheduleTone({ start: ctx.currentTime, dur, f0: f, type: "square", gain: 0.34 });
  }

  function _beepR2D2(opts = {}) {
    if (!unlocked || window.REACH_VOICE_MUTE) return;
    const { ctx } = getBus();
    if (!ctx) return;

    const parts   = Math.max(3, Math.floor(safeNum(opts.parts, 6)));
    const minDur  = Math.max(0.06, safeNum(opts.minDur, 0.09));
    const maxDur  = Math.max(minDur + 0.01, safeNum(opts.maxDur, 0.22));
    const gapMin  = Math.max(0.01, safeNum(opts.gapMin, 0.03));
    const gapMax  = Math.max(gapMin, safeNum(opts.gapMax, 0.08));
    const fLo     = Math.max(80, safeNum(opts.fLo, 450));
    const fHi     = Math.max(fLo + 50, safeNum(opts.fHi, 2600));
    const gain    = Math.max(0, Math.min(1, safeNum(opts.gain, 0.30))); // hotter default

    const rnd  = (a, b) => a + Math.random() * (b - a);
    const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

    let t = ctx.currentTime;
    for (let i = 0; i < parts; i++) {
      const dur = rnd(minDur, maxDur);
      const gap = rnd(gapMin, gapMax);
      const kind = pick(["bleep", "chirpUp", "chirpDown", "twiddle"]);

      if (kind === "bleep") {
        const f = rnd(fLo, fHi);
        t = scheduleTone({ start: t, dur, f0: f, type: "square", gain });
      } else if (kind === "chirpUp") {
        const f0 = rnd(fLo, (fLo + fHi) / 2);
        const f1 = rnd(f0 + 140, fHi);
        t = scheduleTone({ start: t, dur, f0, f1, type: "triangle", gain });
      } else if (kind === "chirpDown") {
        const f1 = rnd(fLo, (fLo + fHi) / 2);
        const f0 = rnd(f1 + 140, fHi);
        t = scheduleTone({ start: t, dur, f0, f1, type: "triangle", gain });
      } else { // twiddle
        const mid  = rnd(fLo + 220, fHi - 220);
        const span = rnd(160, 480);
        const d2   = Math.max(0.04, dur * 0.48);
        t = scheduleTone({ start: t, dur: d2, f0: mid - span, f1: mid + span, type: "sine", gain });
        t = scheduleTone({ start: t, dur: d2, f0: mid + span, f1: mid - span, type: "sine", gain });
      }
      t += gap;
    }
  }

  // NEW: sad descending beeps for “audio off”
  function _beepSad(opts = {}) {
    if (!unlocked || window.REACH_VOICE_MUTE) return 0;
    const { ctx } = getBus();
    if (!ctx) return 0;

    // Short, immediate descending motif (no pre-delay)
    const start = ctx.currentTime;
    const dur   = Math.max(0.08, safeNum(opts.dur, 0.12));
    const gap   = Math.max(0.02, safeNum(opts.gap, 0.05));
    const gain  = Math.max(0, Math.min(1, safeNum(opts.gain, 0.30)));

    // Frequencies: downward steps (sad cue)
    const f1 = safeNum(opts.f1, 1200);
    const f2 = safeNum(opts.f2, 800);
    const f3 = safeNum(opts.f3, 520);

    let t = start;
    t = scheduleTone({ start: t, dur, f0: f1, f1: f2, type: "triangle", gain });
    t += gap;
    t = scheduleTone({ start: t, dur, f0: f2, f1: f3, type: "triangle", gain });
    t += gap;
    t = scheduleTone({ start: t, dur: dur * 0.9, f0: f3, type: "sine", gain: gain * 0.9 });

    const totalMs = Math.round((t - start) * 1000);
    return Math.max(120, totalMs); // return an estimate in ms
  }

  function beepRouter(msOrMode, freq) {
    if (window.REACH_VOICE_MUTE || !unlocked) return;
    if (typeof msOrMode === "string" && msOrMode.toLowerCase() === "r2d2") { _beepR2D2({}); return; }
    if (msOrMode && typeof msOrMode === "object" && (msOrMode.mode || "").toLowerCase() === "r2d2") {
      _beepR2D2(msOrMode); return;
    }
    _beep(msOrMode, freq);
  }
  function beepR2D2(opts) { _beepR2D2(opts || {}); }
  function beepSad(opts)  { return _beepSad(opts || {}); }

  // ---------- Speech ----------
  function _speakNow(text, opts = {}) {
    const msg = String(text || "").trim();
    if (!msg) return;

    if (synth && typeof SpeechSynthesisUtterance !== "undefined") {
      try {
        const u = new SpeechSynthesisUtterance(msg);
        u.lang   = opts.lang   || "en-US";
        u.pitch  = opts.pitch  ?? 1.0;
        u.rate   = opts.rate   ?? 1.0;
        u.volume = opts.volume ?? 1.0;

        const chooseVoice = () => {
          const voices = synth.getVoices?.() || [];
          const wanted = (u.lang || "").toLowerCase();
          const v = voices.find(v => v.lang?.toLowerCase().startsWith(wanted));
          if (v) u.voice = v;
          synth.speak(u);
        };

        if (synth.getVoices && synth.getVoices().length === 0) {
          synth.onvoiceschanged = () => { try { chooseVoice(); } catch {} };
        }
        chooseVoice();
        return;
      } catch {}
    }
    _beep(140, 880); // fallback cue if TTS blocked
  }

  // Public: queued speak (respects mute)
  function speak(text, opts) {
    if (window.REACH_VOICE_MUTE) return;
    if (!unlocked) { queue.push({ text, opts }); return; }

    // fun pre-chirp then speak
    setTimeout(() => {
      _beepR2D2();
      setTimeout(() => { _speakNow(text, opts); }, 1000);
    }, 1000);
  }

  // ---------- Exports & UI wiring ----------
  window.reachSpeak     = speak;
  window.reachBeep      = beepRouter;
  window.reachBeepR2D2  = beepR2D2;
  window.reachBeepSad   = beepSad;
  window.reachAudioSet  = (opts = {}) => {
    if (typeof opts.beepGain === "number" && Number.isFinite(opts.beepGain)) {
      state.beepGain = Math.max(0.2, Math.min(4.0, opts.beepGain));
    }
  };

  window.addEventListener('DOMContentLoaded', () => {
    const audioToggle = document.getElementById('audioFeedbackToggle');

    // Default: OFF (muted) unless the checkbox is checked.
    window.REACH_VOICE_MUTE = audioToggle ? !audioToggle.checked : true;

    // React to user toggling
    audioToggle?.addEventListener("change", () => {
      // Ensure context ready (user gesture), and mark unlocked
      try { ensureCtx(); if (ctx && ctx.state !== "suspended") unlocked = true; } catch {}

      if (audioToggle.checked) {
        // Turn ON: unmute, optional chirp, introduce yourself
        window.REACH_VOICE_MUTE = false;
        try { _beepR2D2({ parts: 5 }); } catch {}
        window.reachSpeak?.("I am REACH.");
      } else {
        // Turn OFF: IMMEDIATELY play a short sad beep motif (no pre-delay), then mute.
        const wasMuted = window.REACH_VOICE_MUTE;
        window.REACH_VOICE_MUTE = false;        // allow the cue
        const ms = _beepSad({});                // schedule instantly
        // mute after the motif finishes (doesn't delay the start)
        setTimeout(() => { window.REACH_VOICE_MUTE = true; }, Math.max(80, ms));
      }
    });
  });
})();
