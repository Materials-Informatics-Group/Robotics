/* =================================================================================================
Project: REACH App — UI web application to control the REACH robot arm
Institution: Hokkaido University (2025)
Last Update: Q3 2025
-------------------------------------------------------------------------------------------------
Authors:
  • Mikael Nicander Kuwahara — Lead System Designer & Lead Developer (2024–)
-------------------------------------------------------------------------------------------------
File: calibration_ui.js
Purpose:
  • Guided “2.5D” calibration flow for the Vision Panel.
  • Collects four corner clicks to solve the plane homography (H), then 4 target samples
    to fit the base pivot and a split linear mapping (mLow/mHigh, C) around 90°.

UI Elements Expected (from vision_panel.html):
  • <img id="visionStream"> <canvas id="visionOverlay"> (for clicks)
  • <button id="calibStartBtn"> <span id="calibStatus">

Endpoints:
  • GET  /calibration/get    -> { ok, data }
  • POST /calibration/solve  { image_points, world_width_mm, world_height_mm } -> { ok, H }
  • POST /calibration/save   { ...payload } -> { ok }
  • POST /vision/analyze     { modes:[], params:{} } -> { ok, frame_size: [w,h] }

Notes:
  • Click order for homography: TL → TR → BR → BL (clockwise).
  • Coordinates: frame-space (camera pixels) vs display-space (canvas pixels).
================================================================================================ */

