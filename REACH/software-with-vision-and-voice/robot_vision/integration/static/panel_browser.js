/* =================================================================================================
Project: REACH App — UI web application to control the REACH robot arm
Institution: Hokkaido University (2025)
Last Update: Q3 2025
-------------------------------------------------------------------------------------------------
Authors:
  • Mikael Nicander Kuwahara — Lead System Designer & Lead Developer (2024–)
-------------------------------------------------------------------------------------------------
File: panel_browser.js
Purpose:
  • Client-side controller for the browser-only Vision panel (no server-side camera stream).
  • Captures frames from getUserMedia(), sends them to server endpoints for analysis, and renders overlays.
Endpoints:
  • POST /vision/upload/analyze  { image: <dataURL>, x, y, bright } -> { ok, detections, frame_size }
  • POST /vision/upload/find     { image: <dataURL>, color, bright } -> { ok, detections, frame_size }
  • POST /vision/upload/find_tag { image: <dataURL>, tag }           -> { ok, detections, frame_size }
Notes:
  • Overlay coordinates are translated between the video’s frame size (videoWidth/Height) and
    the on-screen canvas size (getBoundingClientRect).
  • Logging to <pre id="log"> is optional; if absent, calls are no-ops.
================================================================================================ */

(async () => {
  // ---- Cached DOM references ---------------------------------------------------------------
  const v   = document.getElementById('v');     // <video> (browser webcam)
  const ov  = document.getElementById('ov');    // <canvas> overlay
  const ctx = ov.getContext('2d');              // 2D drawing context
  const sel = document.getElementById('sel');   // <select> for colors/tags
  const findBtn = document.getElementById('find');     // "Find" button
  const brightEl = document.getElementById('bright');  // Brightness hint checkbox
  const logEl = document.getElementById('log');        // Optional debug <pre>

  /**
   * Write a diagnostic object/string to the optional log element.
   * Falls back to String() if JSON serialization fails.
   * @param {any} obj - Value to print into #log.
   */
  function log(obj){ 
    if (!logEl) return;
    try{ logEl.textContent = JSON.stringify(obj, null, 2); }
    catch(e){ logEl.textContent = String(obj); } 
  }

  /**
   * Synchronize the overlay canvas size to the *displayed* video size (post-layout).
   * Uses getBoundingClientRect() so drawings align with what the user sees.
   */
  function syncOverlay(){
    const r = v.getBoundingClientRect();
    ov.width = Math.max(1, Math.round(r.width));
    ov.height = Math.max(1, Math.round(r.height));
  }
  // Keep overlay matched on viewport changes.
  window.addEventListener('resize', syncOverlay);

  // ---- Camera setup ------------------------------------------------------------------------
  // Request a modest 640x480 stream for quick encode/upload and lower bandwidth/CPU.
  const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 }, audio: false });
  v.srcObject = stream;
  await new Promise(res => v.onloadedmetadata = res);
  await v.play();
  syncOverlay();

  /**
   * Capture the current video frame into an offscreen canvas and return a JPEG data URL.
   * @returns {string} dataURL - Base64-encoded JPEG (quality 0.85).
   */
  function frameDataURL(){
    const c = document.createElement('canvas');
    c.width = v.videoWidth || 640;
    c.height = v.videoHeight || 480;
    c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.85);
  }

  /**
   * Draw detection bounding boxes and labels on the overlay canvas.
   * Converts from frame-space (videoWidth/Height) to display-space (overlay width/height).
   * @param {Array<Object>} dets - Detections; supports bbox [x,y,w,h] or legacy x/y/w/h fields.
   * @param {[number,number]} [frameSize] - Optional [W,H] in frame-space from the server;
   *                                        falls back to videoWidth/Height if not provided.
   */
  function draw(dets, frameSize){
    ctx.clearRect(0,0,ov.width, ov.height);
    if(!dets || !dets.length) return;

    const [W,H] = frameSize || [v.videoWidth || 640, v.videoHeight || 480];

    for(const d of dets){
      const bb = d.bbox || [d.x, d.y, d.w, d.h];
      const [x,y,w,h] = bb;

      // Scale from frame-space to display-space
      const sx = x * ov.width / W,  sy = y * ov.height / H;
      const sw = w * ov.width / W,  sh = h * ov.height / H;

      const isTag = d.type === 'tag' || d.label || d.text;

      // Box style: white for tag, cyan-ish for color
      ctx.strokeStyle = isTag ? 'white' : '#00e0ff';
      ctx.lineWidth = 2;
      ctx.strokeRect(sx, sy, sw, sh);

      // Label string (prefer tag label/text/id; otherwise color name)
      const label = isTag ? (d.label || d.text || String(d.id)) : (d.color || d.color_name || 'color');

      // Badged text above the box
      const pad = 4;
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(sx, sy - 18, tw + pad * 2, 18);
      ctx.fillStyle = 'white';
      ctx.fillText(label, sx + pad, sy - 16);
    }
  }

  // ---- Click-to-analyze --------------------------------------------------------------------
  // Sends a single frame + click location; server returns detections to draw.
  ov.addEventListener('click', async (e) => {
    const r = ov.getBoundingClientRect();
    const W = v.videoWidth || 640, H = v.videoHeight || 480;

    // Convert click from display-space to frame-space
    const dx = e.clientX - r.left, dy = e.clientY - r.top;
    const x = Math.round(dx * (W / ov.width)), y = Math.round(dy * (H / ov.height));

    const frame = frameDataURL();

    const res = await fetch('/vision/upload/analyze', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ image: frame, x, y, bright: brightEl.checked })
    }).then(r=>r.json()).catch(()=>({ok:false, detections:[]}));

    draw(res.detections, res.frame_size);
    log(res);
  });

  // ---- Find button: analyze selected color OR tag ------------------------------------------
  findBtn.addEventListener('click', async () => {
    const value = sel.value;
    const TAGS = ['A','B','C','D','1','2','3','4'];
    const isTag = TAGS.includes(value.toUpperCase());

    const frame = frameDataURL();
    const endpoint = isTag ? '/vision/upload/find_tag' : '/vision/upload/find';
    const body = isTag ? { image: frame, tag: value } : { image: frame, color: value, bright: brightEl.checked };

    const res = await fetch(endpoint, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(body)
    }).then(r=>r.json()).catch(()=>({ok:false, detections:[]}));

    draw(res.detections, res.frame_size);
    log(res);
  });
})();
