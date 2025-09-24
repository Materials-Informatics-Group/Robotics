/* =================================================================================================
Project: REACH App — UI web application to control the REACH robot arm
Institution: Hokkaido University (2025)
Last Update: Q3 2025
-------------------------------------------------------------------------------------------------
Authors:
  • Mikael Nicander Kuwahara — Lead System Designer & Lead Developer (2024–)
-------------------------------------------------------------------------------------------------
File: vision_panel.js
Purpose:
  • Client-side controller for the Vision Panel (server-camera mode).
  • Shows MJPEG stream and draws detection overlays aligned to the displayed image.
  • Sends analyze requests to the server and renders results.

Endpoints & Assets:
  • Stream IMG:  {{ url_for('vision.stream') }}                        -> <img id="visionStream">
  • Analyze API: POST /vision/analyze (JSON: { modes, params })         -> returns { detections: [...] }
  • Overlay:     <canvas id="visionOverlay"> aligned to the stream IMG
  • Selector:    <select id="colorSelect"> for colors/tags
  • Button:      <button id="findBtn"> to trigger analysis

Message Protocol (from parent window; same-origin only):
  • { type: 'voice:find', color: '<color>' }     -> programmatically selects color and triggers Find
  • { type: 'voice:findTag', tag: '<label>' }    -> programmatically selects tag and triggers Find

Notes:
  • All scaling is done between camera frame space (naturalWidth/Height) and display space
    (getBoundingClientRect) to keep overlays pixel-accurate regardless of layout.
  • Badge labels use textContent to avoid HTML injection.
================================================================================================= */