(() => {
  const img    = document.getElementById('visionStream');
  const ov     = document.getElementById('visionOverlay');
  const btn    = document.getElementById('calibStartBtn');
  const status = document.getElementById('calibStatus');
  if (!btn) return;

  // ---------- helpers -------------------------------------------------------------------------
  /**
   * Update the calibration status line in the UI.
   * @param {string} m - Message text.
   * @param {boolean} [ok=true] - If false, paint in error color.
   */
  const setStatus = (m, ok=true) => { if (status){ status.textContent = m; status.style.color = ok ? '#7ad' : '#e66'; } };

  /** Clamp v into [a, b]. */
  const clamp = (v,a,b)=>Math.max(a,Math.min(b,v));

  /** True if value is a finite number. */
  const isNum = v => Number.isFinite(v);

  /**
   * Parse a number; return NaN if not finite.
   * @param {any} v
   * @returns {number}
   */
  const toNum = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : NaN; };

  /**
   * Load current calibration JSON from server.
   * @returns {Promise<Object>} calibration object or {} on failure.
   */
  async function loadCalib(){
    try { const j = await fetch('/calibration/get').then(r=>r.json()); if (j?.ok && j.data) return j.data; } catch(_){}
    return {};
  }

  /**
   * Deep-merge two JSON-like values with simple object semantics.
   * Arrays and scalars from `b` replace `a`; plain objects merge recursively.
   * @param {any} a
   * @param {any} b
   * @returns {any}
   */
  function deepMerge(a, b){
    if (Array.isArray(a) || Array.isArray(b)) return (b!==undefined)?b:a;
    if (typeof a!=='object' || a===null)     return (b!==undefined)?b:a;
    const out = {...a};
    for(const k of Object.keys(b||{})){
      const av=a[k], bv=b[k];
      if (av && bv && typeof av==='object' && typeof bv==='object' && !Array.isArray(av) && !Array.isArray(bv)){
        out[k]=deepMerge(av,bv);
      } else {
        out[k]=(bv!==undefined)?bv:av;
      }
    }
    return out;
  }

  /**
   * Ask the server for the current camera frame size.
   * Uses /vision/analyze with empty modes to fetch frame_size.
   * @returns {Promise<{w:number,h:number}>}
   * @throws if the endpoint reports !ok
   */
  async function getFrameSize(){
    const j = await fetch('/vision/analyze', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({modes:[], params:{}})
    }).then(r=>r.json());
    if (!j || !j.ok) throw new Error('vision/analyze failed');
    const [w,h] = j.frame_size || [img?.naturalWidth||640, img?.naturalHeight||480];
    return {w,h};
  }

  /**
   * Capture `n` click points on the overlay canvas (display-space).
   * @param {number} n - number of points to collect
   * @param {string} msg - status text shown while collecting
   * @returns {Promise<Array<[number,number]>>} array of [x,y] in display-space pixels
   */
  async function captureClicks(n, msg){
    return new Promise(resolve=>{
      const pts=[];
      const onClick=(ev)=>{
        const r = ov.getBoundingClientRect();
        pts.push([ev.clientX - r.left, ev.clientY - r.top]);
        setStatus(`${msg}  ${pts.length}/${n}`);
        if (pts.length>=n){ ov.removeEventListener('click', onClick); resolve(pts); }
      };
      setStatus(msg);
      ov.addEventListener('click', onClick);
    });
  }

  /**
   * Convert a set of display-space points to frame-space using the current frame size.
   * @param {Array<[number,number]>} displayPts
   * @returns {Promise<Array<[number,number]>>} frame-space points
   */
  async function scaleDisplayToFrame(displayPts){
    const {w:fw, h:fh} = await getFrameSize();
    const sx = fw / ov.width;
    const sy = fh / ov.height;
    return displayPts.map(([x,y]) => [x*sx, y*sy]);
  }

  /**
   * Apply a 3×3 homography (row-major H) to a frame-space point (x,y).
   * @param {number[][]} H - homography matrix
   * @param {number} x
   * @param {number} y
   * @returns {[number,number]} mapped point in world-plane space (pre-inversion of Y)
   */
  function applyH(H, x, y){
    const d = H[2][0]*x + H[2][1]*y + H[2][2];
    const X = (H[0][0]*x + H[0][1]*y + H[0][2]) / d;
    const Y = (H[1][0]*x + H[1][1]*y + H[1][2]) / d;
    return [X, Y];
  }

  /**
   * Convert frame-space (fx,fy) into world-plane coordinates (mm),
   * with Y flipped to a top-left origin convention.
   * @param {number[][]} H
   * @param {number} Wmm - plane width in mm (TL→TR)
   * @param {number} Hmm - plane height in mm (TR→BR)
   * @param {number} fx
   * @param {number} fy
   * @returns {[number,number]} world-plane [X,Y] in mm
   */
  function frameToWorld(H, Wmm, Hmm, fx, fy){
    const [X, Y0] = applyH(H, fx, fy);
    return [X, Hmm - Y0];
  }

  /**
   * Compute world yaw (degrees) from base pivot to point P: 0..180 from +X axis.
   * @param {{x:number,y:number}} base - pivot location in mm
   * @param {[number,number]} P - world point [X,Y] in mm
   * @returns {number} yaw in degrees (0..180)
   */
  function worldYawDeg(base, P){
    const dx=P[0]-base.x, dy=P[1]-base.y;
    const r = Math.hypot(dx,dy) || 1;
    const c = clamp(dx/r, -1, 1);
    return Math.acos(c) * 180 / Math.PI; // 0..180 from +X
  }

  /**
   * Fit a split linear mapping given a pivot split (deg) between two regimes.
   * Servo ≈ C + m*(yaw - split), with independent slopes mLow/mHigh on each side.
   * @param {number[]} yawDeg
   * @param {number[]} servoDeg
   * @param {number} [split=90]
   * @param {number} [iters=4]
   * @returns {{mLow:number,mHigh:number,C:number,rms:number}}
   */
  function fitMappingGivenPivot(yawDeg, servoDeg, split=90, iters=4){
    const n = yawDeg.length;
    if (n===0) return {mLow:1, mHigh:1, C:90, rms:1e9};

    const lowIdx  = [], highIdx = [];
    for (let i=0;i<n;i++) (yawDeg[i] < split ? lowIdx : highIdx).push(i);
    if (lowIdx.length===0 || highIdx.length===0) return {mLow:1, mHigh:1, C:90, rms:1e9};

    let C = servoDeg.reduce((a,b)=>a+b,0)/n; // init center
    let mLow=1, mHigh=1;

    for (let k=0;k<iters;k++){
      // mLow
      let numL=0, denL=0;
      for (const i of lowIdx){
        const y = yawDeg[i] - split;
        numL += y * (servoDeg[i] - C);
        denL += y * y;
      }
      mLow = (Math.abs(denL)>1e-9) ? (numL/denL) : mLow;

      // mHigh
      let numH=0, denH=0;
      for (const i of highIdx){
        const y = yawDeg[i] - split;
        numH += y * (servoDeg[i] - C);
        denH += y * y;
      }
      mHigh = (Math.abs(denH)>1e-9) ? (numH/denH) : mHigh;

      // C
      let sum = 0;
      for (let i=0;i<n;i++){
        const y = yawDeg[i] - split;
        const m = (yawDeg[i] < split) ? mLow : mHigh;
        sum += (servoDeg[i] - m*y);
      }
      C = sum / n;
    }

    let sse=0;
    for (let i=0;i<n;i++){
      const y = yawDeg[i] - split;
      const m = (yawDeg[i] < split) ? mLow : mHigh;
      const pred = C + m*y;
      const e = servoDeg[i] - pred;
      sse += e*e;
    }
    const rms = Math.sqrt(sse / n);
    return {mLow, mHigh, C, rms};
  }

  /**
   * Grid-search the pivot (base x,y) and fit mapping for each candidate; return the best fit.
   * @param {{X:number,Y:number,servo:number}[]} samples
   * @param {number} [split=90]
   * @param {{xmin:number,xmax:number,ymin:number,ymax:number,coarse:number,fine:number}} box
   * @returns {{err:number, base:{x:number,y:number}, mLow:number, mHigh:number, C:number}}
   */
  function fitPivotAndMapping(samples, split=90, box){
    // samples: [{X,Y, servo}]
    const yawFrom = (base)=> samples.map(s => worldYawDeg(base, [s.X,s.Y]));
    const servo   = samples.map(s => s.servo);

    let best = {err:1e99, base:{x: (box.xmin+box.xmax)/2, y:(box.ymin+box.ymax)/2}, mLow:1, mHigh:1, C:90};

    const passes = [{step: box.coarse},{step: box.fine}];
    let search = {xmin:box.xmin, xmax:box.xmax, ymin:box.ymin, ymax:box.ymax};
    for (const pass of passes){
      for (let x=search.xmin; x<=search.xmax; x+=pass.step){
        for (let y=search.ymin; y<=search.ymax; y+=pass.step){
          const base = {x,y};
          const yaws = yawFrom(base);
          const fit  = fitMappingGivenPivot(yaws, servo, split, 5);
          if (!isFinite(fit.rms)) continue;
          if (fit.rms < best.err){
            best = {err: fit.rms, base, mLow: fit.mLow, mHigh: fit.mHigh, C: fit.C};
          }
        }
      }
      // Narrow around current best for the next pass
      search = {
        xmin: best.base.x - pass.step*2,
        xmax: best.base.x + pass.step*2,
        ymin: best.base.y - pass.step*2,
        ymax: best.base.y + pass.step*2
      };
    }
    return best;
  }

  /**
   * Main calibration routine (button handler).
   * 1) Ask plane dimensions (mm)
   * 2) Collect 4 corner clicks TL→TR→BR→BL -> solve H
   * 3) Collect 4 target samples: click target, enter base servo angle pointing to it
   * 4) Fit pivot + split mapping (mLow/mHigh, C) around 90°
   * 5) Merge and save calibration JSON
   */
  async function runAll(){
    btn.disabled = true;
    try{
      const existing = await loadCalib();
      const defW = existing.plane_size_mm?.[0] ?? 500;
      const defH = existing.plane_size_mm?.[1] ?? 270;

      // ---- 1) plane size ---------------------------------------------------------------------
      let Wmm = toNum(prompt('Plane width in mm (TL→TR).', String(defW)));
      if (!isNum(Wmm)) Wmm = defW;
      let Hmm = toNum(prompt('Plane height in mm (TR→BR).', String(defH)));
      if (!isNum(Hmm)) Hmm = defH;

      // ---- 2) four clicks TL→TR→BR→BL -------------------------------------------------------
      const clicks = await captureClicks(4, 'Click TL → TR → BR → BL on the overlay');
      const framePts = await scaleDisplayToFrame(clicks);

      setStatus('Solving plane…');
      const solved = await fetch('/calibration/solve', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ image_points:framePts, world_width_mm:Wmm, world_height_mm:Hmm })
      }).then(r=>r.json());
      if (!solved?.ok) throw new Error(solved?.error || 'solve failed');
      const H = solved.H;

      // ---- 3) samples: exactly 4 × (click → enter servo angle) ------------------------------
      alert('Collect 4 samples.\nFor each: 1) Click a target on the plane, 2) Enter the base servo angle that points exactly at it.');
      const N = 4;
      const samples = [];
      for (let i=0; i<N; i++){
        // click one point
        const dispPt = (await captureClicks(1, `Sample ${i+1}/${N}: click target`))[0];
        const [[fx,fy]] = await scaleDisplayToFrame([dispPt]);
        const [X,Y] = frameToWorld(H, Wmm, Hmm, fx, fy);

        // prompt servo angle (re-prompt only if NaN)
        let servo = NaN;
        while (!isNum(servo)){
          const hint = `world ≈ (${X.toFixed(1)}, ${Y.toFixed(1)}) mm`;
          const val = prompt(`Enter the base servo angle for this sample.\n${hint}`, '90');
          if (val === null) break; // user cancelled → re-ask same sample
          servo = toNum(val);
        }
        if (!isNum(servo)){ i--; continue; } // repeat this sample

        samples.push({ X, Y, servo });
        setStatus(`Recorded sample ${i+1}/${N}`);
      }

      // sanity: ensure spread across 90° (just warn)
      const roughBase = {x: Wmm/2, y: -Hmm*0.35};
      const roughYaws = samples.map(s => worldYawDeg(roughBase,[s.X,s.Y]));
      if (!(roughYaws.some(y=>y<90) && roughYaws.some(y=>y>=90))) {
        alert('Tip: include samples on both sides of 90° (left & right of center) for best accuracy.');
      }

      // ---- 4) fit pivot + mapping from samples ----------------------------------------------
      setStatus('Fitting base pivot & yaw mapping…');
      const box = {
        xmin: Math.max(0, Wmm*0.15),
        xmax: Math.min(Wmm, Wmm*0.85),
        ymin: -Math.max(160, Hmm*0.8),
        ymax: Math.min(Hmm*0.15, 80),
        coarse: 5,
        fine:   1
      };
      const best = fitPivotAndMapping(samples, 90, box);

      // Mapping numbers
      const offset     = best.C - 90;
      const scale_low  = best.mLow;
      const scale_high = best.mHigh;

      // ---- 5) Save (merge with existing so your poses remain) -------------------------------
      let payload = deepMerge(existing, {});
      payload.H = H;
      payload.plane_size_mm = [Wmm, Hmm];
      payload.base_mm = { x: best.base.x, y: best.base.y };

      payload.servo_map = payload.servo_map || {};
      payload.servo_map.base = payload.servo_map.base || {};
      payload.servo_map.base.split       = 90;
      payload.servo_map.base.offset      = offset;
      payload.servo_map.base.scale_low   = scale_low;
      payload.servo_map.base.scale_high  = scale_high;
      payload.servo_map.base.offset_low  = payload.servo_map.base.offset_low  ?? 0;
      payload.servo_map.base.offset_high = payload.servo_map.base.offset_high ?? 0;
      payload.servo_map.base.radial_k    = payload.servo_map.base.radial_k    ?? 0;
      payload.servo_map.base.radial_r0   = payload.servo_map.base.radial_r0   ?? 220;
      payload.servo_map.base.correction  = []; // fresh fit

      setStatus('Saving calibration… (RMS fit error: ' + best.err.toFixed(2) + '°)');
      const saved = await fetch('/calibration/save', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify(payload)
      }).then(r=>r.json());
      if (!saved?.ok) throw new Error('save failed');

      setStatus('✅ Calibration complete. Base pivot & mapping solved from 4 samples.');
    } catch (e) {
      console.error(e);
      setStatus('❌ ' + (e.message || e), false);
    } finally {
      btn.disabled = false;
    }
  }

  // Start the flow on button click.
  btn.addEventListener('click', runAll);
})();
