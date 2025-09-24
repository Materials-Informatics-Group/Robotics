/* =================================================================================================
Project: REACH App — UI web application to control the REACH robot arm
Institution: Hokkaido University (2025)
Last Update: Q3 2025
-------------------------------------------------------------------------------------------------
Authors:
  • Mikael Nicander Kuwahara — Lead System Designer & Lead Developer (2024–)
-------------------------------------------------------------------------------------------------
File: pickplace.js
Purpose:
  • 2.5D pick/place orchestrator for color objects and beaker tags.
  • Plans simple, deterministic motions from calibrated camera coordinates to robot poses.
  • Exposes three UI operations: pick+place, grab+drop, grab+pour.
External Contracts:
  • /calibration/get → { ok, data: { H, plane_size_mm, base_mm, ... } }
  • /vision/analyze  → { ok, detections: [...] } (supports 'color' and 'tags' modes)
  • dispatchCommand(cmd, immediate) global for low-level servo commands (N0..N5)
UI Hooks:
  • #ppRun button, #ppColor, #ppTag, #ppOp selects, #ppStatus for inline status text.
Voice Bridge:
  • Listens for window.postMessage { type: 'voice:task', payload } to prefill UI and optionally run.
================================================================================================= */

(function () {
  // ================================================================================================
  // UI + CALIBRATION
  // ================================================================================================
  const statusEl = document.getElementById('ppStatus');
  const runBtn   = document.getElementById('ppRun');
  if (!runBtn) return;

  /** Set inline status text/color in the panel. */
  const s = (msg, ok = true) => {
    if (!statusEl) return;
    statusEl.textContent = msg;
    statusEl.style.color = ok ? '#7ad' : '#e66';
  };

  /**
   * Fetch calibration and sanity-check it (homography + base pivot).
   * Throws with a helpful message when not ready.
   */
  async function getCalib() {
    const res = await fetch('/calibration/get').then(r => r.json()).catch(() => null);
    if (!res || !res.ok || !res.data) {
      throw new Error('No calibration found. Open Vision → Calibrate first.');
    }
    const cfg = res.data;

    // Minimal “uncalibrated” gate: H close to identity?
    const isHIdentityLike = (H, tol = 1e-9) => {
      if (!Array.isArray(H) || H.length !== 3) return true;
      const I = [[1,0,0],[0,1,0],[0,0,1]];
      let maxd = 0;
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) {
          const v = (H[r] && Number.isFinite(H[r][c])) ? H[r][c] : 0;
          maxd = Math.max(maxd, Math.abs(v - I[r][c]));
        }
      }
      return maxd < tol;
    };

    if (!cfg.H || isHIdentityLike(cfg.H)) {
      throw new Error('Calibration required. Open Vision → Calibrate first.');
    }

    // Optional: guard against placeholder base pivot (default {10,10})
    if (cfg.base_mm && cfg.base_mm.x === 10 && cfg.base_mm.y === 10) {
      throw new Error('Calibration required. Base pivot not solved yet. Run the wizard.');
    }

    return cfg;
  }

  // ================================================================================================
  // SMALL HELPERS
  // ================================================================================================
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  /** Apply homography H to pixel point [x,y] → world [X,Y] (in panel coords). */
  function applyH(H, pt) {
    const [x, y] = pt;
    const d = H[2][0] * x + H[2][1] * y + H[2][2];
    const X = (H[0][0] * x + H[0][1] * y + H[0][2]) / d;
    const Y = (H[1][0] * x + H[1][1] * y + H[1][2]) / d;
    return [X, Y];
  }

  /** Get detection center (supports either bbox or x/y/w/h fields). */
  function detCenterPx(d) {
    const bb = d.bbox || [d.x, d.y, d.w, d.h];
    return [bb[0] + bb[2] / 2, bb[1] + bb[3] / 2];
  }

  /** Fire a fast multi-servo command then give the rail a short dwell. */
  const FAST_MS = 80;
  async function sendFast(combo) {
    if (typeof dispatchCommand !== "function") throw new Error('dispatchCommand missing');
    await dispatchCommand(combo, true);
    await sleep(FAST_MS);
  }

  // ================================================================================================
  // VISION I/O
  // ================================================================================================
  /**
   * Request both color and tag, return the largest matching color and the first matching tag.
   * @returns {{ colorDet: Object, tagDet: Object }}
   */
  async function analyze(color, tagLabel) {
    const body = { modes: ['color', 'tags'], params: { colors: [color], tag_labels: [tagLabel] } };
    const j = await fetch('/vision/analyze', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    }).then(r => r.json());
    if (!j || !j.ok) throw new Error('vision/analyze failed');

    const { detections } = j;
    const colors = (detections || []).filter(d =>
      d.type === 'color' && (d.color === color || d.color_name === color)
    );
    const tags = (detections || []).filter(d => (d.type === 'tag') || d.label || d.text);

    const colorDet = colors.sort((a, b) => b.bbox[2] * b.bbox[3] - a.bbox[2] * a.bbox[3])[0];
    const tagDet   = tags.find(d => (d.label || String(d.id)) === tagLabel);

    if (!colorDet) throw new Error('No color target found');
    if (!tagDet)   throw new Error('No tag found');

    return { colorDet, tagDet };
  }

  /** Single call pre-lock for color→tag flows. */
  async function prelockTargets(color, tagLabel) {
    const { colorDet, tagDet } = await analyze(color, tagLabel);
    return { colorDet, tagDet };
  }

  // ================================================================================================
  // SERVO/YAW MAPPING
  // ================================================================================================
  /** Piecewise-linear correction table for base yaw. */
  function applyYawCorrection(yawDeg, table) {
    if (!Array.isArray(table) || !table.length) return 0;
    const pts = table.map(p => ({ yaw: Number(p.yaw), deg: Number(p.deg) }))
      .filter(p => Number.isFinite(p.yaw) && Number.isFinite(p.deg))
      .sort((a, b) => a.yaw - b.yaw);
    if (!pts.length) return 0;
    if (yawDeg <= pts[0].yaw) return pts[0].deg;
    if (yawDeg >= pts[pts.length - 1].yaw) return pts[pts.length - 1].deg;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      if (yawDeg >= a.yaw && yawDeg <= b.yaw) {
        const t = (yawDeg - a.yaw) / Math.max(1e-9, (b.yaw - a.yaw));
        return a.deg + t * (b.deg - a.deg);
      }
    }
    return 0;
  }

  /** World yaw angle (0..180) from base pivot to (dx,dy). */
  function worldYawDeg(dx, dy) {
    const r = Math.hypot(dx, dy) || 1;
    const c = Math.max(-1, Math.min(1, dx / r));
    return Math.acos(c) * 180 / Math.PI; // 0..180 from +X
  }

  /**
   * Map world yaw (deg) + optional radial distance (mm) to servo base angle [0..180].
   * Uses config piecewise slopes and optional correction & radial factor.
   */
  function mapWorldYawToServo(cfg, yawWorld, r_mm) {
    const bm = cfg.servo_map?.base || {};
    const split   = Number(bm.split ?? 90);
    const center  = Number((bm.center_deg ?? 90) + (bm.offset ?? 0)); // “world 90° looks like …”
    const slopeLo = Number(bm.scale_low  ?? bm.scale ?? 1);
    const slopeHi = Number(bm.scale_high ?? bm.scale ?? 1);
    const slope   = (yawWorld < split) ? slopeLo : slopeHi;
    const offLow  = Number(bm.offset_low  ?? 0);
    const offHigh = Number(bm.offset_high ?? 0);
    const corrDeg = applyYawCorrection(yawWorld, bm.correction || null);
    const k   = Number(bm.radial_k  ?? 0);
    const r0  = Number(bm.radial_r0 ?? 220);
    const radial = (Number.isFinite(k) && Number.isFinite(r_mm)) ? k * (r_mm - r0) : 0;

    const v = center + slope * (yawWorld - split)
            + (yawWorld < split ? offLow : offHigh)
            + corrDeg + radial;

    return Math.max(0, Math.min(180, Math.round(v)));
  }

  // ================================================================================================
  // SAFE POSTURES
  // ================================================================================================
  const SAFE_YAW_S1 = 110;
  const SAFE_YAW_S3 = 150;

  /**
   * Move safely: lift (S1/S3), rotate base, optionally echo S1/S3 hover.
   * @param {number} targetYawDeg
   * @param {number} [postS1]
   * @param {number} [postS3]
   */
  async function yawViaSafe(targetYawDeg, postS1, postS3) {
    await sendFast(`N1${SAFE_YAW_S1},N3${SAFE_YAW_S3}`);                 // lift first, always
    const yaw = clamp(Math.round(targetYawDeg), 0, 180);
    await sendFast(`N0${yaw}`);                                          // rotate base
    if (typeof postS1 === 'number' || typeof postS3 === 'number') {
      await sendFast(`N0${yaw},N1${Math.round(postS1)},N3${Math.round(postS3)}`); // echo with hover
    }
  }

  // ================================================================================================
  // SELECTION HELPERS
  // ================================================================================================
  /** Parse a selector string → { kind: 'tag'|'color', name }. */
  function ppParseSelector(raw) {
    const s = String(raw || '').trim();
    if (!s) return null;
    const m = /^tag\s*([A-D1-4])$/i.exec(s);
    if (m) return { kind: 'tag', name: m[1].toUpperCase() };
    if (/^[A-D]$/i.test(s)) return { kind: 'tag', name: s.toUpperCase() };
    if (/^[1-4]$/.test(s))  return { kind: 'tag', name: s };
    return { kind: 'color', name: s.toLowerCase() };
  }

  /**
   * Detect a single target (tag or color) and map to world XY (mm) with Y flipped to origin at bottom.
   * @returns {{x:number, y:number}}
   */
  async function ppDetectOne(sel, calib) {
    const modes  = sel.kind === 'tag' ? ['tags'] : ['color'];
    const params = sel.kind === 'tag' ? { tag_labels: [sel.name] } : { colors: [sel.name] };
    const j = await fetch('/vision/analyze', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ modes, params })
    }).then(r => r.json());
    if (!j || !j.ok) throw new Error('vision/analyze failed');

    let centerPx = null;
    if (sel.kind === 'tag') {
      const d = (j.detections || []).find(t => String(t.label ?? t.id ?? '').toUpperCase() === sel.name.toUpperCase());
      if (!d) throw new Error(`Tag "${sel.name}" not found`);
      centerPx = detCenterPx(d);
    } else {
      const cands = (j.detections || [])
        .filter(d => d.type === 'color' && (d.color === sel.name || d.color_name === sel.name))
        .sort((a, b) => b.bbox[2] * b.bbox[3] - a.bbox[2] * a.bbox[3]);
      if (!cands.length) throw new Error(`Color "${sel.name}" not found`);
      centerPx = detCenterPx(cands[0]);
    }

    const [X, Y0] = applyH(calib.H, centerPx);
    const Hmm = (calib.plane_size_mm && calib.plane_size_mm[1]) || 0;
    return { x: X, y: Hmm - Y0 };
  }

  // ================================================================================================
  // OPERATION CALIBRATION HELPERS
  // ================================================================================================
  function getPourCfg(cfg) {
    const t = cfg.pour ?? {};
    return {
      twist_deg: Number(t.twist_deg ?? 180),
      rest_deg:  Number(t.rest_deg  ?? 80),
      dwell_ms:  Number(t.dwell_ms  ?? 1400),
      settle_ms: Number(t.settle_ms ?? 250),
    };
  }
  function getOpYawOffset(cfg, op) {
    const map = cfg.op_base_offset_deg || {};
    const def = (op === 'pour') ? 5 : 0;
    return Number(map[op] ?? def);
  }
  function getPickYawOffset(cfg, pickSel) {
    return (pickSel.kind === 'tag') ? Number(cfg.beaker_pick_yaw_offset_deg ?? 0) : 0;
  }

  // ================================================================================================
  // POSE CONSTRAINTS & FIXED POSES
  // ================================================================================================
  /** Constrain S1/S3 to safe envelope given arm geometry. */
  function clampS1S3Safe(s1, s3) {
    s1 = clamp(Math.round(s1), 0, 180);
    let s3_min = Math.max(85, 180 - s1);
    let s3_max = 170;
    if (s1 >= 140) s3_max = Math.max(110, 335 - 1.25 * s1);
    s3 = clamp(Math.round(s3), s3_min, s3_max);
    return { shoulder: s1, wrist: s3 };
  }

  /** Get a safe fixed drop pose depending on source class (beaker vs colored object). */
  function getFixedDropPose(cfg, pickSel) {
    if (pickSel.kind === 'tag') {
      const cls = ['1','2','3','4'].includes(pickSel.name) ? 'small' : 'large';
      let v = (cls === 'large') ? cfg.beaker_large_drop_pose : cfg.beaker_small_drop_pose;
      if (v && Number.isFinite(v.s1) && Number.isFinite(v.s3)) return clampS1S3Safe(v.s1, v.s3);
      v = (cls === 'large') ? cfg.beaker_large_place_pose : cfg.beaker_small_place_pose;
      if (v && Number.isFinite(v.s1) && Number.isFinite(v.s3)) return clampS1S3Safe(v.s1, v.s3);
    } else {
      let v = cfg.colobj_drop_pose || cfg.colobj_place_pose || cfg.colobj_pick_pose;
      if (v && Number.isFinite(v.s1) && Number.isFinite(v.s3)) return clampS1S3Safe(v.s1, v.s3);
    }
    throw new Error('Missing fixed drop pose in calibration.json for ' + (pickSel.kind==='tag' ? 'beaker' : 'colobj'));
  }

  /** Get a safe hover pose for pour; falls back to pour.hover targets. */
  function getFixedPourHoverPose(cfg, pickSel) {
    if (pickSel.kind === 'tag') {
      const cls = ['1','2','3','4'].includes(pickSel.name) ? 'small' : 'large';
      const v = (cls === 'large') ? cfg.beaker_large_pour_pose : cfg.beaker_small_pour_pose;
      if (v && Number.isFinite(v.s1) && Number.isFinite(v.s3)) return clampS1S3Safe(v.s1, v.s3);
    }
    const ph = cfg.pour || {};
    return clampS1S3Safe(Number(ph.hover_s1_target ?? 120), Number(ph.hover_s3_target ?? 130));
  }

  // ================================================================================================
  // PLANNER (simple & deterministic)
  // ================================================================================================
  /**
   * Plan pick and place poses/angles based on detections and calibration.
   * Returns hover/down poses and gripper open/close degrees.
   */
  async function planPickAndPlace(cfg, pickSel, placeSel, opts = {}) {
    // Detect world XY once (color->tag path optimized via single call)
    let pickXY, destXY;
    if (pickSel.kind === 'color' && placeSel.kind === 'tag') {
      const { colorDet, tagDet } = await prelockTargets(pickSel.name, placeSel.name);
      pickXY = applyH(cfg.H, detCenterPx(colorDet));
      destXY = applyH(cfg.H, detCenterPx(tagDet));
      const Hh = (cfg.plane_size_mm?.[1] || 0);
      pickXY[1] = Hh - pickXY[1]; destXY[1] = Hh - destXY[1];
    } else {
      const p = await ppDetectOne(pickSel, cfg);
      const d = await ppDetectOne(placeSel, cfg);
      pickXY = [p.x, p.y]; destXY = [d.x, d.y];
    }

    // Workspace + base
    const base = cfg.base_mm || { x: 0, y: 0 };
    const [Wmm, Hmm] = cfg.plane_size_mm || [0, 0];
    const inside = ([X, Y]) => { const m = 15; return X > m && Y > m && X < (Wmm - m) && Y < (Hmm - m); };

    // Gripper profiles
    const TAG_CLASS = { A:'large', B:'large', C:'large', D:'large', '1':'small', '2':'small', '3':'small', '4':'small' };
    const PROFILE   = { large:{open:80, close:25}, small:{open:80, close:15}, normal:{open:60, close:5} };

    const carryingBeaker = (pickSel.kind === 'tag');
    if (!inside(pickXY) || !inside(destXY)) throw new Error('Target outside safe workspace');

    const pickRel = [pickXY[0] - base.x, pickXY[1] - base.y];

    // Place planning
    let placeRel, placeAbs;
    if (placeSel.kind !== 'tag') {
      // colored→colored: keep pickup radius
      const rawRel = [destXY[0] - base.x, destXY[1] - base.y];
      const rPick  = Math.hypot(pickRel[0], pickRel[1]);
      const rDest  = Math.hypot(rawRel[0],  rawRel[1]) || 1;
      const ux = rawRel[0] / rDest, uy = rawRel[1] / rDest;
      placeRel = [ux * rPick, uy * rPick];
      placeAbs = [base.x + placeRel[0], base.y + placeRel[1]];
    } else {
      // beaker target: aim yaw straight to the tag
      placeRel = [destXY[0] - base.x, destXY[1] - base.y];
      placeAbs = destXY;
    }

    if (!inside(placeAbs)) throw new Error('Place target outside safe workspace');

    // Hover (yaw only; S1/S3 are fixed safe)
    const yawPickWorld  = worldYawDeg(pickRel[0],  pickRel[1]);
    const yawPlaceWorld = worldYawDeg(placeRel[0], placeRel[1]);
    const rPick  = Math.hypot(pickRel[0],  pickRel[1]);
    const rPlace = Math.hypot(placeRel[0], placeRel[1]);
    const sPickHover  = { base: mapWorldYawToServo(cfg, yawPickWorld,  rPick),  shoulder: SAFE_YAW_S1, wrist: SAFE_YAW_S3 };
    const sPlaceHover = { base: mapWorldYawToServo(cfg, yawPlaceWorld, rPlace), shoulder: SAFE_YAW_S1, wrist: SAFE_YAW_S3 };

    // DOWN poses (from calibration)
    let openDeg, closeDeg, sPickDown, sPlaceDown = null;

    if (carryingBeaker) {
      const cls = TAG_CLASS[pickSel.name];
      openDeg = PROFILE[cls].open; closeDeg = PROFILE[cls].close;

      const bPick = (cls === 'large') ? cfg.beaker_large_pick_pose : cfg.beaker_small_pick_pose;
      if (!bPick || !Number.isFinite(bPick.s1) || !Number.isFinite(bPick.s3)) {
        throw new Error(`Missing fixed beaker pick pose for ${cls}. Add "beaker_${cls}_pick_pose": { "s1":..., "s3":... } to calibration.json`);
      }
      sPickDown = clampS1S3Safe(bPick.s1, bPick.s3);

      if (opts.needPlaceDown) {
        const bPlace = (cls === 'large') ? cfg.beaker_large_place_pose : cfg.beaker_small_place_pose;
        if (!bPlace || !Number.isFinite(bPlace.s1) || !Number.isFinite(bPlace.s3)) {
          throw new Error(`Missing fixed beaker place pose for ${cls}. Add "beaker_${cls}_place_pose": { "s1":..., "s3":... } to calibration.json`);
        }
        sPlaceDown = clampS1S3Safe(bPlace.s1, bPlace.s3);
      }

    } else {
      openDeg = PROFILE.normal.open; closeDeg = PROFILE.normal.close;

      const cpick = cfg.colobj_pick_pose || {};
      if (!Number.isFinite(cpick.s1) || !Number.isFinite(cpick.s3)) {
        throw new Error('Missing "colobj_pick_pose" {s1,s3} in calibration.json');
      }
      sPickDown = clampS1S3Safe(cpick.s1, cpick.s3);

      if (opts.needPlaceDown) {
        const cplace = (cfg.colobj_place_pose || cfg.colobj_pick_pose || {});
        if (!Number.isFinite(cplace.s1) || !Number.isFinite(cplace.s3)) {
          throw new Error('Missing "colobj_place_pose" {s1,s3} in calibration.json');
        }
        sPlaceDown = clampS1S3Safe(cplace.s1, cplace.s3);
      }
    }

    return { base, carryingBeaker, sPickHover, sPickDown, sPlaceHover, sPlaceDown, openDeg, closeDeg, pickSel };
  }

  // ================================================================================================
  // UNIFIED PICKUP PHASE
  // ================================================================================================
  async function doPickupPhase(cfg, pickSel, sPickHover, sPickDown, openDeg, closeDeg) {
    const yawForPick = sPickHover.base + getPickYawOffset(cfg, pickSel);
    await yawViaSafe(yawForPick, sPickHover.shoulder, sPickHover.wrist);                 // lift → yaw → hover
    await sendFast(`N5${openDeg}`);                                                      // open
    await sendFast(`N1${Math.round(sPickDown.shoulder)},N3${Math.round(sPickDown.wrist)}`); // down
    await sendFast(`N5${closeDeg}`);                                                     // close
    await sendFast(`N1${Math.round(sPickHover.shoulder)},N3${Math.round(sPickHover.wrist)}`); // up
  }

  // ================================================================================================
  // FINAL CAMERA-CLEAR / PARK
  // ================================================================================================
  async function parkCameraClear() {
    let base = 90, s1 = 80, s2 = 180, s3 = 90, s4 = 80, s5 = 80;
    try {
      const cfg = await getCalib();
      const cc  = cfg.camera_clear || {};
      base = Number(cc.base ?? base);
      s1   = Number(cc.s1   ?? s1);
      s2   = Number(cc.s2   ?? s2);
      s3   = Number(cc.s3   ?? s3);
      s4   = Number(cc.s4   ?? s4);
      s5   = Number(cc.s5   ?? s5);
    } catch (_) { /* keep defaults */ }

    await yawViaSafe(base, s1, s3);                 // lift → yaw → set shoulder/wrist
    await sendFast(`N2${s2},N4${s4},N5${s5}`);      // finish park
  }

  // ================================================================================================
  // PUBLIC OPERATIONS (UI)
  // ================================================================================================
  async function runGrabDrop(pickRaw, placeRaw) {
    try {
      s('Analyzing (drop)...');
      const cfg = await getCalib();
      const pickSel  = ppParseSelector(pickRaw);
      const placeSel = ppParseSelector(placeRaw);
      if (!pickSel || !placeSel) throw new Error('Both fields must be set');

      const plan = await planPickAndPlace(cfg, pickSel, placeSel, { needPlaceDown: false });
      const { sPickHover, sPickDown, sPlaceHover, openDeg, closeDeg, pickSel: pickSelEcho } = plan;

      await doPickupPhase(cfg, pickSelEcho, sPickHover, sPickDown, openDeg, closeDeg);

      const dropPose = getFixedDropPose(cfg, pickSelEcho);
      const dropYaw = sPlaceHover.base + getOpYawOffset(cfg, 'drop');
      await yawViaSafe(dropYaw, dropPose.shoulder, dropPose.wrist);
      await sendFast(`N5${openDeg}`);

      await parkCameraClear();
      s('✅ Drop done.');
    } catch (e) {
      s('❌ ' + (e.message || e), false);
      console.error(e);
    }
  }

  async function runGrabPour(pickRaw, placeRaw) {
    try {
      s('Analyzing (pour)...');
      const cfg = await getCalib();
      const pickSel  = ppParseSelector(pickRaw);
      const placeSel = ppParseSelector(placeRaw);
      if (!pickSel || pickSel.kind !== 'tag') throw new Error('Pour expects the source to be a beaker tag.');
      if (!placeSel) throw new Error('Destination must be set.');

      const plan = await planPickAndPlace(cfg, pickSel, placeSel, { needPlaceDown: false });
      const { sPickHover, sPickDown, sPlaceHover, openDeg, closeDeg, pickSel: pickSelEcho } = plan;

      await doPickupPhase(cfg, pickSelEcho, sPickHover, sPickDown, openDeg, closeDeg);

      const pourPose = getFixedPourHoverPose(cfg, pickSelEcho);
      const pourYaw  = sPlaceHover.base + getOpYawOffset(cfg, 'pour');
      await yawViaSafe(pourYaw, pourPose.shoulder, pourPose.wrist);

      const pour = getPourCfg(cfg);
      s('Pouring...');
      await sendFast(`N4${Math.round(pour.twist_deg)}`);
      await sleep(pour.dwell_ms);
      await sendFast(`N4${Math.round(pour.rest_deg)}`);
      await sleep(pour.settle_ms);

      // Return & set down gently
      const returnWrist = clamp(Math.round(sPickDown.wrist), 85, 170);
      await yawViaSafe(sPickHover.base, sPickHover.shoulder, sPickHover.wrist);
      await sendFast(`N1${Math.round(sPickDown.shoulder)},N3${returnWrist}`);
      await sendFast(`N5${openDeg}`);
      await sendFast(`N1${Math.round(sPickHover.shoulder)},N3${Math.round(sPickHover.wrist)}`);

      await parkCameraClear();
      s('✅ Pour done (beaker returned).');
    } catch (e) {
      s('❌ ' + (e.message || e), false);
      console.error(e);
    }
  }

  async function runPickPlace(color, tagLabel) {
    try {
      s('Analyzing...');
      const cfg = await getCalib();
      const pickSel  = ppParseSelector(color);
      const placeSel = ppParseSelector(tagLabel);
      if (!pickSel || !placeSel) throw new Error('Both fields must be set');

      const plan = await planPickAndPlace(cfg, pickSel, placeSel, { needPlaceDown: true });
      const { sPickHover, sPickDown, sPlaceHover, sPlaceDown, openDeg, closeDeg, pickSel: pickSelEcho } = plan;

      await doPickupPhase(cfg, pickSelEcho, sPickHover, sPickDown, openDeg, closeDeg);

      const placeYaw = sPlaceHover.base + getOpYawOffset(cfg, 'place');
      await yawViaSafe(placeYaw, sPlaceHover.shoulder, sPlaceHover.wrist);
      await sendFast(`N1${Math.round(sPlaceDown.shoulder)},N3${Math.round(sPlaceDown.wrist)}`);
      await sendFast(`N5${openDeg}`);
      await sendFast(`N1${Math.round(sPlaceHover.shoulder)},N3${Math.round(sPlaceHover.wrist)}`);

      await parkCameraClear();
      s('✅ Done.');
    } catch (e) {
      s('❌ ' + (e.message || e), false);
      console.error(e);
    }
  }

  // ================================================================================================
  // WIRE UP UI
  // ================================================================================================
  runBtn.addEventListener('click', () => {
    const color = (document.getElementById('ppColor') || {}).value || 'red';
    const tag   = (document.getElementById('ppTag')   || {}).value || 'A';
    const op    = (document.getElementById('ppOp')    || {}).value || 'place';

    if (op === 'drop') {
      runGrabDrop(color, tag);
    } else if (op === 'pour') {
      runGrabPour(color, tag);
    } else {
      runPickPlace(color, tag);
    }
  });

  // Expose for console/testing
  window.runPickPlace = (color, tag) => runPickPlace(color, tag);
  window.runGrabDrop  = (pick, tag)  => runGrabDrop(pick, tag);
  window.runGrabPour  = (pick, tag)  => runGrabPour(pick, tag);

  // ================================================================================================
  // VOICE HOOK: 2.5D Pick & Place (NL → selects → gated Run)
  // ================================================================================================
  (function () {
    /** Set a <select> or input value with fuzzy matching and bubble change/input events. */
    function setSelectValue(sel, value) {
      if (!sel || value == null) return false;
      const wantRaw = String(value);
      const want = wantRaw.trim().toLowerCase();
      const norm = (s) => String(s ?? "").trim().toLowerCase();
      const stripTag = (s) => norm(s).replace(/^tag\s+/, "");

      if (sel.tagName === 'SELECT') {
        let found = false;
        for (const opt of sel.options) {
          const txt = norm(opt.textContent || opt.innerText || opt.text || "");
          const val = norm(opt.value || "");

          // exact
          if (txt === want || val === want) { sel.value = opt.value; found = true; break; }

          // fuzzy: "2" == "tag 2", "B" == "tag B"
          if (stripTag(txt) === stripTag(want) || stripTag(val) === stripTag(want)) {
            sel.value = opt.value; found = true; break;
          }

          // op-friendly: allow "grab → pour (gentle)" etc.
          if (sel.id === 'ppOp' && (txt.includes(want) || val.includes(want))) {
            sel.value = opt.value; found = true; break;
          }
        }
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        if (!found) {
          // Soft log of available options for troubleshooting
          // (kept terse; not spammy like the previous detailed DEBUG dump)
          console.log('[voice:task] value not found:', sel.id || sel.name, wantRaw);
        }
        return found;
      } else {
        sel.value = wantRaw;
        sel.dispatchEvent(new Event('input', { bubbles: true }));
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
    }

    const tagify = (v) => {
      const s = String(v || '').trim();
      if (!s) return s;
      return /^tag\s/i.test(s) ? s : `tag ${s.toUpperCase()}`;
    };

    window.addEventListener('message', (e) => {
      if (e.origin !== window.location.origin) return;
      const msg = e.data || {};
      if (msg.type !== 'voice:task') return;

      const p = msg.payload || {};
      const colorSel = document.getElementById('ppColor');   // source (color OR "tag X")
      const tagSel   = document.getElementById('ppTag');     // destination tag
      const opSel    = document.getElementById('ppOp');      // place | drop | pour
      const runBtn   = document.getElementById('ppRun');
      const statusEl = document.getElementById('ppStatus');

      // Source: prefer explicit color; else a tag from 'from'
      const srcValue  = p.color ?? (p.from ? tagify(p.from) : p.pick);
      const destValue = p.tag   ?? (p.to ? tagify(p.to)     : p.place);

      const okSrc  = setSelectValue(colorSel, srcValue);
      const okDest = setSelectValue(tagSel,   destValue);

      let okOp = false;
      if (p.op || p.task) {
        const word = String(p.op || p.task).toLowerCase();
        if (/(drop|release)/.test(word))      okOp = setSelectValue(opSel, 'drop');
        else if (/(pour|spill)/.test(word))   okOp = setSelectValue(opSel, 'pour');
        else if (/(place|put)/.test(word))    okOp = setSelectValue(opSel, 'place');
        else if (/calib/.test(word))          okOp = true;
      } else {
        okOp = !!(opSel && opSel.value);
      }

      const haveSrc  = !!okSrc;
      const haveOp   = !!okOp;
      const haveDest = !!okDest;

      const setOk   = (m) => { if (statusEl) { statusEl.textContent = m; statusEl.style.color = '#1a7f37'; } };
      const setWarn = (m) => { if (statusEl) { statusEl.textContent = m; statusEl.style.color = '#cc8b00'; } };

      if (haveSrc && haveOp && haveDest) {
        runBtn?.click();
        setOk('Voice: running task…');
      } else {
        const missing = [];
        if (!haveSrc)  missing.push('what to pick (color or tag)');
        if (!haveOp)   missing.push('what to do (place/drop/pour)');
        if (!haveDest) missing.push('where to place (tag)');
        if (missing.length) setWarn(`Voice: say ${missing.join(', ')}`);
      }
    });
  })();

})();