(() => {
  // ---- Cached DOM references -----------------------------------------------------------------
  const img = document.getElementById('visionStream');   // <img> MJPEG stream
  const ov  = document.getElementById('visionOverlay');  // <canvas> overlay
  const ctx = ov.getContext('2d');                       // 2D context for overlay rendering
  const sel = document.getElementById('colorSelect');    // <select> colors/tags
  const findBtn = document.getElementById('findBtn');    // "Find" trigger button
  const logEl = document.getElementById('log');          // Optional <pre id="log"> (may be absent)

  // Display (CSS pixels) size cache for the overlay canvas
  let dispW = 0, dispH = 0;

  /**
   * Append/replace diagnostic output in the optional #log element.
   * Falls back to stringification if JSON serialization fails.
   * @param {any} obj - Any value to display for debugging.
   */
  function log(obj) {    
    if (!logEl) return;
    try { logEl.textContent = JSON.stringify(obj, null, 2); }
    catch { logEl.textContent = String(obj); }
  }

  /**
   * Synchronize the overlay canvas drawing buffer and CSS size
   * to match the *displayed* size of the MJPEG <img>.
   * Uses getBoundingClientRect() to capture post-layout dimensions.
   */
  function syncOverlaySize() {
    // Match the canvas drawing buffer to the *displayed* image size.
    const r = img.getBoundingClientRect();
    dispW = Math.max(1, Math.round(r.width));
    dispH = Math.max(1, Math.round(r.height));
    ov.width  = dispW;             // drawing buffer (device pixels)
    ov.height = dispH;
    ov.style.width  = r.width + 'px';   // CSS size (visual pixels)
    ov.style.height = r.height + 'px';
  }

  /**
   * Retrieve the camera's *frame* size as provided by the server stream.
   * Falls back to 640x480 if natural* are not yet known.
   * @returns {[number, number]} [width, height] in frame-space pixels.
   */
  function frameSize() {
    // Natural frame size from the server (camera capture)
    const W = img.naturalWidth  || 640;
    const H = img.naturalHeight || 480;
    return [W, H];
  }

  /**
   * Convert a point from frame-space (natural camera pixels) to display-space
   * (current on-screen pixels) using the cached display size.
   * @param {number} x - X in frame-space.
   * @param {number} y - Y in frame-space.
   * @returns {[number, number]} [x, y] in display-space pixels.
   */
  function scaleFromFrame(x, y) {
    const [W, H] = frameSize();
    const sx = dispW / W, sy = dispH / H;
    return [x * sx, y * sy];
  }

  /**
   * Convert a bounding box from frame-space to display-space.
   * @param {[number, number, number, number]} box - [x, y, w, h] in frame-space.
   * @returns {[number, number, number, number]} [x, y, w, h] in display-space.
   */
  function scaleBox([x, y, w, h]) {
    const [x1, y1] = scaleFromFrame(x, y);
    const [x2, y2] = scaleFromFrame(x + w, y + h);
    return [x1, y1, x2 - x1, y2 - y1];
  }

  /**
   * Render detections on the overlay canvas and attach readable labels as DOM badges.
   * Clears previous drawings and badges.
   * @param {Array<Object>} dets - Array of detection objects. Each supports:
   *   - type: 'tag'|'color' (optional)
   *   - bbox: [x, y, w, h] in frame-space (or legacy x/y/w/h fields)
   *   - label|text|id: string/number label for tags
   *   - color|color_name: string label for colors
   */
  function drawDetections(dets) {
    ctx.clearRect(0, 0, ov.width, ov.height);
    // Remove any previous badges (kept as lightweight absolutely positioned <div>s)
    document.querySelectorAll('.badge').forEach(b => b.remove());

    if (!dets || !dets.length) return;

    ctx.lineWidth = 2;
    dets.forEach(d => {
      const bb = d.bbox || [d.x, d.y, d.w, d.h];
      const [x, y, w, h] = scaleBox(bb);
      const isTag = d.type === 'tag' || d.label || d.text;

      // Box (white for tag, cyan-ish for color)
      ctx.strokeStyle = isTag ? '#ffffff' : '#00e0ff';
      ctx.strokeRect(Math.round(x)+0.5, Math.round(y)+0.5, Math.round(w), Math.round(h));

      // Label badge — use textContent to prevent HTML injection
      const label = isTag ? (d.label || d.text || `tag ${d.id}`) : (d.color || d.color_name || 'color');
      const badge = document.createElement('div');
      badge.className = 'badge';
      badge.textContent = label;
      badge.style.left = `${Math.round(x)}px`;
      badge.style.top  = `${Math.max(0, Math.round(y) - 20)}px`;
      // Attach within the same stacking context to sit above the canvas
      ov.parentElement.appendChild(badge);
    });
  }

  /**
   * Convert a click location on the overlay canvas (display-space) to frame-space
   * coordinates suitable for server-side analysis.
   * @param {MouseEvent} evt
   * @returns {[number, number]} [x, y] in frame-space pixels.
   */
  function clickToFrameCoords(evt) {
    const r = ov.getBoundingClientRect();
    const [W, H] = frameSize();
    const dx = evt.clientX - r.left;
    const dy = evt.clientY - r.top;
    const x = Math.round(dx * (W / r.width));
    const y = Math.round(dy * (H / r.height));
    return [x, y];
  }

  // ---- Layout syncing: when the stream loads or the window resizes ---------------------------
  img.addEventListener('load', () => { syncOverlaySize(); });
  window.addEventListener('resize', () => { syncOverlaySize(); });

  // In case the stream is already flowing by the time this script attaches
  setTimeout(syncOverlaySize, 400);

  // ---- Click-to-analyze: ask server to analyze color + tags at the click point ---------------
  ov.addEventListener('click', async (e) => {
    const [x, y] = clickToFrameCoords(e);
    try {
      const res = await fetch('/vision/analyze', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ modes: ['color','tags'], params: { click: { x, y } } })
      });
      const data = await res.json();
      drawDetections(data?.detections || []);
      log(data);
    } catch (err) {
      log({ ok:false, error:String(err) });
    }
  });

  // ---- Find button: analyze by selected color OR tag label -----------------------------------
  findBtn?.addEventListener('click', async () => {
    const v = sel.value;
    const COLORS = ['red','orange','yellow','green','cyan','blue','purple','pink','white','gray','black'];
    const modes = COLORS.includes(v) ? ['color'] : ['tags'];
    const params = COLORS.includes(v) ? { colors: [v] } : { tag_labels: [v] };

    try {
      const res = await fetch('/vision/analyze', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ modes, params })
      });
      const data = await res.json();
      drawDetections(data?.detections || []);
      log(data);
    } catch (err) {
      log({ ok:false, error:String(err) });
    }
  });

  // ---- Voice integration: same-origin postMessage hooks --------------------------------------
  // Simulates user Find actions based on external (voice) intents from the parent window.
  window.addEventListener('message', (e) => {
    // Only accept same-origin messages
    if (e.origin !== window.location.origin) return;
    const msg = e.data || {};
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'voice:find' && msg.color) {
      // Reuse the same select used by the button handler
      if (sel) sel.value = String(msg.color).toLowerCase();
      // Trigger find to reuse existing fetch + overlay path
      findBtn?.click();
    }
    if (msg.type === 'voice:findTag' && msg.tag) {
      if (sel) sel.value = String(msg.tag).toUpperCase();
      findBtn?.click();
    }
  });

})();
